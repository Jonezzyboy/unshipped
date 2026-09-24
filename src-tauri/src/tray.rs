use std::sync::atomic::{AtomicBool, Ordering};

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

static PANEL_OPEN: AtomicBool = AtomicBool::new(false);

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
    builder.build(app).map_err(|e| e.to_string())?;
    hold_highlight(app);
    Ok(())
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
        // Down, as a native menu opens: the flag has to be up before mouse-up
        // tries to clear the highlight.
        button_state: MouseButtonState::Down,
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
    let window = WebviewWindowBuilder::new(app, PANEL_ID, WebviewUrl::App("panel.html".into()))
        .title("unshipped")
        .inner_size(PANEL_WIDTH, 260.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    prevent_activation(&window);
    hide_on_focus_elsewhere(app);
    Ok(window)
}

/// Activating the app to focus the panel would raise the main window with it.
/// NSWindow ignores the non-activating panel style mask, so this sets the
/// private flag NSPanel applies for that mask.
#[cfg(target_os = "macos")]
fn prevent_activation(window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    unsafe {
        let ns_window = &*(ns_window as *const objc2::runtime::AnyObject);
        let _: () = objc2::msg_send![ns_window, _setPreventsActivation: true];
    }
}

#[cfg(not(target_os = "macos"))]
fn prevent_activation(_window: &WebviewWindow) {}

/// An app that never activates never resigns, so the panel's blur never
/// fires for clicks in, or switches to, other apps.
#[cfg(target_os = "macos")]
fn hide_on_focus_elsewhere(app: &AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{
        NSEvent, NSEventMask, NSWorkspace, NSWorkspaceDidActivateApplicationNotification,
    };

    let hide = {
        let app = app.clone();
        move || {
            if PANEL_OPEN.load(Ordering::Relaxed) {
                hide_panel(&app);
            }
        }
    };
    let on_click = hide.clone();
    let monitor = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown,
        &RcBlock::new(move |_| on_click()),
    );
    let observer = unsafe {
        NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &RcBlock::new(move |_| hide()),
            )
    };
    // The panel lives as long as the app, so these do too.
    std::mem::forget(monitor);
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
fn hide_on_focus_elsewhere(_app: &AppHandle) {}

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

/// tray-icon clears the highlight on every mouse-up, before the click reaches
/// us, which blinks the button off under an opening panel. The button's class
/// is swapped for one that ignores that while the panel is open.
#[cfg(target_os = "macos")]
fn hold_highlight(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let _ = tray.with_inner_tray_icon(|inner| {
        let Some(mtm) = objc2_foundation::MainThreadMarker::new() else {
            return;
        };
        let Some(button) = inner.ns_status_item().and_then(|item| item.button(mtm)) else {
            return;
        };
        let button: &objc2::runtime::AnyObject = &button;
        if let Some(class) = held_button_class(button.class()) {
            unsafe { objc2::runtime::AnyObject::set_class(button, class) };
        }
    });
}

#[cfg(target_os = "macos")]
fn held_button_class(
    button: &'static objc2::runtime::AnyClass,
) -> Option<&'static objc2::runtime::AnyClass> {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use std::sync::OnceLock;

    unsafe extern "C-unwind" fn highlight(this: &AnyObject, _: Sel, on: Bool) {
        let on = Bool::new(on.as_bool() || PANEL_OPEN.load(Ordering::Relaxed));
        let superclass = this.class().superclass().unwrap();
        let _: () = objc2::msg_send![super(this, superclass), highlight: on];
    }

    static CLASS: OnceLock<Option<&'static AnyClass>> = OnceLock::new();
    *CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(c"UnshippedStatusBarButton", button)?;
        unsafe {
            builder.add_method(
                objc2::sel!(highlight:),
                highlight as unsafe extern "C-unwind" fn(_, _, _),
            );
        }
        Some(builder.register())
    })
}

#[cfg(not(target_os = "macos"))]
fn hold_highlight(_app: &AppHandle) {}

pub fn hide_panel(app: &AppHandle) {
    PANEL_OPEN.store(false, Ordering::Relaxed);
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
    // Showing makes the panel key; focusing would activate the app as well.
    panel.show().map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    panel.set_focus().map_err(|e| e.to_string())?;
    PANEL_OPEN.store(true, Ordering::Relaxed);
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
