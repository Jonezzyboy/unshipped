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
