use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDeviceInfo {
    pub name: String,
    pub is_default: bool,
    pub is_input: bool,
    /// Native sample rate/channel count from the device's default shared-
    /// mode config, or None if that query failed - some devices enumerate
    /// fine but still reject a config query (or are synthetic, like the
    /// system-audio loopback pseudo-device, which has no native format of
    /// its own).
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
}

pub struct DeviceManager;

impl DeviceManager {
    pub fn new() -> Self {
        Self
    }

    pub fn list_output_devices(&self) -> Vec<AudioDeviceInfo> {
        let host = cpal::default_host();
        let default_name = host.default_output_device().and_then(|d| d.name().ok());

        host.output_devices()
            .map(|devices| {
                devices
                    .filter_map(|d| {
                        let name = d.name().ok()?;
                        let config = d.default_output_config().ok();
                        Some(AudioDeviceInfo {
                            is_default: Some(&name) == default_name.as_ref(),
                            sample_rate: config.as_ref().map(|c| c.sample_rate().0),
                            channels: config.as_ref().map(|c| c.channels()),
                            name,
                            is_input: false,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn list_input_devices(&self) -> Vec<AudioDeviceInfo> {
        let host = cpal::default_host();
        let default_name = host.default_input_device().and_then(|d| d.name().ok());

        host.input_devices()
            .map(|devices| {
                devices
                    .filter_map(|d| {
                        let name = d.name().ok()?;
                        let config = d.default_input_config().ok();
                        Some(AudioDeviceInfo {
                            is_default: Some(&name) == default_name.as_ref(),
                            sample_rate: config.as_ref().map(|c| c.sample_rate().0),
                            channels: config.as_ref().map(|c| c.channels()),
                            name,
                            is_input: true,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn get_output_device(&self, name: &str) -> Option<cpal::Device> {
        let host = cpal::default_host();
        host.output_devices()
            .ok()?
            .find(|d| d.name().ok().as_deref() == Some(name))
    }

    pub fn get_input_device(&self, name: &str) -> Option<cpal::Device> {
        let host = cpal::default_host();
        host.input_devices()
            .ok()?
            .find(|d| d.name().ok().as_deref() == Some(name))
    }
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Name substrings (case-insensitive) that indicate a device is NOT the
/// laptop/desktop's built-in mic or speaker - external hardware, a jack
/// shared with the internal codec but not itself the speaker/mic, or one of
/// this app's own virtual endpoints. cpal doesn't expose the WASAPI
/// endpoint's actual bus type (HDAUDIO vs USB vs BTHENUM), so this is a
/// best-effort name heuristic rather than a definitive check - it can
/// misfire on unusual OEM naming.
const EXTERNAL_HINTS: &[&str] = &[
    "usb",
    "bluetooth",
    "virtual",
    "cable",
    "voicemeeter",
    "yomagaudio",
    "stereo mix",
    "what u hear",
    "wave out mix",
    "spdif",
    "hdmi",
    "displayport",
    "line in",
    "headset",
    "headphone",
];

fn looks_external(name: &str) -> bool {
    let lower = name.to_lowercase();
    EXTERNAL_HINTS.iter().any(|hint| lower.contains(hint))
}

/// Best guess at the machine's built-in speaker from a device list already
/// filtered down to outputs (see `list_output_devices`) - see
/// `EXTERNAL_HINTS` for the caveats on this being name-based.
pub fn guess_internal_output(devices: &[AudioDeviceInfo]) -> Option<AudioDeviceInfo> {
    let candidates: Vec<&AudioDeviceInfo> =
        devices.iter().filter(|d| !d.is_input && !looks_external(&d.name)).collect();
    candidates
        .iter()
        .find(|d| d.name.to_lowercase().contains("speaker"))
        .or_else(|| candidates.iter().find(|d| d.is_default))
        .or_else(|| candidates.first())
        .map(|d| (*d).clone())
}

/// Best guess at the machine's built-in microphone from a device list
/// already filtered down to inputs (see `list_input_devices`) - see
/// `EXTERNAL_HINTS` for the caveats on this being name-based.
pub fn guess_internal_input(devices: &[AudioDeviceInfo]) -> Option<AudioDeviceInfo> {
    let candidates: Vec<&AudioDeviceInfo> =
        devices.iter().filter(|d| d.is_input && !looks_external(&d.name)).collect();
    candidates
        .iter()
        .find(|d| {
            let lower = d.name.to_lowercase();
            lower.contains("microphone") || lower.contains("mic array") || lower.contains("internal")
        })
        .or_else(|| candidates.iter().find(|d| d.is_default))
        .or_else(|| candidates.first())
        .map(|d| (*d).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_output_devices_does_not_panic() {
        let manager = DeviceManager::new();
        let devices = manager.list_output_devices();
        println!("Output devices: {:?}", devices);
    }

    #[test]
    fn test_list_input_devices_does_not_panic() {
        let manager = DeviceManager::new();
        let devices = manager.list_input_devices();
        println!("Input devices: {:?}", devices);
    }
}
