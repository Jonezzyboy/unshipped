use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Cached {
    token: String,
    minted: Instant,
    key: String,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

// Identity tokens live 1h; refresh with headroom.
const TTL: Duration = Duration::from_secs(50 * 60);

const GCLOUD_CANDIDATES: &[&str] = &[
    "gcloud",
    "/opt/homebrew/bin/gcloud",
    "/usr/local/bin/gcloud",
    "/opt/homebrew/share/google-cloud-sdk/bin/gcloud",
];

pub fn identity_token(client_id: &str, service_account: &str) -> Result<String, String> {
    let key = format!("{client_id}|{service_account}");
    if let Some(c) = CACHE.lock().unwrap().as_ref() {
        if c.key == key && c.minted.elapsed() < TTL {
            return Ok(c.token.clone());
        }
    }
    let token = mint(client_id, service_account)?;
    *CACHE.lock().unwrap() = Some(Cached { token: token.clone(), minted: Instant::now(), key });
    Ok(token)
}

fn mint(client_id: &str, service_account: &str) -> Result<String, String> {
    let audiences = format!("--audiences={client_id}");
    let impersonate = format!("--impersonate-service-account={service_account}");
    let mut args = vec!["auth", "print-identity-token", audiences.as_str()];
    if !service_account.is_empty() {
        args.push(impersonate.as_str());
        args.push("--include-email");
    }
    for gcloud in GCLOUD_CANDIDATES {
        match Command::new(gcloud).args(&args).output() {
            Err(_) => continue,
            Ok(out) => {
                if out.status.success() {
                    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !token.is_empty() {
                        return Ok(token);
                    }
                }
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(format!("gcloud couldn't mint an IAP identity token: {err}"));
            }
        }
    }
    Err("gcloud not found. Install the Google Cloud SDK and run “gcloud auth login”.".into())
}
