use serde::Deserialize;
use tauri::menu::{IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

const TRAY_ID: &str = "menu-bar";
/// Flat black plus alpha: macOS tints a template image to match the menu bar,
/// which the app icon's own colours cannot do.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");
const REPO_PREFIX: &str = "repo:";

#[derive(Deserialize)]
pub struct Entry {
    pub full_name: String,
    pub waiting: u64,
}

pub fn apply(
    app: &AppHandle,
    enabled: bool,
    title: String,
    summary: String,
    entries: Vec<Entry>,
) -> Result<(), String> {
    if !enabled {
        app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }

    let menu = build_menu(app, &summary, &entries)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        return tray.set_title(Some(title)).map_err(|e| e.to_string());
    }

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .title(title)
        .tooltip("unshipped")
        .on_menu_event(on_menu_event);
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

fn build_menu(app: &AppHandle, summary: &str, entries: &[Entry]) -> Result<Menu<Wry>, String> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = Vec::new();
    let mut push = |item: Box<dyn IsMenuItem<Wry>>| items.push(item);

    push(Box::new(
        MenuItem::with_id(app, "summary", summary, false, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));
    push(Box::new(
        PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
    ));

    for entry in entries {
        let label = format!("{} — {} waiting", entry.full_name, entry.waiting);
        push(Box::new(
            MenuItem::with_id(
                app,
                format!("{REPO_PREFIX}{}", entry.full_name),
                label,
                true,
                None::<&str>,
            )
            .map_err(|e| e.to_string())?,
        ));
    }
    if !entries.is_empty() {
        push(Box::new(
            PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
        ));
    }

    push(Box::new(
        MenuItem::with_id(app, "open", "Open unshipped", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));
    push(Box::new(
        MenuItem::with_id(app, "refresh", "Refresh now", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    ));
    push(Box::new(
        PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
    ));
    push(Box::new(
        PredefinedMenuItem::quit(app, Some("Quit unshipped")).map_err(|e| e.to_string())?,
    ));

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    Menu::with_items(app, &refs).map_err(|e| e.to_string())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_window(app),
        "refresh" => {
            let _ = app.emit("tray-refresh", ());
        }
        id => {
            if let Some(repo) = id.strip_prefix(REPO_PREFIX) {
                show_window(app);
                let _ = app.emit("tray-release", repo);
            }
        }
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
