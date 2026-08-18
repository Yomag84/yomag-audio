use crate::audio::{
    AppAudioSession, AudioDeviceInfo, Connection, DeviceManager, EqBand, PeerSnapshot, Profile,
    VirtualDeviceSnapshot, SYSTEM_AUDIO_SOURCE_NAME,
};
use crate::state::AppState;
use tauri::Manager;

fn profile_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("profile.json"))
}

#[tauri::command]
pub fn list_devices() -> Result<Vec<AudioDeviceInfo>, String> {
    let manager = DeviceManager::new();
    let mut devices = manager.list_output_devices();
    devices.extend(manager.list_input_devices());
    // Synthetic pseudo-device: not a real cpal input, captured via WASAPI
    // loopback instead. VirtualDevice::add_source special-cases this name.
    devices.push(AudioDeviceInfo {
        name: SYSTEM_AUDIO_SOURCE_NAME.to_string(),
        is_default: false,
        is_input: true,
        sample_rate: None,
        channels: None,
    });
    Ok(devices)
}

#[tauri::command]
pub fn list_audio_sessions() -> Result<Vec<AppAudioSession>, String> {
    crate::audio::list_app_sessions()
}

#[derive(serde::Serialize)]
pub struct InternalDeviceGuess {
    pub microphone: Option<AudioDeviceInfo>,
    pub speaker: Option<AudioDeviceInfo>,
}

/// Best-effort name-based guess at the machine's built-in mic/speaker, for
/// the frontend's first-run "quick setup" - see device_manager's
/// `EXTERNAL_HINTS` for why this is a guess rather than a certainty.
#[tauri::command]
pub fn guess_internal_devices() -> InternalDeviceGuess {
    let manager = DeviceManager::new();
    InternalDeviceGuess {
        microphone: crate::audio::device_manager::guess_internal_input(&manager.list_input_devices()),
        speaker: crate::audio::device_manager::guess_internal_output(&manager.list_output_devices()),
    }
}

#[derive(serde::Serialize)]
pub struct EngineInfo {
    pub internal_sample_rate: u32,
    pub mix_tick_period_ms: u32,
}

#[tauri::command]
pub fn get_engine_info() -> EngineInfo {
    EngineInfo {
        internal_sample_rate: crate::audio::engine::INTERNAL_SAMPLE_RATE,
        mix_tick_period_ms: crate::audio::engine::MIX_TICK_PERIOD.as_millis() as u32,
    }
}

#[tauri::command]
pub fn list_virtual_devices(state: tauri::State<'_, AppState>) -> Result<Vec<VirtualDeviceSnapshot>, String> {
    Ok(state.router.read().snapshot_all())
}

#[tauri::command]
pub fn create_virtual_device(name: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state.router.write().create_device(name))
}

#[tauri::command]
pub fn delete_virtual_device(device_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.router.write().delete_device(&device_id);
    Ok(())
}

#[tauri::command]
pub fn rename_virtual_device(
    device_id: String,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().rename_device(&device_id, name)
}

#[tauri::command]
pub fn set_device_enabled(
    device_id: String,
    enabled: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().set_device_enabled(&device_id, enabled)
}

#[tauri::command]
pub fn set_device_output_channels(
    device_id: String,
    count: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().set_device_output_channels(&device_id, count)
}

#[tauri::command]
pub fn add_device_source(
    device_id: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .router
        .write()
        .with_device_mut(&device_id, |d| d.add_source(source_id))
}

#[tauri::command]
pub fn remove_device_source(
    device_id: String,
    source_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().with_device_mut(&device_id, |d| {
        d.remove_source(&source_id);
        Ok(())
    })
}

#[tauri::command]
pub fn set_device_source_gain(
    device_id: String,
    source_id: String,
    gain: f32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .router
        .write()
        .with_device_mut(&device_id, |d| d.set_source_gain(&source_id, gain))
}

#[tauri::command]
pub fn set_device_source_muted(
    device_id: String,
    source_id: String,
    muted: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .router
        .write()
        .with_device_mut(&device_id, |d| d.set_source_muted(&source_id, muted))
}

#[tauri::command]
pub fn set_connection(
    device_id: String,
    source_id: String,
    source_channel: usize,
    output_channel: usize,
    gain: f32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().with_device_mut(&device_id, |d| {
        d.set_connection(Connection {
            source_id,
            source_channel,
            output_channel,
            gain,
        });
        Ok(())
    })
}

#[tauri::command]
pub fn remove_connection(
    device_id: String,
    source_id: String,
    source_channel: usize,
    output_channel: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().with_device_mut(&device_id, |d| {
        d.remove_connection(&source_id, source_channel, output_channel);
        Ok(())
    })
}

#[tauri::command]
pub fn add_monitor(
    device_id: String,
    monitor_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .router
        .write()
        .with_device_mut(&device_id, |d| d.add_monitor(monitor_name))
}

#[tauri::command]
pub fn set_monitor_channel(
    device_id: String,
    monitor_name: String,
    monitor_channel: usize,
    output_channel: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().with_device_mut(&device_id, |d| {
        d.set_monitor_channel(&monitor_name, monitor_channel, output_channel)
    })
}

#[tauri::command]
pub fn clear_monitor_channel(
    device_id: String,
    monitor_name: String,
    monitor_channel: usize,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().with_device_mut(&device_id, |d| {
        d.clear_monitor_channel(&monitor_name, monitor_channel)
    })
}

#[tauri::command]
pub fn set_monitor_exclusive(
    device_id: String,
    monitor_name: String,
    exclusive: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .router
        .write()
        .set_monitor_exclusive(&device_id, &monitor_name, exclusive)
}

#[tauri::command]
pub fn set_monitor_buffer_ms(
    device_id: String,
    monitor_name: String,
    ms: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().set_monitor_buffer_ms(&device_id, &monitor_name, ms)
}

#[tauri::command]
pub fn set_monitor_delay_ms(
    device_id: String,
    monitor_name: String,
    ms: u32,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().set_monitor_delay_ms(&device_id, &monitor_name, ms)
}

#[tauri::command]
pub fn set_monitor_eq(
    device_id: String,
    monitor_name: String,
    bands: Vec<EqBand>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().set_monitor_eq(&device_id, &monitor_name, bands)
}

#[tauri::command]
pub fn remove_monitor(
    device_id: String,
    monitor_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().with_device_mut(&device_id, |d| {
        d.remove_monitor(&monitor_name);
        Ok(())
    })
}

#[tauri::command]
pub fn save_profile(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let profile = state.router.read().snapshot_profile();
    let path = profile_path(&app)?;
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_profile(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let path = profile_path(&app)?;
    let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let profile: Profile = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    state.router.write().apply_profile(profile)
}

#[tauri::command]
pub fn has_saved_profile(app: tauri::AppHandle) -> bool {
    profile_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn create_system_endpoint(name: String, state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.router.write().create_system_endpoint(name)
}

#[tauri::command]
pub fn remove_system_endpoint(instance_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.router.write().remove_system_endpoint(&instance_id);
    Ok(())
}

#[tauri::command]
pub fn list_system_endpoints(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.router.read().list_system_endpoints())
}

#[tauri::command]
pub fn list_peers(state: tauri::State<'_, AppState>) -> Result<Vec<PeerSnapshot>, String> {
    Ok(state.router.read().list_peers())
}

#[tauri::command]
pub fn set_device_published(
    device_id: String,
    published: bool,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.router.write().set_device_published(&device_id, published)
}

#[tauri::command]
pub fn add_network_source(
    device_id: String,
    peer_id: String,
    remote_device_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    state
        .router
        .write()
        .add_network_source(&device_id, peer_id, remote_device_id)
}
