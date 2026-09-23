use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};

const TRAY_ID: &str = "menu-bar";
pub const PANEL_ID: &str = "panel";
/// Flat black plus alpha: macOS tints a template image to match the menu bar,
/// which the app icon's own colours cannot do.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

const PANEL_WIDTH: f64 = 360.0;
const PANEL_GAP: f64 = 6.0;

pub fn apply(app: &AppHandle, enabled: bool, title: String) -> Result<(), String> {
    if !enabled {
        hide_panel(app);
        app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        return tray.set_title(Some(title)).map_err(|e| e.to_string());
    }

    // The list lives in the panel now; the menu is the right-click fallback,
    // so it never changes and is built once.
    let menu = right_click_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .title(title)
        .tooltip("Unshipped")
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_event);
    match tauri::image::Image::from_bytes(TRAY_ICON) {
        Ok(icon) => builder = builder.icon(icon),
        Err(_) => {
            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }
    builder.build(app).map(|_| ()).map_err(|e| e.to_string())
}

fn right_click_menu(app: &AppHandle) -> Result<Menu<Wry>, String> {
    let open = MenuItem::with_id(app, "open", "Open unshipped", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit unshipped")).map_err(|e| e.to_string())?;
    Menu::with_items(app, &[&open, &refresh, &sep, &quit]).map_err(|e| e.to_string())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_main(app),
        "refresh" => {
            let _ = app.emit("tray-refresh", ());
        }
        _ => {}
    }
}

fn on_tray_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        rect,
        ..
    } = event
    {
        let app = tray.app_handle();
        match app.get_webview_window(PANEL_ID) {
            Some(panel) if panel.is_visible().unwrap_or(false) => hide_panel(app),
            _ => {
                let _ = show_panel(app, rect);
            }
        }
    }
}

fn panel(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PANEL_ID) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(app, PANEL_ID, WebviewUrl::App("panel.html".into()))
        .title("unshipped")
        .inner_size(PANEL_WIDTH, 260.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}

/// macOS only highlights the status item while it owns a native menu, so a
/// panel of our own has to light the button up itself.
#[cfg(target_os = "macos")]
fn highlight(app: &AppHandle, on: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let _ = tray.with_inner_tray_icon(move |inner| {
        let Some(mtm) = objc2_foundation::MainThreadMarker::new() else {
            return;
        };
        let Some(button) = inner.ns_status_item().and_then(|item| item.button(mtm)) else {
            return;
        };
        unsafe {
            let _: () = objc2::msg_send![&*button, setHighlighted: on];
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn highlight(_app: &AppHandle, _on: bool) {}

pub fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL_ID) {
        let _ = panel.hide();
    }
    highlight(app, false);
}

/// The monitor whose bounds contain the clicked tray icon. The panel's own
/// monitor is wherever it was last shown, which is the wrong one to position
/// against when the click came from another display.
fn monitor_containing(app: &AppHandle, rect: &tauri::Rect) -> Option<Monitor> {
    app.available_monitors().ok()?.into_iter().find(|m| {
        let s = m.scale_factor();
        let p = rect.position.to_logical::<f64>(s);
        let pos = m.position().to_logical::<f64>(s);
        let size = m.size().to_logical::<f64>(s);
        p.x >= pos.x && p.x < pos.x + size.width && p.y >= pos.y && p.y < pos.y + size.height
    })
}

fn show_panel(app: &AppHandle, rect: tauri::Rect) -> Result<(), String> {
    let panel = panel(app)?;
    let monitor = monitor_containing(app, &rect)
        .or_else(|| panel.current_monitor().ok().flatten());

    // Everything in logical units: physical spaces disagree between monitors
    // with different scales, which is what dragged the panel to the wrong one.
    let scale = monitor.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);
    let icon = rect.position.to_logical::<f64>(scale);
    let icon_size = rect.size.to_logical::<f64>(scale);
    let panel_scale = panel.scale_factor().unwrap_or(scale);
    let size = panel
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(panel_scale);

    let mut x = icon.x + icon_size.width / 2.0 - size.width / 2.0;
    // Keep it on screen when the item sits at the right end of the bar.
    if let Some(m) = &monitor {
        let pos = m.position().to_logical::<f64>(m.scale_factor());
        let width = m.size().to_logical::<f64>(m.scale_factor()).width;
        x = x.min(pos.x + width - size.width - 8.0);
        x = x.max(pos.x + 8.0);
    }
    let y = icon.y + icon_size.height + PANEL_GAP;

    panel
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    panel.show().map_err(|e| e.to_string())?;
    panel.set_focus().map_err(|e| e.to_string())?;
    highlight(app, true);
    Ok(())
}

/// The panel reports what its content actually needs; the window has no
/// decorations to size itself against.
pub fn resize(app: &AppHandle, height: f64) -> Result<(), String> {
    let Some(panel) = app.get_webview_window(PANEL_ID) else {
        return Ok(());
    };
    panel
        .set_size(LogicalSize::new(PANEL_WIDTH, height.clamp(120.0, 620.0)))
        .map_err(|e| e.to_string())
}

pub fn show_main(app: &AppHandle) {
    hide_panel(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
