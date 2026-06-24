//! MemeDrip Overlay — Tauri 2.0 Rust entry point
//! =================================================================
//! Creates a borderless, transparent, always-on-top, click-through
//! window that spans the entire screen. The window is initialised
//! with `set_ignore_cursor_events(true)` so it never steals focus
//! or mouse input from the game/application running underneath.
//!
//! Upgrades:
//!   - System tray icon with Quit / Toggle Overlay menu (#11)
//!   - Fixed on_window_event signature (#9)
//!
//! Platform notes:
//!   - Windows:  transparent + decorations:false + always_on_top
//!               + set_ignore_cursor_events(true) is sufficient.
//!               The WS_EX_LAYERED | WS_EX_TRANSPARENT style is applied
//!               internally by Tauri/wry when ignore_cursor_events is true.
//!   - Linux:    Works on X11 (the default for most compositors).
//!               On Wayland, full transparency requires the compositor
//!               to support the zxdg_output protocol; most do.
//!   - macOS:    Not targeted for V1 but the same API works.

// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    Manager, WindowEvent,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // -------------------------------------------------------
            // Window configuration: transparent, borderless, on-top,
            // click-through, no taskbar icon.
            // -------------------------------------------------------
            let overlay_window = app.get_webview_window("overlay")
                .expect("overlay window not found");

            overlay_window.set_always_on_top(true).ok();
            overlay_window.set_ignore_cursor_events(true).ok();
            overlay_window.set_skip_taskbar(true).ok();

            println!("[memedrip] Overlay window initialised — click-through active");

            // -------------------------------------------------------
            // #11 — System tray with Quit / Toggle menu
            // -------------------------------------------------------
            let quit_i = MenuItem::with_id(app, "quit", "Quit MemeDrip", true, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "toggle", "Toggle Overlay", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;

            TrayIconBuilder::new()
                .id("memedrip-tray")
                .icon(app.default_window_icon().unwrap())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => {
                            println!("[memedrip] Quit requested via tray");
                            app.exit(0);
                        }
                        "toggle" => {
                            if let Some(window) = app.get_webview_window("overlay") {
                                let visible = window.is_visible().unwrap_or(true);
                                window.set_visible(!visible).ok();
                                println!("[memedrip] Overlay visibility toggled: {}", !visible);
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            println!("[memedrip] System tray initialised");

            Ok(())
        })
        // #9 — Fixed signature: in Tauri 2, on_window_event takes
        // |window: &Window, event: &WindowEvent|. We use the event
        // parameter only, and the window is available via the first arg
        // if needed. The unused window param is prefixed with _.
        .on_window_event(|_window, event| {
            // Prevent the user from accidentally closing the overlay via
            // Alt+F4 — it should only be closed via the system tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MemeDrip overlay");
}
