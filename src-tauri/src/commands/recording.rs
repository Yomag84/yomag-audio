use crate::audio::recording::{self, RecordingManifest, RecordingProject, RecordingSummary};
use crate::state::AppState;
use tauri::Manager;

/// Base directory every recording session lives under - a sibling of
/// `profile.json`'s config dir, but under the app's data dir since
/// recordings are user content (WAV files, potentially large) rather than
/// small app configuration.
fn recordings_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub fn start_recording(
    app: tauri::AppHandle,
    device_id: String,
    name: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let base_dir = recordings_dir(&app)?;
    state
        .router
        .write()
        .with_device_mut(&device_id, move |d| d.start_recording(base_dir, name))
}

#[tauri::command]
pub fn stop_recording(device_id: String, state: tauri::State<'_, AppState>) -> Result<RecordingSummary, String> {
    state.router.write().with_device_mut(&device_id, |d| d.stop_recording())
}

#[tauri::command]
pub fn list_recordings(app: tauri::AppHandle) -> Result<Vec<RecordingSummary>, String> {
    recording::list_sessions(&recordings_dir(&app)?)
}

#[tauri::command]
pub fn rename_recording(app: tauri::AppHandle, session_id: String, new_name: String) -> Result<(), String> {
    recording::rename_session(&recordings_dir(&app)?, &session_id, new_name)
}

#[tauri::command]
pub fn delete_recording(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    recording::delete_session(&recordings_dir(&app)?, &session_id)
}

#[tauri::command]
pub fn get_recording_manifest(app: tauri::AppHandle, session_id: String) -> Result<RecordingManifest, String> {
    recording::load_manifest(&recordings_dir(&app)?, &session_id)
}

#[tauri::command]
pub fn recording_file_path(
    app: tauri::AppHandle,
    session_id: String,
    relative_file: String,
) -> Result<String, String> {
    recording::resolve_file_path(&recordings_dir(&app)?, &session_id, &relative_file)
}

#[tauri::command]
pub fn load_recording_project(app: tauri::AppHandle, session_id: String) -> Result<RecordingProject, String> {
    recording::load_project(&recordings_dir(&app)?, &session_id)
}

#[tauri::command]
pub fn save_recording_project(
    app: tauri::AppHandle,
    session_id: String,
    project: RecordingProject,
) -> Result<(), String> {
    recording::save_project(&recordings_dir(&app)?, &session_id, &project)
}

#[tauri::command]
pub fn render_mixdown(
    app: tauri::AppHandle,
    session_id: String,
    project: RecordingProject,
    output_name: String,
) -> Result<String, String> {
    recording::render_mixdown(&recordings_dir(&app)?, &session_id, &project, &output_name)
}
