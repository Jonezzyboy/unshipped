import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isWaiting } from "./waiting";
import { DEFAULT_RULES, flagReasons, type RepoRule, type RuleStatus, type Rules } from "./rules";
import { bellSvg, checkedAgo, readCache, relAge, repoLabel, type RepoRef } from "./shared";

interface PanelStatus extends RuleStatus { release_url?: string | null }
interface CachedStatus { status: PanelStatus }
interface PanelSections { pinned: boolean; waiting: boolean; recent: boolean }
interface Settings { rules: Rules; repo_rules: Record<string, RepoRule>; panel_sections?: PanelSections }
interface Waiting { repo: RepoRef; ahead: number; reasons: string[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MAX_ROWS = 5;
const RECENT_ROWS = 3;

const demo = invoke<boolean>("is_demo").catch(() => false);
let checkedKey = "unshipped:checked:v1";

function summaryText(cached: number, released: number, waiting: number, flagged: number): string {
  if (cached === 0) return "Open the window once to fill this in.";
  if (flagged > 0) return `${flagged} ${flagged === 1 ? "repo has" : "repos have"} tripped a rule.`;
  if (waiting > 0) return `${waiting} ${waiting === 1 ? "repo has" : "repos have"} commits waiting to ship.`;
  return released === 0 ? "No releases yet — nothing to ship." : "Everything released is shipped.";
}

function nameCell(repo: RepoRef): HTMLElement {
  const name = document.createElement("span");
  name.className = "panel-name";
  name.title = repo.full_name;
  name.append(...repoLabel(repo));
  return name;
}

function row({ repo, ahead, reasons }: Waiting): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-row";

  if (reasons.length) {
    const flag = document.createElement("span");
    flag.className = "flag-mark";
    flag.innerHTML = bellSvg(12);
    flag.title = reasons.join(" · ");
    el.append(flag);
  }

  const pill = document.createElement("span");
  pill.className = "lamp";
  pill.dataset.heat = ahead >= 20 ? "hot" : "warm";
  pill.textContent = String(ahead);

  const release = document.createElement("button");
  release.type = "button";
  release.textContent = "Release…";
  release.onclick = () => invoke("panel_release", { repo: repo.full_name });

  el.append(nameCell(repo), pill, release);
  return el;
}

function recentRow(repo: RepoRef, status: PanelStatus): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-row";

  const when = document.createElement("span");
  when.className = "panel-when";
  when.textContent = relAge(status.published_at);

  const url = status.release_url;
  const tag = document.createElement(url ? "a" : "span");
  tag.className = "panel-tag";
  tag.textContent = status.latest_tag ?? "";
  if (url) {
    (tag as HTMLAnchorElement).href = "#";
    tag.onclick = (e) => {
      e.preventDefault();
      openUrl(url);
    };
  }

  el.append(nameCell(repo), when, tag);
  return el;
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-section";
  el.textContent = text;
  return el;
}

function renderChecked() {
  if ($("panel-refresh").hasAttribute("data-busy")) return;
  const ago = checkedAgo(localStorage.getItem(checkedKey));
  $("panel-checked").textContent = ago ? `checked ${ago}` : "";
}

async function render() {
  const isDemo = await demo;
  const key = (k: string) => (isDemo ? `demo:${k}` : k);
  const settings = await invoke<Settings>("get_settings").catch(() => null);
  const rules = { ...DEFAULT_RULES, ...(settings?.rules ?? {}) };
  const repoRules = settings?.repo_rules ?? {};
  const sections: PanelSections = {
    pinned: true, waiting: true, recent: true,
    ...(settings?.panel_sections ?? {}),
  };

  document.documentElement.dataset.theme = localStorage.getItem("unshipped:theme") ?? "harbor";
  checkedKey = key("unshipped:checked:v1");

  const repos = readCache<RepoRef[]>(key("unshipped:repos:v1")) ?? [];
  const statuses = readCache<Record<string, CachedStatus>>(key("unshipped:statuses:v1")) ?? {};
  const pins = new Set(readCache<string[]>(key("unshipped:pins:v1")) ?? []);
  const statusOf = (repo: RepoRef) => statuses[repo.full_name]?.status;

  const waiting: Waiting[] = [];
  for (const repo of repos) {
    const status = statusOf(repo);
    const pinned = pins.has(repo.full_name);
    if (!isWaiting(status, pinned)) continue;
    waiting.push({
      repo,
      ahead: status!.ahead_by,
      reasons: flagReasons(status, { rules, override: repoRules[repo.full_name], pinned }),
    });
  }
  // A tripped rule is the whole point of the panel; the count breaks the tie.
  waiting.sort((a, b) => Number(b.reasons.length > 0) - Number(a.reasons.length > 0) || b.ahead - a.ahead);

  const pinned = waiting.filter((x) => pins.has(x.repo.full_name));
  const rest = waiting.filter((x) => !pins.has(x.repo.full_name));
  const released = repos.filter((r) => statusOf(r)?.latest_tag).length;
  const flagged = waiting.filter((x) => x.reasons.length).length;

  renderChecked();
  $("panel-summary").textContent = summaryText(repos.length, released, waiting.length, flagged);

  const list: Node[] = [];
  const shownPins = sections.pinned ? pinned.slice(0, MAX_ROWS) : [];
  const shownRest = sections.waiting ? rest.slice(0, MAX_ROWS - shownPins.length) : [];
  for (const [label, rows] of [["Pinned", shownPins], ["Waiting", shownRest]] as const) {
    if (!rows.length) continue;
    list.push(sectionLabel(label), ...rows.map(row));
  }

  // Only enabled sections' overflow counts — a toggled-off section isn't "more".
  const hidden =
    (sections.pinned ? pinned.length - shownPins.length : 0) +
    (sections.waiting ? rest.length - shownRest.length : 0);
  if (hidden > 0) {
    const more = document.createElement("div");
    more.className = "panel-more";
    more.textContent = `and ${hidden} more`;
    list.push(more);
  }

  if (sections.recent) {
    const recent = repos
      .map((repo) => ({ repo, status: statusOf(repo) }))
      .filter((x): x is { repo: RepoRef; status: PanelStatus } => !!x.status?.published_at)
      .sort((a, b) => b.status.published_at!.localeCompare(a.status.published_at!))
      .slice(0, RECENT_ROWS);
    if (recent.length) {
      list.push(sectionLabel("Recently released"), ...recent.map((x) => recentRow(x.repo, x.status)));
    }
  }
  $("panel-list").replaceChildren(...list);
}

function fit() {
  const height = document.querySelector(".panel")!.getBoundingClientRect().height;
  invoke("resize_panel", { height }).catch(() => {});
}

function setBusy(on: boolean) {
  const btn = $<HTMLButtonElement>("panel-refresh");
  btn.toggleAttribute("data-busy", on);
  btn.disabled = on;
  if (on) $("panel-checked").textContent = "checking…";
}

// Overlapping triggers (focus plus an update) only need the last one painted.
let pending: Promise<void> | null = null;
let again = false;
async function refresh() {
  if (pending) {
    again = true;
    return pending;
  }
  pending = (async () => {
    do {
      again = false;
      await render();
    } while (again);
    fit();
  })().finally(() => (pending = null));
  return pending;
}

$("panel-open").onclick = () => invoke("focus_main");
$("panel-quit").onclick = () => invoke("quit_app");
$("panel-refresh").onclick = () => {
  setBusy(true);
  invoke("panel_refresh");
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") invoke("hide_panel");
});

// The window is reused, so re-read the caches every time it is shown.
window.addEventListener("focus", refresh);
// Fired after every sweep, failed ones included, so it is also what stops the spinner.
listen("ledger-updated", () => {
  setBusy(false);
  refresh();
});
setInterval(renderChecked, 30_000);
refresh();
