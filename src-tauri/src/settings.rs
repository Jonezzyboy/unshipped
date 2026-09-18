use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use tauri::Manager;

/// Bumped when a stored value's meaning changes; `load` migrates older files.
const SCHEMA: u32 = 1;

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(default)]
    pub schema: u32,
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
    pub panel_sections: PanelSections,
    #[serde(default)]
    pub rules: Rules,
    #[serde(default)]
    pub repo_rules: BTreeMap<String, RepoRule>,
}

/// Which sections the menu bar panel shows.
#[derive(Serialize, Deserialize, Clone)]
pub struct PanelSections {
    #[serde(default = "on")]
    pub pinned: bool,
    #[serde(default = "on")]
    pub waiting: bool,
    #[serde(default = "on")]
    pub recent: bool,
}

impl Default for PanelSections {
    fn default() -> Self {
        Self { pinned: true, waiting: true, recent: true }
    }
}

/// When a repo with commits waiting is worth flagging. Every rule is opt-in:
/// nothing gets flagged or notified unless the user turned it on.
#[derive(Serialize, Deserialize, Clone)]
pub struct Rules {
    #[serde(default)]
    pub commits_enabled: bool,
    #[serde(default = "default_commits")]
    pub commits: u64,
    #[serde(default)]
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
            commits_enabled: false,
            commits: default_commits(),
            days_enabled: false,
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
            schema: SCHEMA,
            argo_url: String::new(),
            argo_insecure: false,
            argo_iap_client_id: String::new(),
            argo_iap_service_account: String::new(),
            theme: default_theme(),
            menu_bar: false,
            panel_sections: PanelSections::default(),
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
    let mut s: Settings = path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    // Rules used to default on, so a pre-schema file's enables were written by
    // the default, not the user — reset them once to make the rules opt-in.
    if s.schema < 1 {
        s.rules.commits_enabled = false;
        s.rules.days_enabled = false;
    }
    s
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    // The frontend payload doesn't carry the schema; stamp it here so a saved
    // file is never re-migrated.
    let mut settings = settings.clone();
    settings.schema = SCHEMA;
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path(app)?, raw).map_err(|e| e.to_string())
}
