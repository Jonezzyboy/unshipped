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

pub async fn login(
    server: &str,
    insecure: bool,
    username: &str,
    password: &str,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Session {
        token: String,
    }
    let resp = client(insecure)?
        .post(format!("{}/api/v1/session", base(server)))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let session: Session = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    Ok(session.token)
}

#[derive(Serialize)]
pub struct ArgoStatus {
    pub username: Option<String>,
    pub applications: Option<u64>,
}

pub async fn status(server: &str, insecure: bool, token: &str) -> Result<ArgoStatus, String> {
    #[derive(Deserialize)]
    struct UserInfo {
        #[serde(rename = "loggedIn", default)]
        logged_in: bool,
        username: Option<String>,
    }
    let c = client(insecure)?;
    let resp = c
        .get(format!("{}/api/v1/session/userinfo", base(server)))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let info: UserInfo = check(resp).await?.json().await.map_err(|e| e.to_string())?;
    if !info.logged_in {
        return Err("Argo CD rejected the token — it may have expired.".into());
    }

    // App count is a connectivity nicety; some tokens can't list apps, so failure is fine.
    #[derive(Deserialize)]
    struct Apps {
        items: Option<Vec<serde_json::Value>>,
    }
    let applications = async {
        let resp = c
            .get(format!(
                "{}/api/v1/applications?fields=items.metadata.name",
                base(server)
            ))
            .bearer_auth(token)
            .send()
            .await
            .ok()?;
        let apps: Apps = check(resp).await.ok()?.json().await.ok()?;
        Some(apps.items.map(|i| i.len() as u64).unwrap_or(0))
    }
    .await;

    Ok(ArgoStatus { username: info.username, applications })
}
