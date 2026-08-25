mod auth;
mod github;
mod version;

use auth::token;
use serde::Serialize;

#[derive(Serialize)]
struct AuthStatus {
    user: Option<github::User>,
    error: Option<String>,
}

#[tauri::command]
async fn auth_status() -> AuthStatus {
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
            auth_status,
            list_repos,
            repo_status,
            prepare_release,
            generate_notes,
            create_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
