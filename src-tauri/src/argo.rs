use serde::{Deserialize, Serialize};
use serde_json::json;

/// Set on an Argo CD Application to name the GitHub repo it ships, for when the
/// Application's own sources don't point at that repo (chart repos, config
/// mirrors, one repo split across many apps).
pub const REPO_ANNOTATION: &str = "unshipped.dev/repo";

/// Unlinked apps are listed in settings so the mismatch is visible; a long list
/// stops being diagnostic, so only the head is sent to the UI.
const UNLINKED_SAMPLE: usize = 30;

fn client(insecure: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("unshipped")
        .danger_accept_invalid_certs(insecure)
        .build()
        .map_err(|e| e.to_string())
}

fn base(server: &str) -> String {
    server.trim_end_matches('/').to_string()
}

#[derive(Clone)]
pub struct Conn {
    pub url: String,
    pub insecure: bool,
    /// Google IAP identity token, sent as Proxy-Authorization so the
    /// Authorization header stays free for Argo's own token.
    pub iap_token: Option<String>,
}

impl Conn {
    fn apply(&self, mut req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
        if let Some(iap) = &self.iap_token {
            req = req.header("Proxy-Authorization", format!("Bearer {iap}"));
        }
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        req
    }
}

async fn check_response(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let msg = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["message"].as_str().or(v["error"].as_str()).map(String::from))
        .unwrap_or(body);
    Err(format!("Argo CD error {status}: {msg}"))
}

/// Argo's API always answers JSON. HTML back means the request never reached it —
/// almost always an IAP/SSO login page or a URL pointing at something else.
async fn json_body(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let resp = check_response(resp).await?;
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|_| {
        "That URL answered, but not with Argo CD's API. Check the server URL — \
         if it sits behind IAP or SSO, the request is probably being bounced to a login page."
            .to_string()
    })
}

pub async fn login(conn: &Conn, username: &str, password: &str) -> Result<String, String> {
    let req = client(conn.insecure)?
        .post(format!("{}/api/v1/session", base(&conn.url)))
        .json(&json!({ "username": username, "password": password }));
    let resp = conn.apply(req, None).send().await.map_err(|e| e.to_string())?;
    json_body(resp)
        .await?
        .get("token")
        .and_then(|t| t.as_str())
        .map(String::from)
        .ok_or_else(|| "Argo CD accepted the login but returned no session token.".into())
}

// --- Applications ---

#[derive(Serialize, Clone)]
pub struct App {
    pub name: String,
    /// GitHub `owner/name` this app deploys, lowercased. `None` when nothing
    /// about the app says which repo it comes from.
    pub repo: Option<String>,
    /// How `repo` was worked out — `"annotation"` or `"source"`.
    pub linked_by: Option<&'static str>,
    pub repo_urls: Vec<String>,
    pub sync: String,
    pub health: String,
    pub revision: Option<String>,
    pub url: String,
}

/// Reduces a git remote to `owner/name`. Handles `https://`, `ssh://`, and
/// scp-style `git@host:owner/name.git`, on GitHub.com or an Enterprise host.
pub fn repo_from_url(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let after_userinfo = after_scheme.split_once('@').map(|(_, rest)| rest).unwrap_or(after_scheme);
    // Host ends at ':' for scp-style remotes and '/' for everything else.
    let (_, path) = after_userinfo.split_once(['/', ':'])?;

    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let owner = parts.next()?;
    let name = parts.next()?;
    Some(format!("{owner}/{name}").to_lowercase())
}

fn app_from_item(item: &serde_json::Value, server: &str) -> App {
    let name = item["metadata"]["name"].as_str().unwrap_or_default().to_string();

    let mut repo_urls: Vec<String> = Vec::new();
    if let Some(url) = item["spec"]["source"]["repoURL"].as_str() {
        repo_urls.push(url.to_string());
    }
    for source in item["spec"]["sources"].as_array().unwrap_or(&Vec::new()) {
        if let Some(url) = source["repoURL"].as_str() {
            repo_urls.push(url.to_string());
        }
    }

    let annotated = item["metadata"]["annotations"][REPO_ANNOTATION]
        .as_str()
        .map(|v| v.trim().trim_end_matches('/').to_lowercase())
        .filter(|v| !v.is_empty());

    let (repo, linked_by) = match annotated {
        Some(repo) => (Some(repo), Some("annotation")),
        None => match repo_urls.iter().find_map(|u| repo_from_url(u)) {
            Some(repo) => (Some(repo), Some("source")),
            None => (None, None),
        },
    };

    App {
        url: format!("{}/applications/{name}", base(server)),
        name,
        repo,
        linked_by,
        repo_urls,
        sync: item["status"]["sync"]["status"].as_str().unwrap_or("Unknown").to_string(),
        health: item["status"]["health"]["status"].as_str().unwrap_or("Unknown").to_string(),
        revision: item["status"]["sync"]["revision"].as_str().map(|r| r.chars().take(7).collect()),
    }
}

pub async fn apps(conn: &Conn, token: Option<&str>) -> Result<Vec<App>, String> {
    let fields = "items.metadata.name,items.metadata.annotations,\
                  items.spec.source.repoURL,items.spec.sources,\
                  items.status.sync.status,items.status.sync.revision,items.status.health.status";
    let req = client(conn.insecure)?.get(format!(
        "{}/api/v1/applications?fields={fields}",
        base(&conn.url)
    ));
    let resp = conn.apply(req, token).send().await.map_err(|e| e.to_string())?;
    let body = json_body(resp).await?;

    Ok(body["items"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|item| app_from_item(item, &conn.url))
        .collect())
}

// --- Connection check ---

/// What the settings page needs to explain the integration's state in one round
/// trip: whether the server answered, whether Argo accepted an identity, and
/// whether the applications it returned can be tied back to repos.
#[derive(Serialize, Default)]
pub struct Check {
    pub configured: bool,
    pub reachable: bool,
    pub logged_in: bool,
    pub username: Option<String>,
    /// Which credential Argo accepted — `"token"` or `"iap"`.
    pub auth: Option<&'static str>,
    pub error: Option<String>,
    pub apps: Option<AppReport>,
}

#[derive(Serialize, Default)]
pub struct AppReport {
    pub total: usize,
    pub linked: usize,
    pub by_annotation: usize,
    pub repos: usize,
    pub unlinked: Vec<Unlinked>,
    pub unlinked_total: usize,
    /// Set when the account can reach Argo but not list applications.
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct Unlinked {
    pub name: String,
    pub repo_urls: Vec<String>,
}

pub fn report(apps: &[App]) -> AppReport {
    let mut repos: Vec<&str> = apps.iter().filter_map(|a| a.repo.as_deref()).collect();
    repos.sort_unstable();
    repos.dedup();

    let unlinked: Vec<&App> = apps.iter().filter(|a| a.repo.is_none()).collect();

    AppReport {
        total: apps.len(),
        linked: apps.len() - unlinked.len(),
        by_annotation: apps.iter().filter(|a| a.linked_by == Some("annotation")).count(),
        repos: repos.len(),
        unlinked_total: unlinked.len(),
        unlinked: unlinked
            .iter()
            .take(UNLINKED_SAMPLE)
            .map(|a| Unlinked { name: a.name.clone(), repo_urls: a.repo_urls.clone() })
            .collect(),
        error: None,
    }
}

pub async fn check(conn: &Conn, token: Option<&str>) -> Check {
    #[derive(Deserialize)]
    struct UserInfo {
        #[serde(rename = "loggedIn", default)]
        logged_in: bool,
        username: Option<String>,
    }

    let configured = Check { configured: true, ..Default::default() };

    let client = match client(conn.insecure) {
        Ok(c) => c,
        Err(e) => return Check { error: Some(e), ..configured },
    };
    let req = client.get(format!("{}/api/v1/session/userinfo", base(&conn.url)));
    let resp = match conn.apply(req, token).send().await {
        Ok(r) => r,
        Err(e) => return Check { error: Some(unreachable_message(&e)), ..configured },
    };
    let body = match json_body(resp).await {
        Ok(b) => b,
        Err(e) => return Check { error: Some(e), ..configured },
    };
    let info: UserInfo = match serde_json::from_value(body) {
        Ok(i) => i,
        Err(e) => return Check { error: Some(e.to_string()), ..configured },
    };

    if !info.logged_in {
        return Check {
            configured: true,
            reachable: true,
            error: Some(if token.is_some() {
                "Argo CD rejected the saved credential — an API token expires, and a session token \
                 lasts only as long as the server's session limit. Sign in again below."
                    .into()
            } else {
                "Argo CD answered, but it isn't treating you as signed in. IAP only gets the \
                 request through the proxy — Argo still needs its own identity, so sign in below."
                    .into()
            }),
            ..configured
        };
    }

    let apps = match apps(conn, token).await {
        Ok(apps) => report(&apps),
        Err(e) => AppReport { error: Some(e), ..Default::default() },
    };

    Check {
        configured: true,
        reachable: true,
        logged_in: true,
        username: info.username,
        auth: Some(if token.is_some() { "token" } else { "iap" }),
        error: None,
        apps: Some(apps),
    }
}

fn unreachable_message(e: &reqwest::Error) -> String {
    let detail = e.to_string();
    if e.is_connect() {
        format!("Couldn't reach that URL: {detail}")
    } else if e.is_timeout() {
        format!("Timed out reaching that URL: {detail}")
    } else {
        detail
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_remote_shapes() {
        for url in [
            "https://github.com/Acme/Billing-API.git",
            "https://github.com/acme/billing-api",
            "git@github.com:acme/billing-api.git",
            "ssh://git@github.com/acme/billing-api.git",
            "https://x-access-token:secret@github.com/acme/billing-api.git",
            "https://ghe.corp.example.com/acme/billing-api.git/",
        ] {
            assert_eq!(repo_from_url(url).as_deref(), Some("acme/billing-api"), "{url}");
        }
    }

    #[test]
    fn rejects_remotes_without_an_owner_and_name() {
        assert_eq!(repo_from_url("https://charts.example.com"), None);
        assert_eq!(repo_from_url("https://charts.example.com/stable"), None);
        assert_eq!(repo_from_url(""), None);
    }

    #[test]
    fn annotation_wins_over_source() {
        let item = json!({
            "metadata": { "name": "billing-api-prod", "annotations": { REPO_ANNOTATION: "Acme/Billing-API" } },
            "spec": { "source": { "repoURL": "https://charts.example.com" } },
        });
        let app = app_from_item(&item, "https://argocd.example.com/");
        assert_eq!(app.repo.as_deref(), Some("acme/billing-api"));
        assert_eq!(app.linked_by, Some("annotation"));
        assert_eq!(app.url, "https://argocd.example.com/applications/billing-api-prod");
    }

    #[test]
    fn multi_source_apps_link_by_the_first_usable_source() {
        let item = json!({
            "metadata": { "name": "web" },
            "spec": { "sources": [
                { "repoURL": "https://charts.example.com" },
                { "repoURL": "https://github.com/acme/web.git" },
            ] },
        });
        let app = app_from_item(&item, "https://argocd.example.com");
        assert_eq!(app.repo.as_deref(), Some("acme/web"));
        assert_eq!(app.linked_by, Some("source"));
    }

    #[test]
    fn report_counts_distinct_repos_and_samples_unlinked() {
        let mk = |name: &str, repo: Option<&str>, by: Option<&'static str>| App {
            name: name.into(),
            repo: repo.map(String::from),
            linked_by: by,
            repo_urls: vec!["https://charts.example.com".into()],
            sync: "Synced".into(),
            health: "Healthy".into(),
            revision: None,
            url: String::new(),
        };
        let apps = vec![
            mk("a-dev", Some("acme/a"), Some("source")),
            mk("a-prod", Some("acme/a"), Some("source")),
            mk("b-prod", Some("acme/b"), Some("annotation")),
            mk("chart-only", None, None),
        ];
        let r = report(&apps);
        assert_eq!((r.total, r.linked, r.repos, r.by_annotation), (4, 3, 2, 1));
        assert_eq!(r.unlinked_total, 1);
        assert_eq!(r.unlinked[0].name, "chart-only");
    }
}
