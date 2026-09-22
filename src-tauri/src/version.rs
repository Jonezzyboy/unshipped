use semver::Version;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Bump {
    Major,
    Minor,
    Patch,
}

/// A counting rule a repo keeps for itself. Only rules that cannot be read back
/// off a tag belong here: a semver tag carries its own shape, prefix and all, so
/// there is nothing about one worth storing.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Rule {
    Calendar,
}

/// What the next tag is being counted from, which decides what the release
/// dialog can offer.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Basis {
    /// The last tag parsed: major, minor and patch all mean something.
    Semver,
    /// The repo counts by calendar month, whatever semver makes of its tags.
    Calendar,
    /// Nothing released yet, so the opening tag is the one from settings.
    FirstRelease,
    /// A tag that defeated us, with no rule saying how to count it.
    Unreadable,
}

#[derive(Serialize)]
pub struct Suggestion {
    pub level: Bump,
    pub reason: String,
    pub major: String,
    pub minor: String,
    pub patch: String,
    pub basis: Basis,
    /// The tag to offer when the three levels do not apply.
    pub next: Option<String>,
}

/// Suggests a bump level from conventional-commit messages since the last release.
/// Falls back to patch when no commit follows the convention.
pub fn suggest(
    current_tag: Option<&str>,
    messages: &[String],
    rule: Option<Rule>,
    start_tag: &str,
    today: (i32, u32),
) -> Suggestion {
    let mut level = Bump::Patch;
    let mut reason = String::from("No feature or breaking commits detected");
    for msg in messages {
        let first = msg.lines().next().unwrap_or("");
        if is_breaking(msg, first) {
            level = Bump::Major;
            reason = format!("Breaking change: “{}”", truncate(first));
            break;
        }
        if level != Bump::Minor && is_feature(first) {
            level = Bump::Minor;
            reason = format!("New feature: “{}”", truncate(first));
        }
    }

    // A repo's own rule wins over the parser: 2026.10.3 is valid semver, and a
    // calendar repo offered a 2027.0.0 major would be nonsense.
    let (basis, next) = match (rule, parse_tag(current_tag)) {
        (Some(Rule::Calendar), _) => (Basis::Calendar, Some(next_calendar(current_tag, today))),
        (None, Some(_)) => (Basis::Semver, None),
        (None, None) if current_tag.is_none() => {
            (Basis::FirstRelease, non_empty(start_tag))
        }
        (None, None) => (Basis::Unreadable, None),
    };

    let (prefix, current) = parse_tag(current_tag).unwrap_or_else(|| ("v".into(), Version::new(0, 0, 0)));
    let fmt = |v: Version| format!("{prefix}{v}");
    Suggestion {
        level,
        reason,
        major: fmt(Version::new(current.major + 1, 0, 0)),
        minor: fmt(Version::new(current.major, current.minor + 1, 0)),
        patch: fmt(Version::new(current.major, current.minor, current.patch + 1)),
        basis,
        next,
    }
}

/// Whether any of these commits carries a breaking-change marker.
pub fn has_breaking(messages: &[String]) -> bool {
    messages
        .iter()
        .any(|m| is_breaking(m, m.lines().next().unwrap_or("")))
}

/// The rule a tag someone typed is worth remembering under, if any. A semver
/// tag returns none: the next one is read straight back off it.
pub fn rule_for(tag: &str) -> Option<Rule> {
    parse_calendar(tag.trim()).map(|_| Rule::Calendar)
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

/// The month's next counter, rolling to one whenever the month has turned.
fn next_calendar(current_tag: Option<&str>, today: (i32, u32)) -> String {
    let (year, month) = today;
    let n = match current_tag.and_then(parse_calendar) {
        Some((y, m, n)) if (y, m) == (year, month) => n + 1,
        _ => 1,
    };
    format!("{year}.{month:02}.{n}")
}

/// `2026.09` or `2026.09.3`, the counter defaulting to zero so the next is one.
fn parse_calendar(tag: &str) -> Option<(i32, u32, u32)> {
    let mut parts = tag.split('.');
    let year = parts.next()?;
    let month = parts.next()?;
    if year.len() != 4 || month.len() != 2 {
        return None;
    }
    let year: i32 = year.parse().ok()?;
    let month: u32 = month.parse().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    let n = match parts.next() {
        Some(n) => n.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((year, month, n))
}

fn parse_tag(tag: Option<&str>) -> Option<(String, Version)> {
    let tag = tag?;
    let stripped = tag.trim_start_matches(|c: char| !c.is_ascii_digit());
    let prefix = &tag[..tag.len() - stripped.len()];
    match Version::parse(stripped) {
        Ok(v) => Some((prefix.into(), v)),
        // Tolerate two-part tags like v1.2
        Err(_) => Version::parse(&format!("{stripped}.0"))
            .ok()
            .map(|v| (prefix.into(), v)),
    }
}

fn is_breaking(full: &str, first_line: &str) -> bool {
    if full.contains("BREAKING CHANGE") || full.contains("BREAKING-CHANGE") {
        return true;
    }
    // conventional commits: "feat(scope)!: ..." / "refactor!: ..."
    first_line
        .split_once(':')
        .map(|(kind, _)| kind.trim_end().ends_with('!'))
        .unwrap_or(false)
}

fn is_feature(first_line: &str) -> bool {
    let lower = first_line.to_lowercase();
    lower.starts_with("feat:") || lower.starts_with("feat(") || lower.starts_with("feature:")
}

fn truncate(s: &str) -> String {
    if s.chars().count() > 60 {
        format!("{}…", s.chars().take(60).collect::<String>())
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: (i32, u32) = (2026, 9);
    const START: &str = "v0.1.0";

    fn msgs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn sug(tag: Option<&str>, list: &[&str]) -> Suggestion {
        suggest(tag, &msgs(list), None, START, TODAY)
    }

    #[test]
    fn patch_by_default() {
        let s = sug(Some("v1.2.3"), &["fix: null check", "chore: bump deps"]);
        assert_eq!(s.level, Bump::Patch);
        assert_eq!(s.patch, "v1.2.4");
        assert_eq!(s.minor, "v1.3.0");
        assert_eq!(s.major, "v2.0.0");
        assert_eq!(s.basis, Basis::Semver);
    }

    #[test]
    fn feat_bumps_minor() {
        assert_eq!(sug(Some("v1.2.3"), &["fix: x", "feat(ui): dark mode"]).level, Bump::Minor);
    }

    #[test]
    fn breaking_bumps_major() {
        let s = sug(Some("1.2.3"), &["feat!: drop v1 api"]);
        assert_eq!(s.level, Bump::Major);
        assert_eq!(s.major, "2.0.0");
    }

    #[test]
    fn breaking_footer_bumps_major() {
        let s = sug(Some("v0.9.0"), &["refactor: rework\n\nBREAKING CHANGE: config renamed"]);
        assert_eq!(s.level, Bump::Major);
    }

    #[test]
    fn a_tag_keeps_its_own_prefix() {
        assert_eq!(sug(Some("3.0.1"), &[]).patch, "3.0.2");
        assert_eq!(sug(Some("v3.0.1"), &[]).patch, "v3.0.2");
        assert_eq!(sug(Some("app-charge/v1.2.3"), &[]).patch, "app-charge/v1.2.4");
    }

    #[test]
    fn a_first_release_opens_at_the_setting() {
        let s = sug(None, &["feat: initial"]);
        assert_eq!(s.basis, Basis::FirstRelease);
        assert_eq!(s.next.as_deref(), Some("v0.1.0"));
        let bare = suggest(None, &msgs(&[]), None, "0.1.0", TODAY);
        assert_eq!(bare.next.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn has_breaking_spots_bang_and_footer() {
        assert!(has_breaking(&msgs(&["fix: x", "feat!: drop v1"])));
        assert!(has_breaking(&msgs(&["refactor: rework\n\nBREAKING CHANGE: renamed"])));
        assert!(!has_breaking(&msgs(&["fix: x", "feat: y"])));
    }

    #[test]
    fn tolerates_two_part_tags() {
        assert_eq!(sug(Some("v1.2"), &[]).patch, "v1.2.1");
    }

    #[test]
    fn an_unreadable_tag_says_so_rather_than_restarting() {
        // Semver rejects the leading zero, so this used to come back as v0.0.1.
        let s = sug(Some("2026.09"), &[]);
        assert_eq!(s.basis, Basis::Unreadable);
        assert_eq!(s.next, None);
    }

    #[test]
    fn a_calendar_rule_counts_within_the_month() {
        let cal = |tag| suggest(tag, &msgs(&[]), Some(Rule::Calendar), START, TODAY);
        assert_eq!(cal(Some("2026.09.2")).next.as_deref(), Some("2026.09.3"));
        assert_eq!(cal(Some("2026.08.7")).next.as_deref(), Some("2026.09.1"));
        // A bare year.month counts as the month's zeroth.
        assert_eq!(cal(Some("2026.09")).next.as_deref(), Some("2026.09.1"));
        assert_eq!(cal(None).next.as_deref(), Some("2026.09.1"));
    }

    #[test]
    fn a_calendar_rule_beats_the_parser() {
        // 2026.10.3 is valid semver, and a major would offer 2027.0.0.
        let s = suggest(Some("2026.10.3"), &msgs(&[]), Some(Rule::Calendar), START, TODAY);
        assert_eq!(s.basis, Basis::Calendar);
        assert_eq!(s.next.as_deref(), Some("2026.09.1"));
    }

    #[test]
    fn only_a_calendar_tag_is_worth_remembering() {
        assert_eq!(rule_for("2026.10"), Some(Rule::Calendar));
        assert_eq!(rule_for("2026.09.3"), Some(Rule::Calendar));
        // A semver tag needs no rule — the next one reads straight off it.
        assert_eq!(rule_for("v3.0.1"), None);
        assert_eq!(rule_for("3.0.1"), None);
        assert_eq!(rule_for("release-candidate"), None);
    }
}
