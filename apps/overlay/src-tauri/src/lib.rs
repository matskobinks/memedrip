//! MemeDrip Overlay — Tauri 2.0 Rust entry point
//! =================================================================
//! Creates a borderless, transparent, always-on-top, click-through
//! window that spans the entire screen.  The window is initialised
//! with `set_ignore_cursor_events(true)` so it never steals focus
//! or mouse input from the game/application running underneath.
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

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // -------------------------------------------------------
            // Window configuration: transparent, borderless, on-top,
            // click-through, no taskbar icon.
            // -------------------------------------------------------
            let overlay_window = app.get_webview_window("overlay").expect("overlay window not found");

            // Ensure the window is always on top of everything else.
            overlay_window.set_always_on_top(true).ok();

            // Make the window click-through so it never intercepts
            // mouse or keyboard events — critical for gaming.
            overlay_window.set_ignore_cursor_events(true).ok();

            // Skip the taskbar (window won't appear in the taskbar).
            overlay_window.set_skip_taskbar(true).ok();

            // On Windows, additionally disable focus so alt-tab and
            // game-mode fullscreen don't flicker.
            #[cfg(target_os = "windows")]
            {
                use tauri::webview::WebviewWindow;
                // set_focus(false) isn't a direct API; we achieve non-focus
                // via the window config `focus: false` in tauri.conf.json.
            }

            println!("[memedrip] Overlay window initialised — click-through active");

            Ok(())
        })
        .on_window_event(|window, event| {
            // Prevent the user from accidentally closing the overlay via
            // Alt+F4 — it should only close via the system tray or quit
            // command.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MemeDrip overlay");
}
