// Records a virtual device's currently-connected sources to disk, one WAV
// file per source, for later multitrack playback/editing in the frontend.
// A recording is scoped to whatever sources exist on a device at the
// moment `start_recording` is called - a source added afterward gets no
// track (avoids racing the writer-thread setup below against a source
// being added mid-tick), and a source removed mid-session has its track
// finalized immediately (see `finalize_track`, called from
// `VirtualDevice::remove_source`) rather than silently orphaned.
//
// Each track is written by its own dedicated thread, following the same
// stop-flag + JoinHandle + Drop-joins template as LoopbackCapture/
// ProcessLoopbackCapture (see loopback.rs/process_audio.rs) - the
// difference is this thread is deliberately *not* MMCSS-promoted, since
// disk I/O has none of the real-time guarantees the audio callbacks need
// and has no business running at "Pro Audio" priority.

use ringbuf::traits::Consumer;
use ringbuf::HeapCons;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::delay::FeedbackDelay;
use super::engine::{soft_limit, INTERNAL_SAMPLE_RATE};
use super::eq::{EqBand, MultibandEq};

/// How much a per-source tap ring buffer holds before the mixer's
/// (non-blocking) pushes start silently dropping samples for that tick -
/// generous on purpose, since this side is racing disk I/O rather than
/// another audio callback. See the writer thread's poll loop below.
pub(crate) const RECORD_RING_SECONDS: usize = 5;
const WRITER_POLL_MS: u64 = 20;

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn sanitize_component(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Recording session ids are generated server-side (`rec_<millis>`), but
/// they round-trip through IPC as plain strings and get joined onto a
/// filesystem path in every function below - reject anything that could
/// escape `base_dir` rather than trusting the caller.
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.contains("..") {
        return Err("Invalid recording session id".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackManifest {
    pub source_id: String,
    pub file: String,
    pub channels: usize,
    pub sample_rate: u32,
    pub duration_frames: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingManifest {
    pub session_id: String,
    pub device_id: String,
    pub device_name: String,
    pub name: String,
    pub created_at_ms: u64,
    pub tracks: Vec<TrackManifest>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingSummary {
    pub session_id: String,
    pub name: String,
    pub device_name: String,
    pub created_at_ms: u64,
    pub duration_ms: u64,
    pub track_count: usize,
}

impl RecordingSummary {
    pub(crate) fn from_manifest(manifest: &RecordingManifest) -> Self {
        let duration_frames = manifest.tracks.iter().map(|t| t.duration_frames).max().unwrap_or(0);
        RecordingSummary {
            session_id: manifest.session_id.clone(),
            name: manifest.name.clone(),
            device_name: manifest.device_name.clone(),
            created_at_ms: manifest.created_at_ms,
            duration_ms: (duration_frames * 1000) / INTERNAL_SAMPLE_RATE as u64,
            track_count: manifest.tracks.len(),
        }
    }
}

/// One source's WAV writer: owns the ring-buffer consumer side (the
/// producer side lives on that source's `SourceEntry.record_tap` back in
/// engine.rs) and a dedicated thread draining it to disk.
pub(crate) struct RecordingTrack {
    source_id: String,
    channels: usize,
    file_name: String,
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<u64>>,
}

impl RecordingTrack {
    pub(crate) fn start(
        dir: &Path,
        source_id: &str,
        channels: usize,
        mut consumer: HeapCons<f32>,
    ) -> Result<Self, String> {
        let channels = channels.max(1);
        let file_name = format!("track_{}.wav", sanitize_component(source_id));
        let path = dir.join(&file_name);

        let spec = hound::WavSpec {
            channels: channels as u16,
            sample_rate: INTERNAL_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let writer = hound::WavWriter::create(&path, spec).map_err(|e| e.to_string())?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        // Sized to the ring's own full capacity so one pop_slice call
        // always drains everything currently queued, regardless of how
        // far the 20ms poll cadence has drifted from the mixer's ticks.
        let mut buf = vec![0f32; channels * INTERNAL_SAMPLE_RATE as usize * RECORD_RING_SECONDS];

        let thread = thread::spawn(move || {
            let mut writer = writer;
            let mut frames_written: u64 = 0;
            loop {
                let filled = consumer.pop_slice(&mut buf);
                for &sample in &buf[..filled] {
                    let _ = writer.write_sample(sample);
                }
                frames_written += (filled / channels) as u64;

                if thread_stop.load(Ordering::Relaxed) {
                    break;
                }
                thread::sleep(Duration::from_millis(WRITER_POLL_MS));
            }
            // The mixer may have pushed a little more between the last
            // pop above and the stop flag actually being observed.
            loop {
                let filled = consumer.pop_slice(&mut buf);
                if filled == 0 {
                    break;
                }
                for &sample in &buf[..filled] {
                    let _ = writer.write_sample(sample);
                }
                frames_written += (filled / channels) as u64;
            }
            let _ = writer.finalize();
            frames_written
        });

        Ok(Self {
            source_id: source_id.to_string(),
            channels,
            file_name,
            stop_flag,
            thread: Some(thread),
        })
    }

    /// Stops the writer thread and returns how many frames it wrote.
    fn finish(&mut self) -> u64 {
        self.stop_flag.store(true, Ordering::Relaxed);
        self.thread.take().and_then(|h| h.join().ok()).unwrap_or(0)
    }
}

impl Drop for RecordingTrack {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// Live state for one device's in-progress recording. Held as
/// `VirtualDevice.active_recording` for the duration of the take.
pub struct ActiveRecording {
    session_id: String,
    dir: PathBuf,
    name: String,
    device_id: String,
    device_name: String,
    created_at_ms: u64,
    tracks: HashMap<String, RecordingTrack>,
    finished_tracks: Vec<TrackManifest>,
}

impl ActiveRecording {
    pub(crate) fn new(
        session_id: String,
        dir: PathBuf,
        name: String,
        device_id: String,
        device_name: String,
        tracks: HashMap<String, RecordingTrack>,
    ) -> Self {
        Self {
            session_id,
            dir,
            name,
            device_id,
            device_name,
            created_at_ms: now_millis(),
            tracks,
            finished_tracks: Vec::new(),
        }
    }

    pub(crate) fn source_ids(&self) -> Vec<String> {
        self.tracks.keys().cloned().collect()
    }

    /// Finalizes one track early - used both when a source is removed
    /// mid-recording (see `VirtualDevice::remove_source`) and, via
    /// `finish` below, for every remaining track on a normal stop.
    pub(crate) fn finalize_track(&mut self, source_id: &str) {
        if let Some(mut track) = self.tracks.remove(source_id) {
            let frames = track.finish();
            self.finished_tracks.push(TrackManifest {
                source_id: track.source_id.clone(),
                file: track.file_name.clone(),
                channels: track.channels,
                sample_rate: INTERNAL_SAMPLE_RATE,
                duration_frames: frames,
            });
        }
    }

    /// Stops every remaining track and writes `manifest.json`.
    pub(crate) fn finish(mut self) -> Result<RecordingManifest, String> {
        for source_id in self.source_ids() {
            self.finalize_track(&source_id);
        }

        let manifest = RecordingManifest {
            session_id: self.session_id,
            device_id: self.device_id,
            device_name: self.device_name,
            name: self.name,
            created_at_ms: self.created_at_ms,
            tracks: self.finished_tracks,
        };
        let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        std::fs::write(self.dir.join("manifest.json"), json).map_err(|e| e.to_string())?;
        Ok(manifest)
    }
}

pub(crate) fn default_recording_name(device_name: &str) -> String {
    format!("{device_name} recording")
}

pub(crate) fn new_session_id() -> String {
    format!("rec_{}", now_millis())
}

/// Lists every session under `base_dir` that has a `manifest.json`,
/// newest first. Stateless by design (mirrors `profile.json`'s
/// disk-is-truth persistence model) - there's no in-memory index to keep
/// in sync.
pub fn list_sessions(base_dir: &Path) -> Result<Vec<RecordingSummary>, String> {
    if !base_dir.exists() {
        return Ok(Vec::new());
    }
    let mut summaries = Vec::new();
    for entry in std::fs::read_dir(base_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let manifest_path = entry.path().join("manifest.json");
        let Ok(json) = std::fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<RecordingManifest>(&json) else {
            continue;
        };
        summaries.push(RecordingSummary::from_manifest(&manifest));
    }
    summaries.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    Ok(summaries)
}

pub fn rename_session(base_dir: &Path, session_id: &str, new_name: String) -> Result<(), String> {
    validate_session_id(session_id)?;
    let manifest_path = base_dir.join(session_id).join("manifest.json");
    let json = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let mut manifest: RecordingManifest = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    manifest.name = new_name;
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&manifest_path, json).map_err(|e| e.to_string())
}

pub fn delete_session(base_dir: &Path, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let dir = base_dir.join(session_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn load_manifest(base_dir: &Path, session_id: &str) -> Result<RecordingManifest, String> {
    validate_session_id(session_id)?;
    let path = base_dir.join(session_id).join("manifest.json");
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map_err(|e| e.to_string())
}

/// Resolves one recording file (a track WAV, e.g. `track_a.wav`, or a
/// mixdown export, e.g. `mixdown/My Mix.wav`) to an absolute path, for
/// the frontend to load via Tauri's asset protocol (`convertFileSrc`).
/// `relative_file` may nest one level deep (for `mixdown/...`) but must
/// never escape the session directory - since it arrives over IPC, `..`,
/// a leading separator, and a drive-letter prefix are all rejected rather
/// than trusted.
pub fn resolve_file_path(base_dir: &Path, session_id: &str, relative_file: &str) -> Result<String, String> {
    validate_session_id(session_id)?;
    if relative_file.is_empty()
        || relative_file.contains("..")
        || relative_file.starts_with('/')
        || relative_file.starts_with('\\')
        || relative_file.contains(':')
    {
        return Err("Invalid recording file name".to_string());
    }
    let path = base_dir.join(session_id).join(relative_file);
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Recording path is not valid UTF-8".to_string())
}

// --- Non-destructive editing model -----------------------------------
//
// A `RecordingProject` never touches the recorded WAV files themselves -
// it's a list of per-track settings (gain/mute/solo/EQ) plus a list of
// `Clip`s, each a `[source_start_frame, +length_frames)` range of that
// track's *source* WAV placed at `timeline_start_frame` on the shared
// timeline. Trim = shrink a clip's range. Split = replace one clip with
// two adjacent ones. Move = change `timeline_start_frame`. Delete = drop
// it from the list. All of this lives in `project.json`, separate from
// `manifest.json` (the immutable record of what was actually captured),
// so opening the editor never mutates the facts about the take.
//
// Live preview/scrub/trim in the editor runs entirely client-side via the
// Web Audio API (see src-ui/src/lib/editorEngine.ts) - the functions
// below are only ever invoked for the one thing that has to happen in
// Rust: rendering the *authoritative* mixdown using the same EQ/limiter
// DSP the live routing engine uses, not the browser's approximation.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    pub source_start_frame: u64,
    pub length_frames: u64,
    pub timeline_start_frame: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackProject {
    pub source_id: String,
    pub gain: f32,
    /// Stereo balance, -1.0 (full left) .. 1.0 (full right), 0.0 = center.
    pub pan: f32,
    pub muted: bool,
    pub solo: bool,
    pub eq_bands: Vec<EqBand>,
    pub clips: Vec<Clip>,
    /// Send level (0.0-1.0) to each `EffectReturn`, keyed by its `id`. A
    /// missing entry means "no send", same as 0.0 - `#[serde(default)]` so
    /// a `project.json` saved before Effect Returns existed still loads.
    #[serde(default)]
    pub sends: HashMap<String, f32>,
}

/// A shared send/return bus: every track can send a portion of its
/// (post-gain, post-EQ) signal into one of these, which applies its own
/// effect once and sums the result back into the master mix - the same
/// "aux return" mixing model a hardware console uses, rather than each
/// track running its own private copy of the effect. `FeedbackDelay` is the
/// only effect type today; more could be added the same way EqBand's
/// `MultibandEq` was.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectReturn {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub delay_ms: f32,
    pub feedback: f32,
    pub mix: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingProject {
    pub session_id: String,
    pub tracks: Vec<TrackProject>,
    #[serde(default)]
    pub effect_returns: Vec<EffectReturn>,
    /// Editor-only metronome tempo - never affects `render_mixdown` (a
    /// click track is a monitoring aid, not something that belongs baked
    /// into an export), so this only ever matters to the frontend's live
    /// preview. Defaults to 120 for a project saved before tempo existed.
    #[serde(default = "default_tempo_bpm")]
    pub tempo_bpm: f32,
}

fn default_tempo_bpm() -> f32 {
    120.0
}

/// Loads a session's saved edits, or - if the editor has never been
/// opened for this session - synthesizes a default project straight from
/// `manifest.json`: one full-length, unmodified clip per track.
pub fn load_project(base_dir: &Path, session_id: &str) -> Result<RecordingProject, String> {
    validate_session_id(session_id)?;
    let dir = base_dir.join(session_id);

    let project_path = dir.join("project.json");
    if let Ok(json) = std::fs::read_to_string(&project_path) {
        return serde_json::from_str(&json).map_err(|e| e.to_string());
    }

    let manifest_json = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| e.to_string())?;
    let manifest: RecordingManifest = serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;
    let tracks = manifest
        .tracks
        .iter()
        .map(|t| TrackProject {
            source_id: t.source_id.clone(),
            gain: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            eq_bands: Vec::new(),
            clips: vec![Clip {
                id: format!("{}-clip-0", t.source_id),
                source_start_frame: 0,
                length_frames: t.duration_frames,
                timeline_start_frame: 0,
            }],
            sends: HashMap::new(),
        })
        .collect();
    Ok(RecordingProject {
        session_id: session_id.to_string(),
        tracks,
        effect_returns: Vec::new(),
        tempo_bpm: default_tempo_bpm(),
    })
}

pub fn save_project(base_dir: &Path, session_id: &str, project: &RecordingProject) -> Result<(), String> {
    validate_session_id(session_id)?;
    let dir = base_dir.join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("project.json"), json).map_err(|e| e.to_string())
}

/// Fixed master channel count every mixdown renders to, regardless of how
/// many channels each individual track was captured with - a mono source
/// (e.g. a single mic) duplicates to both channels, a source with more
/// than 2 channels contributes only its first two. Keeps the renderer
/// simple and its output universally playable, at the cost of not
/// preserving a >2-channel source's extra channels in the export.
const MASTER_CHANNELS: usize = 2;

fn sanitize_filename(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

/// Picks a non-colliding "<base>.wav" / "<base> (1).wav" / ... filename
/// inside `dir` for a requested output name, falling back to
/// `fallback_base` (e.g. "mixdown", or a track's own id) if `requested`
/// sanitizes down to nothing.
fn unique_output_name(dir: &Path, requested: &str, fallback_base: &str) -> String {
    let sanitized = sanitize_filename(requested.trim());
    let base = if sanitized.is_empty() {
        fallback_base.to_string()
    } else {
        sanitized.strip_suffix(".wav").unwrap_or(&sanitized).to_string()
    };

    let mut candidate = format!("{base}.wav");
    let mut i = 1;
    while dir.join(&candidate).exists() {
        candidate = format!("{base} ({i}).wav");
        i += 1;
    }
    candidate
}

/// Assembles one track's clips onto a `timeline_frames`-long buffer and
/// applies its pan/gain/EQ - the per-track processing shared by
/// `render_mixdown` (which sums every track's buffer together, plus Effect
/// Return sends) and `render_track` (which writes just one track's buffer
/// straight to disk as a single-stem export).
fn render_track_buffer(
    track: &TrackProject,
    track_manifest: &TrackManifest,
    session_dir: &Path,
    timeline_frames: usize,
) -> Result<Vec<f32>, String> {
    let wav_path = session_dir.join(&track_manifest.file);
    let mut reader = hound::WavReader::open(&wav_path).map_err(|e| e.to_string())?;
    let source_channels = track_manifest.channels.max(1);
    let source_samples: Vec<f32> = reader
        .samples::<f32>()
        .collect::<Result<Vec<f32>, _>>()
        .map_err(|e| e.to_string())?;
    let source_frames = source_samples.len() / source_channels;

    // Simple balance-style pan law: moving right attenuates the left
    // channel (and vice versa) rather than boosting the far side, the
    // same behavior every plain stereo balance control uses.
    let pan = track.pan.clamp(-1.0, 1.0);
    let pan_left_gain = if pan > 0.0 { 1.0 - pan } else { 1.0 };
    let pan_right_gain = if pan < 0.0 { 1.0 + pan } else { 1.0 };

    let mut track_buf = vec![0f32; timeline_frames * MASTER_CHANNELS];
    for clip in &track.clips {
        let clip_start = clip.source_start_frame as usize;
        if clip_start >= source_frames {
            continue;
        }
        let available = source_frames - clip_start;
        let length = (clip.length_frames as usize).min(available);
        let dest_start = clip.timeline_start_frame as usize;

        for frame in 0..length {
            let dest_frame = dest_start + frame;
            if dest_frame >= timeline_frames {
                break;
            }
            let src_frame = clip_start + frame;
            let l = source_samples[src_frame * source_channels];
            let r = if source_channels > 1 {
                source_samples[src_frame * source_channels + 1]
            } else {
                l
            };
            track_buf[dest_frame * MASTER_CHANNELS] += l * pan_left_gain;
            track_buf[dest_frame * MASTER_CHANNELS + 1] += r * pan_right_gain;
        }
    }

    if track.gain != 1.0 {
        for s in track_buf.iter_mut() {
            *s *= track.gain;
        }
    }
    if !track.eq_bands.is_empty() {
        MultibandEq::new().process(&mut track_buf, MASTER_CHANNELS, INTERNAL_SAMPLE_RATE, &track.eq_bands);
    }

    Ok(track_buf)
}

/// The shared arrangement length (in frames) every track's buffer and the
/// final master buffer are sized to - the latest point any track's clip
/// extends to on the timeline.
fn compute_timeline_frames(project: &RecordingProject) -> Result<usize, String> {
    project
        .tracks
        .iter()
        .flat_map(|t| t.clips.iter())
        .map(|c| c.timeline_start_frame + c.length_frames)
        .max()
        .map(|f| f as usize)
        .ok_or_else(|| "Project has no clips to render".to_string())
}

/// Renders a `RecordingProject`'s edit list down to one destructive
/// mixdown WAV under `<session>/mixdown/`, reusing the same
/// `MultibandEq`/`soft_limit` DSP the live routing engine applies to
/// monitors - this is the one point where the app's authoritative EQ math
/// runs on a recording, rather than the browser's `BiquadFilterNode`
/// preview approximation used while editing.
pub fn render_mixdown(
    base_dir: &Path,
    session_id: &str,
    project: &RecordingProject,
    output_name: &str,
) -> Result<String, String> {
    validate_session_id(session_id)?;
    let dir = base_dir.join(session_id);

    let manifest_json = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| e.to_string())?;
    let manifest: RecordingManifest = serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;

    let any_solo = project.tracks.iter().any(|t| t.solo);
    let timeline_frames = compute_timeline_frames(project)?;

    let mut master = vec![0f32; timeline_frames * MASTER_CHANNELS];
    let mut return_buses: HashMap<String, Vec<f32>> = project
        .effect_returns
        .iter()
        .map(|r| (r.id.clone(), vec![0f32; timeline_frames * MASTER_CHANNELS]))
        .collect();

    for track in &project.tracks {
        if track.muted || (any_solo && !track.solo) {
            continue;
        }
        let Some(track_manifest) = manifest.tracks.iter().find(|t| t.source_id == track.source_id) else {
            // The source's WAV was removed/renamed out from under the
            // project - skip it rather than failing the whole render.
            continue;
        };

        let track_buf = render_track_buffer(track, track_manifest, &dir, timeline_frames)?;

        // Feed this track's post-gain, post-EQ signal into every return bus
        // it sends to, same source `track_buf` the dry sum below uses -
        // a return is an *additional* copy of the signal routed through a
        // shared effect, not a replacement for the track's own dry path.
        for (return_id, &send_amount) in &track.sends {
            if send_amount <= 0.0 {
                continue;
            }
            if let Some(bus) = return_buses.get_mut(return_id) {
                for (b, t) in bus.iter_mut().zip(track_buf.iter()) {
                    *b += t * send_amount;
                }
            }
        }

        for (m, t) in master.iter_mut().zip(track_buf.iter()) {
            *m += t;
        }
    }

    for effect_return in &project.effect_returns {
        if !effect_return.enabled {
            continue;
        }
        let Some(bus) = return_buses.get_mut(&effect_return.id) else { continue };
        let delay = FeedbackDelay {
            delay_ms: effect_return.delay_ms,
            feedback: effect_return.feedback,
            mix: effect_return.mix,
        };
        delay.process(bus, MASTER_CHANNELS, INTERNAL_SAMPLE_RATE);
        for (m, b) in master.iter_mut().zip(bus.iter()) {
            *m += b;
        }
    }

    for sample in master.iter_mut() {
        *sample = soft_limit(*sample);
    }

    let mixdown_dir = dir.join("mixdown");
    std::fs::create_dir_all(&mixdown_dir).map_err(|e| e.to_string())?;
    let output_file_name = unique_output_name(&mixdown_dir, output_name, "mixdown");
    let output_path = mixdown_dir.join(&output_file_name);

    let spec = hound::WavSpec {
        channels: MASTER_CHANNELS as u16,
        sample_rate: INTERNAL_SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&output_path, spec).map_err(|e| e.to_string())?;
    for sample in &master {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_file_name)
}

/// Renders one track's own edit list - clips, gain, pan, EQ, the same
/// per-track processing `render_mixdown` applies before summing everything
/// together - to its own WAV under `<session>/mixdown/`, for pulling a
/// single clean stem out without the rest of the mix.
///
/// Deliberately ignores mute/solo and Effect Return sends: an explicit
/// "save this track" request should hand back exactly that track
/// regardless of how mute/solo happen to be set elsewhere right now, and a
/// return is a cross-track mix bus, not something that belongs to one
/// isolated stem.
pub fn render_track(
    base_dir: &Path,
    session_id: &str,
    project: &RecordingProject,
    track_source_id: &str,
    output_name: &str,
) -> Result<String, String> {
    validate_session_id(session_id)?;
    let dir = base_dir.join(session_id);

    let manifest_json = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| e.to_string())?;
    let manifest: RecordingManifest = serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;

    let track = project
        .tracks
        .iter()
        .find(|t| t.source_id == track_source_id)
        .ok_or_else(|| format!("Unknown track: {track_source_id}"))?;
    let track_manifest = manifest
        .tracks
        .iter()
        .find(|t| t.source_id == track_source_id)
        .ok_or_else(|| format!("No recorded audio for track: {track_source_id}"))?;

    let timeline_frames = compute_timeline_frames(project)?;
    let mut track_buf = render_track_buffer(track, track_manifest, &dir, timeline_frames)?;

    for sample in track_buf.iter_mut() {
        *sample = soft_limit(*sample);
    }

    let mixdown_dir = dir.join("mixdown");
    std::fs::create_dir_all(&mixdown_dir).map_err(|e| e.to_string())?;
    let output_file_name = unique_output_name(&mixdown_dir, output_name, &sanitize_component(track_source_id));
    let output_path = mixdown_dir.join(&output_file_name);

    let spec = hound::WavSpec {
        channels: MASTER_CHANNELS as u16,
        sample_rate: INTERNAL_SAMPLE_RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&output_path, spec).map_err(|e| e.to_string())?;
    for sample in &track_buf {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(output_file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, channels: u16, samples: &[f32]) {
        let spec = hound::WavSpec {
            channels,
            sample_rate: INTERNAL_SAMPLE_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("failed to create test wav");
        for &s in samples {
            writer.write_sample(s).expect("failed to write test sample");
        }
        writer.finalize().expect("failed to finalize test wav");
    }

    fn scratch_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("yomagaudio_{label}_{}_{}", std::process::id(), now_millis()))
    }

    /// Validates the core clip-mapping arithmetic (trim, split into two
    /// clips read from different source offsets, move on the timeline)
    /// plus per-track gain and mute, without touching the live capture
    /// engine at all - manifest.json and the source WAVs are hand-built
    /// fixtures.
    #[test]
    fn render_mixdown_maps_clips_applies_gain_and_respects_mute() {
        let base_dir = scratch_dir("render_test");
        let session_id = "rec_test_session".to_string();
        let dir = base_dir.join(&session_id);
        std::fs::create_dir_all(&dir).unwrap();

        // Track A: 500-frame ramp, mono - sample[i] = i / 2000.0, so every
        // frame has a distinct, easily-checked value.
        let track_a_samples: Vec<f32> = (0..500).map(|i| i as f32 / 2000.0).collect();
        write_test_wav(&dir.join("track_a.wav"), 1, &track_a_samples);

        // Track B: constant 0.9, mono - will be muted, so it must
        // contribute nothing to the render.
        write_test_wav(&dir.join("track_b.wav"), 1, &vec![0.9; 500]);

        let manifest = RecordingManifest {
            session_id: session_id.clone(),
            device_id: "dev".to_string(),
            device_name: "Test Device".to_string(),
            name: "Test".to_string(),
            created_at_ms: 0,
            tracks: vec![
                TrackManifest {
                    source_id: "a".to_string(),
                    file: "track_a.wav".to_string(),
                    channels: 1,
                    sample_rate: INTERNAL_SAMPLE_RATE,
                    duration_frames: 500,
                },
                TrackManifest {
                    source_id: "b".to_string(),
                    file: "track_b.wav".to_string(),
                    channels: 1,
                    sample_rate: INTERNAL_SAMPLE_RATE,
                    duration_frames: 500,
                },
            ],
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let project = RecordingProject {
            session_id: session_id.clone(),
            tracks: vec![
                TrackProject {
                    source_id: "a".to_string(),
                    gain: 2.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    eq_bands: Vec::new(),
                    // Trim: only the first 200 of 500 source frames.
                    // Split + move: a second clip pulled from source
                    // frames [300, 400) but placed right after the first
                    // clip on the timeline instead of at its own [300,400).
                    clips: vec![
                        Clip { id: "a1".to_string(), source_start_frame: 0, length_frames: 200, timeline_start_frame: 0 },
                        Clip { id: "a2".to_string(), source_start_frame: 300, length_frames: 100, timeline_start_frame: 200 },
                    ],
                    sends: HashMap::new(),
                },
                TrackProject {
                    source_id: "b".to_string(),
                    gain: 1.0,
                    pan: 0.0,
                    muted: true,
                    solo: false,
                    eq_bands: Vec::new(),
                    clips: vec![Clip { id: "b1".to_string(), source_start_frame: 0, length_frames: 300, timeline_start_frame: 0 }],
                    sends: HashMap::new(),
                },
            ],
            effect_returns: Vec::new(),
            tempo_bpm: default_tempo_bpm(),
        };

        let output_name = render_mixdown(&base_dir, &session_id, &project, "mix").expect("render failed");
        let output_path = dir.join("mixdown").join(&output_name);
        let mut reader = hound::WavReader::open(&output_path).expect("failed to open rendered mixdown");
        assert_eq!(reader.spec().channels, 2);
        let samples: Vec<f32> = reader.samples::<f32>().collect::<Result<_, _>>().unwrap();
        assert_eq!(samples.len() / 2, 300, "timeline should be 300 frames (max clip extent)");

        let at = |frame: usize| samples[frame * 2];

        // Clip 1: dest frame f <- source frame f. value = (f/2000)*gain(2.0) = f/1000.
        assert!((at(50) - 0.05).abs() < 1e-5, "clip1 frame 50 was {}", at(50));
        // Clip 2: dest frame f <- source frame (f - 200) + 300 = f + 100.
        assert!((at(250) - 0.35).abs() < 1e-5, "clip2 frame 250 was {}", at(250));
        // Mono source duplicated to both channels.
        assert_eq!(samples[50 * 2], samples[50 * 2 + 1]);
        // Muted track B contributes nothing: frame 50 is exactly track A's
        // value alone, not track A + track B's 0.9.
        assert!((at(50) - 0.05).abs() < 1e-5);

        let _ = std::fs::remove_dir_all(&base_dir);
    }

    /// Confirms `render_track` exports a single track's own edit list even
    /// when that track is muted (an explicit "save this track" request
    /// should hand back exactly that track regardless of the rest of the
    /// project's current mute/solo state), applies that track's own
    /// gain/pan, and rejects an unknown track id rather than silently
    /// rendering nothing.
    #[test]
    fn render_track_exports_one_track_ignoring_mute_and_rejects_unknown_ids() {
        let base_dir = scratch_dir("render_track_test");
        let session_id = "rec_track_session".to_string();
        let dir = base_dir.join(&session_id);
        std::fs::create_dir_all(&dir).unwrap();

        write_test_wav(&dir.join("track_a.wav"), 1, &vec![0.2; 100]);
        write_test_wav(&dir.join("track_b.wav"), 1, &vec![0.4; 100]);

        let manifest = RecordingManifest {
            session_id: session_id.clone(),
            device_id: "dev".to_string(),
            device_name: "Test Device".to_string(),
            name: "Test".to_string(),
            created_at_ms: 0,
            tracks: vec![
                TrackManifest {
                    source_id: "a".to_string(),
                    file: "track_a.wav".to_string(),
                    channels: 1,
                    sample_rate: INTERNAL_SAMPLE_RATE,
                    duration_frames: 100,
                },
                TrackManifest {
                    source_id: "b".to_string(),
                    file: "track_b.wav".to_string(),
                    channels: 1,
                    sample_rate: INTERNAL_SAMPLE_RATE,
                    duration_frames: 100,
                },
            ],
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let project = RecordingProject {
            session_id: session_id.clone(),
            tracks: vec![
                TrackProject {
                    source_id: "a".to_string(),
                    gain: 1.0,
                    pan: 0.0,
                    muted: false,
                    solo: false,
                    eq_bands: Vec::new(),
                    clips: vec![Clip { id: "a1".to_string(), source_start_frame: 0, length_frames: 100, timeline_start_frame: 0 }],
                    sends: HashMap::new(),
                },
                TrackProject {
                    source_id: "b".to_string(),
                    gain: 2.0,
                    pan: -1.0, // hard left
                    muted: true, // single-track export must ignore this
                    solo: false,
                    eq_bands: Vec::new(),
                    clips: vec![Clip { id: "b1".to_string(), source_start_frame: 0, length_frames: 100, timeline_start_frame: 0 }],
                    sends: HashMap::new(),
                },
            ],
            effect_returns: Vec::new(),
            tempo_bpm: default_tempo_bpm(),
        };

        let output_name = render_track(&base_dir, &session_id, &project, "b", "b_export").expect("render_track failed");
        let output_path = dir.join("mixdown").join(&output_name);
        let mut reader = hound::WavReader::open(&output_path).expect("failed to open rendered track export");
        assert_eq!(reader.spec().channels, 2);
        let samples: Vec<f32> = reader.samples::<f32>().collect::<Result<_, _>>().unwrap();
        assert_eq!(samples.len() / 2, 100);

        // gain 2.0 * source 0.4 = 0.8; hard-left pan silences the right channel.
        assert!((samples[0] - 0.8).abs() < 1e-5, "left channel should be the gain-applied source, got {}", samples[0]);
        assert!(samples[1].abs() < 1e-5, "hard-left pan should silence the right channel, got {}", samples[1]);

        let missing = render_track(&base_dir, &session_id, &project, "does-not-exist", "x");
        assert!(missing.is_err(), "render_track should reject an unknown track id");

        let _ = std::fs::remove_dir_all(&base_dir);
    }

    /// Confirms a track's `eq_bands` actually reach `MultibandEq` during
    /// render (as opposed to being silently ignored) by comparing a
    /// render with a strong peaking band against an identical flat
    /// render - exact biquad output values are covered by eq.rs's own
    /// tests, this only checks the wiring.
    #[test]
    fn render_mixdown_eq_band_changes_output() {
        let base_dir = scratch_dir("render_eq_test");
        let session_id = "rec_eq_session".to_string();
        let dir = base_dir.join(&session_id);
        std::fs::create_dir_all(&dir).unwrap();

        // Full-scale alternating samples: lots of high-frequency energy
        // for a peaking band to visibly act on.
        let samples: Vec<f32> = (0..200).map(|i| if i % 2 == 0 { 0.3 } else { -0.3 }).collect();
        write_test_wav(&dir.join("track_a.wav"), 1, &samples);

        let manifest = RecordingManifest {
            session_id: session_id.clone(),
            device_id: "dev".to_string(),
            device_name: "Test Device".to_string(),
            name: "Test".to_string(),
            created_at_ms: 0,
            tracks: vec![TrackManifest {
                source_id: "a".to_string(),
                file: "track_a.wav".to_string(),
                channels: 1,
                sample_rate: INTERNAL_SAMPLE_RATE,
                duration_frames: 200,
            }],
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let base_track = TrackProject {
            source_id: "a".to_string(),
            gain: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            eq_bands: Vec::new(),
            clips: vec![Clip { id: "a1".to_string(), source_start_frame: 0, length_frames: 200, timeline_start_frame: 0 }],
            sends: HashMap::new(),
        };

        let flat_project = RecordingProject {
            session_id: session_id.clone(),
            tracks: vec![base_track.clone()],
            effect_returns: Vec::new(),
            tempo_bpm: default_tempo_bpm(),
        };
        let mut eq_track = base_track;
        eq_track.eq_bands = vec![EqBand { freq_hz: 8000.0, gain_db: 18.0, q: 1.0 }];
        let eq_project = RecordingProject {
            session_id: session_id.clone(),
            tracks: vec![eq_track],
            effect_returns: Vec::new(),
            tempo_bpm: default_tempo_bpm(),
        };

        let flat_name = render_mixdown(&base_dir, &session_id, &flat_project, "flat").unwrap();
        let eq_name = render_mixdown(&base_dir, &session_id, &eq_project, "eq").unwrap();

        let read_samples = |name: &str| -> Vec<f32> {
            hound::WavReader::open(dir.join("mixdown").join(name))
                .unwrap()
                .samples::<f32>()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let flat_samples = read_samples(&flat_name);
        let eq_samples = read_samples(&eq_name);

        assert_eq!(flat_samples.len(), eq_samples.len());
        let differs = flat_samples.iter().zip(eq_samples.iter()).any(|(a, b)| (a - b).abs() > 1e-4);
        assert!(differs, "an 18dB peaking band at 8kHz should audibly change a high-frequency-heavy signal");

        let _ = std::fs::remove_dir_all(&base_dir);
    }

    /// Covers the rest of the session-management surface the frontend
    /// relies on: `load_project`'s default-from-manifest generation,
    /// a save/load round-trip that then reflects the saved edits instead
    /// of regenerating the default, and `list_sessions`/`rename_session`/
    /// `delete_session`. Uses hand-built fixtures rather than the live
    /// capture engine - that path is already covered by
    /// `engine::tests::recording_writes_a_wav_file_per_source`.
    #[test]
    fn project_lifecycle_defaults_saves_lists_renames_and_deletes() {
        let base_dir = scratch_dir("project_lifecycle_test");
        let session_id = "rec_lifecycle_session".to_string();
        let dir = base_dir.join(&session_id);
        std::fs::create_dir_all(&dir).unwrap();

        write_test_wav(&dir.join("track_a.wav"), 1, &vec![0.1; 400]);

        let manifest = RecordingManifest {
            session_id: session_id.clone(),
            device_id: "dev".to_string(),
            device_name: "Test Device".to_string(),
            name: "Original Name".to_string(),
            created_at_ms: 1_000,
            tracks: vec![TrackManifest {
                source_id: "a".to_string(),
                file: "track_a.wav".to_string(),
                channels: 1,
                sample_rate: INTERNAL_SAMPLE_RATE,
                duration_frames: 400,
            }],
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        // No project.json yet - load_project must synthesize a default:
        // one full-length, untouched clip per track.
        let default_project = load_project(&base_dir, &session_id).expect("default project load failed");
        assert_eq!(default_project.tracks.len(), 1);
        let default_track = &default_project.tracks[0];
        assert_eq!(default_track.source_id, "a");
        assert_eq!(default_track.gain, 1.0);
        assert!(!default_track.muted);
        assert_eq!(default_track.clips.len(), 1);
        assert_eq!(default_track.clips[0].source_start_frame, 0);
        assert_eq!(default_track.clips[0].length_frames, 400);
        assert_eq!(default_track.clips[0].timeline_start_frame, 0);

        // Save an edited project, then confirm load_project returns the
        // saved edits rather than regenerating the default.
        let mut edited = default_project;
        edited.tracks[0].gain = 0.5;
        edited.tracks[0].muted = true;
        save_project(&base_dir, &session_id, &edited).expect("save_project failed");
        assert!(dir.join("project.json").exists());

        let reloaded = load_project(&base_dir, &session_id).expect("reload after save failed");
        assert_eq!(reloaded.tracks[0].gain, 0.5);
        assert!(reloaded.tracks[0].muted);

        // list_sessions should find this session via manifest.json.
        let sessions = list_sessions(&base_dir).expect("list_sessions failed");
        let found = sessions.iter().find(|s| s.session_id == session_id).expect("session not listed");
        assert_eq!(found.name, "Original Name");
        assert_eq!(found.track_count, 1);

        rename_session(&base_dir, &session_id, "Renamed".to_string()).expect("rename_session failed");
        let sessions = list_sessions(&base_dir).expect("list_sessions after rename failed");
        let found = sessions.iter().find(|s| s.session_id == session_id).expect("session not listed after rename");
        assert_eq!(found.name, "Renamed");

        delete_session(&base_dir, &session_id).expect("delete_session failed");
        assert!(!dir.exists());

        let _ = std::fs::remove_dir_all(&base_dir);
    }

    /// Confirms `TrackProject::pan` actually reaches the mixdown: hard
    /// left should silence the right channel (and vice versa), and center
    /// should leave both channels at the source's original level - the
    /// balance-style pan law documented on `render_mixdown`.
    #[test]
    fn render_mixdown_pan_attenuates_the_opposite_channel() {
        let base_dir = scratch_dir("render_pan_test");
        let session_id = "rec_pan_session".to_string();
        let dir = base_dir.join(&session_id);
        std::fs::create_dir_all(&dir).unwrap();

        write_test_wav(&dir.join("track_a.wav"), 1, &vec![0.5; 100]);

        let manifest = RecordingManifest {
            session_id: session_id.clone(),
            device_id: "dev".to_string(),
            device_name: "Test Device".to_string(),
            name: "Test".to_string(),
            created_at_ms: 0,
            tracks: vec![TrackManifest {
                source_id: "a".to_string(),
                file: "track_a.wav".to_string(),
                channels: 1,
                sample_rate: INTERNAL_SAMPLE_RATE,
                duration_frames: 100,
            }],
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let base_track = TrackProject {
            source_id: "a".to_string(),
            gain: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            eq_bands: Vec::new(),
            clips: vec![Clip { id: "a1".to_string(), source_start_frame: 0, length_frames: 100, timeline_start_frame: 0 }],
            sends: HashMap::new(),
        };

        let render_at_pan = |pan: f32| -> Vec<f32> {
            let mut track = base_track.clone();
            track.pan = pan;
            let project = RecordingProject {
                session_id: session_id.clone(),
                tracks: vec![track],
                effect_returns: Vec::new(),
                tempo_bpm: default_tempo_bpm(),
            };
            let name = render_mixdown(&base_dir, &session_id, &project, &format!("pan_{pan}")).unwrap();
            hound::WavReader::open(dir.join("mixdown").join(name))
                .unwrap()
                .samples::<f32>()
                .collect::<Result<_, _>>()
                .unwrap()
        };

        let center = render_at_pan(0.0);
        assert!((center[0] - 0.5).abs() < 1e-5, "center pan left channel was {}", center[0]);
        assert!((center[1] - 0.5).abs() < 1e-5, "center pan right channel was {}", center[1]);

        let hard_left = render_at_pan(-1.0);
        assert!((hard_left[0] - 0.5).abs() < 1e-5, "hard-left pan should leave the left channel untouched");
        assert!(hard_left[1].abs() < 1e-5, "hard-left pan should silence the right channel, got {}", hard_left[1]);

        let hard_right = render_at_pan(1.0);
        assert!(hard_right[0].abs() < 1e-5, "hard-right pan should silence the left channel, got {}", hard_right[0]);
        assert!((hard_right[1] - 0.5).abs() < 1e-5, "hard-right pan should leave the right channel untouched");

        let _ = std::fs::remove_dir_all(&base_dir);
    }

    /// Confirms an EffectReturn actually reaches the mixdown: a track
    /// sending into an enabled Delay return should produce an echo after
    /// its dry hit, and disabling the return should silence that echo
    /// without touching the dry signal - the wiring test for
    /// `render_mixdown`'s return-bus loop, the same spirit as the EQ/pan
    /// wiring tests above.
    #[test]
    fn render_mixdown_effect_return_delay_adds_an_echo_after_the_dry_signal() {
        let base_dir = scratch_dir("render_return_test");
        let session_id = "rec_return_session".to_string();
        let dir = base_dir.join(&session_id);
        std::fs::create_dir_all(&dir).unwrap();

        // A single impulse at frame 0, silence afterward - any energy
        // later in the render can only have come from the delay. Kept
        // under soft_limit's 0.98 ceiling (see engine::soft_limit) so the
        // dry sample survives the render completely untouched, rather than
        // comparing against a value the limiter has already reshaped.
        let mut samples = vec![0f32; 400];
        samples[0] = 0.5;
        write_test_wav(&dir.join("track_a.wav"), 1, &samples);

        let manifest = RecordingManifest {
            session_id: session_id.clone(),
            device_id: "dev".to_string(),
            device_name: "Test Device".to_string(),
            name: "Test".to_string(),
            created_at_ms: 0,
            tracks: vec![TrackManifest {
                source_id: "a".to_string(),
                file: "track_a.wav".to_string(),
                channels: 1,
                sample_rate: INTERNAL_SAMPLE_RATE,
                duration_frames: 400,
            }],
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();

        let return_id = "ret1".to_string();
        // A round 5ms so the echo lands on an exact, easily-asserted sample
        // index rather than one rounded from a fractional-ms delay.
        let delay_ms = 5.0f32;
        let delay_frames = (INTERNAL_SAMPLE_RATE as f32 * delay_ms / 1000.0).round() as usize;

        let mut sends = HashMap::new();
        sends.insert(return_id.clone(), 1.0f32);
        let track = TrackProject {
            source_id: "a".to_string(),
            gain: 1.0,
            pan: 0.0,
            muted: false,
            solo: false,
            eq_bands: Vec::new(),
            clips: vec![Clip { id: "a1".to_string(), source_start_frame: 0, length_frames: 400, timeline_start_frame: 0 }],
            sends,
        };

        let make_project = |enabled: bool| RecordingProject {
            session_id: session_id.clone(),
            tracks: vec![track.clone()],
            effect_returns: vec![EffectReturn {
                id: return_id.clone(),
                name: "Delay".to_string(),
                enabled,
                delay_ms,
                feedback: 0.5,
                mix: 1.0,
            }],
            tempo_bpm: default_tempo_bpm(),
        };

        let render = |enabled: bool, name: &str| -> Vec<f32> {
            let project = make_project(enabled);
            let output_name = render_mixdown(&base_dir, &session_id, &project, name).unwrap();
            hound::WavReader::open(dir.join("mixdown").join(output_name))
                .unwrap()
                .samples::<f32>()
                .collect::<Result<_, _>>()
                .unwrap()
        };

        let with_return = render(true, "with_return");
        let at = |samples: &Vec<f32>, frame: usize| samples[frame * 2];

        assert!((at(&with_return, 0) - 0.5).abs() < 1e-5, "the dry impulse itself should be untouched");
        assert!(
            at(&with_return, delay_frames) > 0.1,
            "expected an audible echo at the delay time, got {}",
            at(&with_return, delay_frames)
        );

        let without_return = render(false, "without_return");
        assert!(
            (at(&without_return, 0) - 0.5).abs() < 1e-5,
            "dry signal must be identical whether the return is enabled or not"
        );
        assert!(
            at(&without_return, delay_frames).abs() < 1e-6,
            "a disabled return must contribute no echo at all, got {}",
            at(&without_return, delay_frames)
        );

        let _ = std::fs::remove_dir_all(&base_dir);
    }
}
