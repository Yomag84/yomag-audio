use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use windows::core::GUID;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eRender, IAudioClient, IAudioRenderClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_SHAREMODE_EXCLUSIVE,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

// mmreg.h constant; not exposed as a named item by this windows-crate version.
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_values(
    0x0000_0003,
    0x0000,
    0x0010,
    [0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71],
);

/// Common rates to probe when negotiating an exclusive-mode format, tried
/// in this order for every channel-count candidate.
const CANDIDATE_SAMPLE_RATES: [u32; 4] = [48_000, 44_100, 96_000, 32_000];

/// Runs a dedicated WASAPI *exclusive*-mode render stream for a device,
/// bypassing the shared-mode audio engine's single negotiated mix format.
/// Shared mode (what cpal and every other app on the system normally uses)
/// locks every process on the machine to whichever format Windows has
/// negotiated for that device (Sound Settings > device > Advanced >
/// Default Format) - for many multi-channel virtual devices that format
/// reports far fewer channels than the device actually supports. Exclusive
/// mode negotiates directly with the driver instead, so it can reach the
/// device's true channel count - at the cost of taking the device away
/// from every other application for as long as this stream is open, which
/// is why this is opt-in per monitor rather than always used.
pub struct ExclusiveOutput {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for ExclusiveOutput {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl ExclusiveOutput {
    /// `desired_channels` is the channel count to start probing from (the
    /// device's own real maximum, if known); negotiation walks downward
    /// from there and across a handful of common sample rates until the
    /// driver accepts one, so a lower actual channel/rate than requested is
    /// possible and is returned to the caller rather than assumed.
    ///
    /// `fill` is invoked from a dedicated real-time thread every period
    /// with exactly the interleaved f32 buffer the device wants
    /// (`channels * frames_this_period` samples); it must write every
    /// sample (silence for anything it can't supply) since whatever is
    /// left in the buffer is what physically plays.
    pub fn start(
        device_name: &str,
        desired_channels: usize,
        mut fill: impl FnMut(&mut [f32], usize, u32) + Send + 'static,
    ) -> Result<(Self, usize, u32), String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(usize, u32), String>>();
        let device_name = device_name.to_string();

        let thread = thread::spawn(move || {
            render_thread_main(&device_name, desired_channels, &mut fill, &thread_stop, &ready_tx);
        });

        match ready_rx.recv() {
            Ok(Ok((channels, sample_rate))) => Ok((
                Self {
                    stop_flag,
                    thread: Some(thread),
                },
                channels,
                sample_rate,
            )),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err("Exclusive-mode render thread exited during startup".to_string())
            }
        }
    }
}

fn render_thread_main(
    device_name: &str,
    desired_channels: usize,
    fill: &mut dyn FnMut(&mut [f32], usize, u32),
    stop_flag: &AtomicBool,
    ready_tx: &mpsc::Sender<Result<(usize, u32), String>>,
) {
    super::mmcss::promote_current_thread_to_pro_audio();

    // Safety: everything COM-related below runs on this single dedicated
    // thread, which initializes its own multithreaded-apartment COM context
    // and never shares raw interface pointers/handles with other threads.
    unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            let _ = ready_tx.send(Err(format!("CoInitializeEx failed: {e}")));
            return;
        }

        let setup = setup_exclusive_render(device_name, desired_channels);
        let (audio_client, render_client, event, channels, sample_rate, buffer_frames) = match setup
        {
            Ok(v) => {
                let _ = ready_tx.send(Ok((v.3, v.4)));
                v
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                CoUninitialize();
                return;
            }
        };

        while !stop_flag.load(Ordering::Relaxed) {
            // 2s timeout: just a periodic chance to notice stop_flag if the
            // device somehow stops signaling; a healthy stream always wakes
            // well before this via the event.
            if WaitForSingleObject(event, 2000) != WAIT_OBJECT_0 {
                continue;
            }

            let padding = match audio_client.GetCurrentPadding() {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(%e, "Exclusive-mode GetCurrentPadding failed");
                    break;
                }
            };
            let frames_available = buffer_frames.saturating_sub(padding);
            if frames_available == 0 {
                continue;
            }

            let buffer_ptr = match render_client.GetBuffer(frames_available) {
                Ok(p) => p,
                Err(e) => {
                    tracing::error!(%e, "Exclusive-mode GetBuffer failed");
                    break;
                }
            };

            let sample_count = frames_available as usize * channels;
            let out: &mut [f32] = std::slice::from_raw_parts_mut(buffer_ptr as *mut f32, sample_count);
            fill(out, channels, sample_rate);

            if let Err(e) = render_client.ReleaseBuffer(frames_available, 0) {
                tracing::error!(%e, "Exclusive-mode ReleaseBuffer failed");
                break;
            }
        }

        let _ = audio_client.Stop();
        let _ = CloseHandle(event);
        CoUninitialize();
    }
}

/// Finds the device, negotiates the widest exclusive-mode F32 format it
/// will accept, initializes an event-driven exclusive stream (retrying
/// once with an aligned buffer size if the driver demands it, per WASAPI's
/// documented exclusive-mode procedure), and starts it.
unsafe fn setup_exclusive_render(
    device_name: &str,
    desired_channels: usize,
) -> Result<(IAudioClient, IAudioRenderClient, HANDLE, usize, u32, u32), String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = find_device_by_name(&enumerator, device_name)?;

    let probe_client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
    let (format, channels, sample_rate) = negotiate_format(&probe_client, desired_channels)?;
    drop(probe_client);

    let audio_client = activate_and_initialize(&device, &format, sample_rate)?;

    let event = CreateEventW(None, false, false, None).map_err(|e| e.to_string())?;
    audio_client.SetEventHandle(event).map_err(|e| e.to_string())?;

    let buffer_frames = audio_client.GetBufferSize().map_err(|e| e.to_string())?;
    let render_client: IAudioRenderClient = audio_client.GetService().map_err(|e| e.to_string())?;

    // Exclusive-mode event-driven streams must have their entire buffer
    // pre-filled before Start() - the first event doesn't fire until after
    // playback begins consuming it, so an empty buffer at Start() means the
    // stream starts from a broken/undefined state (silent, or the render
    // thread's first real cycle inherits corrupt padding accounting).
    // Microsoft's own WASAPI render sample does exactly this one silent
    // pre-fill; skipping it is a well-documented way to get a stream that
    // "starts" successfully but never actually produces audio.
    let prefill_ptr = render_client.GetBuffer(buffer_frames).map_err(|e| e.to_string())?;
    std::ptr::write_bytes(prefill_ptr, 0, buffer_frames as usize * channels * std::mem::size_of::<f32>());
    render_client
        .ReleaseBuffer(buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
        .map_err(|e| e.to_string())?;

    audio_client.Start().map_err(|e| e.to_string())?;

    Ok((audio_client, render_client, event, channels, sample_rate, buffer_frames))
}

unsafe fn find_device_by_name(enumerator: &IMMDeviceEnumerator, name: &str) -> Result<IMMDevice, String> {
    let collection = enumerator
        .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
        .map_err(|e| e.to_string())?;
    let count = collection.GetCount().map_err(|e| e.to_string())?;
    for i in 0..count {
        let device = collection.Item(i).map_err(|e| e.to_string())?;
        let store = match device.OpenPropertyStore(STGM_READ) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let friendly_name = match store.GetValue(&PKEY_Device_FriendlyName) {
            Ok(v) => v.to_string(),
            Err(_) => continue,
        };
        if friendly_name == name {
            return Ok(device);
        }
    }
    Err(format!("Output device not found for exclusive mode: {name}"))
}

/// Exclusive mode has no "list supported formats" API the way shared mode
/// does - drivers only answer yes/no to a specific candidate via
/// `IsFormatSupported`, so the widest format has to be found by probing
/// channel counts downward from `desired_channels` across a handful of
/// common sample rates, taking the first one the driver accepts.
unsafe fn negotiate_format(
    audio_client: &IAudioClient,
    desired_channels: usize,
) -> Result<(WAVEFORMATEXTENSIBLE, usize, u32), String> {
    for channels in (1..=desired_channels.max(1)).rev() {
        for &rate in &CANDIDATE_SAMPLE_RATES {
            let format = build_format(channels, rate);
            let hr = audio_client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &format.Format, None);
            if hr.is_ok() {
                return Ok((format, channels, rate));
            }
        }
    }

    Err(format!(
        "Device does not support exclusive-mode float32 output at {desired_channels} channels or fewer, at any common sample rate"
    ))
}

fn build_format(channels: usize, sample_rate: u32) -> WAVEFORMATEXTENSIBLE {
    let bits_per_sample: u16 = 32;
    let block_align: u16 = (channels as u16).saturating_mul(bits_per_sample / 8);
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE,
            nChannels: channels as u16,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: bits_per_sample,
            cbSize: 22, // size of the fields after WAVEFORMATEX in WAVEFORMATEXTENSIBLE
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: bits_per_sample,
        },
        // No standard speaker layout applies past 8 channels anyway; 0
        // ("unspecified assignment") is what multi-channel virtual cables
        // and interfaces expect for their extra channels.
        dwChannelMask: 0,
        SubFormat: SUBTYPE_IEEE_FLOAT,
    }
}

unsafe fn activate_and_initialize(
    device: &IMMDevice,
    format: &WAVEFORMATEXTENSIBLE,
    sample_rate: u32,
) -> Result<IAudioClient, String> {
    let stream_flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;

    match client.Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, stream_flags, 0, 0, &format.Format, None) {
        Ok(()) => Ok(client),
        Err(e) if e.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED => {
            // Documented WASAPI exclusive-mode procedure: a client that
            // failed to initialize this way can still report the aligned
            // buffer size, but can't be reused - a fresh client has to be
            // activated and initialized with that aligned period instead.
            let aligned_frames = client.GetBufferSize().map_err(|e| e.to_string())?;
            drop(client);
            let retry_client: IAudioClient =
                device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
            let hns = (10_000_000.0 * aligned_frames as f64 / sample_rate as f64).round() as i64;
            retry_client
                .Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, stream_flags, hns, hns, &format.Format, None)
                .map_err(|e| format!("Exclusive-mode Initialize (aligned retry) failed: {e}"))?;
            Ok(retry_client)
        }
        Err(e) => Err(format!("Exclusive-mode Initialize failed: {e}")),
    }
}
