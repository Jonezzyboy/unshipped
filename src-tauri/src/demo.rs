use crate::argo;
use crate::github::{Repo, RepoOwner, User};

pub fn enabled() -> bool {
    std::env::var("UNSHIPPED_DEMO").is_ok_and(|v| !v.is_empty() && v != "0")
}

pub fn user() -> User {
    User {
        login: "octocat".into(),
        avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4".into(),
    }
}

fn repo(owner: &str, name: &str, private: bool, pushed: &str) -> Repo {
    Repo {
        name: name.into(),
        full_name: format!("{owner}/{name}"),
        private,
        fork: false,
        archived: false,
        default_branch: "main".into(),
        html_url: format!("https://github.com/{owner}/{name}"),
        pushed_at: Some(pushed.into()),
        owner: RepoOwner { login: owner.into() },
    }
}

pub fn repos() -> Vec<Repo> {
    vec![
        repo("acme", "payment-gateway", true, "2026-08-24T16:12:00Z"),
        repo("acme", "billing-api", true, "2026-08-25T09:31:00Z"),
        repo("acme", "webhook-relay", true, "2026-08-23T11:02:00Z"),
        repo("acme", "vault-service", true, "2026-08-21T14:45:00Z"),
        repo("acme", "infra-cluster", true, "2026-08-25T08:05:00Z"),
        repo("nimbus-labs", "proto-schemas", true, "2026-07-30T10:20:00Z"),
        repo("kitefin", "monolith", true, "2026-08-25T07:58:00Z"),
        repo("octocat", "unshipped", false, "2026-08-25T12:00:00Z"),
        repo("octocat", "flock-game", false, "2026-08-11T19:30:00Z"),
        repo("octocat", "tally", false, "2026-06-14T09:00:00Z"),
        repo("octocat", "card-table", false, "2026-05-02T15:10:00Z"),
        repo("octocat", "spot-finder", false, "2026-04-18T17:25:00Z"),
    ]
}

/// (latest_tag, published_at, ahead_by) per demo repo.
pub fn status(full_name: &str) -> (Option<&'static str>, Option<&'static str>, u64) {
    match full_name {
        "acme/payment-gateway" => (Some("v2.14.1"), Some("2026-08-19T10:00:00Z"), 0),
        "acme/billing-api" => (Some("v1.8.0"), Some("2026-08-12T09:00:00Z"), 3),
        "acme/webhook-relay" => (Some("v0.9.2"), Some("2026-07-28T13:00:00Z"), 12),
        "acme/vault-service" => (Some("v3.2.0"), Some("2026-08-15T11:30:00Z"), 0),
        "acme/infra-cluster" => (None, None, 156),
        "nimbus-labs/proto-schemas" => (Some("v1.29.2"), Some("2026-05-20T10:00:00Z"), 0),
        "kitefin/monolith" => (Some("v5.22.0"), Some("2026-08-01T08:00:00Z"), 28),
        "octocat/unshipped" => (Some("v0.1.0"), Some("2026-08-25T09:00:00Z"), 7),
        "octocat/flock-game" => (None, None, 42),
        "octocat/tally" => (Some("v1.0.3"), Some("2026-06-10T18:00:00Z"), 1),
        "octocat/card-table" => (Some("v1.1.0"), Some("2026-05-02T15:00:00Z"), 0),
        "octocat/spot-finder" => (None, None, 9),
        _ => (None, None, 0),
    }
}

pub fn commits(full_name: &str) -> Vec<String> {
    let msgs: &[&str] = match full_name {
        "acme/billing-api" => &[
            "fix: reject expired idempotency keys",
            "feat(webhooks): add invoice.updated event",
            "chore: bump grpc deps",
        ],
        "acme/webhook-relay" => &[
            "feat!: move to v2 delivery pipeline",
            "fix: retry backoff on soft failures",
            "feat: signed payload support",
        ],
        "kitefin/monolith" => &[
            "feat(exports): expose ticket export API",
            "fix(console): panel race on reload",
        ],
        "octocat/unshipped" => &[
            "feat: argo cd integration with google iap",
            "feat: themes with persistence",
            "fix: mutually exclusive status filters",
        ],
        _ => &["fix: assorted fixes", "chore: dependency bumps"],
    };
    msgs.iter().map(|s| s.to_string()).collect()
}

pub fn notes(repo: &str, tag: &str) -> (String, String) {
    let body = format!(
        "## What's Changed\n\
         * feat: signed payload support by @octocat\n\
         * fix: retry backoff on soft failures by @octocat\n\
         * chore: dependency bumps by @dependabot\n\n\
         **Full Changelog**: https://github.com/{repo}/compare/...{tag}"
    );
    (tag.to_string(), body)
}

fn app(name: &str, repo: &str, sync: &str, health: &str, rev: &str) -> argo::App {
    argo::App {
        name: name.into(),
        repo_urls: vec![format!("https://github.com/{repo}.git")],
        sync: sync.into(),
        health: health.into(),
        revision: Some(rev.into()),
    }
}

pub fn argo_apps() -> Vec<argo::App> {
    vec![
        app("payment-gateway-dev", "acme/payment-gateway", "Synced", "Healthy", "9f21c4a"),
        app("payment-gateway-prod", "acme/payment-gateway", "Synced", "Healthy", "9f21c4a"),
        app("billing-api-dev", "acme/billing-api", "OutOfSync", "Progressing", "e77d210"),
        app("billing-api-prod", "acme/billing-api", "Synced", "Healthy", "b3a9910"),
        app("webhook-relay-prod", "acme/webhook-relay", "Synced", "Degraded", "41c0d2e"),
        app("vault-service-prod", "acme/vault-service", "Synced", "Healthy", "cc01f83"),
        app("monolith-dev", "kitefin/monolith", "OutOfSync", "Missing", "0d44b17"),
    ]
}
