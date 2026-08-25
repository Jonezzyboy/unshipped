use semver::Version;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Bump {
    Major,
    Minor,
    Patch,
}

#[derive(Serialize)]
pub struct Suggestion {
    pub level: Bump,
    pub reason: String,
    pub major: String,
    pub minor: String,
    pub patch: String,
}

/// Suggests a bump level from conventional-commit messages since the last release.
/// Falls back to patch when no commit follows the convention.
pub fn suggest(current_tag: Option<&str>, messages: &[String]) -> Suggestion {
    let (prefix, current) = parse_tag(current_tag);

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

    let fmt = |v: Version| format!("{prefix}{v}");
    Suggestion {
        level,
        reason,
        major: fmt(Version::new(current.major + 1, 0, 0)),
        minor: fmt(Version::new(current.major, current.minor + 1, 0)),
        patch: fmt(Version::new(current.major, current.minor, current.patch + 1)),
    }
}

fn parse_tag(tag: Option<&str>) -> (String, Version) {
    let Some(tag) = tag else {
        return ("v".into(), Version::new(0, 0, 0));
    };
    let stripped = tag.trim_start_matches(|c: char| !c.is_ascii_digit());
    let prefix = &tag[..tag.len() - stripped.len()];
    match Version::parse(stripped) {
        Ok(v) => (prefix.into(), v),
        // Tolerate two-part tags like v1.2
        Err(_) => match Version::parse(&format!("{stripped}.0")) {
            Ok(v) => (prefix.into(), v),
            Err(_) => ("v".into(), Version::new(0, 0, 0)),
        },
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

    fn msgs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn patch_by_default() {
        let s = suggest(Some("v1.2.3"), &msgs(&["fix: null check", "chore: bump deps"]));
        assert_eq!(s.level, Bump::Patch);
        assert_eq!(s.patch, "v1.2.4");
        assert_eq!(s.minor, "v1.3.0");
        assert_eq!(s.major, "v2.0.0");
    }

    #[test]
    fn feat_bumps_minor() {
        let s = suggest(Some("v1.2.3"), &msgs(&["fix: x", "feat(ui): dark mode"]));
        assert_eq!(s.level, Bump::Minor);
    }

    #[test]
    fn breaking_bumps_major() {
        let s = suggest(Some("1.2.3"), &msgs(&["feat!: drop v1 api"]));
        assert_eq!(s.level, Bump::Major);
        assert_eq!(s.major, "2.0.0");
    }

    #[test]
    fn breaking_footer_bumps_major() {
        let s = suggest(Some("v0.9.0"), &msgs(&["refactor: rework\n\nBREAKING CHANGE: config renamed"]));
        assert_eq!(s.level, Bump::Major);
    }

    #[test]
    fn no_previous_release_starts_at_zero() {
        let s = suggest(None, &msgs(&["feat: initial"]));
        assert_eq!(s.minor, "v0.1.0");
    }

    #[test]
    fn tolerates_two_part_tags() {
        let s = suggest(Some("v1.2"), &msgs(&[]));
        assert_eq!(s.patch, "v1.2.1");
    }
}
