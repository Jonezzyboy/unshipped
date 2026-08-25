use serde::{Deserialize, Serialize};
use std::fs;
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(default)]
    pub argo_url: String,
    #[serde(default)]
    pub argo_insecure: bool,
    #[serde(default)]
    pub argo_iap_client_id: String,
    #[serde(default)]
    pub argo_iap_service_account: String,
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "harbor".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            argo_url: String::new(),
            argo_insecure: false,
            argo_iap_client_id: String::new(),
            argo_iap_service_account: String::new(),
            theme: default_theme(),
        }
    }
}

fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path(app)?, raw).map_err(|e| e.to_string())
}
