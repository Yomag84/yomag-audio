// Per-application audio: enumerating which running processes currently have
// an audio session (so the UI can offer them as routable sources - the same
// list Windows' own Volume Mixer shows), and capturing a single process's
// (plus its child processes') render output via the Windows 10 2004+
// "process loopback" activation API. This is the same building block OBS
// uses for its "Application Audio Capture" source.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use ringbuf::traits::Producer;
use ringbuf::HeapProd;
use serde::Serialize;
use windows::core::{implement, Interface, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateExpired,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume,
    MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

// mmreg.h constant; same reasoning as loopback.rs's copy - not exposed as a
// named item by this windows-crate version.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

/// Every capture built here is 48kHz stereo float32 regardless of what the
/// target app is actually producing - see `activate_process_loopback_client`
/// for why (process-loopback clients don't support `GetMixFormat`, so we
/// choose the format ourselves and pick the mixer's own internal rate to
/// skip a resampler entirely).
const CAPTURE_CHANNELS: usize = 2;

const APP_SOURCE_PREFIX: &str = "app:";

/// Parses a source id in the `app:<pid>:<process_name>` shape the frontend
/// builds when routing an application (see `AppAudioSession` below) into a
/// virtual device - encoding the pid directly rather than looking it up by
/// name later, since the pid is what the capture API actually targets and
/// process names aren't unique across running instances anyway. Returns the
/// target pid if `id` is one.
pub fn parse_app_source_id(id: &str) -> Option<u32> {
    let rest = id.strip_prefix(APP_SOURCE_PREFIX)?;
    let (pid_str, _name) = rest.split_once(':')?;
    pid_str.parse().ok()
}

#[derive(Debug, Clone, Serialize)]
pub struct AppAudioSession {
    pub pid: u32,
    pub process_name: String,
    pub display_name: String,
    pub volume: f32,
    pub muted: bool,
    /// Live peak level (0.0-1.0), read via `IAudioMeterInformation` on this
    /// same session - see `list_input_device_meters` in device_manager.rs
    /// for why that interface needs no capture stream of its own. 0.0 if
    /// the session doesn't expose a meter for some reason, which just
    /// shows as an empty meter rather than failing enumeration.
    pub level: f32,
}

/// Enumerates every process currently holding a non-expired audio session on
/// the default render device - i.e. every app that could be captured
/// individually via `ProcessLoopbackCapture`. Mirrors what Windows' own
/// Volume Mixer shows. Sessions are deduped by pid: an app can hold several
/// sessions (one per stream) but the process-loopback API only ever targets
/// a whole process (tree), so there's nothing finer-grained to expose.
pub fn list_app_sessions() -> Result<Vec<AppAudioSession>, String> {
    // Runs on a dedicated, freshly-spawned thread rather than whatever
    // thread Tauri handed this synchronous command on: Tauri's blocking-
    // command thread pool reuses OS threads across many different calls,
    // and some of those threads may already have COM initialized in a
    // different apartment mode by something else running on this same pool
    // (e.g. cpal's WASAPI backend puts a thread into STA the first time
    // `list_devices` runs on it) - CoInitializeEx then fails with
    // RPC_E_CHANGED_MODE instead of just no-opping. A brand new thread has
    // never had COM touched, so this sidesteps the conflict entirely - the
    // same reasoning `capture_thread_main` already relies on below.
    thread::spawn(|| unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            return Err(format!("CoInitializeEx failed: {e}"));
        }

        let result = list_app_sessions_inner();
        CoUninitialize();
        result
    })
    .join()
    .unwrap_or_else(|_| Err("Session enumeration thread panicked".to_string()))
}

unsafe fn list_app_sessions_inner() -> Result<Vec<AppAudioSession>, String> {
    let enumerator: IMMDeviceEnumerator =
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|e| format!("No default output device: {e}"))?;
    let session_manager: IAudioSessionManager2 =
        device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())?;
    let session_enumerator = session_manager.GetSessionEnumerator().map_err(|e| e.to_string())?;
    let count = session_enumerator.GetCount().map_err(|e| e.to_string())?;

    let current_pid = std::process::id();
    let mut by_pid: HashMap<u32, AppAudioSession> = HashMap::new();

    for i in 0..count {
        let Ok(control) = session_enumerator.GetSession(i) else { continue };
        let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };

        if control2.GetState().unwrap_or(AudioSessionStateExpired) == AudioSessionStateExpired {
            continue;
        }
        if control2.IsSystemSoundsSession() == windows::Win32::Foundation::S_OK {
            continue;
        }
        let Ok(pid) = control2.GetProcessId() else { continue };
        if pid == 0 || pid == current_pid || by_pid.contains_key(&pid) {
            continue;
        }

        let process_name = process_name_for_pid(pid).unwrap_or_else(|| format!("pid {pid}"));
        let display_name = control
            .GetDisplayName()
            .ok()
            .and_then(|p| take_pwstr_string(p))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| process_name.clone());

        let (volume, muted) = match control.cast::<ISimpleAudioVolume>() {
            Ok(v) => (
                v.GetMasterVolume().unwrap_or(1.0),
                v.GetMute().map(|b| b.as_bool()).unwrap_or(false),
            ),
            Err(_) => (1.0, false),
        };
        let level = control
            .cast::<IAudioMeterInformation>()
            .and_then(|m| m.GetPeakValue())
            .unwrap_or(0.0);

        by_pid.insert(
            pid,
            AppAudioSession {
                pid,
                process_name,
                display_name,
                volume,
                muted,
                level,
            },
        );
    }

    let mut sessions: Vec<AppAudioSession> = by_pid.into_values().collect();
    sessions.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(sessions)
}

/// Copies a COM-allocated string into a Rust `String` and frees the
/// original via `CoTaskMemFree`, as required by `IAudioSessionControl::
/// GetDisplayName`'s contract.
unsafe fn take_pwstr_string(p: PWSTR) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let s = p.to_string().ok();
    CoTaskMemFree(Some(p.as_ptr() as *mut _));
    s
}

fn process_name_for_pid(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let query_result =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        query_result.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/']).next().map(|s| s.to_string())
    }
}

/// Captures one process's (and, by default, its whole child-process tree's)
/// render output, resolved the same way as `LoopbackCapture` but scoped to a
/// single application instead of the whole default output device.
pub struct ProcessLoopbackCapture {
    stop_flag: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ProcessLoopbackCapture {
    /// Starts capturing `pid`'s audio, resampled to `target_sample_rate`
    /// (always stereo - see `CAPTURE_CHANNELS`). Returns the fixed channel
    /// count alongside the handle so the caller can register this as a
    /// source with the right channel layout, mirroring `LoopbackCapture::
    /// start`'s shape.
    pub fn start(pid: u32, target_sample_rate: u32, producer: HeapProd<f32>) -> Result<(Self, usize), String> {
        let stop_flag = Arc::new(AtomicBool::new(false));
        let thread_stop = stop_flag.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<usize, String>>();

        let thread = thread::spawn(move || {
            capture_thread_main(pid, target_sample_rate, producer, &thread_stop, &ready_tx);
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
                Err("Process loopback capture thread exited during startup".to_string())
            }
        }
    }
}

impl Drop for ProcessLoopbackCapture {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

fn capture_thread_main(
    pid: u32,
    target_sample_rate: u32,
    mut producer: HeapProd<f32>,
    stop_flag: &AtomicBool,
    ready_tx: &mpsc::Sender<Result<usize, String>>,
) {
    super::mmcss::promote_current_thread_to_pro_audio();

    // Safety: everything COM-related below runs on this single dedicated
    // thread, which initializes its own multithreaded-apartment COM context
    // and never shares raw interface pointers with other threads - same
    // approach as loopback.rs's capture thread.
    unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            let _ = ready_tx.send(Err(format!("CoInitializeEx failed: {e}")));
            return;
        }

        let setup = setup_capture(pid, target_sample_rate);
        let (audio_client, capture_client) = match setup {
            Ok(v) => {
                let _ = ready_tx.send(Ok(CAPTURE_CHANNELS));
                v
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                CoUninitialize();
                return;
            }
        };

        while !stop_flag.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(10));

            loop {
                let packet_size = match capture_client.GetNextPacketSize() {
                    Ok(size) => size,
                    Err(e) => {
                        tracing::error!(%e, "Process loopback GetNextPacketSize failed");
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
                    tracing::error!(%e, "Process loopback GetBuffer failed");
                    break;
                }

                if frames_available > 0 {
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    let native_buf: Vec<f32>;
                    let native: &[f32] = if silent || buffer_ptr.is_null() {
                        native_buf = vec![0.0; frames_available as usize * CAPTURE_CHANNELS];
                        &native_buf
                    } else {
                        let sample_count = frames_available as usize * CAPTURE_CHANNELS;
                        std::slice::from_raw_parts(buffer_ptr as *const f32, sample_count)
                    };
                    producer.push_slice(native);
                }

                if let Err(e) = capture_client.ReleaseBuffer(frames_available) {
                    tracing::error!(%e, "Process loopback ReleaseBuffer failed");
                    break;
                }
            }
        }

        let _ = audio_client.Stop();
        CoUninitialize();
    }
}

/// Activates a process-scoped loopback `IAudioClient` and initializes it
/// with a format we choose ourselves. Must be called on the thread that
/// initialized COM for this capture.
unsafe fn setup_capture(
    pid: u32,
    target_sample_rate: u32,
) -> Result<(IAudioClient, IAudioCaptureClient), String> {
    let audio_client = activate_process_loopback_client(pid)?;

    let channels = CAPTURE_CHANNELS as u16;
    let bits_per_sample: u16 = 32;
    let block_align = channels * (bits_per_sample / 8);
    let wave_format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: channels,
        nSamplesPerSec: target_sample_rate,
        nAvgBytesPerSec: target_sample_rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits_per_sample,
        cbSize: 0,
    };

    // 1 second buffer (in 100ns units), same headroom loopback.rs uses for
    // its 10ms poll loop.
    audio_client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            10_000_000,
            0,
            &wave_format,
            None,
        )
        .map_err(|e| format!("Failed to initialize process loopback capture: {e}"))?;

    let capture_client: IAudioCaptureClient = audio_client.GetService().map_err(|e| e.to_string())?;
    audio_client.Start().map_err(|e| e.to_string())?;

    Ok((audio_client, capture_client))
}

/// Runs the async `ActivateAudioInterfaceAsync` process-loopback activation
/// to completion and returns the resulting `IAudioClient`, blocking the
/// calling thread until the completion handler fires (or times out).
///
/// Unlike a normal device activation, `GetMixFormat` is not supported on a
/// process-loopback client - there is no real "device" to negotiate a
/// format with - so the caller (`setup_capture`) has to pick a format
/// itself rather than asking this client what it wants.
unsafe fn activate_process_loopback_client(pid: u32) -> Result<IAudioClient, String> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                // Includes child processes (e.g. a browser's renderer
                // subprocesses) under the same capture - the more useful
                // default for "capture this app's audio".
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    // Hand-built VT_BLOB PROPVARIANT pointing at `params` on the stack,
    // rather than going through `windows::core::PROPVARIANT`'s owning
    // wrapper: that wrapper's Drop calls PropVariantClear, which for
    // VT_BLOB would CoTaskMemFree pBlobData - fatal here since it points at
    // stack memory, not a CoTaskMemAlloc'd block. `params` outlives this
    // raw variant and the raw variant outlives the activation call, so no
    // cleanup is needed at all.
    let raw_propvariant = windows::core::imp::PROPVARIANT {
        Anonymous: windows::core::imp::PROPVARIANT_0 {
            Anonymous: windows::core::imp::PROPVARIANT_0_0 {
                vt: 65u16, // VT_BLOB
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: windows::core::imp::PROPVARIANT_0_0_0 {
                    blob: windows::core::imp::BLOB {
                        cbSize: core::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: &mut params as *mut AUDIOCLIENT_ACTIVATION_PARAMS as *mut u8,
                    },
                },
            },
        },
    };
    let propvariant_ptr =
        &raw_propvariant as *const windows::core::imp::PROPVARIANT as *const windows::core::PROPVARIANT;

    let (tx, rx) = mpsc::channel::<Result<IAudioClient, String>>();
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler {
        tx: Mutex::new(Some(tx)),
    }
    .into();

    let _async_op = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(propvariant_ptr),
        &handler,
    )
    .map_err(|e| format!("ActivateAudioInterfaceAsync failed: {e}"))?;

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result,
        Err(_) => Err("Timed out waiting for process loopback activation".to_string()),
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    tx: Mutex<Option<mpsc::Sender<Result<IAudioClient, String>>>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result = match activateoperation {
            Some(op) => unsafe {
                let mut hr = windows::core::HRESULT(0);
                let mut activated: Option<windows::core::IUnknown> = None;
                match op.GetActivateResult(&mut hr, &mut activated) {
                    Ok(()) if hr.is_ok() => match activated {
                        Some(unk) => unk.cast::<IAudioClient>().map_err(|e| e.to_string()),
                        None => Err("Activation succeeded but returned no interface".to_string()),
                    },
                    Ok(()) => Err(format!("Process loopback activation failed: {hr:?}")),
                    Err(e) => Err(format!("GetActivateResult failed: {e}")),
                }
            },
            None => Err("Activation completed without an async operation".to_string()),
        };

        if let Some(tx) = self.tx.lock().take() {
            let _ = tx.send(result);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_app_sessions_does_not_panic() {
        let sessions = list_app_sessions();
        println!("App audio sessions: {sessions:?}");
    }

    #[test]
    fn test_parse_app_source_id_roundtrips_pid() {
        assert_eq!(parse_app_source_id("app:1234:spotify.exe"), Some(1234));
        assert_eq!(parse_app_source_id("Microphone (Realtek)"), None);
    }

    /// Exercises the full `ActivateAudioInterfaceAsync` process-loopback
    /// activation against whatever process actually has an audio session
    /// running right now - the only way to catch a malformed
    /// AUDIOCLIENT_ACTIVATION_PARAMS/PROPVARIANT short of a live machine.
    /// Skips (rather than fails) when nothing is currently playing audio,
    /// since that's an environment fact this test can't control.
    #[test]
    fn test_process_loopback_capture_starts_against_a_live_session() {
        let sessions = match list_app_sessions() {
            Ok(s) => s,
            Err(e) => {
                println!("Skipping: could not list app sessions: {e}");
                return;
            }
        };
        let Some(session) = sessions.first() else {
            println!("Skipping: no application currently has an audio session");
            return;
        };

        let ring = ringbuf::HeapRb::<f32>::new(48_000 * 8);
        let (producer, _consumer) = ringbuf::traits::Split::split(ring);
        let started = ProcessLoopbackCapture::start(session.pid, 48_000, producer);
        match &started {
            Ok((_, channels)) => assert_eq!(*channels, CAPTURE_CHANNELS),
            Err(e) => panic!("process loopback activation failed for pid {}: {e}", session.pid),
        }
    }
}
