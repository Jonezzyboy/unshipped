import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isWaiting } from "./waiting";
import { DEFAULT_RULES, flagReasons, type RepoRule, type RuleStatus, type Rules } from "./rules";

interface Repo { name: string; full_name: string; owner: { login: string } }
interface PanelStatus extends RuleStatus { release_url?: string | null }
interface CachedStatus { status: PanelStatus }
interface PanelSections { pinned: boolean; waiting: boolean; recent: boolean }
interface Settings { rules: Rules; repo_rules: Record<string, RepoRule>; panel_sections?: PanelSections }
interface Waiting { repo: Repo; ahead: number; reasons: string[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MAX_ROWS = 5;
const RECENT_ROWS = 3;

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function since(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `checked ${hours}h ago` : "checked a while ago";
}

function heat(ahead: number): string {
  return ahead >= 20 ? "hot" : "warm";
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}

const BELL_SVG =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">' +
  '<path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Z"/></svg>';

function summaryText(cached: number, released: number, waiting: number, flagged: number): string {
  if (cached === 0) return "Open the window once to fill this in.";
  if (flagged > 0) return `${flagged} ${flagged === 1 ? "repo has" : "repos have"} tripped a rule.`;
  if (waiting > 0) return `${waiting} ${waiting === 1 ? "repo has" : "repos have"} commits waiting to ship.`;
  return released === 0 ? "No releases yet — nothing to ship." : "Everything released is shipped.";
}

function row({ repo, ahead, reasons }: Waiting): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-row";

  const name = document.createElement("span");
  name.className = "panel-name";
  const owner = document.createElement("span");
  owner.className = "owner";
  owner.textContent = `${repo.owner.login} / `;
  name.append(owner, document.createTextNode(repo.name));
  name.title = repo.full_name;

  if (reasons.length) {
    const flag = document.createElement("span");
    flag.className = "flag-mark";
    flag.innerHTML = BELL_SVG;
    flag.title = reasons.join(" · ");
    el.append(flag);
  }

  const pill = document.createElement("span");
  pill.className = "lamp";
  pill.dataset.heat = heat(ahead);
  pill.textContent = String(ahead);

  const release = document.createElement("button");
  release.type = "button";
  release.textContent = "Release…";
  release.onclick = () => invoke("panel_release", { repo: repo.full_name });

  el.append(name, pill, release);
  return el;
}

function recentRow(repo: Repo, status: PanelStatus): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-row";

  const name = document.createElement("span");
  name.className = "panel-name";
  const owner = document.createElement("span");
  owner.className = "owner";
  owner.textContent = `${repo.owner.login} / `;
  name.append(owner, document.createTextNode(repo.name));
  name.title = repo.full_name;

  const when = document.createElement("span");
  when.className = "panel-when";
  when.textContent = ago(status.published_at!);

  const tag = document.createElement(status.release_url ? "a" : "span");
  tag.className = "panel-tag";
  tag.textContent = status.latest_tag ?? "";
  if (status.release_url) {
    (tag as HTMLAnchorElement).href = "#";
    tag.onclick = (e) => {
      e.preventDefault();
      openUrl(status.release_url!);
    };
  }

  el.append(name, when, tag);
  return el;
}

async function render() {
  const demo = await invoke<boolean>("is_demo").catch(() => false);
  const key = (k: string) => (demo ? `demo:${k}` : k);
  const settings = await invoke<Settings>("get_settings").catch(() => null);
  const rules = { ...DEFAULT_RULES, ...(settings?.rules ?? {}) };
  const repoRules = settings?.repo_rules ?? {};

  document.documentElement.dataset.theme = localStorage.getItem("unshipped:theme") ?? "harbor";

  const repos = readCache<Repo[]>(key("unshipped:repos:v1")) ?? [];
  const statuses = readCache<Record<string, CachedStatus>>(key("unshipped:statuses:v1")) ?? {};
  const pins = new Set(readCache<string[]>(key("unshipped:pins:v1")) ?? []);
  $("panel-checked").textContent = since(localStorage.getItem(key("unshipped:checked:v1")));

  const waiting: Waiting[] = repos
    .map((repo) => ({ repo, status: statuses[repo.full_name]?.status }))
    .filter((x) => isWaiting(x.status, pins.has(x.repo.full_name)))
    .map((x) => ({
      repo: x.repo,
      ahead: x.status!.ahead_by,
      reasons: flagReasons(x.status, {
        rules,
        override: repoRules[x.repo.full_name],
        pinned: pins.has(x.repo.full_name),
      }),
    }))
    // A tripped rule is the whole point of the panel; the count breaks the tie.
    .sort((a, b) => Number(b.reasons.length > 0) - Number(a.reasons.length > 0) || b.ahead - a.ahead);

  const sections: PanelSections = {
    pinned: true, waiting: true, recent: true,
    ...(settings?.panel_sections ?? {}),
  };

  const [pinned, rest] = [
    waiting.filter((x) => pins.has(x.repo.full_name)),
    waiting.filter((x) => !pins.has(x.repo.full_name)),
  ];
  const released = repos.filter((r) => statuses[r.full_name]?.status.latest_tag).length;
  const flagged = waiting.filter((x) => x.reasons.length).length;

  $("panel-summary").textContent = summaryText(repos.length, released, waiting.length, flagged);

  const list = $("panel-list");
  list.innerHTML = "";

  const shownPins = sections.pinned ? pinned.slice(0, MAX_ROWS) : [];
  const shownRest = sections.waiting ? rest.slice(0, MAX_ROWS - shownPins.length) : [];
  for (const [label, rows] of [["Pinned", shownPins], ["Waiting", shownRest]] as const) {
    if (!rows.length) continue;
    const el = document.createElement("div");
    el.className = "panel-section";
    el.textContent = label;
    list.append(el);
    for (const entry of rows) list.append(row(entry));
  }

  // Only enabled sections' overflow counts — a toggled-off section isn't "more".
  let hidden = 0;
  if (sections.pinned) hidden += pinned.length - shownPins.length;
  if (sections.waiting) hidden += rest.length - shownRest.length;
  if (hidden > 0) {
    const more = document.createElement("div");
    more.className = "panel-more";
    more.textContent = `and ${hidden} more`;
    list.append(more);
  }

  if (sections.recent) {
    const recent = repos
      .map((repo) => ({ repo, status: statuses[repo.full_name]?.status }))
      .filter((x): x is { repo: Repo; status: PanelStatus } => !!x.status?.published_at)
      .sort((a, b) => b.status.published_at!.localeCompare(a.status.published_at!))
      .slice(0, RECENT_ROWS);
    if (recent.length) {
      const el = document.createElement("div");
      el.className = "panel-section";
      el.textContent = "Recently released";
      list.append(el);
      for (const entry of recent) list.append(recentRow(entry.repo, entry.status));
    }
  }
}

function fit() {
  invoke("resize_panel", { height: document.querySelector(".panel")!.getBoundingClientRect().height }).catch(() => {});
}

$("panel-open").onclick = () => invoke("focus_main");
$("panel-quit").onclick = () => invoke("quit_app");
$("panel-refresh").onclick = () => {
  invoke("panel_refresh");
  $("panel-refresh").toggleAttribute("data-busy", true);
  $("panel-checked").textContent = "checking…";
};

async function refresh() {
  await render();
  $("panel-refresh").removeAttribute("data-busy");
  fit();
}

// The window is reused, so re-read the caches every time it is shown.
window.addEventListener("focus", refresh);
listen("ledger-updated", refresh);
refresh();
