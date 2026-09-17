use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    #[serde(default)]
    pub menu_bar: bool,
    #[serde(default)]
    pub rules: Rules,
    #[serde(default)]
    pub repo_rules: BTreeMap<String, RepoRule>,
}

/// When a repo with commits waiting is worth flagging.
#[derive(Serialize, Deserialize, Clone)]
pub struct Rules {
    #[serde(default = "on")]
    pub commits_enabled: bool,
    #[serde(default = "default_commits")]
    pub commits: u64,
    #[serde(default = "on")]
    pub days_enabled: bool,
    #[serde(default = "default_days")]
    pub days: u64,
    #[serde(default)]
    pub breaking: bool,
    #[serde(default)]
    pub pinned_only: bool,
    #[serde(default)]
    pub notify: bool,
}

/// Per-repo overrides. An unset threshold falls back to the global rule.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct RepoRule {
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub commits: Option<u64>,
    #[serde(default)]
    pub days: Option<u64>,
}

fn on() -> bool {
    true
}

fn default_commits() -> u64 {
    10
}

fn default_days() -> u64 {
    14
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            commits_enabled: true,
            commits: default_commits(),
            days_enabled: true,
            days: default_days(),
            breaking: false,
            pinned_only: false,
            notify: false,
        }
    }
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
            menu_bar: false,
            rules: Rules::default(),
            repo_rules: BTreeMap::new(),
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
