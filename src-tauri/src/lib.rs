mod argo;
mod auth;
mod demo;
mod github;
mod iap;
mod settings;
mod store;
mod version;

use auth::token;
use serde::Serialize;

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

#[tauri::command]
async fn argo_login(
    app: tauri::AppHandle,
    username: String,
    password: String,
) -> Result<argo::ArgoStatus, String> {
    let conn = argo_conn(&app)?;
    let token = argo::login(&conn, &username, &password).await?;
    let status = argo::status(&conn, Some(&token)).await?;
    store::set(ARGO_TOKEN_KEY, &token)?;
    Ok(status)
}

#[tauri::command]
async fn argo_set_token(app: tauri::AppHandle, token: String) -> Result<argo::ArgoStatus, String> {
    let conn = argo_conn(&app)?;
    let status = argo::status(&conn, Some(token.trim())).await?;
    store::set(ARGO_TOKEN_KEY, token.trim())?;
    Ok(status)
}

#[tauri::command]
async fn argo_status(app: tauri::AppHandle) -> Result<Option<argo::ArgoStatus>, String> {
    if demo::enabled() {
        return Ok(Some(argo::ArgoStatus {
            username: Some("demo".into()),
            applications: Some(demo::argo_apps().len() as u64),
        }));
    }
    let s = settings::load(&app);
    if s.argo_url.trim().is_empty() {
        return Ok(None);
    }
    let token = store::get(ARGO_TOKEN_KEY);
    // With IAP in front, Argo may trust the proxy identity and need no token of its own.
    if token.is_none() && s.argo_iap_client_id.trim().is_empty() {
        return Ok(None);
    }
    let conn = argo_conn(&app)?;
    argo::status(&conn, token.as_deref()).await.map(Some)
}

#[tauri::command]
fn argo_disconnect() -> Result<(), String> {
    store::delete(ARGO_TOKEN_KEY)
}

#[tauri::command]
async fn argo_apps(app: tauri::AppHandle) -> Result<Vec<argo::App>, String> {
    if demo::enabled() {
        return Ok(demo::argo_apps());
    }
    let s = settings::load(&app);
    let token = store::get(ARGO_TOKEN_KEY);
    if s.argo_url.trim().is_empty() || (token.is_none() && s.argo_iap_client_id.trim().is_empty()) {
        return Ok(Vec::new());
    }
    let conn = argo_conn(&app)?;
    argo::apps(&conn, token.as_deref()).await
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
        });
    }
    let token = token()?;
    match github::latest_release(&token, &owner, &repo).await? {
        Some(release) => {
            let cmp =
                github::compare(&token, &owner, &repo, &release.tag_name, &default_branch).await?;
            Ok(RepoStatus {
                latest_tag: Some(release.tag_name),
                release_url: Some(release.html_url),
                published_at: release.published_at,
                ahead_by: cmp.ahead_by,
            })
        }
        None => Ok(RepoStatus {
            latest_tag: None,
            release_url: None,
            published_at: None,
            ahead_by: github::branch_commit_count(&token, &owner, &repo, &default_branch).await?,
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
        .invoke_handler(tauri::generate_handler![
            is_demo,
            auth_status,
            argo_apps,
            get_settings,
            save_settings,
            argo_login,
            argo_set_token,
            argo_status,
            argo_disconnect,
            list_repos,
            repo_status,
            prepare_release,
            generate_notes,
            create_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
