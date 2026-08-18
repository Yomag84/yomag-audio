// Dynamically instantiates additional device nodes bound to our already-
// installed YomagAudioDriver.sys via the Windows Software Device API. This
// is deliberately app-level (user-mode), NOT a driver change: driver.cpp's
// AddDevice already builds one independent topology+wave adapter instance
// per PDO it's handed, so every SwDeviceCreate call here that PnP matches
// against our INF's `Root\YomagAudioCable` hardware ID produces one more
// fully independent "YomagAudio Cable" speaker+mic pair Windows shows to
// every app on the system, without touching the kernel driver at all.
//
// SwDeviceCreate is asynchronous: it returns immediately and the actual
// result arrives later via callback, so this bridges that back to a normal
// blocking Result with a channel (mirroring the pattern used for WASAPI
// setup elsewhere in this codebase).
//
// Creating a device node that binds a kernel driver is a privileged
// operation - this reliably needs the process to be running elevated
// (Administrator). That's surfaced as a plain error message rather than
// anything automatic: silently elevating a background audio-routing app
// is not something to do without the user asking for it.
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Devices::Enumeration::Pnp::{
    SwDeviceClose, SwDeviceCreate, HSWDEVICE, SWDeviceCapabilitiesDriverRequired,
    SWDeviceCapabilitiesSilentInstall, SW_DEVICE_CREATE_INFO,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

const YOMAG_HARDWARE_ID: &str = "Root\\YomagAudioCable";

pub struct SystemEndpoint {
    pub instance_id: String,
    handle: HSWDEVICE,
}

// HSWDEVICE is a plain opaque handle (like HANDLE); safe to move between
// threads as long as access is serialized, which the registry holding
// these already guarantees via its Mutex.
unsafe impl Send for SystemEndpoint {}
unsafe impl Sync for SystemEndpoint {}

impl Drop for SystemEndpoint {
    fn drop(&mut self) {
        unsafe {
            SwDeviceClose(self.handle);
        }
    }
}

struct CreateCompletion {
    succeeded: bool,
    hresult_message: String,
    instance_id: Option<String>,
}

fn double_null_terminated(s: &str) -> Vec<u16> {
    let mut v: Vec<u16> = s.encode_utf16().collect();
    v.push(0);
    v.push(0);
    v
}

unsafe extern "system" fn create_callback(
    _hswdevice: HSWDEVICE,
    create_result: windows::core::HRESULT,
    pcontext: *const core::ffi::c_void,
    pszdeviceinstanceid: PCWSTR,
) {
    if pcontext.is_null() {
        return;
    }
    // Reclaims ownership of the one-shot sender boxed in create_system_endpoint.
    let sender = Box::from_raw(pcontext as *mut mpsc::Sender<CreateCompletion>);

    let instance_id = if !pszdeviceinstanceid.is_null() {
        pszdeviceinstanceid.to_string().ok()
    } else {
        None
    };

    let _ = sender.send(CreateCompletion {
        succeeded: create_result.is_ok(),
        hresult_message: format!("{create_result:?}"),
        instance_id,
    });
}

/// Creates one new "YomagAudio Cable" device node, appearing to the rest of
/// Windows as an independent speaker+mic pair once this returns
/// successfully. `unique_suffix` must be different for every call in this
/// process's lifetime (the caller's own device id is a good choice).
///
/// Runs on a dedicated, freshly-spawned thread rather than whatever thread
/// Tauri handed this synchronous command on: SwDeviceCreate activates a COM
/// server internally, and Tauri's blocking-command thread pool reuses OS
/// threads across many different calls, some of which may already have COM
/// initialized in a different apartment mode by something else running on
/// this same pool (e.g. cpal's WASAPI backend). Calling SwDeviceCreate
/// without a properly initialized apartment on the calling thread fails
/// with a class-registration-flavored HRESULT rather than a permissions
/// error, even though the message below also mentions Administrator - see
/// the identical reasoning in process_audio.rs's list_app_sessions.
pub fn create_system_endpoint(display_name: &str, unique_suffix: &str) -> Result<SystemEndpoint, String> {
    let display_name = display_name.to_string();
    let unique_suffix = unique_suffix.to_string();
    thread::spawn(move || unsafe {
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            return Err(format!("CoInitializeEx failed: {e}"));
        }
        let result = create_system_endpoint_on_com_thread(&display_name, &unique_suffix);
        CoUninitialize();
        result
    })
    .join()
    .unwrap_or_else(|_| Err("System device creation thread panicked".to_string()))
}

fn create_system_endpoint_on_com_thread(
    display_name: &str,
    unique_suffix: &str,
) -> Result<SystemEndpoint, String> {
    // pszInstanceId becomes the instance-ID segment of the device instance
    // ID PnP assigns; per Microsoft's docs it "cannot contain any '\'
    // characters" (https://learn.microsoft.com/windows-hardware/drivers/install/instance-ids),
    // so this can't reuse backslash as a separator the way a real device
    // instance path (Enumerator\DeviceID\InstanceID) does.
    let instance_id_string = format!("YomagAudioCable_{unique_suffix}");
    let instance_id = HSTRING::from(instance_id_string.as_str());
    let hardware_ids = double_null_terminated(YOMAG_HARDWARE_ID);
    let description = HSTRING::from(display_name);

    let create_info = SW_DEVICE_CREATE_INFO {
        cbSize: std::mem::size_of::<SW_DEVICE_CREATE_INFO>() as u32,
        pszInstanceId: PCWSTR::from_raw(instance_id.as_ptr()),
        pszzHardwareIds: PCWSTR::from_raw(hardware_ids.as_ptr()),
        pszzCompatibleIds: PCWSTR::null(),
        pContainerId: std::ptr::null(),
        CapabilityFlags: (SWDeviceCapabilitiesDriverRequired.0 | SWDeviceCapabilitiesSilentInstall.0) as u32,
        pszDeviceDescription: PCWSTR::from_raw(description.as_ptr()),
        pszDeviceLocation: PCWSTR::null(),
        pSecurityDescriptor: std::ptr::null(),
    };

    let (tx, rx) = mpsc::channel::<CreateCompletion>();
    let boxed_tx = Box::into_raw(Box::new(tx));

    let create_result = unsafe {
        SwDeviceCreate(
            windows::core::w!("YomagAudio"),
            // Unlike pProperties/pContext, pszParentDeviceInstance isn't
            // documented as optional - SwDeviceCreate's docs give this
            // literal string (ending in a literal backslash + "0" digit,
            // not a NUL terminator) as the value to pass when a software
            // device has no natural parent, not NULL:
            // https://learn.microsoft.com/windows/win32/api/swdevice/nf-swdevice-swdevicecreate
            windows::core::w!("HTREE\\ROOT\\0"),
            &create_info,
            None,
            Some(create_callback),
            Some(boxed_tx as *const core::ffi::c_void),
        )
    };

    let handle = match create_result {
        Ok(h) => h,
        Err(e) => {
            // The callback will never fire for a call that failed
            // synchronously, so reclaim the box here instead of leaking it.
            unsafe {
                drop(Box::from_raw(boxed_tx));
            }
            return Err(format!(
                "Failed to create system device (are you running as Administrator?): {e}"
            ));
        }
    };

    let completion = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(c) => c,
        Err(_) => {
            unsafe { SwDeviceClose(handle) };
            return Err("Timed out waiting for Windows to finish creating the device".to_string());
        }
    };

    if !completion.succeeded {
        unsafe { SwDeviceClose(handle) };
        return Err(format!(
            "Windows rejected the device creation request: {}",
            completion.hresult_message
        ));
    }

    Ok(SystemEndpoint {
        instance_id: completion.instance_id.unwrap_or(instance_id_string),
        handle,
    })
}
