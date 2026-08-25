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

function showView(id: "view-login" | "view-repos") {
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

interface CachedStatus { pushed_at: string | null; status: RepoStatus }

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

let statusCache: Record<string, CachedStatus> =
  readCache<Record<string, CachedStatus>>(STATUS_KEY) ?? {};

function saveStatusCache() {
  localStorage.setItem(STATUS_KEY, JSON.stringify(statusCache));
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
  const cachedRepos = readCache<Repo[]>(REPOS_KEY);
  if (cachedRepos) {
    allRepos = cachedRepos;
    seedFromCache(allRepos);
    renderRepos();
  }
  $("repo-summary").textContent = "Refreshing repos…";

  try {
    const repos = await invoke<Repo[]>("list_repos");
    allRepos = repos.filter((r) => !r.archived);
    localStorage.setItem(REPOS_KEY, JSON.stringify(allRepos));
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

function searchedRepos(): Repo[] {
  const q = $<HTMLInputElement>("search").value.toLowerCase();
  return allRepos.filter((r) => r.full_name.toLowerCase().includes(q));
}

function sortedRepos(): Repo[] {
  return searchedRepos()
    .filter((r) => matchesOwner(r) && matchesStatus(r, statusFilter))
    .sort((a, b) => {
      const sa = statuses.get(a.full_name)?.ahead_by ?? -2;
      const sb = statuses.get(b.full_name)?.ahead_by ?? -2;
      return sb - sa || a.full_name.localeCompare(b.full_name);
    });
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

function renderRepos() {
  renderFilters();
  sentinelObserver.disconnect();
  const list = $("repo-list");
  list.innerHTML = "";
  const repos = sortedRepos();
  for (const repo of repos.slice(0, visibleLimit)) {
    const li = document.createElement("li");
    li.className = "repo-row";
    li.append(
      rowName(repo),
      rowLamp(repo),
      rowTag(repo),
      rowAge(repo),
      rowActions(repo),
    );
    list.append(li);
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
  return el;
}

// --- Release dialog ---

let currentBump: { repo: Repo; prep: ReleasePrep; tag: string } | null = null;

async function openReleaseDialog(repo: Repo) {
  const dialog = $<HTMLDialogElement>("release-dialog");
  $("rel-title").textContent = repo.full_name;
  $("rel-loading").hidden = false;
  $("rel-body").hidden = true;
  $("rel-error").hidden = true;
  $<HTMLAnchorElement>("rel-done-link").hidden = true;
  $<HTMLButtonElement>("btn-create-release").disabled = false;
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
    btn.textContent = "Released ✓";
    const link = $<HTMLAnchorElement>("rel-done-link");
    link.hidden = false;
    link.onclick = (e) => { e.preventDefault(); openUrl(url); };
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

// --- Wiring ---

$("btn-refresh").onclick = loadRepos;
$("search").oninput = resetAndRender;
$("btn-retry").onclick = checkAuth;
$<HTMLDialogElement>("release-dialog").addEventListener("close", () => {
  currentBump = null;
});

checkAuth();
