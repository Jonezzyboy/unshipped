import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { isWaiting } from "./waiting";
import {
  DEFAULT_RULES,
  flagReasons,
  overrideText,
  type RepoRule,
  type Rules,
} from "./rules";

interface User { login: string; avatar_url: string }
interface AuthStatus { user: User | null; error: string | null }
interface Repo {
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  html_url: string;
  pushed_at: string | null;
  owner: { login: string };
}
interface RepoStatus {
  latest_tag: string | null;
  release_url: string | null;
  published_at: string | null;
  ahead_by: number;
  breaking?: boolean;
}
type BumpLevel = "major" | "minor" | "patch";
interface Suggestion { level: BumpLevel; reason: string; major: string; minor: string; patch: string }
interface ReleasePrep { current_tag: string | null; suggestion: Suggestion; commit_count: number; commits: string[] }
interface Notes { name: string; body: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// --- Views ---

function showView(id: "view-login" | "view-repos" | "view-settings") {
  for (const v of document.querySelectorAll<HTMLElement>(".view")) v.hidden = v.id !== id;
}

// --- Sign in (token comes from the gh CLI) ---

function showLogin(error: string | null) {
  showView("view-login");
  const errEl = $("login-error");
  errEl.textContent = error ?? "";
  errEl.hidden = !error;
}

async function checkAuth() {
  const status = await invoke<AuthStatus>("auth_status");
  if (status.user) enterApp(status.user);
  else showLogin(status.error);
}

// --- Repo ledger ---

let allRepos: Repo[] = [];
const statuses = new Map<string, RepoStatus>();
let currentLogin = "";

type OwnerFilter = "all" | "mine" | "orgs";
type StatusFilter = "all" | "unshipped" | "shipped" | "noreleases" | "flagged";
let ownerFilter: OwnerFilter = "all";
let statusFilter: StatusFilter = "all";

function enterApp(user: User) {
  showView("view-repos");
  currentLogin = user.login;
  $<HTMLImageElement>("avatar").src = user.avatar_url;
  $("username").textContent = user.login;
  loadRepos();
}

let renderTimer: number | undefined;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderRepos();
    summarize();
    saveStatusCache();
    syncMenuBar();
  }, 150);
}

// --- Cache: repo list for instant paint; statuses reused while pushed_at is unchanged ---

const REPOS_KEY = "unshipped:repos:v1";
const STATUS_KEY = "unshipped:statuses:v1";
const CHECKED_KEY = "unshipped:checked:v1";

// Demo mode gets its own cache namespace so canned data never mixes with real data.
let demoMode = false;
const cacheKey = (k: string) => (demoMode ? `demo:${k}` : k);

interface CachedStatus { pushed_at: string | null; status: RepoStatus }

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

let statusCache: Record<string, CachedStatus> = {};

function saveStatusCache() {
  localStorage.setItem(cacheKey(STATUS_KEY), JSON.stringify(statusCache));
}

const LANDED_MS = 1200;
const landedAt = new Map<string, number>();

function cacheStatus(repo: Repo, status: RepoStatus) {
  statuses.set(repo.full_name, status);
  statusCache[repo.full_name] = { pushed_at: repo.pushed_at, status };
  landedAt.set(repo.full_name, Date.now());
}

function seedFromCache(repos: Repo[]): Repo[] {
  const stale: Repo[] = [];
  for (const repo of repos) {
    const cached = statusCache[repo.full_name];
    if (cached && cached.pushed_at === repo.pushed_at && cached.status.ahead_by >= 0) {
      statuses.set(repo.full_name, cached.status);
    } else {
      stale.push(repo);
    }
  }
  return stale;
}

let refreshing = false;

// Mirrors the tray panel's wording so the two windows read the same.
function checkedLabel(): string {
  const iso = localStorage.getItem(cacheKey(CHECKED_KEY));
  if (!iso) return "Never checked";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "Checked just now";
  if (mins < 60) return `Checked ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `Checked ${hours}h ago` : "Checked a while ago";
}

function setRefreshLabel(text: string) {
  $("refresh-label").textContent = text;
}

function setRefreshing(on: boolean) {
  refreshing = on;
  const btn = $<HTMLButtonElement>("btn-refresh");
  btn.toggleAttribute("data-busy", on);
  btn.disabled = on;
  setRefreshLabel(on ? "Checking…" : checkedLabel());
}

async function loadRepos() {
  if (refreshing) return;
  setRefreshing(true);
  statuses.clear();

  // Paint instantly from the last run's repo list while the fresh one loads.
  const cachedRepos = readCache<Repo[]>(cacheKey(REPOS_KEY));
  if (cachedRepos) {
    allRepos = cachedRepos;
    seedFromCache(allRepos);
    renderRepos();
    // The table below is the cached one, so the caption under it says so too;
    // the refresh control is what narrates the sweep.
    summarize();
  }
  loadDeployments();

  try {
    const repos = await invoke<Repo[]>("list_repos");
    allRepos = repos.filter((r) => !r.archived);
    localStorage.setItem(cacheKey(REPOS_KEY), JSON.stringify(allRepos));
    statuses.clear();
    const stale = seedFromCache(allRepos);
    renderRepos();
    summarize();
    // Collapsed sections aren't polled; expanding one fetches what it missed.
    await fetchStatuses(stale.filter((r) => !inCollapsedSection(r)));
    renderRepos();
    summarize();
    saveStatusCache();
    // The panel is a separate window with no state of its own; it reads this.
    localStorage.setItem(cacheKey(CHECKED_KEY), new Date().toISOString());
    emit("ledger-updated");
    notifyFlagged();
  } catch (e) {
    $("repo-summary").textContent = String(e);
  } finally {
    setRefreshing(false);
  }
}

function summaryText(): string {
  const waiting = allRepos.filter(
    (r) => isWaiting(statuses.get(r.full_name), pinnedSet.has(r.full_name))
  ).length;
  const total = allRepos.length;
  const hidden = hiddenCount();
  const suffix = hidden ? ` ${hidden} hidden by settings.` : "";
  return waiting === 0
    ? `${total} repos — everything is shipped.${suffix}`
    : `${waiting} of ${total} repos have unshipped commits.${suffix}`;
}

function summarize() {
  $("repo-summary").textContent = summaryText();
}

async function fetchStatuses(repos: Repo[]) {
  const queue = [...repos];
  const total = repos.length;
  let checked = 0;
  const workers = Array.from({ length: 6 }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      try {
        const status = await invoke<RepoStatus>("repo_status", {
          owner: repo.owner.login,
          repo: repo.name,
          defaultBranch: repo.default_branch,
        });
        cacheStatus(repo, status);
      } catch {
        // Not cached — errors get retried next launch.
        statuses.set(repo.full_name, { latest_tag: null, release_url: null, published_at: null, ahead_by: -1 });
      }
      checked += 1;
      // Section back-fills also land here; only a full refresh narrates progress.
      if (refreshing && total >= 5) {
        setRefreshLabel(`Checking ${checked} of ${total}`);
      }
      scheduleRender();
    }
  });
  await Promise.all(workers);
}

// --- Argo deployments ---

interface ArgoApp {
  name: string;
  repo: string | null;
  sync: string;
  health: string;
  revision: string | null;
  url: string;
}
interface Deployments { configured: boolean; apps: ArgoApp[]; error: string | null }

let argoAppsByRepo = new Map<string, ArgoApp[]>();
let argoConfigured = false;
let deploymentsLoading = false;

const ARGO_COLUMN_KEY = "unshipped:argo-column:v1";

function setArgoColumn(on: boolean) {
  document.body.dataset.argo = on ? "on" : "off";
  localStorage.setItem(cacheKey(ARGO_COLUMN_KEY), String(on));
}

async function loadDeployments() {
  deploymentsLoading = true;
  const result = await invoke<Deployments>("argo_deployments").catch(
    (e): Deployments => ({ configured: true, apps: [], error: String(e) })
  );
  deploymentsLoading = false;

  argoConfigured = result.configured;
  setArgoColumn(result.configured);

  argoAppsByRepo = new Map();
  for (const app of result.apps) {
    if (!app.repo) continue;
    const list = argoAppsByRepo.get(app.repo) ?? [];
    list.push(app);
    argoAppsByRepo.set(app.repo, list);
  }

  // A configured-but-broken Argo otherwise looks exactly like a repo nothing deploys.
  const notice = $("argo-notice");
  notice.hidden = !result.error;
  notice.textContent = result.error
    ? `Argo CD: ${result.error} — the Deployed column stays empty until this is fixed. See Settings → Integrations.`
    : "";

  scheduleRender();
}

function appsFor(repo: Repo): ArgoApp[] {
  return argoAppsByRepo.get(repo.full_name.toLowerCase()) ?? [];
}

const HEALTH_RANK: Record<string, number> = {
  Degraded: 5, Missing: 4, Unknown: 3, Progressing: 2, Suspended: 2, Healthy: 1,
};

function deployRank(repo: Repo): number {
  const apps = appsFor(repo);
  if (!apps.length) return 0;
  let rank = Math.max(...apps.map((a) => HEALTH_RANK[a.health] ?? 3));
  if (apps.some((a) => a.sync === "OutOfSync")) rank += 0.5;
  return rank;
}

function heat(status: RepoStatus | undefined): string {
  if (!status) return "loading";
  if (status.ahead_by < 0) return "error";
  if (status.ahead_by === 0) return "shipped";
  return status.ahead_by >= 20 ? "hot" : "warm";
}

function lampText(status: RepoStatus | undefined): string {
  if (!status) return "checking";
  if (status.ahead_by < 0) return "error";
  if (status.ahead_by === 0) return "shipped";
  return `${status.ahead_by} waiting`;
}

function relAge(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function matchesOwner(repo: Repo): boolean {
  if (ownerFilter === "all") return true;
  const mine = repo.owner.login === currentLogin;
  return ownerFilter === "mine" ? mine : !mine;
}

function matchesStatus(repo: Repo, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  const status = statuses.get(repo.full_name);
  if (!status || status.ahead_by < 0) return false;
  switch (filter) {
    case "unshipped": return status.latest_tag !== null && status.ahead_by > 0;
    case "shipped": return status.latest_tag !== null && status.ahead_by === 0;
    case "noreleases": return status.latest_tag === null;
    case "flagged": return flagsFor(repo).length > 0;
  }
}

// --- Pins: shown in their own section above the list, unaffected by search/filters ---

const PINS_KEY = "unshipped:pins:v1";
let pinnedSet = new Set<string>();

function togglePin(repo: Repo) {
  if (pinnedSet.has(repo.full_name)) pinnedSet.delete(repo.full_name);
  else pinnedSet.add(repo.full_name);
  localStorage.setItem(cacheKey(PINS_KEY), JSON.stringify([...pinnedSet]));
  renderRepos();
  // A pin can put an unreleased repo in the menu bar, or take one out of it.
  syncMenuBar();
  emit("ledger-updated");
}

// --- Shipping rules ---

let rules: Rules = { ...DEFAULT_RULES };
let repoRules: Record<string, RepoRule> = {};

function flagsFor(repo: Repo): string[] {
  return flagReasons(statuses.get(repo.full_name), {
    rules,
    override: repoRules[repo.full_name],
    pinned: pinnedSet.has(repo.full_name),
  });
}

function flaggedRepos(): Repo[] {
  return allRepos.filter((r) => flagsFor(r).length > 0);
}

function pinnedRepos(): Repo[] {
  return allRepos.filter((r) => pinnedSet.has(r.full_name)).sort(compareRepos);
}

// --- Ledger visibility: settings can hide whole categories; a pin overrides ---

let hideShipped = false;
let hideNoReleases = false;

// A repo whose status hasn't loaded yet stays visible either way.
function hiddenBySettings(repo: Repo): boolean {
  const s = statuses.get(repo.full_name);
  if (!s || s.ahead_by < 0) return false;
  if (hideShipped && s.latest_tag !== null && s.ahead_by === 0) return true;
  if (hideNoReleases && s.latest_tag === null) return true;
  return false;
}

function hiddenCount(): number {
  return allRepos.filter((r) => !pinnedSet.has(r.full_name) && hiddenBySettings(r)).length;
}

function searchedRepos(): Repo[] {
  const q = $<HTMLInputElement>("search").value.toLowerCase();
  return allRepos.filter(
    (r) =>
      !pinnedSet.has(r.full_name) &&
      !hiddenBySettings(r) &&
      r.full_name.toLowerCase().includes(q)
  );
}

type SortKey = "name" | "waiting" | "tag" | "released" | "deployed";
let sortKey: SortKey = "waiting";
let sortDir: 1 | -1 = -1;
const defaultDirs: Record<SortKey, 1 | -1> = { name: 1, waiting: -1, tag: 1, released: -1, deployed: -1 };

function compareRepos(a: Repo, b: Repo): number {
  const sa = statuses.get(a.full_name);
  const sb = statuses.get(b.full_name);
  let cmp = 0;
  switch (sortKey) {
    case "name":
      cmp = a.full_name.localeCompare(b.full_name);
      break;
    case "waiting":
      cmp = (sa?.ahead_by ?? -2) - (sb?.ahead_by ?? -2);
      break;
    case "tag":
      cmp = (sa?.latest_tag ?? "").localeCompare(sb?.latest_tag ?? "", undefined, { numeric: true });
      break;
    case "released":
      cmp = (sa?.published_at ?? "").localeCompare(sb?.published_at ?? "");
      break;
    case "deployed":
      cmp = deployRank(a) - deployRank(b);
      break;
  }
  return cmp * sortDir || a.full_name.localeCompare(b.full_name);
}

function updateSortHeader() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#ledger-head button")) {
    if (btn.dataset.sort === sortKey) btn.setAttribute("data-active", sortDir === 1 ? "asc" : "desc");
    else btn.removeAttribute("data-active");
  }
}

function sortedRepos(): Repo[] {
  return searchedRepos()
    .filter((r) => matchesOwner(r) && matchesStatus(r, statusFilter))
    .sort(compareRepos);
}

function chip(label: string, count: number | null, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chip";
  btn.setAttribute("aria-pressed", String(pressed));
  btn.textContent = label;
  if (count !== null) {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = String(count);
    btn.append(c);
  }
  btn.onclick = onClick;
  return btn;
}

function renderFilters() {
  const searched = searchedRepos();

  const owners = $("owner-chips");
  owners.innerHTML = "";
  const ownerDefs: [OwnerFilter, string][] = [["all", "All"], ["mine", "Mine"], ["orgs", "Orgs"]];
  for (const [value, label] of ownerDefs) {
    const count = value === "all" ? null : searched.filter((r) =>
      value === "mine" ? r.owner.login === currentLogin : r.owner.login !== currentLogin
    ).length;
    owners.append(chip(label, count, ownerFilter === value, () => {
      ownerFilter = value;
      resetAndRender();
    }));
  }

  const scope = searched.filter(matchesOwner);
  const statusEl = $("status-chips");
  statusEl.innerHTML = "";
  const statusDefs: [StatusFilter, string][] = [
    ["all", "All"],
    ["unshipped", "Unshipped"],
    ["flagged", "Flagged"],
    ["shipped", "Shipped"],
    ["noreleases", "No releases"],
  ];
  for (const [value, label] of statusDefs) {
    // A hidden category's chip would only ever count zero.
    if ((value === "shipped" && hideShipped) || (value === "noreleases" && hideNoReleases)) continue;
    const count = value === "all" ? null : scope.filter((r) => matchesStatus(r, value)).length;
    statusEl.append(chip(label, count, statusFilter === value, () => {
      statusFilter = value;
      resetAndRender();
    }));
  }
}

const PAGE_SIZE = 20;
let visibleLimit = PAGE_SIZE;

const sentinelObserver = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) {
    visibleLimit += PAGE_SIZE;
    renderRepos();
  }
});

// Filter/search changes start back at the first page; status streaming keeps the current one.
function resetAndRender() {
  visibleLimit = PAGE_SIZE;
  renderRepos();
  summarize();
}

function buildRow(repo: Repo): HTMLElement {
  const li = document.createElement("li");
  li.className = "repo-row";
  if (flagsFor(repo).length) li.dataset.flagged = "";
  const landed = landedAt.get(repo.full_name);
  if (landed !== undefined && Date.now() - landed < LANDED_MS) li.dataset.landed = "";
  li.append(
    rowSelect(repo),
    rowName(repo),
    rowLamp(repo),
    rowTag(repo),
    rowAge(repo),
    rowDeploy(repo),
    rowActions(repo),
  );
  return li;
}

// --- Collapsible sections: collapsed repos are also skipped when polling statuses ---

type SectionId = "pinned" | "all";
const COLLAPSED_KEY = "unshipped:collapsed:v1";
let collapsedSections = new Set<SectionId>();

function sectionOf(repo: Repo): SectionId {
  return pinnedSet.has(repo.full_name) ? "pinned" : "all";
}

// "All repos" only collapses behind its header, which exists only when there
// are pins — otherwise a stale collapsed state would leave the list empty
// with nothing to click.
function inCollapsedSection(repo: Repo): boolean {
  const id = sectionOf(repo);
  if (id === "all" && pinnedSet.size === 0) return false;
  return collapsedSections.has(id);
}

function toggleSection(id: SectionId) {
  if (collapsedSections.has(id)) {
    collapsedSections.delete(id);
    // The poller skipped these while collapsed — catch up now.
    const missing = allRepos.filter(
      (r) => sectionOf(r) === id && !statuses.has(r.full_name)
    );
    if (missing.length) {
      fetchStatuses(missing).then(() => {
        renderRepos();
        summarize();
        saveStatusCache();
      });
    }
  } else {
    collapsedSections.add(id);
  }
  localStorage.setItem(cacheKey(COLLAPSED_KEY), JSON.stringify([...collapsedSections]));
  renderRepos();
}

function sectionHeader(id: SectionId, text: string, count: number): HTMLElement {
  const li = document.createElement("li");
  li.className = "section-label";
  const btn = document.createElement("button");
  btn.type = "button";
  const collapsed = collapsedSections.has(id);
  btn.setAttribute("aria-expanded", String(!collapsed));
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "▸";
  btn.append(chevron, document.createTextNode(collapsed ? `${text} (${count})` : text));
  btn.onclick = () => toggleSection(id);
  li.append(btn);
  return li;
}

function renderRepos() {
  renderFilters();
  renderTrainBar();
  sentinelObserver.disconnect();
  const list = $("repo-list");
  list.innerHTML = "";

  const pins = pinnedRepos();
  const repos = sortedRepos();
  if (pins.length) {
    list.append(sectionHeader("pinned", "Pinned", pins.length));
    if (!collapsedSections.has("pinned")) {
      for (const repo of pins) list.append(buildRow(repo));
    }
    list.append(sectionHeader("all", "All repos", repos.length));
    if (collapsedSections.has("all")) return;
  }

  for (const repo of repos.slice(0, visibleLimit)) {
    list.append(buildRow(repo));
  }
  if (repos.length > visibleLimit) {
    const sentinel = document.createElement("li");
    sentinel.className = "load-more";
    sentinel.textContent = `Showing ${visibleLimit} of ${repos.length} — scroll for more`;
    list.append(sentinel);
    sentinelObserver.observe(sentinel);
  }
}

function rowName(repo: Repo): HTMLElement {
  const el = document.createElement("span");
  el.className = "repo-name";
  const owner = document.createElement("span");
  owner.className = "owner";
  owner.textContent = `${repo.owner.login} / `;
  const link = document.createElement("a");
  link.href = "#";
  link.title = `Open ${repo.full_name} on GitHub`;
  link.append(owner, document.createTextNode(repo.name));
  link.onclick = (e) => {
    e.preventDefault();
    openUrl(repo.html_url);
  };
  el.append(link);
  return el;
}

function rowLamp(repo: Repo): HTMLElement {
  const status = statuses.get(repo.full_name);
  const el = document.createElement("span");
  el.className = "lamp";
  el.dataset.heat = heat(status);
  el.textContent = lampText(status);
  return el;
}

function skeleton(): HTMLElement {
  const el = document.createElement("span");
  el.className = "skeleton";
  return el;
}

function rowTag(repo: Repo): HTMLElement {
  const status = statuses.get(repo.full_name);
  const el = document.createElement("span");
  el.className = "repo-tag";
  if (!status) {
    el.append(skeleton());
  } else if (status.latest_tag && status.release_url) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = status.latest_tag;
    a.onclick = (e) => { e.preventDefault(); openUrl(status.release_url!); };
    el.append(a);
  } else {
    el.textContent = "no releases";
  }
  return el;
}

function rowAge(repo: Repo): HTMLElement {
  const status = statuses.get(repo.full_name);
  const el = document.createElement("span");
  el.className = "repo-age";
  if (!status) {
    el.append(skeleton());
  } else {
    el.textContent = relAge(status.published_at);
  }
  return el;
}

function rowDeploy(repo: Repo): HTMLElement {
  const el = document.createElement("span");
  el.className = "deploy";
  const apps = appsFor(repo);
  // Until Argo answers, an empty map is indistinguishable from "nothing deploys this".
  if (deploymentsLoading && !apps.length) {
    el.append(skeleton());
    return el;
  }
  if (!apps.length) {
    el.textContent = "—";
    el.title = argoConfigured
      ? `No Argo CD application points at ${repo.full_name}. Annotate the application with ` +
        `${annotationKey}: ${repo.full_name} to link it.`
      : "Argo CD isn’t configured.";
    return el;
  }

  const rank = deployRank(repo);
  el.dataset.state = rank >= 4 ? "bad" : rank > 1 ? "warn" : "ok";

  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "●";

  const worst = apps.reduce((a, b) => ((HEALTH_RANK[b.health] ?? 3) > (HEALTH_RANK[a.health] ?? 3) ? b : a));
  const outOfSync = apps.filter((a) => a.sync === "OutOfSync").length;
  const label =
    apps.length === 1
      ? worst.health + (outOfSync ? " · OutOfSync" : "")
      : `${apps.length} apps · ${worst.health}${outOfSync ? ` · ${outOfSync} OutOfSync` : ""}`;

  const link = document.createElement("a");
  link.href = "#";
  link.append(dot, document.createTextNode(label));
  link.onclick = (e) => {
    e.preventDefault();
    openUrl(worst.url);
  };
  el.append(link);
  el.title = apps
    .map((a) => `${a.name}: ${a.sync} / ${a.health}${a.revision ? ` @ ${a.revision}` : ""}`)
    .join("\n");
  return el;
}

const PIN_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
  '<path d="M4.456.734a1.75 1.75 0 0 1 2.826.504l.613 1.327a3.08 3.08 0 0 0 2.084 1.707l2.454.584c1.332.317 1.8 1.972.832 2.94L11.06 10l3.72 3.72a.75.75 0 1 1-1.061 1.06L10 11.06l-2.204 2.205c-.968.968-2.623.5-2.94-.832l-.584-2.454a3.08 3.08 0 0 0-1.707-2.084l-1.327-.613a1.75 1.75 0 0 1-.504-2.826L4.456.734Z"/></svg>';

const BELL_SVG =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">' +
  '<path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Z"/></svg>';

function rowActions(repo: Repo): HTMLElement {
  const el = document.createElement("span");
  el.className = "actions";

  const status = statuses.get(repo.full_name);
  if (status && status.ahead_by > 0) {
    const btn = document.createElement("button");
    btn.textContent = "New version…";
    btn.onclick = () => openReleaseDialog(repo);
    el.append(btn);
  }

  const reasons = flagsFor(repo);
  const flag = document.createElement("button");
  flag.className = "flag";
  flag.innerHTML = BELL_SVG;
  flag.title = reasons.length ? `Flagged — ${reasons.join(" · ")}` : "Rules for this repo…";
  flag.setAttribute("aria-pressed", String(reasons.length > 0));
  flag.onclick = () => openRepoRules(repo);
  el.append(flag);

  const isPinned = pinnedSet.has(repo.full_name);
  const pin = document.createElement("button");
  pin.className = "pin";
  pin.innerHTML = PIN_SVG;
  pin.title = isPinned ? "Unpin" : "Pin to top";
  pin.setAttribute("aria-pressed", String(isPinned));
  pin.onclick = () => togglePin(repo);
  el.append(pin);
  return el;
}

// --- Per-repo rules dialog ---

let ruleRepo: Repo | null = null;

function ruleMode(): string {
  return (
    document.querySelector<HTMLInputElement>('input[name="repo-rule-mode"]:checked')?.value ??
    "global"
  );
}

function syncRuleMode() {
  $("repo-rule-custom").hidden = ruleMode() !== "custom";
}

function openRepoRules(repo: Repo) {
  ruleRepo = repo;
  const existing = repoRules[repo.full_name];
  const reasons = flagsFor(repo);

  $("repo-rule-title").textContent = repo.full_name;
  $("repo-rule-state").textContent = reasons.length
    ? `Flagged now — ${reasons.join(" · ")}.`
    : "Not flagged at the moment.";

  const mode = existing?.muted ? "muted" : existing ? "custom" : "global";
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="repo-rule-mode"]')) {
    input.checked = input.value === mode;
  }
  $<HTMLInputElement>("repo-rule-commits").value = String(existing?.commits ?? rules.commits);
  $<HTMLInputElement>("repo-rule-days").value = String(existing?.days ?? rules.days);
  syncRuleMode();
  $<HTMLDialogElement>("rules-dialog").showModal();
}

function clampRule(id: string, fallback: number): number {
  const value = Number($<HTMLInputElement>(id).value);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

$("btn-repo-rule-save").onclick = () => {
  if (!ruleRepo) return;
  const mode = ruleMode();
  if (mode === "global") delete repoRules[ruleRepo.full_name];
  else if (mode === "muted") repoRules[ruleRepo.full_name] = { muted: true, commits: null, days: null };
  else {
    repoRules[ruleRepo.full_name] = {
      muted: false,
      commits: clampRule("repo-rule-commits", rules.commits),
      days: clampRule("repo-rule-days", rules.days),
    };
  }
  $<HTMLDialogElement>("rules-dialog").close();
  saveRules();
};

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="repo-rule-mode"]')) {
  input.onchange = syncRuleMode;
}
$<HTMLDialogElement>("rules-dialog").addEventListener("close", () => {
  ruleRepo = null;
});

// --- Release dialog ---

let currentBump: { repo: Repo; prep: ReleasePrep; tag: string } | null = null;

async function openReleaseDialog(repo: Repo) {
  const dialog = $<HTMLDialogElement>("release-dialog");
  $("rel-title").textContent = repo.full_name;
  cancelAutoClose();
  $("rel-loading").hidden = false;
  $("rel-body").hidden = true;
  $("rel-error").hidden = true;
  $("rel-success").hidden = true;
  const createBtn = $<HTMLButtonElement>("btn-create-release");
  createBtn.disabled = false;
  createBtn.textContent = "Create release";
  dialog.showModal();

  try {
    const prep = await invoke<ReleasePrep>("prepare_release", {
      owner: repo.owner.login,
      repo: repo.name,
      defaultBranch: repo.default_branch,
    });
    renderPrep(repo, prep);
  } catch (e) {
    $("rel-loading").textContent = String(e);
  }
}

function renderPrep(repo: Repo, prep: ReleasePrep) {
  $("rel-loading").hidden = true;
  $("rel-body").hidden = false;
  $("rel-reason").textContent = prep.current_tag
    ? `${prep.commit_count} commits since ${prep.current_tag}. ${prep.suggestion.reason}.`
    : `No releases yet — ${prep.commit_count} commits on ${repo.default_branch}.`;

  const commits = $("rel-commits");
  commits.innerHTML = "";
  for (const msg of prep.commits) {
    const li = document.createElement("li");
    li.textContent = msg;
    commits.append(li);
  }
  $("rel-commits-summary").textContent = `Commits (${prep.commits.length}${prep.commit_count > prep.commits.length ? ` of ${prep.commit_count}` : ""})`;
  $("rel-commits-wrap").hidden = prep.commits.length === 0;

  const choices = $("bump-choices");
  choices.innerHTML = "";
  for (const level of ["major", "minor", "patch"] as BumpLevel[]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bump";
    btn.setAttribute("role", "radio");
    const suggested = level === prep.suggestion.level;
    btn.innerHTML = `<span class="kind">${level}${suggested ? ' <span class="suggested">suggested</span>' : ""}</span><span class="ver">${prep.suggestion[level]}</span>`;
    btn.onclick = () => selectBump(repo, prep, level);
    choices.append(btn);
  }
  selectBump(repo, prep, prep.suggestion.level);
}

async function selectBump(repo: Repo, prep: ReleasePrep, level: BumpLevel) {
  const tag = prep.suggestion[level];
  currentBump = { repo, prep, tag };
  const buttons = [...$("bump-choices").querySelectorAll<HTMLButtonElement>(".bump")];
  const levels: BumpLevel[] = ["major", "minor", "patch"];
  buttons.forEach((b, i) => b.setAttribute("aria-checked", String(levels[i] === level)));

  $<HTMLInputElement>("rel-name").value = tag;
  $("notes-status").textContent = " — generating…";
  try {
    const notes = await invoke<Notes>("generate_notes", {
      owner: repo.owner.login,
      repo: repo.name,
      tagName: tag,
      defaultBranch: repo.default_branch,
      previousTag: prep.current_tag,
    });
    // A slower earlier request must not overwrite a newer selection.
    if (currentBump?.tag !== tag) return;
    $<HTMLInputElement>("rel-name").value = notes.name || tag;
    $<HTMLTextAreaElement>("rel-notes").value = notes.body;
    $("notes-status").textContent = "";
  } catch (e) {
    if (currentBump?.tag !== tag) return;
    $("notes-status").textContent = "";
    $<HTMLTextAreaElement>("rel-notes").value = "";
    showRelError(e);
  }
}

function showRelError(e: unknown) {
  const el = $("rel-error");
  el.textContent = String(e);
  el.hidden = false;
}

const AUTO_CLOSE_SECONDS = 5;
let autoCloseTimer: number | undefined;

function cancelAutoClose() {
  clearInterval(autoCloseTimer);
  autoCloseTimer = undefined;
}

function startAutoClose(hint: HTMLElement, dialog: HTMLDialogElement) {
  cancelAutoClose();
  let left = AUTO_CLOSE_SECONDS;
  hint.textContent = `Closing in ${left}…`;
  autoCloseTimer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      hint.textContent = `Closing in ${left}…`;
      return;
    }
    cancelAutoClose();
    dialog.close();
  }, 1000);
}

function showReleaseSuccess(repo: Repo, tag: string, url: string) {
  $("rel-body").hidden = true;
  $("rel-loading").hidden = true;
  $("rel-success").hidden = false;
  $("rel-success-msg").textContent = `${repo.full_name} ${tag} released`;

  const link = $<HTMLAnchorElement>("rel-done-link");
  // Opening the release cancels the countdown — the dialog shouldn't vanish mid-read.
  link.onclick = (e) => { e.preventDefault(); cancelAutoClose(); $("rel-close-hint").textContent = ""; openUrl(url); };

  startAutoClose($("rel-close-hint"), $<HTMLDialogElement>("release-dialog"));
}

$("btn-create-release").onclick = async () => {
  if (!currentBump) return;
  const { repo, tag } = currentBump;
  const btn = $<HTMLButtonElement>("btn-create-release");
  btn.disabled = true;
  btn.textContent = "Creating…";
  $("rel-error").hidden = true;
  try {
    const url = await invoke<string>("create_release", {
      owner: repo.owner.login,
      repo: repo.name,
      tagName: tag,
      defaultBranch: repo.default_branch,
      name: $<HTMLInputElement>("rel-name").value || tag,
      body: $<HTMLTextAreaElement>("rel-notes").value,
    });
    showReleaseSuccess(repo, tag, url);
    await refreshStatus(repo);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Create release";
    showRelError(e);
  }
};


// --- Selection: the rows a release train runs over ---

const TICK_SVG =
  '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16" fill="none">' +
  '<path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const GRIP_SVG =
  '<svg aria-hidden="true" width="10" height="14" viewBox="0 0 10 16" fill="currentColor">' +
  '<circle cx="3" cy="4" r="1.1"/><circle cx="7" cy="4" r="1.1"/>' +
  '<circle cx="3" cy="8" r="1.1"/><circle cx="7" cy="8" r="1.1"/>' +
  '<circle cx="3" cy="12" r="1.1"/><circle cx="7" cy="12" r="1.1"/></svg>';

const selected = new Set<string>();

function rowSelect(repo: Repo): HTMLElement {
  const status = statuses.get(repo.full_name);
  if (!status || status.ahead_by <= 0) return document.createElement("span");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tick-box";
  btn.innerHTML = TICK_SVG;
  const on = selected.has(repo.full_name);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Take out of the release train" : "Add to a release train";
  btn.onclick = () => {
    if (on) selected.delete(repo.full_name);
    else selected.add(repo.full_name);
    renderRepos();
  };
  return btn;
}

function renderTrainBar() {
  // A repo that shipped in the meantime has nothing left to release.
  for (const name of [...selected]) {
    const status = statuses.get(name);
    if (status && status.ahead_by <= 0) selected.delete(name);
  }
  $("train-bar").hidden = selected.size === 0;
  document.body.dataset.selecting = selected.size ? "on" : "off";
  $("train-count").textContent = `${selected.size} selected`;
}

/// Ledger order, then anything a filter is currently hiding — a selection made
/// before filtering must not silently drop out of the train.
function trainRepos(): Repo[] {
  const ordered = [...pinnedRepos(), ...sortedRepos(), ...allRepos];
  const seen = new Set<string>();
  const out: Repo[] = [];
  for (const repo of ordered) {
    if (!selected.has(repo.full_name) || seen.has(repo.full_name)) continue;
    seen.add(repo.full_name);
    out.push(repo);
  }
  return out;
}

async function refreshStatus(repo: Repo) {
  try {
    const status = await invoke<RepoStatus>("repo_status", {
      owner: repo.owner.login,
      repo: repo.name,
      defaultBranch: repo.default_branch,
    });
    cacheStatus(repo, status);
    scheduleRender();
  } catch {
    // The row stays as it was until the next refresh.
  }
}

// --- Release train ---

type TrainState = "queued" | "running" | "done" | "failed" | "skipped";

interface TrainEntry {
  repo: Repo;
  prep: ReleasePrep | null;
  level: BumpLevel;
  include: boolean;
  state: TrainState;
  note: string;
  url: string | null;
}

const LEVELS: BumpLevel[] = ["major", "minor", "patch"];
let train: TrainEntry[] = [];
let trainRunning = false;
let trainFinished = false;

const trainLocked = () => trainRunning || trainFinished;

async function openTrain() {
  const repos = trainRepos();
  if (!repos.length) return;

  train = repos.map((repo) => ({
    repo,
    prep: null,
    level: "patch",
    include: true,
    state: "queued",
    note: "queued",
    url: null,
  }));
  trainRunning = false;
  trainFinished = false;

  $("train-lede").textContent =
    `${repos.length} repo${repos.length === 1 ? "" : "s"}, one tag each with generated notes, cut in the order below.`;
  $("train-loading").hidden = false;
  $("train-body").hidden = true;
  $("train-error").hidden = true;
  $("train-foot-hint").textContent = "Stops on the first failure — nothing after it is tagged.";
  $<HTMLDialogElement>("train-dialog").showModal();

  await Promise.all(
    train.map(async (entry) => {
      try {
        entry.prep = await invoke<ReleasePrep>("prepare_release", {
          owner: entry.repo.owner.login,
          repo: entry.repo.name,
          defaultBranch: entry.repo.default_branch,
        });
        entry.level = entry.prep.suggestion.level;
      } catch (e) {
        entry.include = false;
        entry.state = "skipped";
        entry.note = String(e);
      }
    })
  );

  $("train-loading").hidden = true;
  $("train-body").hidden = false;
  renderTrain();
}

/// Pointer events rather than HTML5 drag and drop: WebKit will not start a drag
/// from a form control, so the grab handle never began one.
function dragRow(index: number, down: PointerEvent) {
  if (trainLocked()) return;
  down.preventDefault();

  const rows = [...$("train-rows").children] as HTMLElement[];
  const held = rows[index];
  if (!held) return;
  held.dataset.dragging = "true";
  let target = index;

  // The line goes on the edge the row will land against, so dragging onto the
  // last row marks its bottom rather than the gap the held row already sits in.
  const mark = (over: HTMLElement | null, below = false) => {
    for (const row of rows) delete row.dataset.drop;
    if (over) over.dataset.drop = below ? "below" : "above";
  };

  const onMove = (e: PointerEvent) => {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const over = under instanceof Element ? under.closest<HTMLElement>(".train-row") : null;
    if (!over || over === held) {
      target = index;
      mark(null);
      return;
    }
    target = rows.indexOf(over);
    mark(over, target > index);
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    delete held.dataset.dragging;
    mark(null);
    if (target !== index) moveTrainEntry(index, target);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function moveTrainEntry(from: number, to: number): boolean {
  if (trainLocked() || to < 0 || to >= train.length || from === to) return false;
  const [entry] = train.splice(from, 1);
  train.splice(to, 0, entry);
  renderTrain();
  return true;
}

function trainRow(entry: TrainEntry, index: number): HTMLElement {
  const li = document.createElement("li");
  li.className = "train-row";
  li.dataset.state = entry.state;
  li.dataset.include = String(entry.include);

  const grip = document.createElement("button");
  grip.type = "button";
  grip.className = "grip";
  grip.innerHTML = GRIP_SVG;
  grip.title = "Drag, or use the up and down arrows, to reorder";
  grip.setAttribute("aria-label", `Reorder ${entry.repo.full_name}`);
  grip.onkeydown = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const to = index + (e.key === "ArrowUp" ? -1 : 1);
    if (!moveTrainEntry(index, to)) return;
    $("train-rows").children[to]?.querySelector<HTMLButtonElement>(".grip")?.focus();
  };
  grip.onpointerdown = (e) => dragRow(index, e);

  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick-box";
  tick.innerHTML = TICK_SVG;
  tick.setAttribute("aria-pressed", String(entry.include));
  tick.disabled = trainLocked() || !entry.prep;
  tick.title = entry.include ? "Leave this repo out" : "Put this repo back in";
  tick.onclick = () => {
    entry.include = !entry.include;
    renderTrain();
  };

  const name = document.createElement("span");
  name.className = "repo";
  const owner = document.createElement("span");
  owner.className = "owner";
  owner.textContent = `${entry.repo.owner.login} / `;
  name.append(owner, document.createTextNode(entry.repo.name));

  const segs = document.createElement("span");
  segs.className = "segs";
  for (const level of LEVELS) {
    const seg = document.createElement("button");
    seg.type = "button";
    seg.className = "seg";
    seg.textContent = level;
    seg.setAttribute("role", "radio");
    seg.setAttribute("aria-checked", String(entry.level === level));
    seg.disabled = trainLocked() || !entry.prep;
    seg.onclick = () => {
      entry.level = level;
      renderTrain();
    };
    segs.append(seg);
  }

  const next = document.createElement("span");
  next.className = "next";
  if (entry.prep) {
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = entry.prep.current_tag ? `${entry.prep.current_tag} → ` : "first → ";
    next.append(from, document.createTextNode(entry.prep.suggestion[entry.level]));
  } else {
    next.textContent = "—";
  }

  const state = document.createElement("span");
  state.className = "state";
  state.title = entry.note;
  if (entry.state === "done" && entry.url) {
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = entry.note;
    link.onclick = (e) => {
      e.preventDefault();
      // Opening a release cancels the countdown — the dialog shouldn't vanish mid-read.
      if (autoCloseTimer !== undefined) {
        cancelAutoClose();
        $("train-foot-hint").textContent = "Close to go back to the ledger.";
      }
      openUrl(entry.url!);
    };
    state.append(link);
  } else {
    state.textContent = entry.note;
  }

  li.append(grip, tick, name, segs, next, state);
  return li;
}

function renderTrain() {
  const list = $("train-rows");
  list.innerHTML = "";
  train.forEach((entry, index) => list.append(trainRow(entry, index)));

  const runnable = train.filter((e) => e.include && e.prep).length;
  const run = $<HTMLButtonElement>("btn-train-run");
  if (trainFinished) {
    run.disabled = true;
  } else if (trainRunning) {
    run.disabled = true;
    run.textContent = "Releasing…";
  } else {
    run.disabled = runnable === 0;
    run.textContent = `Create ${runnable} release${runnable === 1 ? "" : "s"}`;
  }
  // Closing mid-train would hide a run that is still tagging repos.
  $("train-dialog").querySelector<HTMLButtonElement>(".release-head button")!.disabled = trainRunning;
}

function showTrainError(message: string) {
  const el = $("train-error");
  el.textContent = message;
  el.hidden = false;
}

async function runTrain() {
  trainRunning = true;
  $("train-error").hidden = true;
  renderTrain();

  let released = 0;
  let stopped = false;

  for (const entry of train) {
    if (!entry.include || !entry.prep) continue;
    if (stopped) {
      entry.state = "skipped";
      entry.note = "not tagged";
      continue;
    }

    const { repo, prep } = entry;
    const tag = prep.suggestion[entry.level];
    entry.state = "running";
    entry.note = "releasing…";
    renderTrain();

    try {
      const notes = await invoke<Notes>("generate_notes", {
        owner: repo.owner.login,
        repo: repo.name,
        tagName: tag,
        defaultBranch: repo.default_branch,
        previousTag: prep.current_tag,
      });
      entry.url = await invoke<string>("create_release", {
        owner: repo.owner.login,
        repo: repo.name,
        tagName: tag,
        defaultBranch: repo.default_branch,
        name: notes.name || tag,
        body: notes.body,
      });
      entry.state = "done";
      entry.note = tag;
      released += 1;
      selected.delete(repo.full_name);
      refreshStatus(repo);
    } catch (e) {
      entry.state = "failed";
      entry.note = "failed";
      stopped = true;
      showTrainError(`${repo.full_name}: ${String(e)}`);
    }
    renderTrain();
  }

  trainRunning = false;
  trainFinished = true;
  const run = $<HTMLButtonElement>("btn-train-run");
  run.textContent = released
    ? `${released} release${released === 1 ? "" : "s"} created`
    : "Nothing released";
  if (stopped) {
    $("train-foot-hint").textContent =
      "The rest were left alone — fix the failure and run another train.";
  } else {
    startAutoClose($("train-foot-hint"), $<HTMLDialogElement>("train-dialog"));
  }
  renderTrain();
  renderRepos();
  summarize();
  saveStatusCache();
}

$("btn-train").onclick = openTrain;
$("btn-train-clear").onclick = () => {
  selected.clear();
  renderRepos();
};
$("btn-train-run").onclick = runTrain;
$<HTMLDialogElement>("train-dialog").addEventListener("cancel", (e) => {
  if (trainRunning) e.preventDefault();
});
$<HTMLDialogElement>("train-dialog").addEventListener("close", () => {
  cancelAutoClose();
  train = [];
  trainRunning = false;
  trainFinished = false;
});

// --- Menu bar ---

const TRAY_REFRESH_MS = 15 * 60_000;

let menuBarOn = false;
let menuBarTimer: number | undefined;

function syncMenuBar() {
  const waiting = allRepos.filter(
    (r) => isWaiting(statuses.get(r.full_name), pinnedSet.has(r.full_name))
  ).length;
  invoke("set_menu_bar", {
    enabled: menuBarOn,
    title: allRepos.length ? String(waiting) : "…",
  }).catch(() => {});
}

function setMenuBar(on: boolean) {
  menuBarOn = on;
  clearInterval(menuBarTimer);
  // Nothing else refreshes the counts while the window is closed.
  menuBarTimer = on ? window.setInterval(loadRepos, TRAY_REFRESH_MS) : undefined;
  syncMenuBar();
}

listen<string>("tray-release", (event) => {
  const repo = allRepos.find((r) => r.full_name === event.payload);
  if (repo) openReleaseDialog(repo);
});
listen("tray-refresh", () => loadRepos());

// --- Themes ---

const THEMES = [
  { id: "harbor", label: "Harbor", dots: ["#10141a", "#f0a63c", "#4cc38a"] },
  { id: "midnight", label: "Midnight", dots: ["#05070a", "#ffb454", "#3ddc97"] },
  { id: "daylight", label: "Daylight", dots: ["#f5f3ee", "#b26e08", "#1a7f4e"] },
  { id: "dusk", label: "Dusk", dots: ["#14121d", "#c99bf5", "#52d49b"] },
  { id: "radar", label: "Radar", dots: ["#081209", "#ffc857", "#4ade80"] },
  { id: "signal", label: "Signal", dots: ["#0b1220", "#4fa3ff", "#35d0a0"] },
  { id: "copper", label: "Copper", dots: ["#171210", "#e2854a", "#56c489"] },
  { id: "paper", label: "Paper", dots: ["#f6efdf", "#a05f12", "#3f7d43"] },
  { id: "graphite", label: "Graphite", dots: ["#1f1f1f", "#f2c14e", "#56d364"] },
  { id: "lagoon", label: "Lagoon", dots: ["#06181b", "#2dd4bf", "#4ade80"] },
  { id: "blossom", label: "Blossom", dots: ["#f9eff1", "#b0325f", "#1a7f4e"] },
];
const THEME_CACHE_KEY = "unshipped:theme";
let currentTheme = localStorage.getItem(THEME_CACHE_KEY) ?? "harbor";

function applyTheme(id: string) {
  if (!THEMES.some((t) => t.id === id)) id = "harbor";
  currentTheme = id;
  document.documentElement.dataset.theme = id;
  localStorage.setItem(THEME_CACHE_KEY, id);
}

function renderThemeOptions() {
  const wrap = $("theme-options");
  wrap.innerHTML = "";
  for (const theme of THEMES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-swatch";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(theme.id === currentTheme));
    const dots = document.createElement("span");
    dots.className = "dots";
    for (const color of theme.dots) {
      const dot = document.createElement("span");
      dot.style.background = color;
      dots.append(dot);
    }
    btn.append(dots, document.createTextNode(theme.label));
    btn.onclick = () => {
      applyTheme(theme.id);
      renderThemeOptions();
      saveSettings();
    };
    wrap.append(btn);
  }
}

// --- Settings ---

interface PanelSections {
  pinned: boolean;
  waiting: boolean;
  recent: boolean;
}
interface Settings {
  argo_url: string;
  argo_insecure: boolean;
  argo_iap_client_id: string;
  argo_iap_service_account: string;
  theme: string;
  menu_bar: boolean;
  hide_shipped: boolean;
  hide_no_releases: boolean;
  shortcuts: Record<string, string>;
  panel_sections: PanelSections;
  rules: Rules;
  repo_rules: Record<string, RepoRule>;
}

let panelSections: PanelSections = { pinned: true, waiting: true, recent: true };
interface Unlinked { name: string; repo_urls: string[] }
interface AppReport {
  total: number;
  linked: number;
  by_annotation: number;
  repos: number;
  unlinked: Unlinked[];
  unlinked_total: number;
  error: string | null;
}
interface ArgoCheck {
  configured: boolean;
  reachable: boolean;
  logged_in: boolean;
  username: string | null;
  auth: "token" | "iap" | null;
  error: string | null;
  apps: AppReport | null;
}

let annotationKey = "unshipped.dev/repo";

function showSettingsSection(section: string) {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".settings-nav button")) {
    if (btn.dataset.section === section) btn.setAttribute("data-active", "");
    else btn.removeAttribute("data-active");
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".settings-panel")) {
    panel.hidden = panel.id !== `panel-${section}`;
  }
}

function currentSettings(): Settings {
  const iap = $<HTMLInputElement>("argo-iap").checked;
  return {
    argo_url: $<HTMLInputElement>("argo-url").value.trim(),
    argo_insecure: $<HTMLInputElement>("argo-insecure").checked,
    argo_iap_client_id: iap ? $<HTMLInputElement>("argo-iap-client").value.trim() : "",
    argo_iap_service_account: iap ? $<HTMLInputElement>("argo-iap-sa").value.trim() : "",
    theme: currentTheme,
    menu_bar: menuBarOn,
    hide_shipped: hideShipped,
    hide_no_releases: hideNoReleases,
    shortcuts: shortcutOverrides,
    panel_sections: panelSections,
    rules,
    repo_rules: repoRules,
  };
}

// Saves are chained: two quick toggles fired concurrently can land on disk
// out of order, persisting the older state.
let saveChain: Promise<unknown> = Promise.resolve();
function saveSettings(): Promise<unknown> {
  const snap = currentSettings();
  saveChain = saveChain.catch(() => {}).then(() => invoke("save_settings", { new: snap }));
  return saveChain;
}

// --- Shipping rules: settings panel ---

function saveRules() {
  saveSettings().catch(() => {});
  renderRepos();
  syncMenuBar();
  emit("ledger-updated");
  if (!$("panel-rules").hidden) renderRulesPanel();
}

function renderOverrides() {
  const list = $("rule-overrides");
  list.innerHTML = "";
  const entries = Object.entries(repoRules).sort(([a], [b]) => a.localeCompare(b));
  list.hidden = entries.length === 0;
  $("rule-overrides-note").textContent = entries.length
    ? "Set one from the bell on any row in the ledger."
    : "None yet — set one from the bell on any row in the ledger.";

  for (const [full, rule] of entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "override-name";
    name.textContent = full;
    const value = document.createElement("span");
    value.className = "override-value mono";
    value.textContent = overrideText(rule);
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "ghost";
    drop.textContent = "Remove";
    drop.onclick = () => {
      delete repoRules[full];
      saveRules();
    };
    li.append(name, value, drop);
    list.append(li);
  }
}

function renderRulesPanel() {
  $<HTMLInputElement>("rule-commits-on").checked = rules.commits_enabled;
  $<HTMLInputElement>("rule-commits").value = String(rules.commits);
  $<HTMLInputElement>("rule-commits").disabled = !rules.commits_enabled;
  $<HTMLInputElement>("rule-days-on").checked = rules.days_enabled;
  $<HTMLInputElement>("rule-days").value = String(rules.days);
  $<HTMLInputElement>("rule-days").disabled = !rules.days_enabled;
  $<HTMLInputElement>("rule-breaking").checked = rules.breaking;
  $<HTMLInputElement>("rule-notify").checked = rules.notify;
  $<HTMLInputElement>("rule-pinned-only").checked = rules.pinned_only;

  const flagged = flaggedRepos().length;
  $("rule-pinned-note").textContent = allRepos.length
    ? `${pinnedSet.size} of ${allRepos.length} repos are pinned. ${flagged} flagged right now.`
    : "";
  renderOverrides();
}

function wireRule(id: string, apply: (on: boolean) => void) {
  $<HTMLInputElement>(id).onchange = (e) => {
    apply((e.target as HTMLInputElement).checked);
    saveRules();
  };
}

function wireThreshold(id: string, apply: (value: number) => void, fallback: () => number) {
  $<HTMLInputElement>(id).onchange = () => {
    apply(clampRule(id, fallback()));
    saveRules();
  };
}

wireRule("rule-commits-on", (on) => {
  rules.commits_enabled = on;
});
wireRule("rule-days-on", (on) => {
  rules.days_enabled = on;
});
wireRule("rule-breaking", (on) => {
  rules.breaking = on;
});
wireRule("rule-pinned-only", (on) => {
  rules.pinned_only = on;
});
wireThreshold("rule-commits", (v) => {
  rules.commits = v;
}, () => DEFAULT_RULES.commits);
wireThreshold("rule-days", (v) => {
  rules.days = v;
}, () => DEFAULT_RULES.days);

$<HTMLInputElement>("rule-notify").onchange = async (e) => {
  const box = e.target as HTMLInputElement;
  if (box.checked && !(await isPermissionGranted().catch(() => false))) {
    const granted = await requestPermission().catch(() => "denied");
    if (granted !== "granted") {
      box.checked = false;
      $("rule-notify-note").textContent =
        "macOS is not letting unshipped send notifications — turn them on in System Settings → Notifications.";
      return;
    }
  }
  rules.notify = box.checked;
  saveRules();
};

// --- Shipping rules: notifications ---

const NOTIFIED_KEY = "unshipped:notified:v1";
const DAY_MS = 86_400_000;

async function notifyFlagged() {
  if (!rules.notify) return;
  // The ledger is the notification when the window is there to read.
  if (await getCurrentWindow().isVisible().catch(() => true)) return;
  if (!(await isPermissionGranted().catch(() => false))) return;

  const sent = readCache<Record<string, number>>(cacheKey(NOTIFIED_KEY)) ?? {};
  const now = Date.now();
  const due = flaggedRepos().filter((r) => now - (sent[r.full_name] ?? 0) >= DAY_MS);
  if (!due.length) return;

  if (due.length <= 2) {
    for (const repo of due) {
      sendNotification({ title: repo.full_name, body: flagsFor(repo).join(" · ") });
    }
  } else {
    const names = due.slice(0, 4).map((r) => r.name).join(", ");
    sendNotification({
      title: `${due.length} repos have tripped a rule`,
      body: due.length > 4 ? `${names} and ${due.length - 4} more` : names,
    });
  }

  for (const repo of due) sent[repo.full_name] = now;
  localStorage.setItem(cacheKey(NOTIFIED_KEY), JSON.stringify(sent));
}

// --- The three setup steps ---

type StepState = "idle" | "ok" | "todo" | "bad";

function setStep(id: string, state: StepState, note: string) {
  const step = $(`step-${id}`);
  step.dataset.state = state;
  step.querySelector(".step-state")!.textContent = note;
}

// Errors belong to the step that produced them, not to a footer far below it.
function setError(id: string, message: string | null) {
  const el = $(id);
  el.textContent = message ?? "";
  el.hidden = !message;
}

function resetSteps() {
  for (const id of ["server", "auth", "match"]) setStep(id, "idle", "");
  for (const id of ["server-error", "auth-error", "argo-error"]) setError(id, null);
  $("match-report").hidden = true;
  $("argo-connected").hidden = true;
  $("argo-auth").hidden = false;
}

function renderCheck(check: ArgoCheck) {
  resetSteps();
  $("auth-iap-note").hidden = !$<HTMLInputElement>("argo-iap").checked;

  if (!check.configured) {
    setStep("server", "todo", "Needs a server URL");
    setStep("auth", "idle", "Waiting on step 1");
    setStep("match", "idle", "Waiting on step 2");
    return;
  }

  if (!check.reachable) {
    setStep("server", "bad", "Can’t reach it");
    setError("server-error", check.error);
    setStep("auth", "idle", "Waiting on step 1");
    setStep("match", "idle", "Waiting on step 2");
    return;
  }
  setStep("server", "ok", "Reachable");

  if (!check.logged_in) {
    setStep("auth", "todo", "Not signed in");
    setError("auth-error", check.error);
    setStep("match", "idle", "Waiting on step 2");
    return;
  }
  const via = check.auth === "iap" ? "the IAP identity" : "a stored credential";
  $("argo-status-text").textContent = `Signed in as ${check.username ?? "unknown"} via ${via}.`;
  $("argo-connected").hidden = false;
  $("argo-auth").hidden = true;
  setStep("auth", "ok", "Signed in");

  renderMatchReport(check.apps);
}

function renderMatchReport(report: AppReport | null) {
  const wrap = $("match-report");
  wrap.hidden = !report;
  if (!report) {
    setStep("match", "idle", "Waiting on step 2");
    return;
  }

  const summary = $("match-summary");
  if (report.error) {
    setStep("match", "bad", "Can’t list applications");
    summary.textContent = report.error;
    summary.dataset.error = "";
    $("unlinked-details").hidden = true;
    return;
  }
  delete summary.dataset.error;

  const annotated = report.by_annotation ? ` (${report.by_annotation} by annotation)` : "";
  summary.textContent =
    `${report.total} application${report.total === 1 ? "" : "s"} · ` +
    `${report.linked} linked to ${report.repos} repo${report.repos === 1 ? "" : "s"}${annotated} · ` +
    `${report.unlinked_total} unlinked`;

  if (report.total === 0) setStep("match", "todo", "No applications visible");
  else if (report.linked === 0) setStep("match", "bad", "Nothing linked");
  else setStep("match", report.unlinked_total ? "todo" : "ok", `${report.linked} of ${report.total} linked`);

  const details = $<HTMLDetailsElement>("unlinked-details");
  details.hidden = report.unlinked_total === 0;
  if (!report.unlinked_total) return;

  const shown = report.unlinked.length;
  $("unlinked-summary").textContent =
    shown < report.unlinked_total
      ? `Unlinked applications (first ${shown} of ${report.unlinked_total})`
      : `Unlinked applications (${report.unlinked_total})`;

  const list = $("unlinked-list");
  list.innerHTML = "";
  for (const app of report.unlinked) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "unlinked-name mono";
    name.textContent = app.name;
    const from = document.createElement("span");
    from.className = "unlinked-src mono";
    from.textContent = app.repo_urls.length ? app.repo_urls.join(", ") : "no git source";
    li.append(name, from);
    list.append(li);
  }
}

async function runCheck() {
  const btn = $<HTMLButtonElement>("btn-argo-check");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    await saveSettings();
    renderCheck(await invoke<ArgoCheck>("argo_check"));
  } catch (e) {
    setError("argo-error", String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = "Check setup";
  }
}

async function connect(action: () => Promise<ArgoCheck>) {
  setError("auth-error", null);
  try {
    await saveSettings();
    renderCheck(await action());
  } catch (e) {
    setError("auth-error", String(e));
  }
}

async function openSettings() {
  resetSteps();
  showSettingsSection("appearance");
  showView("view-settings");

  const s = await invoke<Settings>("get_settings");
  $<HTMLInputElement>("argo-url").value = s.argo_url;
  $<HTMLInputElement>("argo-insecure").checked = s.argo_insecure;
  $<HTMLInputElement>("argo-iap").checked = !!s.argo_iap_client_id;
  $<HTMLInputElement>("argo-iap-client").value = s.argo_iap_client_id;
  $<HTMLInputElement>("argo-iap-sa").value = s.argo_iap_service_account;
  $("iap-fields").hidden = !s.argo_iap_client_id;
  $<HTMLInputElement>("menu-bar-toggle").checked = s.menu_bar;
  $<HTMLInputElement>("hide-shipped").checked = hideShipped;
  $<HTMLInputElement>("hide-noreleases").checked = hideNoReleases;
  $<HTMLInputElement>("panel-sec-pinned").checked = panelSections.pinned;
  $<HTMLInputElement>("panel-sec-waiting").checked = panelSections.waiting;
  $<HTMLInputElement>("panel-sec-recent").checked = panelSections.recent;
  recordingFor = null;
  renderShortcutRows();
  renderRulesPanel();
  renderThemeOptions();

  renderCheck(await invoke<ArgoCheck>("argo_check"));
}

$("btn-settings").onclick = () => {
  setMenu(false);
  openSettings();
};
$<HTMLInputElement>("argo-iap").onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  $("iap-fields").hidden = !on;
  $("auth-iap-note").hidden = !on;
};
$<HTMLInputElement>("menu-bar-toggle").onchange = (e) => {
  setMenuBar((e.target as HTMLInputElement).checked);
  saveSettings();
};
function wireHideToggle(id: string, apply: (on: boolean) => void, filter: StatusFilter) {
  $<HTMLInputElement>(id).onchange = (e) => {
    apply((e.target as HTMLInputElement).checked);
    // The active chip may have just been hidden along with its repos.
    if (statusFilter === filter && (e.target as HTMLInputElement).checked) statusFilter = "all";
    saveSettings();
    resetAndRender();
  };
}
wireHideToggle("hide-shipped", (on) => (hideShipped = on), "shipped");
wireHideToggle("hide-noreleases", (on) => (hideNoReleases = on), "noreleases");

for (const key of ["pinned", "waiting", "recent"] as const) {
  $<HTMLInputElement>(`panel-sec-${key}`).onchange = (e) => {
    panelSections[key] = (e.target as HTMLInputElement).checked;
    saveSettings();
    // The panel re-renders on this event, so an open panel updates live.
    emit("ledger-updated");
  };
}
$("btn-argo-check").onclick = runCheck;
$("btn-argo-login").onclick = () =>
  connect(() =>
    invoke<ArgoCheck>("argo_login", {
      username: $<HTMLInputElement>("argo-user").value.trim(),
      password: $<HTMLInputElement>("argo-pass").value,
    })
  );
$("btn-argo-token").onclick = () =>
  connect(() =>
    invoke<ArgoCheck>("argo_set_token", { token: $<HTMLInputElement>("argo-token").value })
  );
$("btn-argo-disconnect").onclick = async () => {
  await invoke("argo_disconnect");
  await runCheck();
};

invoke<string>("argo_repo_annotation").then((key) => {
  annotationKey = key;
  $("annotation-snippet").textContent =
    `metadata:\n  annotations:\n    ${key}: owner/repo`;
});

function closeSettings() {
  saveSettings().catch(() => {}).then(loadDeployments);
  showView("view-repos");
}

$("btn-settings-back").onclick = closeSettings;
for (const btn of document.querySelectorAll<HTMLButtonElement>(".settings-nav button")) {
  btn.onclick = () => showSettingsSection(btn.dataset.section!);
}

import("@tauri-apps/api/app").then(async ({ getVersion }) => {
  $("app-version").textContent = `v${await getVersion()}`;
}).catch(() => {});

// --- Wiring ---

const profileDropdown = $("profile-dropdown");

function setMenu(open: boolean) {
  profileDropdown.hidden = !open;
  $("btn-profile").setAttribute("aria-expanded", String(open));
}

$("btn-profile").onclick = (e) => {
  e.stopPropagation();
  setMenu(Boolean(profileDropdown.hidden));
};
document.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  setMenu(false);
  if (!$("view-settings").hidden) closeSettings();
});

// --- Keyboard shortcuts ---

interface ShortcutDef { id: string; label: string; combo: string; run: () => void }

const SHORTCUTS: ShortcutDef[] = [
  { id: "refresh", label: "Refresh repos", combo: "Cmd+R", run: () => loadRepos() },
  { id: "search", label: "Focus the filter", combo: "Cmd+F", run: () => $<HTMLInputElement>("search").select() },
  { id: "train", label: "Open the release train", combo: "Cmd+T", run: () => { if (selected.size) openTrain(); } },
  { id: "clear-selection", label: "Clear selected repos", combo: "Cmd+Shift+K", run: () => { selected.clear(); renderRepos(); } },
  {
    id: "settings", label: "Open or close settings", combo: "Cmd+,",
    run: () => ($("view-settings").hidden ? openSettings() : closeSettings()),
  },
];

let shortcutOverrides: Record<string, string> = {};
let recordingFor: string | null = null;

const effectiveCombo = (def: ShortcutDef) => shortcutOverrides[def.id] ?? def.combo;

// e.key shifts with modifiers ("," becomes "<"), so combos are built from e.code.
function keyName(e: KeyboardEvent): string | null {
  const c = e.code;
  if (/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(c)) return null;
  if (c.startsWith("Key")) return c.slice(3);
  if (c.startsWith("Digit")) return c.slice(5);
  const named: Record<string, string> = {
    Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[",
    BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`", Minus: "-", Equal: "=",
  };
  return named[c] ?? c;
}

function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  return [
    e.metaKey ? "Cmd" : "",
    e.ctrlKey ? "Ctrl" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
    key,
  ].filter(Boolean).join("+");
}

const KEY_SYMBOLS: Record<string, string> = { Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const comboKeys = (combo: string) => combo.split("+").map((p) => KEY_SYMBOLS[p] ?? p);
const prettyCombo = (combo: string) => comboKeys(combo).join("");

function syncShortcutHints() {
  const refresh = SHORTCUTS.find((d) => d.id === "refresh")!;
  const btn = $("btn-refresh");
  btn.title = `Refresh repos (${prettyCombo(effectiveCombo(refresh))})`;
  btn.setAttribute("aria-label", btn.title);
}

function renderShortcutRows() {
  const list = $("shortcut-rows");
  list.innerHTML = "";
  for (const def of SHORTCUTS) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = def.label;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shortcut-btn";
    if (recordingFor === def.id) {
      btn.textContent = "Press keys…";
      btn.setAttribute("data-recording", "");
    } else {
      for (const key of comboKeys(effectiveCombo(def))) {
        const cap = document.createElement("kbd");
        cap.textContent = key;
        btn.append(cap);
      }
      if (shortcutOverrides[def.id]) btn.title = `Default: ${prettyCombo(def.combo)}`;
    }
    btn.onclick = (e) => {
      e.stopPropagation();
      recordingFor = recordingFor === def.id ? null : def.id;
      $("shortcut-note").textContent = "";
      renderShortcutRows();
    };
    li.append(label, btn);
    list.append(li);
  }
}

function finishRecording() {
  recordingFor = null;
  $("shortcut-note").textContent = "";
  saveSettings();
  renderShortcutRows();
  syncShortcutHints();
}

// Capture phase, so a recorded Escape never reaches the settings-closing handler.
document.addEventListener("keydown", (e) => {
  if (!recordingFor) return;
  e.preventDefault();
  e.stopPropagation();
  const def = SHORTCUTS.find((d) => d.id === recordingFor)!;
  if (e.key === "Escape") {
    recordingFor = null;
    $("shortcut-note").textContent = "";
    renderShortcutRows();
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    delete shortcutOverrides[def.id];
    finishRecording();
    return;
  }
  const combo = comboFromEvent(e);
  if (!combo) return;
  const clash = SHORTCUTS.find((d) => d.id !== def.id && effectiveCombo(d) === combo);
  if (clash) {
    $("shortcut-note").textContent = `${prettyCombo(combo)} already runs “${clash.label}” — still recording.`;
    return;
  }
  if (combo === def.combo) delete shortcutOverrides[def.id];
  else shortcutOverrides[def.id] = combo;
  finishRecording();
}, true);

document.addEventListener("keydown", (e) => {
  if (recordingFor) return;
  if (!$("view-login").hidden) return;
  // A dialog owns the keyboard — refreshing under a running train would be chaos.
  if (document.querySelector("dialog[open]")) return;
  const combo = comboFromEvent(e);
  if (!combo) return;
  const def = SHORTCUTS.find((d) => effectiveCombo(d) === combo);
  if (!def) return;
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  if (typing && !e.metaKey && !e.ctrlKey) return;
  e.preventDefault();
  def.run();
});

$("btn-refresh").onclick = loadRepos;
function syncSearchClear() {
  $("btn-search-clear").hidden = $<HTMLInputElement>("search").value.length === 0;
}
$("search").oninput = () => {
  syncSearchClear();
  resetAndRender();
};
$("btn-search-clear").onclick = () => {
  const input = $<HTMLInputElement>("search");
  input.value = "";
  syncSearchClear();
  resetAndRender();
  input.focus();
};
$("btn-retry").onclick = checkAuth;
for (const btn of document.querySelectorAll<HTMLButtonElement>("#ledger-head button")) {
  btn.onclick = () => {
    const key = btn.dataset.sort as SortKey;
    if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
    else {
      sortKey = key;
      sortDir = defaultDirs[key];
    }
    updateSortHeader();
    resetAndRender();
  };
}
updateSortHeader();
$<HTMLDialogElement>("release-dialog").addEventListener("close", () => {
  currentBump = null;
  cancelAutoClose();
});

applyTheme(currentTheme);
// settings.json is the source of truth; the localStorage copy only avoids a flash at boot.
invoke<Settings>("get_settings").then((s) => {
  if (s.theme !== currentTheme) applyTheme(s.theme);
  rules = { ...DEFAULT_RULES, ...s.rules };
  repoRules = s.repo_rules ?? {};
  panelSections = { ...panelSections, ...s.panel_sections };
  hideShipped = s.hide_shipped;
  hideNoReleases = s.hide_no_releases;
  shortcutOverrides = s.shortcuts ?? {};
  syncShortcutHints();
  setMenuBar(s.menu_bar);
  if (allRepos.length) renderRepos();
});
// "Checked 4 min ago" goes stale on its own; nothing else redraws it between sweeps.
setInterval(() => {
  if (!refreshing) setRefreshLabel(checkedLabel());
}, 30_000);

(async () => {
  demoMode = await invoke<boolean>("is_demo").catch(() => false);
  statusCache = readCache<Record<string, CachedStatus>>(cacheKey(STATUS_KEY)) ?? {};
  setArgoColumn(localStorage.getItem(cacheKey(ARGO_COLUMN_KEY)) === "true");
  pinnedSet = new Set(readCache<string[]>(cacheKey(PINS_KEY)) ?? []);
  collapsedSections = new Set(readCache<SectionId[]>(cacheKey(COLLAPSED_KEY)) ?? []);
  checkAuth();
})();
