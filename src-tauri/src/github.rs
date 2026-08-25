use serde::{Deserialize, Serialize};
use serde_json::json;

const API: &str = "https://api.github.com";

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("unshipped")
        .build()
        .expect("failed to build http client")
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["message"].as_str().map(String::from))
        .unwrap_or(body);
    Err(format!("GitHub API error {status}: {msg}"))
}

async fn get_json<T: for<'de> Deserialize<'de>>(token: &str, url: &str) -> Result<T, String> {
    let resp = client()
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    check(resp).await?.json().await.map_err(|e| e.to_string())
}

async fn post_json<T: for<'de> Deserialize<'de>>(
    token: &str,
    url: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    let resp = client()
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    check(resp).await?.json().await.map_err(|e| e.to_string())
}

// --- API models ---

#[derive(Serialize, Deserialize)]
pub struct User {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize, Deserialize)]
pub struct Repo {
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub default_branch: String,
    pub html_url: String,
    pub pushed_at: Option<String>,
    pub owner: RepoOwner,
}

#[derive(Serialize, Deserialize)]
pub struct RepoOwner {
    pub login: String,
}

#[derive(Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub published_at: Option<String>,
    pub html_url: String,
}

#[derive(Deserialize)]
pub struct Comparison {
    pub ahead_by: u64,
    pub commits: Vec<CommitEntry>,
}

#[derive(Deserialize)]
pub struct CommitEntry {
    pub commit: CommitDetail,
}

#[derive(Deserialize)]
pub struct CommitDetail {
    pub message: String,
}

// --- API calls ---

pub async fn current_user(token: &str) -> Result<User, String> {
    get_json(token, &format!("{API}/user")).await
}

pub async fn list_repos(token: &str) -> Result<Vec<Repo>, String> {
    let page_url = |page: usize| {
        format!(
            "{API}/user/repos?per_page=100&page={page}&sort=pushed\
             &affiliation=owner,collaborator,organization_member"
        )
    };
    let mut repos: Vec<Repo> = get_json(token, &page_url(1)).await?;
    if repos.len() < 100 {
        return Ok(repos);
    }
    // Remaining pages fetched concurrently; page count is unknown, so over-ask
    // and stop collecting at the first empty page.
    let rest = futures::future::join_all((2..=10).map(|p| {
        let url = page_url(p);
        async move { get_json::<Vec<Repo>>(token, &url).await }
    }));
    for batch in rest.await {
        let batch = batch?;
        if batch.is_empty() {
            break;
        }
        repos.extend(batch);
    }
    Ok(repos)
}

pub async fn latest_release(
    token: &str,
    owner: &str,
    repo: &str,
) -> Result<Option<Release>, String> {
    let url = format!("{API}/repos/{owner}/{repo}/releases/latest");
    let resp = client()
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    Ok(Some(
        check(resp).await?.json().await.map_err(|e| e.to_string())?,
    ))
}

pub async fn compare(
    token: &str,
    owner: &str,
    repo: &str,
    base: &str,
    head: &str,
) -> Result<Comparison, String> {
    // The compare API caps the commit list at 250, but ahead_by is always exact.
    let url = format!("{API}/repos/{owner}/{repo}/compare/{base}...{head}?per_page=250");
    get_json(token, &url).await
}

/// Total commits on a branch, used when a repo has no releases yet.
pub async fn branch_commit_count(
    token: &str,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Result<u64, String> {
    let url = format!("{API}/repos/{owner}/{repo}/commits?sha={branch}&per_page=1");
    let resp = client()
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let resp = check(resp).await?;
    // With per_page=1 the last page number in the Link header is the commit count.
    let count = resp
        .headers()
        .get("link")
        .and_then(|l| l.to_str().ok())
        .and_then(|l| {
            l.split(',')
                .find(|part| part.contains("rel=\"last\""))
                .and_then(|part| part.split("page=").last())
                .and_then(|p| p.trim_end_matches(|c: char| !c.is_ascii_digit()).parse().ok())
        });
    if let Some(count) = count {
        return Ok(count);
    }
    let commits: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(commits.len() as u64)
}

#[derive(Deserialize)]
pub struct GeneratedNotes {
    pub name: String,
    pub body: String,
}

pub async fn generate_notes(
    token: &str,
    owner: &str,
    repo: &str,
    tag_name: &str,
    target: &str,
    previous_tag: Option<&str>,
) -> Result<GeneratedNotes, String> {
    let mut body = json!({ "tag_name": tag_name, "target_commitish": target });
    if let Some(prev) = previous_tag {
        body["previous_tag_name"] = json!(prev);
    }
    post_json(
        token,
        &format!("{API}/repos/{owner}/{repo}/releases/generate-notes"),
        &body,
    )
    .await
}

#[derive(Deserialize)]
pub struct CreatedRelease {
    pub html_url: String,
}

pub async fn create_release(
    token: &str,
    owner: &str,
    repo: &str,
    tag_name: &str,
    target: &str,
    name: &str,
    body: &str,
) -> Result<CreatedRelease, String> {
    post_json(
        token,
        &format!("{API}/repos/{owner}/{repo}/releases"),
        &json!({
            "tag_name": tag_name,
            "target_commitish": target,
            "name": name,
            "body": body,
        }),
    )
    .await
}
