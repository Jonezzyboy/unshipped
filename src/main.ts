import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

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
type StatusFilter = "all" | "unshipped" | "shipped" | "noreleases";
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
  }, 150);
}

// --- Cache: repo list for instant paint; statuses reused while pushed_at is unchanged ---

const REPOS_KEY = "unshipped:repos:v1";
const STATUS_KEY = "unshipped:statuses:v1";

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

function cacheStatus(repo: Repo, status: RepoStatus) {
  statuses.set(repo.full_name, status);
  statusCache[repo.full_name] = { pushed_at: repo.pushed_at, status };
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

async function loadRepos() {
  statuses.clear();

  // Paint instantly from the last run's repo list while the fresh one loads.
  const cachedRepos = readCache<Repo[]>(cacheKey(REPOS_KEY));
  if (cachedRepos) {
    allRepos = cachedRepos;
    seedFromCache(allRepos);
    renderRepos();
  }
  $("repo-summary").textContent = "Refreshing repos…";
  loadDeployments();

  try {
    const repos = await invoke<Repo[]>("list_repos");
    allRepos = repos.filter((r) => !r.archived);
    localStorage.setItem(cacheKey(REPOS_KEY), JSON.stringify(allRepos));
    statuses.clear();
    const stale = seedFromCache(allRepos);
    renderRepos();
    summarize();
    await fetchStatuses(stale);
    renderRepos();
    summarize();
    saveStatusCache();
  } catch (e) {
    $("repo-summary").textContent = String(e);
  }
}

function summarize() {
  const waiting = [...statuses.values()].filter((s) => s.ahead_by > 0).length;
  const total = allRepos.length;
  $("repo-summary").textContent =
    waiting === 0
      ? `${total} repos — everything is shipped.`
      : `${waiting} of ${total} repos have unshipped commits.`;
}

async function fetchStatuses(repos: Repo[]) {
  const queue = [...repos];
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

const ARGO_COLUMN_KEY = "unshipped:argo-column:v1";

function setArgoColumn(on: boolean) {
  document.body.dataset.argo = on ? "on" : "off";
  localStorage.setItem(cacheKey(ARGO_COLUMN_KEY), String(on));
}

async function loadDeployments() {
  const result = await invoke<Deployments>("argo_deployments").catch(
    (e): Deployments => ({ configured: true, apps: [], error: String(e) })
  );

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
  if (!status) return "…";
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
}

function pinnedRepos(): Repo[] {
  return allRepos.filter((r) => pinnedSet.has(r.full_name)).sort(compareRepos);
}

function searchedRepos(): Repo[] {
  const q = $<HTMLInputElement>("search").value.toLowerCase();
  return allRepos.filter(
    (r) => !pinnedSet.has(r.full_name) && r.full_name.toLowerCase().includes(q)
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
    ["shipped", "Shipped"],
    ["noreleases", "No releases"],
  ];
  for (const [value, label] of statusDefs) {
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
  li.append(
    rowName(repo),
    rowLamp(repo),
    rowTag(repo),
    rowAge(repo),
    rowDeploy(repo),
    rowActions(repo),
  );
  return li;
}

function sectionLabel(text: string): HTMLElement {
  const li = document.createElement("li");
  li.className = "section-label";
  li.textContent = text;
  return li;
}

function renderRepos() {
  renderFilters();
  sentinelObserver.disconnect();
  const list = $("repo-list");
  list.innerHTML = "";

  const pins = pinnedRepos();
  if (pins.length) {
    list.append(sectionLabel("Pinned"));
    for (const repo of pins) list.append(buildRow(repo));
    list.append(sectionLabel("All repos"));
  }

  const repos = sortedRepos();
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
  el.append(owner, document.createTextNode(repo.name));
  el.title = repo.full_name;
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

function rowTag(repo: Repo): HTMLElement {
  const status = statuses.get(repo.full_name);
  const el = document.createElement("span");
  el.className = "repo-tag";
  if (status?.latest_tag && status.release_url) {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = status.latest_tag;
    a.onclick = (e) => { e.preventDefault(); openUrl(status.release_url!); };
    el.append(a);
  } else if (status) {
    el.textContent = "no releases";
  }
  return el;
}

function rowAge(repo: Repo): HTMLElement {
  const el = document.createElement("span");
  el.className = "repo-age";
  el.textContent = relAge(statuses.get(repo.full_name)?.published_at ?? null);
  return el;
}

function rowDeploy(repo: Repo): HTMLElement {
  const el = document.createElement("span");
  el.className = "deploy";
  const apps = appsFor(repo);
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

function showReleaseSuccess(repo: Repo, tag: string, url: string) {
  $("rel-body").hidden = true;
  $("rel-loading").hidden = true;
  $("rel-success").hidden = false;
  $("rel-success-msg").textContent = `${repo.full_name} ${tag} released`;

  const link = $<HTMLAnchorElement>("rel-done-link");
  // Opening the release cancels the countdown — the dialog shouldn't vanish mid-read.
  link.onclick = (e) => { e.preventDefault(); cancelAutoClose(); $("rel-close-hint").textContent = ""; openUrl(url); };

  const hint = $("rel-close-hint");
  let left = AUTO_CLOSE_SECONDS;
  hint.textContent = `Closing in ${left}…`;
  autoCloseTimer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      hint.textContent = `Closing in ${left}…`;
      return;
    }
    cancelAutoClose();
    $<HTMLDialogElement>("release-dialog").close();
  }, 1000);
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
    // Refresh this repo's row — it just shipped.
    const status = await invoke<RepoStatus>("repo_status", {
      owner: repo.owner.login,
      repo: repo.name,
      defaultBranch: repo.default_branch,
    });
    cacheStatus(repo, status);
    scheduleRender();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Create release";
    showRelError(e);
  }
};

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
      invoke("save_settings", { new: currentSettings() });
    };
    wrap.append(btn);
  }
}

// --- Settings ---

interface Settings {
  argo_url: string;
  argo_insecure: boolean;
  argo_iap_client_id: string;
  argo_iap_service_account: string;
  theme: string;
}
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
  };
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
    await invoke("save_settings", { new: currentSettings() });
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
    await invoke("save_settings", { new: currentSettings() });
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
  invoke("save_settings", { new: currentSettings() }).catch(() => {}).then(loadDeployments);
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

$("btn-refresh").onclick = loadRepos;
$("search").oninput = resetAndRender;
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
});
(async () => {
  demoMode = await invoke<boolean>("is_demo").catch(() => false);
  statusCache = readCache<Record<string, CachedStatus>>(cacheKey(STATUS_KEY)) ?? {};
  setArgoColumn(localStorage.getItem(cacheKey(ARGO_COLUMN_KEY)) === "true");
  pinnedSet = new Set(readCache<string[]>(cacheKey(PINS_KEY)) ?? []);
  checkAuth();
})();
