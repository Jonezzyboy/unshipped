mod argo;
mod auth;
mod demo;
mod github;
mod iap;
mod settings;
mod store;
mod tray;
mod version;

use auth::token;
use serde::Serialize;
use tauri::{Emitter, Manager};

const ARGO_TOKEN_KEY: &str = "argo_token";

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, new: settings::Settings) -> Result<(), String> {
    settings::save(&app, &new)
}

fn argo_conn(app: &tauri::AppHandle) -> Result<argo::Conn, String> {
    let s = settings::load(app);
    if s.argo_url.trim().is_empty() {
        return Err("Set the Argo CD server URL first.".into());
    }
    let iap_token = match s.argo_iap_client_id.trim() {
        "" => None,
        client_id => Some(iap::identity_token(client_id, s.argo_iap_service_account.trim())?),
    };
    Ok(argo::Conn { url: s.argo_url.trim().into(), insecure: s.argo_insecure, iap_token })
}

fn argo_configured(app: &tauri::AppHandle) -> bool {
    !settings::load(app).argo_url.trim().is_empty()
}

#[tauri::command]
async fn argo_login(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<argo::Check, String> {
    let conn = argo_conn(&app)?;
    let token = argo::login(&conn, &username, &password).await?;
    store::set(ARGO_TOKEN_KEY, &token)?;
    Ok(argo::check(&conn, Some(&token)).await)
}

#[tauri::command]
async fn argo_set_token(app: tauri::AppHandle, token: String) -> Result<argo::Check, String> {
    let conn = argo_conn(&app)?;
    let token = token.trim();
    let check = argo::check(&conn, Some(token)).await;
    if check.logged_in {
        store::set(ARGO_TOKEN_KEY, token)?;
    }
    Ok(check)
}

#[tauri::command]
async fn argo_check(app: tauri::AppHandle) -> argo::Check {
    if demo::enabled() {
        return demo::argo_check();
    }
    if !argo_configured(&app) {
        return argo::Check::default();
    }
    match argo_conn(&app) {
        Ok(conn) => argo::check(&conn, store::get(ARGO_TOKEN_KEY).as_deref()).await,
        Err(e) => argo::Check { configured: true, error: Some(e), ..Default::default() },
    }
}

#[tauri::command]
fn argo_disconnect() -> Result<(), String> {
    store::delete(ARGO_TOKEN_KEY)
}

/// The ledger needs to tell "Argo isn't set up" (hide the column) apart from
/// "Argo is set up but answering badly" (say so) — both otherwise look like an
/// empty Deployed column.
#[derive(Serialize)]
struct Deployments {
    configured: bool,
    apps: Vec<argo::App>,
    error: Option<String>,
}

#[tauri::command]
async fn argo_deployments(app: tauri::AppHandle) -> Deployments {
    if demo::enabled() {
        return Deployments { configured: true, apps: demo::argo_apps(), error: None };
    }
    if !argo_configured(&app) {
        return Deployments { configured: false, apps: Vec::new(), error: None };
    }
    let result = match argo_conn(&app) {
        Ok(conn) => argo::apps(&conn, store::get(ARGO_TOKEN_KEY).as_deref()).await,
        Err(e) => Err(e),
    };
    match result {
        Ok(apps) => Deployments { configured: true, apps, error: None },
        Err(e) => Deployments { configured: true, apps: Vec::new(), error: Some(e) },
    }
}

#[tauri::command]
fn argo_repo_annotation() -> &'static str {
    argo::REPO_ANNOTATION
}

/// The ledger owns the counts, so it hands the menu bar its title.
#[tauri::command]
fn set_menu_bar(app: tauri::AppHandle, enabled: bool, title: String) -> Result<(), String> {
    tray::apply(&app, enabled, title)
}

#[tauri::command]
fn resize_panel(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    tray::resize(&app, height)
}

#[tauri::command]
fn focus_main(app: tauri::AppHandle) {
    tray::show_main(&app);
}

/// The panel asks the ledger to do the work: emitting from the panel window
/// would need an event permission it does not have, and the ordering here is
/// guaranteed — the window is up before the dialog is asked for.
#[tauri::command]
fn panel_release(app: tauri::AppHandle, repo: String) {
    tray::show_main(&app);
    let _ = app.emit("tray-release", repo);
}

#[tauri::command]
fn panel_refresh(app: tauri::AppHandle) {
    let _ = app.emit("tray-refresh", ());
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[derive(Serialize)]
struct AuthStatus {
    user: Option<github::User>,
    error: Option<String>,
}

#[tauri::command]
fn is_demo() -> bool {
    demo::enabled()
}

#[tauri::command]
async fn auth_status() -> AuthStatus {
    if demo::enabled() {
        return AuthStatus { user: Some(demo::user()), error: None };
    }
    auth::clear_cache();
    let token = match token() {
        Ok(t) => t,
        Err(e) => return AuthStatus { user: None, error: Some(e) },
    };
    match github::current_user(&token).await {
        Ok(user) => AuthStatus { user: Some(user), error: None },
        Err(e) => AuthStatus { user: None, error: Some(e) },
    }
}

#[tauri::command]
async fn list_repos() -> Result<Vec<github::Repo>, String> {
    if demo::enabled() {
        return Ok(demo::repos());
    }
    github::list_repos(&token()?).await
}

#[derive(Serialize)]
struct RepoStatus {
    latest_tag: Option<String>,
    release_url: Option<String>,
    published_at: Option<String>,
    ahead_by: u64,
    breaking: bool,
}

#[tauri::command]
async fn repo_status(
    owner: String,
    repo: String,
    default_branch: String,
) -> Result<RepoStatus, String> {
    if demo::enabled() {
        let (tag, published, ahead) = demo::status(&format!("{owner}/{repo}"));
        return Ok(RepoStatus {
            latest_tag: tag.map(String::from),
            release_url: tag.map(|t| format!("https://github.com/{owner}/{repo}/releases/tag/{t}")),
            published_at: published.map(String::from),
            ahead_by: ahead,
            breaking: version::has_breaking(&demo::commits(&format!("{owner}/{repo}"))),
        });
    }
    let token = token()?;
    match github::latest_release(&token, &owner, &repo).await? {
        Some(release) => {
            let cmp =
                github::compare(&token, &owner, &repo, &release.tag_name, &default_branch).await?;
            // The compare call already carries the messages; the flag is free.
            let messages: Vec<String> = cmp.commits.into_iter().map(|c| c.commit.message).collect();
            Ok(RepoStatus {
                latest_tag: Some(release.tag_name),
                release_url: Some(release.html_url),
                published_at: release.published_at,
                ahead_by: cmp.ahead_by,
                breaking: version::has_breaking(&messages),
            })
        }
        None => Ok(RepoStatus {
            latest_tag: None,
            release_url: None,
            published_at: None,
            ahead_by: github::branch_commit_count(&token, &owner, &repo, &default_branch).await?,
            breaking: false,
        }),
    }
}

#[derive(Serialize)]
struct ReleasePrep {
    current_tag: Option<String>,
    suggestion: version::Suggestion,
    commit_count: u64,
    commits: Vec<String>,
}

#[tauri::command]
async fn prepare_release(
    owner: String,
    repo: String,
    default_branch: String,
) -> Result<ReleasePrep, String> {
    if demo::enabled() {
        let full = format!("{owner}/{repo}");
        let (tag, _, ahead) = demo::status(&full);
        let commits = demo::commits(&full);
        let suggestion = version::suggest(tag, &commits);
        return Ok(ReleasePrep {
            current_tag: tag.map(String::from),
            suggestion,
            commit_count: ahead,
            commits,
        });
    }
    let token = token()?;
    let release = github::latest_release(&token, &owner, &repo).await?;
    let current_tag = release.map(|r| r.tag_name);

    let (messages, count) = match &current_tag {
        Some(tag) => {
            let cmp = github::compare(&token, &owner, &repo, tag, &default_branch).await?;
            let msgs: Vec<String> = cmp.commits.into_iter().map(|c| c.commit.message).collect();
            (msgs, cmp.ahead_by)
        }
        None => {
            let count =
                github::branch_commit_count(&token, &owner, &repo, &default_branch).await?;
            (Vec::new(), count)
        }
    };

    let suggestion = version::suggest(current_tag.as_deref(), &messages);
    let first_lines = messages
        .iter()
        .map(|m| m.lines().next().unwrap_or("").to_string())
        .collect();

    Ok(ReleasePrep {
        current_tag,
        suggestion,
        commit_count: count,
        commits: first_lines,
    })
}

#[derive(Serialize)]
struct Notes {
    name: String,
    body: String,
}

#[tauri::command]
async fn generate_notes(
    owner: String,
    repo: String,
    tag_name: String,
    default_branch: String,
    previous_tag: Option<String>,
) -> Result<Notes, String> {
    if demo::enabled() {
        let (name, body) = demo::notes(&format!("{owner}/{repo}"), &tag_name);
        return Ok(Notes { name, body });
    }
    let notes = github::generate_notes(
        &token()?,
        &owner,
        &repo,
        &tag_name,
        &default_branch,
        previous_tag.as_deref(),
    )
    .await?;
    Ok(Notes { name: notes.name, body: notes.body })
}

#[tauri::command]
async fn create_release(
    owner: String,
    repo: String,
    tag_name: String,
    default_branch: String,
    name: String,
    body: String,
) -> Result<String, String> {
    if demo::enabled() {
        let _ = (&name, &body);
        return Ok(format!("https://github.com/{owner}/{repo}/releases/tag/{tag_name}"));
    }
    let created = github::create_release(
        &token()?,
        &owner,
        &repo,
        &tag_name,
        &default_branch,
        &name,
        &body,
    )
    .await?;
    Ok(created.html_url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            is_demo,
            auth_status,
            get_settings,
            save_settings,
            argo_login,
            argo_set_token,
            argo_check,
            argo_disconnect,
            argo_deployments,
            argo_repo_annotation,
            list_repos,
            repo_status,
            prepare_release,
            generate_notes,
            create_release,
            set_menu_bar,
            resize_panel,
            focus_main,
            panel_release,
            panel_refresh,
            quit_app,
        ])
        .setup(|app| {
            // The ledger fills in the counts a moment later; the item exists from
            // launch so the app is reachable even if the window never opens.
            if settings::load(app.handle()).menu_bar {
                let _ = tray::apply(app.handle(), true, String::from("…"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // The panel is a menu: it goes away the moment it is not the focus.
            if window.label() == tray::PANEL_ID {
                if let tauri::WindowEvent::Focused(false) = event {
                    tray::hide_panel(&window.app_handle().clone());
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // With a menu bar item there is somewhere to come back from;
                // without one, closing the window has to mean quit.
                if settings::load(window.app_handle()).menu_bar {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
