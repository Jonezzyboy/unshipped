//! Asks a local decision model, served by Ollama's systemone endpoint, which
//! bump a release needs, for repos whose commits carry no conventional markers.

use crate::version::Bump;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

/// How sure the model must be before it may raise the suggestion.
const MIN_PROBABILITY: f64 = 0.8;

/// Keeps the request well inside Nimble's 8k-token context.
const MAX_COMMIT_BYTES: usize = 16_000;

pub struct Conn {
    pub url: String,
    pub model: String,
}

impl Conn {
    /// Blank fields fall back to $OLLAMA_HOST, then Ollama's default, and nimble.
    pub fn new(url: &str, model: &str) -> Self {
        let mut url = url.trim().trim_end_matches('/').to_string();
        if url.is_empty() {
            url = std::env::var("OLLAMA_HOST").unwrap_or_default();
        }
        if url.is_empty() {
            url = "http://localhost:11434".into();
        }
        if !url.contains("://") {
            url = format!("http://{url}");
        }
        let model = match model.trim() {
            "" => "nimble".into(),
            m => m.into(),
        };
        Self { url, model }
    }
}

#[derive(Serialize, Debug)]
pub struct Verdict {
    /// The model's own pick.
    pub level: Bump,
    pub probability: f64,
    pub probabilities: BTreeMap<String, f64>,
    /// What the release dialog should suggest once the model has had its say.
    pub suggested: Bump,
}

/// The model may raise the conventional-commit level but never lower it: a
/// `feat:` or `BREAKING CHANGE` is the author saying so outright.
pub fn adopt(markers: Bump, model: Bump, probability: f64) -> Bump {
    if probability >= MIN_PROBABILITY && rank(model) > rank(markers) {
        model
    } else {
        markers
    }
}

fn rank(b: Bump) -> u8 {
    match b {
        Bump::Patch => 0,
        Bump::Minor => 1,
        Bump::Major => 2,
    }
}

fn commit_list(commits: &[String]) -> String {
    let mut out = String::new();
    for c in commits {
        let line = format!("- {}\n", c.lines().next().unwrap_or("").trim());
        if out.len() + line.len() > MAX_COMMIT_BYTES {
            break;
        }
        out.push_str(&line);
    }
    out
}

fn client() -> reqwest::Client {
    // A cold 9B model takes several seconds to load before its first answer.
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_default()
}

pub async fn judge(
    conn: &Conn,
    current_tag: Option<&str>,
    commits: &[String],
    markers: Bump,
) -> Result<Verdict, String> {
    let body = serde_json::json!({
        "model": conn.model,
        "keep_alive": "10m",
        "state": {
            "current_version": current_tag.unwrap_or("none yet"),
            "commits": commit_list(commits),
        },
        "questions": {
            "bump": {
                "type": "choice",
                "instructions": "Under semantic versioning, which version bump does this release need? Judge by the most significant user-facing change.",
                "criteria": {
                    "major": "Upgrading forces existing users to change something: a removed or renamed API, command, flag or config key, a changed default they relied on, or an incompatible data or protocol format",
                    "minor": "Adds something users can now do — a new feature, option, command, endpoint or integration — while everything that worked before still works",
                    "patch": "Nothing new for users to use: bug fixes, performance, refactors, docs, tests, CI, dependency bumps, or small visual and wording tweaks to what already exists",
                },
            },
        },
    });
    let resp = client()
        .post(format!("{}/v1/systemone", conn.url))
        .json(&body)
        .send()
        .await
        .map_err(|_| format!("no Ollama server at {} — start it with ollama serve", conn.url))?;
    if !resp.status().is_success() {
        return Err(format!("{} answered {}", conn.model, resp.status()));
    }

    #[derive(Deserialize)]
    struct Answer {
        choice: String,
        probabilities: BTreeMap<String, f64>,
    }
    #[derive(Deserialize)]
    struct Answers {
        bump: Answer,
    }
    #[derive(Deserialize)]
    struct Out {
        answers: Answers,
    }
    let out: Out = resp
        .json()
        .await
        .map_err(|e| format!("{} did not answer like a decision model: {e}", conn.model))?;
    let a = out.answers.bump;
    let level = match a.choice.as_str() {
        "major" => Bump::Major,
        "minor" => Bump::Minor,
        "patch" => Bump::Patch,
        other => return Err(format!("{} answered {other:?}", conn.model)),
    };
    // The answer's confidence field runs well below its probability even on
    // clear-cut input, so the probability is what gets compared.
    let probability = a.probabilities.get(&a.choice).copied().unwrap_or(0.0);
    Ok(Verdict {
        level,
        probability,
        probabilities: a.probabilities,
        suggested: adopt(markers, level, probability),
    })
}

/// Confirms the server is up with the model pulled, then judges a sample,
/// since only a decision model serves systemone.
pub async fn check(conn: &Conn) -> Result<Verdict, String> {
    #[derive(Deserialize)]
    struct Model {
        name: String,
    }
    #[derive(Deserialize)]
    struct Tags {
        models: Vec<Model>,
    }
    let tags: Tags = client()
        .get(format!("{}/api/tags", conn.url))
        .send()
        .await
        .map_err(|_| format!("no Ollama server at {} — start it with ollama serve", conn.url))?
        .json()
        .await
        .map_err(|e| format!("{} did not answer like an Ollama server: {e}", conn.url))?;
    let pulled = tags
        .models
        .iter()
        .any(|m| m.name == conn.model || m.name == format!("{}:latest", conn.model));
    if !pulled {
        return Err(format!("{} is not pulled — run ollama pull {}", conn.model, conn.model));
    }
    let sample = ["Add CSV export to the reports page".to_string(), "Fix off-by-one in pagination".to_string()];
    judge(conn, Some("v1.4.2"), &sample, Bump::Patch).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sure_model_raises_the_markers() {
        assert_eq!(adopt(Bump::Patch, Bump::Minor, 0.94), Bump::Minor);
        assert_eq!(adopt(Bump::Minor, Bump::Major, 0.8), Bump::Major);
    }

    #[test]
    fn an_unsure_model_leaves_them() {
        assert_eq!(adopt(Bump::Patch, Bump::Minor, 0.66), Bump::Patch);
    }

    #[test]
    fn a_marker_is_never_lowered() {
        assert_eq!(adopt(Bump::Major, Bump::Patch, 0.99), Bump::Major);
        assert_eq!(adopt(Bump::Minor, Bump::Patch, 0.99), Bump::Minor);
    }

    #[test]
    fn commits_are_sent_as_subjects_within_budget() {
        let list = commit_list(&["feat: x\n\nbody text".into(), "fix: y".into()]);
        assert_eq!(list, "- feat: x\n- fix: y\n");

        let many: Vec<String> = (0..2000).map(|i| format!("commit number {i}")).collect();
        let list = commit_list(&many);
        assert!(list.len() <= MAX_COMMIT_BYTES);
        assert!(list.starts_with("- commit number 0\n"));
    }

    #[test]
    fn blank_connection_fields_fall_back() {
        let c = Conn::new("  ", "");
        assert_eq!(c.model, "nimble");
        assert!(c.url.starts_with("http"));
        assert_eq!(Conn::new("localhost:11434/", "x").url, "http://localhost:11434");
    }
}

