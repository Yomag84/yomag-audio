use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::Stream;
use parking_lot::Mutex;
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::device_manager::DeviceManager;
use super::eq::{EqBand, MultibandEq};
use super::loopback::{LoopbackCapture, SYSTEM_AUDIO_SOURCE_NAME};
use super::network::{NetworkManager, NetworkSubscription, PeerSnapshot, NETWORK_CHANNELS};
use super::process_audio::{parse_app_source_id, ProcessLoopbackCapture};
use super::resampler::LinearResampler;

/// Fixed rate every source is resampled to and every mixer thread runs at.
/// Monitors resample back out to their own hardware rate independently.
pub(crate) const INTERNAL_SAMPLE_RATE: u32 = 48_000;
/// Mixer tick pacing: nominally 5ms, but see mixer_loop() - the frame count
/// actually mixed each tick is derived from measured elapsed wall-clock
/// time, not assumed to be exactly this. A fixed-size sleep(5ms)-then-mix-
/// 240-frames loop quietly runs slower than real time (sleep plus the
/// mix work itself always takes >=5ms), which starves every monitor's ring
/// buffer at a slow, steady drip - audible as periodic glitching that
/// doesn't show up as ever-growing latency the way clock drift does. This
/// thread is timer-driven, not hardware-callback-driven (it has to serve an
/// arbitrary number of monitors with independent clocks), so it trades a
/// little latency for a much simpler fan-out model - see start_monitor().
pub(crate) const MIX_TICK_PERIOD: Duration = Duration::from_millis(5);

/// Every ring buffer in this pipeline bridges two independently-clocked
/// threads (a hardware callback and either another hardware callback or
/// this mixer's own sleep-timed loop). No two clocks agree exactly, so
/// without correction the faster side's buffer backlog grows without
/// bound - heard as latency that keeps creeping up rather than stabilizing.
/// Capping backlog to a small target window every tick, by dropping the
/// stale excess instead of ever building it up, keeps latency bounded at
/// the cost of an inaudible sample or two when it actually has to catch up.
const MAX_BACKLOG_MS: usize = 80;
const TARGET_BACKLOG_MS: usize = 20;

/// Same "cap to a bounded window" headroom the fixed source-side backlog
/// above uses (80 - 20 = 60), applied on top of each monitor's own
/// configurable `buffer_ms`/`delay_ms` instead of the fixed constants - see
/// `build_monitor_fill`.
const MONITOR_BACKLOG_HEADROOM_MS: usize = MAX_BACKLOG_MS - TARGET_BACKLOG_MS;
const DEFAULT_MONITOR_BUFFER_MS: u32 = TARGET_BACKLOG_MS as u32;
const MIN_MONITOR_BUFFER_MS: u32 = 5;
const MAX_MONITOR_BUFFER_MS: u32 = 250;
const MAX_MONITOR_DELAY_MS: u32 = 500;

fn ms_to_frames(ms: usize, sample_rate: u32) -> usize {
    (sample_rate as usize * ms) / 1000
}

/// `Device::default_output_config()` on Windows returns only the mix format
/// currently negotiated by the shared-mode audio engine (Sound Control
/// Panel > device > Advanced > Default Format) - for many multi-channel
/// virtual devices (e.g. a 16-channel virtual audio cable) that negotiated
/// default can be far narrower than what the device actually advertises,
/// silently truncating a 16-channel device down to however many channels
/// Windows happens to be defaulting it to. Real DAWs pick the widest format
/// a device actually supports rather than trusting its "default"; this does
/// the same, falling back to default_output_config() only if the device
/// doesn't expose a supported-configs list at all.
fn best_output_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
    let widest = device
        .supported_output_configs()
        .ok()
        .and_then(|configs| {
            configs
                .filter(|c| c.sample_format() == cpal::SampleFormat::F32)
                .max_by_key(|c| c.channels())
        });

    match widest {
        Some(range) => Ok(range
            .try_with_sample_rate(cpal::SampleRate(INTERNAL_SAMPLE_RATE))
            .unwrap_or_else(|| range.with_max_sample_rate())),
        None => device.default_output_config().map_err(|e| e.to_string()),
    }
}

/// If `consumer` has more than `max_frames` worth of unread audio queued
/// up, drops the stale excess so occupancy snaps back down to
/// `target_frames` instead of continuing to grow. Returns whether it had to
/// drop anything, for overrun counting.
fn cap_backlog(consumer: &mut impl Consumer<Item = f32>, channels: usize, max_frames: usize, target_frames: usize) -> bool {
    let channels = channels.max(1);
    let occupied_frames = consumer.occupied_len() / channels;
    if occupied_frames > max_frames {
        let frames_to_drop = occupied_frames - target_frames;
        consumer.skip(frames_to_drop * channels);
        true
    } else {
        false
    }
}

/// Ceiling below which `soft_limit` is a no-op - normal-level audio never
/// touches the limiter at all.
const SOFT_LIMIT_CEILING: f32 = 0.98;

/// Smoothly compresses a sample that would otherwise hard-clip instead of
/// chopping it off flat. Multiple sources routed onto the same output
/// channel sum linearly (e.g. three unity-gain sources peaking together
/// hit 3.0), and a plain `clamp(-1.0, 1.0)` on that turns every one of
/// those overs into a flat-topped square wave - the harsh, "torn"-sounding
/// digital clipping this fixes. Below `SOFT_LIMIT_CEILING` this is exactly
/// `sample` (zero cost beyond the comparison); only genuine overs pay for
/// the tanh, and even those approach but never reach +/-1.0.
#[inline]
fn soft_limit(sample: f32) -> f32 {
    let magnitude = sample.abs();
    if magnitude <= SOFT_LIMIT_CEILING {
        return sample;
    }
    let over = (magnitude - SOFT_LIMIT_CEILING) / (1.0 - SOFT_LIMIT_CEILING);
    sample.signum() * (SOFT_LIMIT_CEILING + (1.0 - SOFT_LIMIT_CEILING) * over.tanh())
}

/// Health counters for one ring-buffer hop, visible to the UI so a
/// connection that's actually glitching can be told apart from one that
/// just isn't very loud. Underruns = the consumer found less data than it
/// needed (the producer is behind); overruns = cap_backlog had to drop
/// stale data (the producer is ahead). Either climbing steadily indicates
/// a real, ongoing problem on that specific hop, not a one-off blip.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StreamStats {
    pub underruns: u64,
    pub overruns: u64,
    pub buffered_ms: f32,
}

struct StatsCounters {
    underruns: AtomicU64,
    overruns: AtomicU64,
    buffered_frames: AtomicU64,
}

impl StatsCounters {
    fn new() -> Self {
        Self {
            underruns: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            buffered_frames: AtomicU64::new(0),
        }
    }

    fn record_underrun(&self) {
        self.underruns.fetch_add(1, Ordering::Relaxed);
    }

    fn record_overrun(&self) {
        self.overruns.fetch_add(1, Ordering::Relaxed);
    }

    fn set_buffered_frames(&self, frames: usize) {
        self.buffered_frames.store(frames as u64, Ordering::Relaxed);
    }

    fn snapshot(&self, sample_rate: u32) -> StreamStats {
        StreamStats {
            underruns: self.underruns.load(Ordering::Relaxed),
            overruns: self.overruns.load(Ordering::Relaxed),
            buffered_ms: (self.buffered_frames.load(Ordering::Relaxed) as f32 / sample_rate as f32) * 1000.0,
        }
    }
}

fn peaks_of(chunk: &[f32], channels: usize) -> Vec<f32> {
    let mut peaks = vec![0.0f32; channels.max(1)];
    for frame in chunk.chunks(channels.max(1)) {
        for (c, &s) in frame.iter().enumerate() {
            let a = s.abs();
            if a > peaks[c] {
                peaks[c] = a;
            }
        }
    }
    peaks
}

/// Per-channel peak store. Not a decaying peak-hold - each tick just
/// overwrites with that tick's peak, which is plenty for a live meter at
/// the ~100ms UI refresh rate this feeds.
struct LevelStore {
    bits: Vec<AtomicU32>,
}

impl LevelStore {
    fn new(channels: usize) -> Self {
        Self {
            bits: (0..channels.max(1)).map(|_| AtomicU32::new(0)).collect(),
        }
    }

    fn update(&self, chunk: &[f32], channels: usize) {
        for (i, p) in peaks_of(chunk, channels).into_iter().enumerate() {
            if let Some(slot) = self.bits.get(i) {
                slot.store(p.to_bits(), Ordering::Relaxed);
            }
        }
    }

    fn snapshot(&self) -> Vec<f32> {
        self.bits
            .iter()
            .map(|b| f32::from_bits(b.load(Ordering::Relaxed)))
            .collect()
    }

    fn clear(&self) {
        for b in &self.bits {
            b.store(0, Ordering::Relaxed);
        }
    }
}

/// One entry in a virtual device's routing matrix: `gain` of `source_id`'s
/// `source_channel` is added into the device's `output_channel` every tick.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Connection {
    pub source_id: String,
    pub source_channel: usize,
    pub output_channel: usize,
    pub gain: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInfo {
    pub id: String,
    pub channels: usize,
    pub gain: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub name: String,
    pub channels: usize,
    /// channel_map[i] = which of this device's output_channels feeds this
    /// monitor's channel i, or None if that channel hasn't been wired yet
    /// (silent until the user connects it - monitors do not auto-connect).
    pub channel_map: Vec<Option<usize>>,
    /// When true, this monitor is opened via WASAPI exclusive mode instead
    /// of the normal shared mode - see `exclusive_output` module. Exclusive
    /// mode can reach a device's true channel count even when Windows'
    /// shared-mode "Default Format" for it is narrower, but it takes the
    /// device away from every other application while running, so it's
    /// opt-in per monitor rather than the default.
    pub exclusive: bool,
    /// Target ring-buffer occupancy for this monitor's output hop, in ms.
    /// Larger absorbs more scheduling jitter at the cost of latency;
    /// smaller is snappier but more prone to underruns on a loaded system.
    pub buffer_ms: u32,
    /// Extra fixed latency added on top of `buffer_ms`, in ms - for
    /// aligning this output against another speaker/room whose physical or
    /// processing delay it needs to match.
    pub delay_ms: u32,
    pub eq_bands: Vec<EqBand>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VirtualDeviceSnapshot {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub output_channels: usize,
    pub sources: Vec<SourceInfo>,
    pub connections: Vec<Connection>,
    pub monitors: Vec<MonitorInfo>,
    pub is_published: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DeviceLevels {
    pub source_levels: HashMap<String, Vec<f32>>,
    pub output_levels: Vec<f32>,
    pub source_stats: HashMap<String, StreamStats>,
    pub monitor_stats: HashMap<String, StreamStats>,
}

// Held only for RAII: dropping a variant stops that stream/capture. Neither
// field is ever read directly.
#[allow(dead_code)]
enum SourceStream {
    Input(Stream),
    Loopback(LoopbackCapture),
    ProcessLoopback(ProcessLoopbackCapture),
    Network(NetworkSubscription),
}

// Held only for RAII: dropping either variant stops that monitor's stream.
#[allow(dead_code)]
enum MonitorStream {
    Shared(Stream),
    Exclusive(super::exclusive_output::ExclusiveOutput),
}

struct SourceEntry {
    channels: usize,
    consumer: HeapCons<f32>,
    levels: Arc<LevelStore>,
    stats: Arc<StatsCounters>,
    gain: f32,
    muted: bool,
    _stream: SourceStream,
}

// Same reasoning as VirtualDevice below: cpal::Stream/LoopbackCapture are
// !Send/!Sync by default but safe to share across threads on the WASAPI
// backend, and access is always serialized behind the sources Mutex.
unsafe impl Send for SourceEntry {}
unsafe impl Sync for SourceEntry {}

/// One independent mixing bus: a set of sources (raw, channel-preserved -
/// no auto-downmix at ingestion), a per-channel routing matrix into
/// `output_channels`, and any number of physical "monitor" outputs the
/// routed mix is played to. Sources capture as soon as they're added;
/// `enabled` gates only the mixer thread and monitor playback, so toggling
/// a device off doesn't force reconnecting its sources.
pub struct VirtualDevice {
    pub id: String,
    pub name: String,
    enabled: bool,
    output_channels: usize,
    sources: Arc<Mutex<HashMap<String, SourceEntry>>>,
    connections: Arc<Mutex<Vec<Connection>>>,
    output_levels: Arc<LevelStore>,
    /// Per monitor, which output_channel index feeds each of that
    /// monitor's own channels, or None if that channel hasn't been wired
    /// yet - e.g. [Some(1), None] means the monitor's channel 0 pulls from
    /// this device's output channel 1, and channel 1 is silent until
    /// connected. Sized to the monitor's real channel count, starts fully
    /// disconnected when a monitor is added - monitors never auto-wire.
    /// Shared with that monitor's live output callback so wiring changes
    /// take effect immediately, no restart needed.
    monitor_channel_maps: HashMap<String, Arc<Mutex<Vec<Option<usize>>>>>,
    monitor_stats: HashMap<String, Arc<StatsCounters>>,
    /// Per monitor, whether it should be opened via WASAPI exclusive mode.
    /// Absent/false means normal shared mode (the default).
    monitor_exclusive: HashMap<String, bool>,
    /// Per monitor, target ring-buffer occupancy in ms. Absent means
    /// `DEFAULT_MONITOR_BUFFER_MS`. Changing this restarts that one
    /// monitor's stream (see `restart_monitor_if_running`) since it changes
    /// the ring buffer's own sizing, not just a value read live.
    monitor_buffer_ms: HashMap<String, u32>,
    /// Per monitor, extra fixed latency in ms on top of `monitor_buffer_ms`.
    /// Absent means 0. Also restarts the monitor's stream when changed.
    monitor_delay_ms: HashMap<String, u32>,
    /// Per monitor, the parametric EQ bands applied to its output. Shared
    /// with that monitor's live callback via `Arc<Mutex<_>>` so edits take
    /// effect immediately without restarting the stream - unlike buffer/
    /// delay, this doesn't change ring buffer sizing.
    monitor_eq: HashMap<String, Arc<Mutex<Vec<EqBand>>>>,
    monitor_producers: Arc<Mutex<HashMap<String, HeapProd<f32>>>>,
    monitor_streams: HashMap<String, MonitorStream>,
    mixer_stop: Option<Arc<AtomicBool>>,
    mixer_thread: Option<thread::JoinHandle<()>>,
    is_published: bool,
}

// cpal::Stream/LoopbackCapture wrap platform handles that are neither Send
// nor Sync by default, so VirtualDevice can't be stored in Tauri-managed
// state (shared across threads) without this. Access is always serialized
// behind Router's RwLock, and on the WASAPI backend the handles themselves
// are safe to move/share between threads, so this is sound.
unsafe impl Send for VirtualDevice {}
unsafe impl Sync for VirtualDevice {}

impl VirtualDevice {
    pub fn new(id: String, name: String) -> Self {
        Self {
            id,
            name,
            enabled: false,
            output_channels: 2,
            sources: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(Vec::new())),
            output_levels: Arc::new(LevelStore::new(2)),
            monitor_channel_maps: HashMap::new(),
            monitor_stats: HashMap::new(),
            monitor_exclusive: HashMap::new(),
            monitor_buffer_ms: HashMap::new(),
            monitor_delay_ms: HashMap::new(),
            monitor_eq: HashMap::new(),
            monitor_producers: Arc::new(Mutex::new(HashMap::new())),
            monitor_streams: HashMap::new(),
            mixer_stop: None,
            mixer_thread: None,
            is_published: false,
        }
    }

    pub fn snapshot(&self) -> VirtualDeviceSnapshot {
        VirtualDeviceSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            enabled: self.enabled,
            output_channels: self.output_channels,
            sources: self
                .sources
                .lock()
                .iter()
                .map(|(id, e)| SourceInfo {
                    id: id.clone(),
                    channels: e.channels,
                    gain: e.gain,
                    muted: e.muted,
                })
                .collect(),
            connections: self.connections.lock().clone(),
            monitors: self
                .monitor_channel_maps
                .iter()
                .map(|(name, map)| {
                    let map = map.lock();
                    MonitorInfo {
                        name: name.clone(),
                        channels: map.len(),
                        channel_map: map.clone(),
                        exclusive: self.monitor_exclusive.get(name).copied().unwrap_or(false),
                        buffer_ms: self
                            .monitor_buffer_ms
                            .get(name)
                            .copied()
                            .unwrap_or(DEFAULT_MONITOR_BUFFER_MS),
                        delay_ms: self.monitor_delay_ms.get(name).copied().unwrap_or(0),
                        eq_bands: self
                            .monitor_eq
                            .get(name)
                            .map(|a| a.lock().clone())
                            .unwrap_or_default(),
                    }
                })
                .collect(),
            is_published: self.is_published,
        }
    }

    pub fn levels(&self) -> DeviceLevels {
        let sources = self.sources.lock();
        let source_levels = sources.iter().map(|(id, e)| (id.clone(), e.levels.snapshot())).collect();
        let source_stats = sources
            .iter()
            .map(|(id, e)| (id.clone(), e.stats.snapshot(INTERNAL_SAMPLE_RATE)))
            .collect();
        drop(sources);

        let monitor_stats = self
            .monitor_stats
            .iter()
            .map(|(name, s)| (name.clone(), s.snapshot(INTERNAL_SAMPLE_RATE)))
            .collect();

        DeviceLevels {
            source_levels,
            output_levels: self.output_levels.snapshot(),
            source_stats,
            monitor_stats,
        }
    }

    /// Changes the output channel count on the fly. If the device is
    /// currently running, this briefly stops and restarts the mixer thread
    /// and every monitor stream around the resize (same teardown/rebuild
    /// set_enabled already does) so the caller never has to manually
    /// disable the device first - a few milliseconds of silence during the
    /// resize itself is unavoidable (the mix buffer and every monitor
    /// stream's internal-channel assumption both have to change size), but
    /// it happens automatically instead of surfacing as an error.
    pub fn set_output_channels(&mut self, count: usize, network: &NetworkManager) -> Result<(), String> {
        let count = count.clamp(1, 32);
        if count == self.output_channels {
            return Ok(());
        }

        let was_enabled = self.enabled;
        if was_enabled {
            self.set_enabled(false, network)?;
        }

        self.output_channels = count;
        self.output_levels = Arc::new(LevelStore::new(self.output_channels));

        if was_enabled {
            self.set_enabled(true, network)?;
        }
        Ok(())
    }

    pub fn add_source(&mut self, source_id: String) -> Result<(), String> {
        if self.sources.lock().contains_key(&source_id) {
            return Ok(());
        }

        if source_id == SYSTEM_AUDIO_SOURCE_NAME {
            let ring = HeapRb::<f32>::new(INTERNAL_SAMPLE_RATE as usize * 8);
            let (producer, consumer) = ring.split();
            let (capture, channels) = LoopbackCapture::start(INTERNAL_SAMPLE_RATE, producer)?;
            self.sources.lock().insert(
                source_id,
                SourceEntry {
                    channels,
                    consumer,
                    levels: Arc::new(LevelStore::new(channels)),
                    stats: Arc::new(StatsCounters::new()),
                    gain: 1.0,
                    muted: false,
                    _stream: SourceStream::Loopback(capture),
                },
            );
            return Ok(());
        }

        if let Some(pid) = parse_app_source_id(&source_id) {
            let ring = HeapRb::<f32>::new(INTERNAL_SAMPLE_RATE as usize * 8);
            let (producer, consumer) = ring.split();
            let (capture, channels) = ProcessLoopbackCapture::start(pid, INTERNAL_SAMPLE_RATE, producer)?;
            self.sources.lock().insert(
                source_id,
                SourceEntry {
                    channels,
                    consumer,
                    levels: Arc::new(LevelStore::new(channels)),
                    stats: Arc::new(StatsCounters::new()),
                    gain: 1.0,
                    muted: false,
                    _stream: SourceStream::ProcessLoopback(capture),
                },
            );
            return Ok(());
        }

        let manager = DeviceManager::new();
        let input_device = manager
            .get_input_device(&source_id)
            .ok_or_else(|| format!("Input device not found: {source_id}"))?;
        let input_config = input_device
            .default_input_config()
            .map_err(|e| e.to_string())?
            .config();
        let channels = input_config.channels as usize;

        let mut resampler = if input_config.sample_rate.0 != INTERNAL_SAMPLE_RATE {
            Some(LinearResampler::new(
                input_config.sample_rate.0,
                INTERNAL_SAMPLE_RATE,
                channels,
            ))
        } else {
            None
        };

        let ring = HeapRb::<f32>::new(INTERNAL_SAMPLE_RATE as usize * channels.max(1));
        let (mut producer, consumer) = ring.split();
        let levels = Arc::new(LevelStore::new(channels));
        let callback_levels = levels.clone();
        let mut resampled_buf: Vec<f32> = Vec::new();

        let stream = input_device
            .build_input_stream(
                &input_config,
                move |data: &[f32], _info: &cpal::InputCallbackInfo| {
                    super::mmcss::promote_current_thread_to_pro_audio();
                    callback_levels.update(data, channels);

                    match resampler.as_mut() {
                        Some(r) => {
                            resampled_buf.clear();
                            r.process(data, &mut resampled_buf);
                            producer.push_slice(&resampled_buf);
                        }
                        None => {
                            producer.push_slice(data);
                        }
                    }
                },
                |err| tracing::error!(%err, "Input stream error"),
                None,
            )
            .map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;

        self.sources.lock().insert(
            source_id,
            SourceEntry {
                channels,
                consumer,
                levels,
                stats: Arc::new(StatsCounters::new()),
                gain: 1.0,
                muted: false,
                _stream: SourceStream::Input(stream),
            },
        );
        Ok(())
    }

    pub fn remove_source(&mut self, source_id: &str) {
        self.sources.lock().remove(source_id);
        self.connections.lock().retain(|c| c.source_id != source_id);
    }

    /// Subscribes to a LAN peer's published device and adds the incoming
    /// audio as a source, keyed as any other source would be by id so it
    /// shows up uniformly in snapshots/routing.
    pub fn add_network_source(
        &mut self,
        peer_id: &str,
        remote_device_id: &str,
        network: &NetworkManager,
    ) -> Result<String, String> {
        let source_id = format!("net:{peer_id}:{remote_device_id}");
        if self.sources.lock().contains_key(&source_id) {
            return Ok(source_id);
        }

        let (consumer, subscription) = network.subscribe(peer_id, remote_device_id)?;
        self.sources.lock().insert(
            source_id.clone(),
            SourceEntry {
                channels: NETWORK_CHANNELS,
                consumer,
                levels: Arc::new(LevelStore::new(NETWORK_CHANNELS)),
                stats: Arc::new(StatsCounters::new()),
                gain: 1.0,
                muted: false,
                _stream: SourceStream::Network(subscription),
            },
        );
        Ok(source_id)
    }

    pub fn set_source_gain(&mut self, source_id: &str, gain: f32) -> Result<(), String> {
        let mut sources = self.sources.lock();
        let entry = sources
            .get_mut(source_id)
            .ok_or_else(|| format!("Unknown source: {source_id}"))?;
        entry.gain = gain.clamp(0.0, 4.0);
        Ok(())
    }

    pub fn set_source_muted(&mut self, source_id: &str, muted: bool) -> Result<(), String> {
        let mut sources = self.sources.lock();
        let entry = sources
            .get_mut(source_id)
            .ok_or_else(|| format!("Unknown source: {source_id}"))?;
        entry.muted = muted;
        Ok(())
    }

    pub fn set_connection(&mut self, connection: Connection) {
        let mut connections = self.connections.lock();
        if let Some(existing) = connections.iter_mut().find(|c| {
            c.source_id == connection.source_id
                && c.source_channel == connection.source_channel
                && c.output_channel == connection.output_channel
        }) {
            existing.gain = connection.gain;
        } else {
            connections.push(connection);
        }
    }

    pub fn remove_connection(&mut self, source_id: &str, source_channel: usize, output_channel: usize) {
        self.connections.lock().retain(|c| {
            !(c.source_id == source_id
                && c.source_channel == source_channel
                && c.output_channel == output_channel)
        });
    }

    pub fn add_monitor(&mut self, monitor_name: String) -> Result<(), String> {
        if self.monitor_channel_maps.contains_key(&monitor_name) {
            return Ok(());
        }

        let manager = DeviceManager::new();
        let output_device = manager
            .get_output_device(&monitor_name)
            .ok_or_else(|| format!("Output device not found: {monitor_name}"))?;
        let channels = best_output_config(&output_device)?.config().channels as usize;
        // Starts fully disconnected - every channel is silent until the
        // user explicitly wires it via the cable diagram. Auto-connecting
        // here made the wiring UI look broken (audio already flowing before
        // you'd touched anything).
        let disconnected_map: Vec<Option<usize>> = vec![None; channels];
        self.monitor_channel_maps
            .insert(monitor_name.clone(), Arc::new(Mutex::new(disconnected_map)));
        self.monitor_stats
            .insert(monitor_name.clone(), Arc::new(StatsCounters::new()));
        self.monitor_buffer_ms
            .insert(monitor_name.clone(), DEFAULT_MONITOR_BUFFER_MS);
        self.monitor_delay_ms.insert(monitor_name.clone(), 0);
        self.monitor_eq
            .insert(monitor_name.clone(), Arc::new(Mutex::new(Vec::new())));

        if self.enabled {
            self.start_monitor(&monitor_name)?;
        }
        Ok(())
    }

    pub fn remove_monitor(&mut self, monitor_name: &str) {
        self.monitor_channel_maps.remove(monitor_name);
        self.monitor_stats.remove(monitor_name);
        self.monitor_exclusive.remove(monitor_name);
        self.monitor_buffer_ms.remove(monitor_name);
        self.monitor_delay_ms.remove(monitor_name);
        self.monitor_eq.remove(monitor_name);
        self.monitor_streams.remove(monitor_name);
        self.monitor_producers.lock().remove(monitor_name);
    }

    /// Switches a monitor between shared mode (the default, works with
    /// every device but can't exceed whatever channel count Windows has
    /// negotiated as that device's shared "Default Format") and WASAPI
    /// exclusive mode (reaches the device's true channel count, but takes
    /// the device away from every other application while running). Takes
    /// effect immediately if the monitor is currently live, by restarting
    /// just that one monitor's stream.
    pub fn set_monitor_exclusive(&mut self, monitor_name: &str, exclusive: bool) -> Result<(), String> {
        if !self.monitor_channel_maps.contains_key(monitor_name) {
            return Err(format!("Unknown monitor: {monitor_name}"));
        }
        self.monitor_exclusive.insert(monitor_name.to_string(), exclusive);
        self.restart_monitor_if_running(monitor_name)
    }

    /// Sets a monitor's target ring-buffer occupancy. Takes effect on next
    /// start: since it resizes the ring buffer itself (not just a value the
    /// live callback rereads), a currently-running monitor is restarted -
    /// same tradeoff `set_monitor_exclusive` already makes.
    pub fn set_monitor_buffer_ms(&mut self, monitor_name: &str, ms: u32) -> Result<(), String> {
        if !self.monitor_channel_maps.contains_key(monitor_name) {
            return Err(format!("Unknown monitor: {monitor_name}"));
        }
        let ms = ms.clamp(MIN_MONITOR_BUFFER_MS, MAX_MONITOR_BUFFER_MS);
        self.monitor_buffer_ms.insert(monitor_name.to_string(), ms);
        self.restart_monitor_if_running(monitor_name)
    }

    /// Sets a monitor's extra fixed latency on top of its buffer size. Also
    /// restarts a running monitor - see `set_monitor_buffer_ms`.
    pub fn set_monitor_delay_ms(&mut self, monitor_name: &str, ms: u32) -> Result<(), String> {
        if !self.monitor_channel_maps.contains_key(monitor_name) {
            return Err(format!("Unknown monitor: {monitor_name}"));
        }
        let ms = ms.clamp(0, MAX_MONITOR_DELAY_MS);
        self.monitor_delay_ms.insert(monitor_name.to_string(), ms);
        self.restart_monitor_if_running(monitor_name)
    }

    /// Replaces a monitor's EQ bands. Unlike buffer/delay this is picked up
    /// live by the running callback via the shared `Arc<Mutex<_>>` (see
    /// `monitor_eq`), so no restart/glitch is needed even while it's
    /// actively playing.
    pub fn set_monitor_eq(&mut self, monitor_name: &str, bands: Vec<EqBand>) -> Result<(), String> {
        let slot = self
            .monitor_eq
            .get(monitor_name)
            .ok_or_else(|| format!("Unknown monitor: {monitor_name}"))?;
        let bands = bands
            .into_iter()
            .map(|b| EqBand {
                freq_hz: b.freq_hz.clamp(20.0, 20_000.0),
                gain_db: b.gain_db.clamp(-24.0, 24.0),
                q: b.q.clamp(0.1, 18.0),
            })
            .collect();
        *slot.lock() = bands;
        Ok(())
    }

    /// Restarts a monitor's stream if it's currently live, so a setting
    /// that requires rebuilding the stream (buffer size, delay, exclusive
    /// mode) takes effect immediately instead of only on next enable.
    fn restart_monitor_if_running(&mut self, monitor_name: &str) -> Result<(), String> {
        let was_running = self.monitor_streams.contains_key(monitor_name);
        if was_running {
            self.monitor_streams.remove(monitor_name);
            self.monitor_producers.lock().remove(monitor_name);
            self.start_monitor(monitor_name)?;
        }
        Ok(())
    }

    /// Repoints one of a monitor's channels to draw from a different output
    /// channel of this device. Takes effect immediately - no restart needed,
    /// since the monitor's live output callback reads this map every tick.
    pub fn set_monitor_channel(
        &mut self,
        monitor_name: &str,
        monitor_channel: usize,
        output_channel: usize,
    ) -> Result<(), String> {
        let mut map = self.monitor_channel_map_mut(monitor_name, monitor_channel)?;
        map[monitor_channel] = Some(output_channel);
        Ok(())
    }

    /// Disconnects one of a monitor's channels, silencing it until it's
    /// wired again.
    pub fn clear_monitor_channel(&mut self, monitor_name: &str, monitor_channel: usize) -> Result<(), String> {
        let mut map = self.monitor_channel_map_mut(monitor_name, monitor_channel)?;
        map[monitor_channel] = None;
        Ok(())
    }

    fn monitor_channel_map_mut(
        &self,
        monitor_name: &str,
        monitor_channel: usize,
    ) -> Result<parking_lot::MutexGuard<'_, Vec<Option<usize>>>, String> {
        let map = self
            .monitor_channel_maps
            .get(monitor_name)
            .ok_or_else(|| format!("Unknown monitor: {monitor_name}"))?;
        let map = map.lock();
        if monitor_channel >= map.len() {
            return Err(format!(
                "Monitor '{monitor_name}' has no channel {monitor_channel}"
            ));
        }
        Ok(map)
    }

    /// Publishing reuses the exact same fan-out the mixer thread already
    /// feeds monitors through (see mixer_loop) - a network publish is just
    /// another producer in monitor_producers under a reserved key, except
    /// its "output stream" is NetworkManager's own broadcast-to-listeners
    /// thread instead of a cpal device, so it deliberately isn't added to
    /// monitor_channel_maps/monitor_streams (which assume a real physical
    /// device).
    pub fn set_published(&mut self, published: bool, network: &NetworkManager) -> Result<(), String> {
        const NETWORK_MONITOR_KEY: &str = "__network__";

        if published == self.is_published {
            return Ok(());
        }

        if published {
            if !self.enabled {
                return Err("Enable the device before publishing it to the network".to_string());
            }
            let producer = network.publish(self.id.clone(), self.name.clone());
            self.monitor_producers
                .lock()
                .insert(NETWORK_MONITOR_KEY.to_string(), producer);
        } else {
            network.unpublish(&self.id);
            self.monitor_producers.lock().remove(NETWORK_MONITOR_KEY);
        }

        self.is_published = published;
        Ok(())
    }

    /// Starts one monitor's own output stream, in whichever mode this
    /// monitor is configured for.
    fn start_monitor(&mut self, monitor_name: &str) -> Result<(), String> {
        let exclusive = self.monitor_exclusive.get(monitor_name).copied().unwrap_or(false);
        if exclusive {
            self.start_monitor_exclusive(monitor_name)
        } else {
            self.start_monitor_shared(monitor_name)
        }
    }

    /// Builds one monitor's own shared-mode output stream via cpal. It
    /// pulls the internal-format mix (48kHz, this device's output_channels)
    /// from a ring buffer the mixer thread fans out into, resampling/
    /// channel-adapting to whatever this monitor's real hardware format is
    /// - the same "bridge two independent clocks with a ring buffer"
    /// pattern used for sources.
    fn start_monitor_shared(&mut self, monitor_name: &str) -> Result<(), String> {
        let manager = DeviceManager::new();
        let output_device = manager
            .get_output_device(monitor_name)
            .ok_or_else(|| format!("Output device not found: {monitor_name}"))?;
        let output_config = best_output_config(&output_device)?.config();
        let monitor_channels = output_config.channels as usize;
        let internal_channels = self.output_channels;

        let channel_map = self
            .monitor_channel_maps
            .entry(monitor_name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(vec![None; monitor_channels])))
            .clone();
        let stats = self
            .monitor_stats
            .entry(monitor_name.to_string())
            .or_insert_with(|| Arc::new(StatsCounters::new()))
            .clone();
        let buffer_ms = self
            .monitor_buffer_ms
            .get(monitor_name)
            .copied()
            .unwrap_or(DEFAULT_MONITOR_BUFFER_MS);
        let delay_ms = self.monitor_delay_ms.get(monitor_name).copied().unwrap_or(0);
        let eq_config = self
            .monitor_eq
            .entry(monitor_name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Vec::new())))
            .clone();

        let (producer, mut fill) =
            build_monitor_fill(internal_channels, channel_map, stats, buffer_ms, delay_ms, eq_config);

        let stream = output_device
            .build_output_stream(
                &output_config,
                move |output: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                    fill(output, monitor_channels, output_config.sample_rate.0);
                },
                |err| tracing::error!(%err, "Monitor output stream error"),
                None,
            )
            .map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;

        self.monitor_producers
            .lock()
            .insert(monitor_name.to_string(), producer);
        self.monitor_streams
            .insert(monitor_name.to_string(), MonitorStream::Shared(stream));
        Ok(())
    }

    /// Same as `start_monitor_shared`, but opens the device via WASAPI
    /// exclusive mode instead of cpal's shared-mode stream, so it can reach
    /// a device's true channel count rather than whatever Windows' shared
    /// "Default Format" happens to be negotiating for it. The real channel
    /// count/sample rate aren't known until the driver actually accepts a
    /// negotiated format, so this resizes the monitor's channel map (which
    /// may have been created with only a shared-mode guess) to match once
    /// the exclusive stream is actually up.
    fn start_monitor_exclusive(&mut self, monitor_name: &str) -> Result<(), String> {
        let internal_channels = self.output_channels;

        let channel_map = self
            .monitor_channel_maps
            .entry(monitor_name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Vec::new())))
            .clone();
        let stats = self
            .monitor_stats
            .entry(monitor_name.to_string())
            .or_insert_with(|| Arc::new(StatsCounters::new()))
            .clone();
        let buffer_ms = self
            .monitor_buffer_ms
            .get(monitor_name)
            .copied()
            .unwrap_or(DEFAULT_MONITOR_BUFFER_MS);
        let delay_ms = self.monitor_delay_ms.get(monitor_name).copied().unwrap_or(0);
        let eq_config = self
            .monitor_eq
            .entry(monitor_name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(Vec::new())))
            .clone();

        let (producer, fill) = build_monitor_fill(
            internal_channels,
            channel_map.clone(),
            stats,
            buffer_ms,
            delay_ms,
            eq_config,
        );

        const EXCLUSIVE_PROBE_CHANNELS: usize = 32;
        let (handle, actual_channels, _actual_rate) =
            super::exclusive_output::ExclusiveOutput::start(monitor_name, EXCLUSIVE_PROBE_CHANNELS, fill)?;

        {
            let mut map = channel_map.lock();
            if map.len() != actual_channels {
                map.resize(actual_channels, None);
            }
        }

        self.monitor_producers
            .lock()
            .insert(monitor_name.to_string(), producer);
        self.monitor_streams
            .insert(monitor_name.to_string(), MonitorStream::Exclusive(handle));
        Ok(())
    }

    pub fn set_enabled(&mut self, enabled: bool, network: &NetworkManager) -> Result<(), String> {
        if enabled == self.enabled {
            return Ok(());
        }

        if enabled {
            let monitor_names: Vec<String> = self.monitor_channel_maps.keys().cloned().collect();
            for name in monitor_names {
                self.start_monitor(&name)?;
            }

            let stop_flag = Arc::new(AtomicBool::new(false));
            let thread_stop = stop_flag.clone();
            let sources = self.sources.clone();
            let connections = self.connections.clone();
            let monitor_producers = self.monitor_producers.clone();
            let output_levels = self.output_levels.clone();
            let output_channels = self.output_channels;

            let handle = thread::spawn(move || {
                mixer_loop(
                    output_channels,
                    sources,
                    connections,
                    monitor_producers,
                    output_levels,
                    &thread_stop,
                );
            });

            self.mixer_stop = Some(stop_flag);
            self.mixer_thread = Some(handle);
            self.enabled = true;
        } else {
            if let Some(flag) = self.mixer_stop.take() {
                flag.store(true, Ordering::Relaxed);
            }
            if let Some(handle) = self.mixer_thread.take() {
                let _ = handle.join();
            }
            self.monitor_streams.clear();
            self.monitor_producers.lock().clear();
            self.output_levels.clear();
            self.enabled = false;

            if self.is_published {
                network.unpublish(&self.id);
                self.is_published = false;
            }
        }

        Ok(())
    }

    pub fn shutdown(&mut self, network: &NetworkManager) {
        let _ = self.set_enabled(false, network);
        self.sources.lock().clear();
        self.connections.lock().clear();
    }
}

/// Builds the ring-buffer producer plus the per-callback "fill" closure
/// shared by both a shared-mode (cpal) and exclusive-mode (WASAPI) monitor
/// stream: pull this device's internal-format mix out of the ring buffer,
/// resample to the monitor's real output rate if needed, and route through
/// the channel map. Split out so both modes get identical backlog-capping/
/// resampling/routing/stats behavior instead of two hand-maintained copies.
///
/// The monitor's channel count and sample rate are passed into the
/// returned closure on every call rather than fixed at build time, because
/// exclusive mode doesn't know either until the driver actually accepts a
/// negotiated format - the resampler is (re)built lazily the first time a
/// rate is seen, which for a stream's entire lifetime is just once.
fn build_monitor_fill(
    internal_channels: usize,
    channel_map: Arc<Mutex<Vec<Option<usize>>>>,
    stats: Arc<StatsCounters>,
    buffer_ms: u32,
    delay_ms: u32,
    eq_config: Arc<Mutex<Vec<EqBand>>>,
) -> (HeapProd<f32>, impl FnMut(&mut [f32], usize, u32) + Send + 'static) {
    // `delay_ms` is folded into both the target and max backlog so it reads
    // as a permanent floor under this monitor's buffered occupancy rather
    // than something cap_backlog would trim away as soon as it next runs -
    // see the padding pushed into `producer` below for how the floor is
    // actually established.
    let delay_frames = ms_to_frames(delay_ms as usize, INTERNAL_SAMPLE_RATE);
    let target_backlog_frames = ms_to_frames(buffer_ms as usize, INTERNAL_SAMPLE_RATE) + delay_frames;
    let max_backlog_frames =
        target_backlog_frames + ms_to_frames(MONITOR_BACKLOG_HEADROOM_MS, INTERNAL_SAMPLE_RATE);

    let ring = HeapRb::<f32>::new(INTERNAL_SAMPLE_RATE as usize * internal_channels.max(1));
    let (mut producer, mut consumer) = ring.split();
    // Realizes `delay_ms` as steady-state latency immediately on start,
    // rather than waiting for it to accumulate on its own: producer and
    // consumer both run at real-time rates close to each other, so ring
    // occupancy otherwise just sits wherever it started instead of
    // drifting up to a new target.
    if delay_frames > 0 {
        producer.push_slice(&vec![0.0f32; delay_frames * internal_channels.max(1)]);
    }
    let mut pull_buf: Vec<f32> = Vec::new();
    let mut resampled_buf: Vec<f32> = Vec::new();
    let mut resampler: Option<LinearResampler> = None;
    let mut resampler_rate: Option<u32> = None;
    let mut eq = MultibandEq::new();

    let fill = move |output: &mut [f32], monitor_channels: usize, output_sample_rate: u32| {
        super::mmcss::promote_current_thread_to_pro_audio();

        if resampler_rate != Some(output_sample_rate) {
            resampler = if output_sample_rate != INTERNAL_SAMPLE_RATE {
                Some(LinearResampler::new(INTERNAL_SAMPLE_RATE, output_sample_rate, internal_channels))
            } else {
                None
            };
            resampler_rate = Some(output_sample_rate);
        }
        // How many internal (48kHz) frames are needed to produce one
        // output frame at this monitor's native rate. Getting this wrong
        // silently pulls the wrong amount of data from the ring buffer
        // every callback - too little causes dropouts, too much causes
        // discarded/skipped audio - both sound like glitchy/unclear audio.
        let internal_frames_per_output_frame = INTERNAL_SAMPLE_RATE as f64 / output_sample_rate as f64;

        if cap_backlog(&mut consumer, internal_channels, max_backlog_frames, target_backlog_frames) {
            stats.record_overrun();
        }

        let output_frames_needed = output.len() / monitor_channels.max(1);
        let want_internal_frames =
            (output_frames_needed as f64 * internal_frames_per_output_frame).ceil() as usize + 16;
        pull_buf.resize(want_internal_frames * internal_channels, 0.0);
        let filled = consumer.pop_slice(&mut pull_buf);
        if filled < pull_buf.len() {
            stats.record_underrun();
        }
        for s in &mut pull_buf[filled..] {
            *s = 0.0;
        }
        stats.set_buffered_frames(consumer.occupied_len() / internal_channels.max(1));

        let source_for_output: &[f32] = match resampler.as_mut() {
            Some(r) => {
                resampled_buf.clear();
                r.process(&pull_buf, &mut resampled_buf);
                &resampled_buf
            }
            None => &pull_buf,
        };

        let map = channel_map.lock();
        let mut out_idx = 0;
        for frame in source_for_output.chunks(internal_channels.max(1)) {
            if out_idx >= output.len() {
                break;
            }
            for (mc, src_channel) in map.iter().enumerate() {
                if out_idx + mc >= output.len() {
                    break;
                }
                output[out_idx + mc] = match src_channel {
                    Some(sc) => frame.get(*sc).copied().unwrap_or(0.0),
                    None => 0.0,
                };
            }
            out_idx += monitor_channels;
        }
        let tail_start = out_idx.min(output.len());
        for s in &mut output[tail_start..] {
            *s = 0.0;
        }

        let bands = eq_config.lock().clone();
        eq.process(output, monitor_channels, output_sample_rate, &bands);

        // EQ boost (up to +24dB/band) can push already near-unity samples
        // well past +/-1.0 with nothing downstream to catch it - this was
        // sent straight to the output device uncapped, which is a second,
        // worse source of clipping than the main mix's (previously also
        // hard) clamp: unlike that one, this path had no limiting at all.
        for sample in output.iter_mut() {
            *sample = soft_limit(*sample);
        }
    };

    (producer, fill)
}

/// Runs on its own timer (not a hardware callback) since it has to serve an
/// arbitrary number of monitors with independent clocks: each tick, pulls a
/// chunk from every source, applies the routing matrix + per-source
/// gain/mute, sums into the device's output_channels, and fans the result
/// out to every monitor's ring buffer.
fn mixer_loop(
    output_channels: usize,
    sources: Arc<Mutex<HashMap<String, SourceEntry>>>,
    connections: Arc<Mutex<Vec<Connection>>>,
    monitor_producers: Arc<Mutex<HashMap<String, HeapProd<f32>>>>,
    output_levels: Arc<LevelStore>,
    stop_flag: &AtomicBool,
) {
    // Every other real-time thread in this pipeline (source capture
    // callbacks, monitor output callbacks, exclusive-mode output) promotes
    // itself to MMCSS "Pro Audio" priority - this one didn't, despite being
    // the thread every one of those ring buffers actually depends on
    // staying on schedule: it's the single point that reads every source
    // and feeds every monitor, every 5ms. Left at normal priority, it's far
    // more likely than the threads around it to get preempted by ordinary
    // system load, which shows up as backlog overruns/underruns on both
    // sides of it - i.e. audible tearing, not tied to any specific source
    // or monitor.
    super::mmcss::promote_current_thread_to_pro_audio();

    let max_backlog_frames = ms_to_frames(MAX_BACKLOG_MS, INTERNAL_SAMPLE_RATE);
    let target_backlog_frames = ms_to_frames(TARGET_BACKLOG_MS, INTERNAL_SAMPLE_RATE);
    // Bounds how much a single tick can try to catch up by (e.g. after the
    // process was suspended by a debugger or the scheduler starved this
    // thread for a while) - without this, a long stall would demand one
    // enormous allocation and mix pass instead of just dropping the gap.
    let max_tick_frames = ms_to_frames(200, INTERNAL_SAMPLE_RATE);

    let mut next_deadline = Instant::now() + MIX_TICK_PERIOD;
    let mut last_tick = Instant::now();

    while !stop_flag.load(Ordering::Relaxed) {
        let now = Instant::now();
        if next_deadline > now {
            thread::sleep(next_deadline - now);
            next_deadline += MIX_TICK_PERIOD;
        } else {
            // Already behind schedule: don't sleep, and don't let the
            // deadline schedule keep sliding further into the past.
            next_deadline = now + MIX_TICK_PERIOD;
        }

        let now = Instant::now();
        let elapsed = now.duration_since(last_tick);
        last_tick = now;
        let frames = ((elapsed.as_secs_f64() * INTERNAL_SAMPLE_RATE as f64).round() as usize)
            .clamp(1, max_tick_frames);

        let mut mix: Vec<f32> = vec![0.0; frames * output_channels];

        let conns = connections.lock().clone();
        let mut chunks: HashMap<String, (usize, Vec<f32>)> = HashMap::new();
        {
            let mut sources_guard = sources.lock();
            for (id, entry) in sources_guard.iter_mut() {
                if cap_backlog(&mut entry.consumer, entry.channels, max_backlog_frames, target_backlog_frames) {
                    entry.stats.record_overrun();
                }

                let mut buf = vec![0.0f32; frames * entry.channels.max(1)];
                let filled = entry.consumer.pop_slice(&mut buf);
                if filled < buf.len() {
                    entry.stats.record_underrun();
                }
                entry
                    .stats
                    .set_buffered_frames(entry.consumer.occupied_len() / entry.channels.max(1));
                entry.levels.update(&buf, entry.channels);

                if entry.muted {
                    continue;
                }
                if entry.gain != 1.0 {
                    for s in buf.iter_mut() {
                        *s *= entry.gain;
                    }
                }
                chunks.insert(id.clone(), (entry.channels, buf));
            }
        }

        for conn in &conns {
            if conn.output_channel >= output_channels {
                continue;
            }
            if let Some((channels, chunk)) = chunks.get(&conn.source_id) {
                if conn.source_channel >= *channels {
                    continue;
                }
                for frame in 0..frames {
                    let src_idx = frame * channels + conn.source_channel;
                    let dst_idx = frame * output_channels + conn.output_channel;
                    if src_idx < chunk.len() && dst_idx < mix.len() {
                        mix[dst_idx] += chunk[src_idx] * conn.gain;
                    }
                }
            }
        }

        for sample in mix.iter_mut() {
            *sample = soft_limit(*sample);
        }
        output_levels.update(&mix, output_channels);

        let mut producers = monitor_producers.lock();
        for producer in producers.values_mut() {
            producer.push_slice(&mix);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceProfile {
    pub id: String,
    pub gain: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorProfile {
    pub name: String,
    pub buffer_ms: u32,
    pub delay_ms: u32,
    pub eq_bands: Vec<EqBand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub name: String,
    pub output_channels: usize,
    pub enabled: bool,
    pub sources: Vec<SourceProfile>,
    pub connections: Vec<Connection>,
    pub monitors: Vec<MonitorProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Profile {
    pub devices: Vec<DeviceProfile>,
}

/// Owns every virtual device. Devices are independent mixing buses; the
/// only thing this adds on top is identity (ids/ordering) and bulk
/// save/load of the whole routing setup as a Profile.
pub struct Router {
    devices: HashMap<String, VirtualDevice>,
    order: Vec<String>,
    next_id: u32,
    system_endpoints: HashMap<String, super::system_device::SystemEndpoint>,
    network: Arc<NetworkManager>,
}

unsafe impl Send for Router {}
unsafe impl Sync for Router {}

impl Router {
    pub fn new() -> Self {
        Self {
            devices: HashMap::new(),
            order: Vec::new(),
            next_id: 0,
            system_endpoints: HashMap::new(),
            network: NetworkManager::new(),
        }
    }

    pub fn list_peers(&self) -> Vec<PeerSnapshot> {
        self.network.list_peers()
    }

    pub fn set_device_published(&mut self, device_id: &str, published: bool) -> Result<(), String> {
        let network = self.network.clone();
        self.with_device_mut(device_id, |d| d.set_published(published, &network))
    }

    pub fn set_device_enabled(&mut self, device_id: &str, enabled: bool) -> Result<(), String> {
        let network = self.network.clone();
        self.with_device_mut(device_id, |d| d.set_enabled(enabled, &network))
    }

    pub fn set_device_output_channels(&mut self, device_id: &str, count: usize) -> Result<(), String> {
        let network = self.network.clone();
        self.with_device_mut(device_id, |d| d.set_output_channels(count, &network))
    }

    pub fn set_monitor_exclusive(
        &mut self,
        device_id: &str,
        monitor_name: &str,
        exclusive: bool,
    ) -> Result<(), String> {
        self.with_device_mut(device_id, |d| d.set_monitor_exclusive(monitor_name, exclusive))
    }

    pub fn set_monitor_buffer_ms(&mut self, device_id: &str, monitor_name: &str, ms: u32) -> Result<(), String> {
        self.with_device_mut(device_id, |d| d.set_monitor_buffer_ms(monitor_name, ms))
    }

    pub fn set_monitor_delay_ms(&mut self, device_id: &str, monitor_name: &str, ms: u32) -> Result<(), String> {
        self.with_device_mut(device_id, |d| d.set_monitor_delay_ms(monitor_name, ms))
    }

    pub fn set_monitor_eq(
        &mut self,
        device_id: &str,
        monitor_name: &str,
        bands: Vec<EqBand>,
    ) -> Result<(), String> {
        self.with_device_mut(device_id, |d| d.set_monitor_eq(monitor_name, bands))
    }

    pub fn add_network_source(
        &mut self,
        device_id: &str,
        peer_id: String,
        remote_device_id: String,
    ) -> Result<String, String> {
        let network = self.network.clone();
        self.with_device_mut(device_id, |d| {
            d.add_network_source(&peer_id, &remote_device_id, &network)
        })
    }

    pub fn create_device(&mut self, name: String) -> String {
        self.next_id += 1;
        let id = format!("device-{}", self.next_id);
        self.devices
            .insert(id.clone(), VirtualDevice::new(id.clone(), name));
        self.order.push(id.clone());
        id
    }

    /// Creates a new device node bound to YomagAudioDriver.sys, appearing
    /// to the rest of Windows as an independent speaker+mic pair. This is
    /// deliberately unrelated to the app-level VirtualDevice/mixing model -
    /// once created, the resulting real audio device just shows up in
    /// list_devices() like any other hardware, ready to be wired in as a
    /// source or monitor on any virtual device.
    pub fn create_system_endpoint(&mut self, name: String) -> Result<String, String> {
        self.next_id += 1;
        let suffix = format!("ep{}", self.next_id);
        let endpoint = super::system_device::create_system_endpoint(&name, &suffix)?;
        let instance_id = endpoint.instance_id.clone();
        self.system_endpoints.insert(instance_id.clone(), endpoint);
        Ok(instance_id)
    }

    pub fn remove_system_endpoint(&mut self, instance_id: &str) {
        self.system_endpoints.remove(instance_id);
    }

    pub fn list_system_endpoints(&self) -> Vec<String> {
        self.system_endpoints.keys().cloned().collect()
    }

    pub fn delete_device(&mut self, id: &str) {
        if let Some(mut device) = self.devices.remove(id) {
            device.shutdown(&self.network);
        }
        self.order.retain(|d| d != id);
    }

    pub fn rename_device(&mut self, id: &str, name: String) -> Result<(), String> {
        self.devices
            .get_mut(id)
            .ok_or_else(|| format!("Unknown device: {id}"))?
            .name = name;
        Ok(())
    }

    pub fn with_device_mut<F, T>(&mut self, id: &str, f: F) -> Result<T, String>
    where
        F: FnOnce(&mut VirtualDevice) -> Result<T, String>,
    {
        let device = self
            .devices
            .get_mut(id)
            .ok_or_else(|| format!("Unknown device: {id}"))?;
        f(device)
    }

    pub fn snapshot_all(&self) -> Vec<VirtualDeviceSnapshot> {
        self.order
            .iter()
            .filter_map(|id| self.devices.get(id))
            .map(|d| d.snapshot())
            .collect()
    }

    pub fn all_levels(&self) -> HashMap<String, DeviceLevels> {
        self.devices
            .iter()
            .map(|(id, d)| (id.clone(), d.levels()))
            .collect()
    }

    pub fn snapshot_profile(&self) -> Profile {
        Profile {
            devices: self
                .order
                .iter()
                .filter_map(|id| self.devices.get(id))
                .map(|d| {
                    let snap = d.snapshot();
                    DeviceProfile {
                        name: snap.name,
                        output_channels: snap.output_channels,
                        enabled: snap.enabled,
                        sources: snap
                            .sources
                            .into_iter()
                            .map(|s| SourceProfile {
                                id: s.id,
                                gain: s.gain,
                                muted: s.muted,
                            })
                            .collect(),
                        connections: snap.connections,
                        monitors: snap
                            .monitors
                            .into_iter()
                            .map(|m| MonitorProfile {
                                name: m.name,
                                buffer_ms: m.buffer_ms,
                                delay_ms: m.delay_ms,
                                eq_bands: m.eq_bands,
                            })
                            .collect(),
                    }
                })
                .collect(),
        }
    }

    pub fn apply_profile(&mut self, profile: Profile) -> Result<(), String> {
        for id in self.order.clone() {
            self.delete_device(&id);
        }

        let network = self.network.clone();

        for dp in profile.devices {
            let id = self.create_device(dp.name);
            let device = self
                .devices
                .get_mut(&id)
                .expect("device was just inserted");

            device.set_output_channels(dp.output_channels, &network)?;
            for source in dp.sources {
                device.add_source(source.id.clone())?;
                device.set_source_gain(&source.id, source.gain)?;
                device.set_source_muted(&source.id, source.muted)?;
            }
            for conn in dp.connections {
                device.set_connection(conn);
            }
            for monitor in dp.monitors {
                device.add_monitor(monitor.name.clone())?;
                device.set_monitor_buffer_ms(&monitor.name, monitor.buffer_ms)?;
                device.set_monitor_delay_ms(&monitor.name, monitor.delay_ms)?;
                device.set_monitor_eq(&monitor.name, monitor.eq_bands)?;
            }
            if dp.enabled {
                device.set_enabled(true, &network)?;
            }
        }

        Ok(())
    }
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    /// Measures the actual per-tick hot path used by mixer_loop: routing N
    /// sources' worth of samples through a connection matrix into an
    /// output buffer. Compute-latency smoke test, not an end-to-end
    /// hardware latency measurement (needs a live device for that) - it
    /// catches gross regressions in the routing loop itself.
    #[test]
    fn routing_loop_latency_is_well_under_one_tick_period() {
        const SOURCES: usize = 8;
        const SOURCE_CHANNELS: usize = 2;
        const OUTPUT_CHANNELS: usize = 8;
        const CHUNK_FRAMES: usize = 240; // matches MIX_CHUNK_FRAMES, 5ms @ 48kHz

        let sources: Vec<Vec<f32>> = (0..SOURCES)
            .map(|i| {
                (0..CHUNK_FRAMES * SOURCE_CHANNELS)
                    .map(|n| ((i * 997 + n) as f32 * 0.001).sin())
                    .collect()
            })
            .collect();

        // Every source's both channels routed to two different output
        // channels each - a reasonably dense patch-bay, not a trivial case.
        let connections: Vec<(usize, usize, usize, f32)> = (0..SOURCES)
            .flat_map(|i| {
                let out_a = (i * 2) % OUTPUT_CHANNELS;
                let out_b = (i * 2 + 1) % OUTPUT_CHANNELS;
                [(i, 0, out_a, 0.8f32), (i, 1, out_b, 0.8f32)]
            })
            .collect();

        let mut mix = vec![0.0f32; CHUNK_FRAMES * OUTPUT_CHANNELS];

        let start = Instant::now();
        for _ in 0..100 {
            for s in mix.iter_mut() {
                *s = 0.0;
            }
            for &(src_idx, src_channel, out_channel, gain) in &connections {
                let chunk = &sources[src_idx];
                for frame in 0..CHUNK_FRAMES {
                    let src_i = frame * SOURCE_CHANNELS + src_channel;
                    let dst_i = frame * OUTPUT_CHANNELS + out_channel;
                    mix[dst_i] += chunk[src_i] * gain;
                }
            }
            for s in mix.iter_mut() {
                *s = s.clamp(-1.0, 1.0);
            }
        }
        let elapsed_per_tick = start.elapsed() / 100;

        let tick_period_us = (CHUNK_FRAMES as f64 / 48_000.0) * 1_000_000.0;
        println!(
            "routing {SOURCES} sources x {CHUNK_FRAMES} frames into {OUTPUT_CHANNELS}ch: {:?} (tick period budget: {:.0}us)",
            elapsed_per_tick, tick_period_us
        );

        assert!(
            elapsed_per_tick.as_micros() < 1000,
            "routing loop took {:?}, expected comfortably under the {:.0}us tick period",
            elapsed_per_tick,
            tick_period_us
        );
    }
}
