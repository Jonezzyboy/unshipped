import { isWaiting, type WaitingStatus } from "./waiting";

export interface Rules {
  commits_enabled: boolean;
  commits: number;
  days_enabled: boolean;
  days: number;
  breaking: boolean;
  pinned_only: boolean;
  notify: boolean;
}

export interface RepoRule {
  muted: boolean;
  commits: number | null;
  days: number | null;
}

// breaking is absent in statuses cached before the flag existed.
export interface RuleStatus extends WaitingStatus {
  published_at: string | null;
  breaking?: boolean;
}

// Every rule is opt-in — keep in sync with Rules::default in settings.rs.
export const DEFAULT_RULES: Rules = {
  commits_enabled: false,
  commits: 10,
  days_enabled: false,
  days: 14,
  breaking: false,
  pinned_only: false,
  notify: false,
};

export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export interface RuleContext {
  rules: Rules;
  override?: RepoRule;
  pinned: boolean;
}

// Every line the repo trips, in the words the flag, the notification and the
/// settings list all use. Empty means nothing to say about it.
export function flagReasons(status: RuleStatus | undefined, ctx: RuleContext): string[] {
  const { rules, override, pinned } = ctx;
  if (!isWaiting(status, pinned) || override?.muted) return [];
  if (rules.pinned_only && !pinned) return [];

  const reasons: string[] = [];
  if (rules.commits_enabled && status!.ahead_by >= (override?.commits ?? rules.commits)) {
    reasons.push(`${status!.ahead_by} commits waiting`);
  }
  if (rules.days_enabled) {
    const days = daysSince(status!.published_at);
    if (days !== null && days >= (override?.days ?? rules.days)) {
      reasons.push(`${days} days since ${status!.latest_tag}`);
    }
  }
  if (rules.breaking && status!.breaking) {
    reasons.push("a breaking change is waiting");
  }
  return reasons;
}

export function overrideText(rule: RepoRule): string {
  if (rule.muted) return "muted";
  const parts: string[] = [];
  if (rule.commits !== null) parts.push(`≥ ${rule.commits} commits`);
  if (rule.days !== null) parts.push(`${rule.days} days`);
  return parts.join(" · ") || "no change";
}
