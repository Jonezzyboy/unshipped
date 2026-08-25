use std::process::Command;
use std::sync::Mutex;

static TOKEN: Mutex<Option<String>> = Mutex::new(None);

// Bundled .app launches don't inherit a shell PATH, so try Homebrew locations too.
const GH_CANDIDATES: &[&str] = &["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

pub fn token() -> Result<String, String> {
    if let Some(token) = TOKEN.lock().unwrap().clone() {
        return Ok(token);
    }
    let token = fetch_gh_token()?;
    *TOKEN.lock().unwrap() = Some(token.clone());
    Ok(token)
}

pub fn clear_cache() {
    *TOKEN.lock().unwrap() = None;
}

fn fetch_gh_token() -> Result<String, String> {
    let mut found_gh = false;
    for gh in GH_CANDIDATES {
        match Command::new(gh).args(["auth", "token"]).output() {
            Err(_) => continue,
            Ok(out) => {
                found_gh = true;
                if out.status.success() {
                    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !token.is_empty() {
                        return Ok(token);
                    }
                }
            }
        }
    }
    if found_gh {
        Err("GitHub CLI isn’t signed in. Run “gh auth login” in a terminal, then retry.".into())
    } else {
        Err("GitHub CLI not found. Install it (brew install gh) and run “gh auth login”.".into())
    }
}
