import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isWaiting, type WaitingStatus } from "./waiting";

interface Repo { name: string; full_name: string; owner: { login: string } }
interface CachedStatus { status: WaitingStatus }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const MAX_ROWS = 5;

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

function summaryText(cached: number, released: number, waiting: number): string {
  if (cached === 0) return "Open the window once to fill this in.";
  if (waiting > 0) return `${waiting} ${waiting === 1 ? "repo has" : "repos have"} commits waiting to ship.`;
  return released === 0 ? "No releases yet — nothing to ship." : "Everything released is shipped.";
}

function row(repo: Repo, ahead: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel-row";

  const name = document.createElement("span");
  name.className = "panel-name";
  const owner = document.createElement("span");
  owner.className = "owner";
  owner.textContent = `${repo.owner.login} / `;
  name.append(owner, document.createTextNode(repo.name));
  name.title = repo.full_name;

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

async function render() {
  const demo = await invoke<boolean>("is_demo").catch(() => false);
  const key = (k: string) => (demo ? `demo:${k}` : k);

  document.documentElement.dataset.theme = localStorage.getItem("unshipped:theme") ?? "harbor";

  const repos = readCache<Repo[]>(key("unshipped:repos:v1")) ?? [];
  const statuses = readCache<Record<string, CachedStatus>>(key("unshipped:statuses:v1")) ?? {};
  const pins = new Set(readCache<string[]>(key("unshipped:pins:v1")) ?? []);
  $("panel-checked").textContent = since(localStorage.getItem(key("unshipped:checked:v1")));

  const waiting = repos
    .map((repo) => ({ repo, status: statuses[repo.full_name]?.status }))
    .filter((x) => isWaiting(x.status, pins.has(x.repo.full_name)))
    .map((x) => ({ repo: x.repo, ahead: x.status!.ahead_by }))
    .sort((a, b) => b.ahead - a.ahead);

  const [pinned, rest] = [
    waiting.filter((x) => pins.has(x.repo.full_name)),
    waiting.filter((x) => !pins.has(x.repo.full_name)),
  ];
  const released = repos.filter((r) => statuses[r.full_name]?.status.latest_tag).length;

  $("panel-summary").textContent = summaryText(repos.length, released, waiting.length);

  const list = $("panel-list");
  list.innerHTML = "";

  const shownPins = pinned.slice(0, MAX_ROWS);
  const shownRest = rest.slice(0, MAX_ROWS - shownPins.length);
  for (const [label, rows] of [["Pinned", shownPins], ["Waiting", shownRest]] as const) {
    if (!rows.length) continue;
    const el = document.createElement("div");
    el.className = "panel-section";
    el.textContent = label;
    list.append(el);
    for (const { repo, ahead } of rows) list.append(row(repo, ahead));
  }

  const hidden = waiting.length - shownPins.length - shownRest.length;
  if (hidden > 0) {
    const more = document.createElement("div");
    more.className = "panel-more";
    more.textContent = `and ${hidden} more`;
    list.append(more);
  }
}

function fit() {
  invoke("resize_panel", { height: document.querySelector(".panel")!.getBoundingClientRect().height }).catch(() => {});
}

$("panel-open").onclick = () => invoke("focus_main");
$("panel-quit").onclick = () => invoke("quit_app");
$("panel-refresh").onclick = () => {
  invoke("panel_refresh");
  $("panel-checked").textContent = "checking…";
};

async function refresh() {
  await render();
  fit();
}

// The window is reused, so re-read the caches every time it is shown.
window.addEventListener("focus", refresh);
listen("ledger-updated", refresh);
refresh();
