use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use ringbuf::traits::Producer;
use ringbuf::HeapProd;
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};

// mmreg.h constants; not exposed as named items by this windows-crate version.
const WAVE_FORMAT_IEEE_FLOAT: u32 = 3;
const WAVE_FORMAT_EXTENSIBLE: u32 = 0xFFFE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

use super::resampler::LinearResampler;

/// The channel-count and sample-rate identifying string is the display name
/// used consistently as this pseudo-device's identity throughout the engine.
pub const SYSTEM_AUDIO_SOURCE_NAME: &str = "System Audio (Loopback)";

const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_values(
    0x0000_0003,
    0x0000,
    0x0010,
    [0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71],
);

/// Captures "what you hear" from the default output device via WASAPI loopback,
/// converts it to the mixer's channel count/sample rate, and pushes it into a
/// ring buffer consumed by the output mix callback — the same shape as a
/// regular cpal input source, just fed by our own COM capture loop instead of
/// a cpal Stream (which has no loopback support).
pub struct LoopbackCapture {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LoopbackCapture {
    /// Starts capturing the default output device's loopback, resampled to
    /// `target_sample_rate` but with its native channel count preserved (no
    /// downmixing at ingestion - routing decides how channels get used).
    /// Returns the captured channel count alongside the handle so the caller
    /// can register this as a source with the right channel layout.
    pub fn start(
        target_sample_rate: u32,
        producer: HeapProd<f32>,
    ) -> Result<(Self, usize), String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<usize, String>>();

        let thread = thread::spawn(move || {
            capture_thread_main(target_sample_rate, producer, &thread_stop, &ready_tx);
        });

        match ready_rx.recv() {
            Ok(Ok(channels)) => Ok((
                Self {
                    stop_flag,
                    thread: Some(thread),
                },
                channels,
            )),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err("Loopback capture thread exited during startup".to_string())
            }
        }
    }
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn capture_thread_main(
    target_sample_rate: u32,
    mut producer: HeapProd<f32>,
    stop_flag: &AtomicBool,
    ready_tx: &mpsc::Sender<Result<usize, String>>,
) {
    super::mmcss::promote_current_thread_to_pro_audio();

    // Safety: everything COM-related below runs on this single dedicated
    // thread, which initializes its own multithreaded-apartment COM context
    // and never shares raw interface pointers with other threads.
    unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            let _ = ready_tx.send(Err(format!("CoInitializeEx failed: {e}")));
            return;
        }

        let setup = setup_capture(target_sample_rate);
        let (audio_client, capture_client, input_channels, mut resampler) = match setup {
            Ok(v) => {
                let channels = v.2;
                let _ = ready_tx.send(Ok(channels));
                v
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                CoUninitialize();
                return;
            }
        };

        let mut resampled_buf: Vec<f32> = Vec::new();

        while !stop_flag.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(10));

            loop {
                let packet_size = match capture_client.GetNextPacketSize() {
                    Ok(size) => size,
                    Err(e) => {
                        tracing::error!(%e, "Loopback GetNextPacketSize failed");
                        break;
                    }
                };
                if packet_size == 0 {
                    break;
                }

                let mut buffer_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames_available: u32 = 0;
                let mut flags: u32 = 0;
                if let Err(e) = capture_client.GetBuffer(
                    &mut buffer_ptr,
                    &mut frames_available,
                    &mut flags,
                    None,
                    None,
                ) {
                    tracing::error!(%e, "Loopback GetBuffer failed");
                    break;
                }

                if frames_available > 0 {
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    let native_buf: Vec<f32>;
                    let native: &[f32] = if silent || buffer_ptr.is_null() {
                        native_buf = vec![0.0; frames_available as usize * input_channels];
                        &native_buf
                    } else {
                        let sample_count = frames_available as usize * input_channels;
                        std::slice::from_raw_parts(buffer_ptr as *const f32, sample_count)
                    };

                    match resampler.as_mut() {
                        Some(r) => {
                            resampled_buf.clear();
                            r.process(native, &mut resampled_buf);
                            producer.push_slice(&resampled_buf);
                        }
                        None => {
                            producer.push_slice(native);
                        }
                    }
                }

                if let Err(e) = capture_client.ReleaseBuffer(frames_available) {
                    tracing::error!(%e, "Loopback ReleaseBuffer failed");
                    break;
                }
            }
        }

        let _ = audio_client.Stop();
        CoUninitialize();
    }
}

/// Activates the default render device in loopback mode and starts capture.
/// Must be called on the thread that initialized COM for this capture.
unsafe fn setup_capture(
    target_sample_rate: u32,
) -> Result<(IAudioClient, IAudioCaptureClient, usize, Option<LinearResampler>), String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("No default output device for loopback capture: {e}"))?;
    let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;

    let mix_format = audio_client.GetMixFormat().map_err(|e| e.to_string())?;
    let format_result = describe_format(mix_format);
    let (input_channels, input_sample_rate) = match format_result {
        Ok(v) => v,
        Err(e) => {
            CoTaskMemFree(Some(mix_format as *mut _));
            return Err(e);
        }
    };

    // 1 second buffer (in 100ns units); shared-mode event-less capture just
    // needs enough headroom that our 10ms poll loop never misses a packet.
    let init_result = audio_client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
        10_000_000,
        0,
        mix_format,
        None,
    );
    CoTaskMemFree(Some(mix_format as *mut _));
    init_result.map_err(|e| format!("Failed to initialize loopback capture: {e}"))?;

    let capture_client: IAudioCaptureClient =
        audio_client.GetService().map_err(|e| e.to_string())?;
    audio_client.Start().map_err(|e| e.to_string())?;

    let resampler = if input_sample_rate != target_sample_rate {
        Some(LinearResampler::new(
            input_sample_rate,
            target_sample_rate,
            input_channels,
        ))
    } else {
        None
    };

    Ok((audio_client, capture_client, input_channels, resampler))
}

/// Only float32 mix formats are supported: WASAPI shared-mode's internal
/// engine format is virtually always IEEE float on modern Windows, and
/// reading a non-float buffer as float would silently produce loud noise
/// rather than a clear error, so anything else is rejected outright.
unsafe fn describe_format(fmt: *mut WAVEFORMATEX) -> Result<(usize, u32), String> {
    let base = &*fmt;
    let channels = base.nChannels as usize;
    let sample_rate = base.nSamplesPerSec;

    let is_float = match base.wFormatTag as u32 {
        WAVE_FORMAT_IEEE_FLOAT => true,
        WAVE_FORMAT_EXTENSIBLE => {
            let ext_ptr = fmt as *const WAVEFORMATEXTENSIBLE;
            let sub_format = std::ptr::addr_of!((*ext_ptr).SubFormat).read_unaligned();
            sub_format == SUBTYPE_IEEE_FLOAT
        }
        _ => false,
    };

    if !is_float {
        return Err(
            "System audio loopback requires a float32 mix format, which this output device's shared-mode config doesn't use"
                .to_string(),
        );
    }
    if channels == 0 {
        return Err("Loopback mix format reported zero channels".to_string());
    }

    Ok((channels, sample_rate))
}
