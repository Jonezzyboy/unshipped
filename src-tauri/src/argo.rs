use serde::{Deserialize, Serialize};
use serde_json::json;

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

async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
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

pub async fn login(conn: &Conn, username: &str, password: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Session {
        token: String,
    }
    let req = client(conn.insecure)?
        .post(format!("{}/api/v1/session", base(&conn.url)))
        .json(&json!({ "username": username, "password": password }));
    let resp = conn.apply(req, None).send().await.map_err(|e| e.to_string())?;
    let session: Session = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(session.token)
}

#[derive(Serialize)]
pub struct ArgoStatus {
    pub username: Option<String>,
    pub applications: Option<u64>,
}

pub async fn status(conn: &Conn, token: Option<&str>) -> Result<ArgoStatus, String> {
    #[derive(Deserialize)]
    struct UserInfo {
        #[serde(rename = "loggedIn", default)]
        logged_in: bool,
        username: Option<String>,
    }
    let c = client(conn.insecure)?;
    let req = c.get(format!("{}/api/v1/session/userinfo", base(&conn.url)));
    let resp = conn.apply(req, token).send().await.map_err(|e| e.to_string())?;
    let info: UserInfo = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    if !info.logged_in {
        return Err(if token.is_some() {
            "Argo CD rejected the token — it may have expired.".into()
        } else {
            "Reached Argo CD through IAP, but it needs its own login — connect with username/password or an API token.".into()
        });
    }

    // App count is a connectivity nicety; some tokens can't list apps, so failure is fine.
    #[derive(Deserialize)]
    struct Apps {
        items: Option<Vec<serde_json::Value>>,
    }
    let applications = async {
        let req = c.get(format!(
            "{}/api/v1/applications?fields=items.metadata.name",
            base(&conn.url)
        ));
        let resp = conn.apply(req, token).send().await.ok()?;
        let apps: Apps = check(resp).await.ok()?.json().await.ok()?;
        Some(apps.items.map(|i| i.len() as u64).unwrap_or(0))
    }
    .await;

    Ok(ArgoStatus { username: info.username, applications })
}

#[derive(Serialize)]
pub struct App {
    pub name: String,
    pub repo_urls: Vec<String>,
    pub sync: String,
    pub health: String,
    pub revision: Option<String>,
}

pub async fn apps(conn: &Conn, token: Option<&str>) -> Result<Vec<App>, String> {
    let fields = "items.metadata.name,items.spec.source.repoURL,items.spec.sources,\
                  items.status.sync.status,items.status.sync.revision,items.status.health.status";
    let req = client(conn.insecure)?.get(format!(
        "{}/api/v1/applications?fields={fields}",
        base(&conn.url)
    ));
    let resp = conn.apply(req, token).send().await.map_err(|e| e.to_string())?;
    let body: serde_json::Value = check(resp).await?.json().await.map_err(|e| e.to_string())?;

    let mut apps = Vec::new();
    for item in body["items"].as_array().unwrap_or(&Vec::new()) {
        let mut repo_urls: Vec<String> = Vec::new();
        if let Some(url) = item["spec"]["source"]["repoURL"].as_str() {
            repo_urls.push(url.to_string());
        }
        for source in item["spec"]["sources"].as_array().unwrap_or(&Vec::new()) {
            if let Some(url) = source["repoURL"].as_str() {
                repo_urls.push(url.to_string());
            }
        }
        apps.push(App {
            name: item["metadata"]["name"].as_str().unwrap_or_default().to_string(),
            repo_urls,
            sync: item["status"]["sync"]["status"].as_str().unwrap_or("Unknown").to_string(),
            health: item["status"]["health"]["status"].as_str().unwrap_or("Unknown").to_string(),
            revision: item["status"]["sync"]["revision"].as_str().map(|r| r.chars().take(7).collect()),
        });
    }
    Ok(apps)
}
