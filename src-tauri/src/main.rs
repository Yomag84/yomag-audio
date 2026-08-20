#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod audio;
mod commands;
mod state;

use state::AppState;
use std::time::Duration;
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

fn main() {
    tracing_subscriber::fmt::init();

    // Without this, Windows has no app identity to group this process's
    // windows/taskbar entry/Task Manager row under, and a WebView2-hosted
    // app with no explicit AUMID gets bucketed under the generic
    // "WebView2 Manager" entry alongside every other unrelated WebView2
    // app on the system instead of showing up as its own "YomagAudio"
    // entry. Must be set before any window is created (see MSDN), so this
    // runs before Tauri's Builder ever touches a window. Matches the app
    // identifier in tauri.conf.json rather than inventing a separate name.
    if let Err(err) =
        unsafe { windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!("com.yomag.audio")) }
    {
        tracing::warn!(%err, "failed to set AppUserModelID - Task Manager/taskbar may group this under a generic WebView2 entry");
    }

    // Windows' default timer resolution is ~15.6ms, but the mixer thread,
    // loopback capture, and network publish threads all sleep for 5-10ms
    // between ticks. Without this, those sleeps silently round up to the
    // system granularity, so a "5ms tick" can actually fire every ~15ms -
    // starving downstream ring buffers (most audibly the monitor output
    // buffer) and producing exactly the choppy/glitchy audio this fixes.
    // Held for the process's whole lifetime; released automatically on exit.
    unsafe {
        windows::Win32::Media::timeBeginPeriod(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }

            let show_item = MenuItem::with_id(app, "show", "Show YomagAudio", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Main window menu bar (File / View / Device / Help). Every
            // item besides Quit just forwards to the frontend as a
            // "menu://" event and lets App.tsx decide what to do with it -
            // the native menu doesn't know which virtual device is
            // selected or which routing/profile state is current, only the
            // React state does.
            let new_device_item = MenuItemBuilder::with_id("menu-new-device", "New Virtual Device")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let save_profile_item = MenuItemBuilder::with_id("menu-save-profile", "Save Profile")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let load_profile_item = MenuItemBuilder::with_id("menu-load-profile", "Load Profile")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let settings_item = MenuItemBuilder::with_id("menu-settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let quit_item_menu = MenuItemBuilder::with_id("menu-quit", "Quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_device_item)
                .separator()
                .item(&save_profile_item)
                .item(&load_profile_item)
                .separator()
                .item(&settings_item)
                .separator()
                .item(&quit_item_menu)
                .build()?;

            let routing_item = MenuItemBuilder::with_id("menu-view-routing", "Routing").build(app)?;
            let applications_item =
                MenuItemBuilder::with_id("menu-view-applications", "Applications").build(app)?;
            let network_item = MenuItemBuilder::with_id("menu-view-network", "Network").build(app)?;
            let switch_to_menu = SubmenuBuilder::new(app, "Switch To")
                .item(&routing_item)
                .item(&applications_item)
                .item(&network_item)
                .build()?;
            let refresh_item = MenuItemBuilder::with_id("menu-refresh-devices", "Refresh Devices")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&switch_to_menu)
                .separator()
                .item(&refresh_item)
                .build()?;

            let delete_device_item =
                MenuItemBuilder::with_id("menu-delete-device", "Delete Selected Device").build(app)?;
            let device_menu = SubmenuBuilder::new(app, "Device").item(&delete_device_item).build()?;

            let documentation_item = MenuItemBuilder::with_id("menu-documentation", "Documentation")
                .accelerator("F1")
                .build(app)?;
            let report_issue_item =
                MenuItemBuilder::with_id("menu-report-issue", "Report an Issue…").build(app)?;
            let discord_item = MenuItemBuilder::with_id("menu-discord", "Join Discord").build(app)?;
            let sponsor_item =
                MenuItemBuilder::with_id("menu-sponsor", "Sponsor · Donate · Send a Gift…").build(app)?;
            let about_item = MenuItemBuilder::with_id("menu-about", "About YomagAudio").build(app)?;
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&documentation_item)
                .separator()
                .item(&report_issue_item)
                .item(&discord_item)
                .item(&sponsor_item)
                .separator()
                .item(&about_item)
                .build()?;

            let window_menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&view_menu)
                .item(&device_menu)
                .item(&help_menu)
                .build()?;
            app.set_menu(window_menu)?;

            let menu_app_handle = app.handle().clone();
            app.on_menu_event(move |_app, event| match event.id.as_ref() {
                "menu-quit" => menu_app_handle.exit(0),
                "menu-new-device" => {
                    let _ = menu_app_handle.emit("menu://new-device", ());
                }
                "menu-save-profile" => {
                    let _ = menu_app_handle.emit("menu://save-profile", ());
                }
                "menu-load-profile" => {
                    let _ = menu_app_handle.emit("menu://load-profile", ());
                }
                "menu-settings" => {
                    let _ = menu_app_handle.emit("menu://settings", ());
                }
                "menu-refresh-devices" => {
                    let _ = menu_app_handle.emit("menu://refresh-devices", ());
                }
                "menu-delete-device" => {
                    let _ = menu_app_handle.emit("menu://delete-device", ());
                }
                "menu-view-routing" => {
                    let _ = menu_app_handle.emit("menu://view-routing", ());
                }
                "menu-view-applications" => {
                    let _ = menu_app_handle.emit("menu://view-applications", ());
                }
                "menu-view-network" => {
                    let _ = menu_app_handle.emit("menu://view-network", ());
                }
                "menu-about" => {
                    let _ = menu_app_handle.emit("menu://about", ());
                }
                "menu-documentation" => {
                    let _ = menu_app_handle.emit("menu://documentation", ());
                }
                "menu-report-issue" => {
                    let _ = menu_app_handle.emit("menu://report-issue", ());
                }
                "menu-discord" => {
                    let _ = menu_app_handle.emit("menu://discord", ());
                }
                "menu-sponsor" => {
                    let _ = menu_app_handle.emit("menu://sponsor", ());
                }
                _ => {}
            });

            // One periodic emitter for all devices' meters, rather than a
            // thread per device - simpler lifetime, and the UI only needs
            // one event stream to subscribe to regardless of how many
            // virtual devices exist.
            let router = app.state::<AppState>().router.clone();
            let app_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(100));
                let levels = router.read().all_levels();
                let _ = app_handle.emit("audio://levels", levels);
            });

            // The main window starts hidden (see tauri.conf.json) so it
            // never flashes an unstyled/blank frame while the webview
            // loads; the splashscreen window - a genuinely separate
            // static HTML page, not the React bundle - paints instantly
            // in the meantime. A fixed delay rather than a frontend-ready
            // signal: this app has no network calls or slow work on
            // startup (device enumeration is local and fast), so there's
            // nothing worth the extra IPC round-trip to actually wait on.
            let splash_app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1200));
                if let Some(splash) = splash_app_handle.get_webview_window("splashscreen") {
                    let _ = splash.close();
                }
                if let Some(main) = splash_app_handle.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.set_focus();
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // The engine keeps mixing in the background; closing the window
            // should hide it to the tray rather than tear down the app and
            // interrupt whatever's currently being routed.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::audio::list_devices,
            commands::audio::list_audio_sessions,
            commands::audio::guess_internal_devices,
            commands::audio::get_engine_info,
            commands::audio::list_virtual_devices,
            commands::audio::create_virtual_device,
            commands::audio::delete_virtual_device,
            commands::audio::rename_virtual_device,
            commands::audio::set_device_enabled,
            commands::audio::set_device_output_channels,
            commands::audio::add_device_source,
            commands::audio::remove_device_source,
            commands::audio::add_virtual_device_source,
            commands::audio::list_device_meters,
            commands::audio::set_device_source_gain,
            commands::audio::set_device_source_muted,
            commands::audio::set_connection,
            commands::audio::remove_connection,
            commands::audio::add_monitor,
            commands::audio::remove_monitor,
            commands::audio::set_monitor_channel,
            commands::audio::clear_monitor_channel,
            commands::audio::set_monitor_exclusive,
            commands::audio::set_monitor_buffer_ms,
            commands::audio::set_monitor_delay_ms,
            commands::audio::set_monitor_eq,
            commands::audio::save_profile,
            commands::audio::load_profile,
            commands::audio::has_saved_profile,
            commands::audio::create_system_endpoint,
            commands::audio::remove_system_endpoint,
            commands::audio::list_system_endpoints,
            commands::audio::list_peers,
            commands::audio::set_device_published,
            commands::audio::add_network_source,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::list_recordings,
            commands::recording::rename_recording,
            commands::recording::delete_recording,
            commands::recording::get_recording_manifest,
            commands::recording::recording_file_path,
            commands::recording::load_recording_project,
            commands::recording::save_recording_project,
            commands::recording::render_mixdown,
            commands::recording::render_track_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
