import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

interface User { login: string; avatar_url: string }
interface AuthStatus { user: User | null; client_id: string | null }
interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
}
interface Repo {
  name: string;
  full_name: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  html_url: string;
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

// --- Sign in ---

async function initLogin(clientId: string | null) {
  showView("view-login");
  const input = $<HTMLInputElement>("client-id");
  if (clientId) input.value = clientId;

  $("btn-signin").onclick = async () => {
    const id = input.value.trim();
    const errEl = $("login-error");
    errEl.hidden = true;
    if (!id) {
      errEl.textContent = "Enter your OAuth app client ID first.";
      errEl.hidden = false;
      return;
    }
    try {
      const code = await invoke<DeviceCode>("start_device_flow", { clientId: id });
      $("login-step-id").hidden = true;
      $("login-step-code").hidden = false;
      $("user-code").textContent = code.user_code;
      $("verify-host").textContent = code.verification_uri.replace(/^https?:\/\//, "");
      $("btn-open-verify").onclick = () => openUrl(code.verification_uri);
      const user = await invoke<User>("poll_device_flow", {
        clientId: id,
        deviceCode: code.device_code,
        interval: code.interval,
      });
      enterApp(user);
    } catch (e) {
      $("login-step-id").hidden = false;
      $("login-step-code").hidden = true;
      errEl.textContent = String(e);
      errEl.hidden = false;
    }
  };
}

// --- Repo ledger ---

let allRepos: Repo[] = [];
const statuses = new Map<string, RepoStatus>();

function enterApp(user: User) {
  showView("view-repos");
  $<HTMLImageElement>("avatar").src = user.avatar_url;
  $("username").textContent = user.login;
  loadRepos();
}

async function loadRepos() {
  const list = $("repo-list");
  list.innerHTML = "";
  statuses.clear();
  $("repo-summary").textContent = "Loading repos…";
  try {
    const repos = await invoke<Repo[]>("list_repos");
    allRepos = repos.filter((r) => !r.archived);
    renderRepos();
    await fetchStatuses();
    renderRepos();
    summarize();
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

async function fetchStatuses() {
  const queue = [...allRepos];
  const workers = Array.from({ length: 6 }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      try {
        const status = await invoke<RepoStatus>("repo_status", {
          owner: repo.owner.login,
          repo: repo.name,
          defaultBranch: repo.default_branch,
        });
        statuses.set(repo.full_name, status);
      } catch {
        statuses.set(repo.full_name, { latest_tag: null, release_url: null, published_at: null, ahead_by: -1 });
      }
      updateRow(repo);
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

function sortedRepos(): Repo[] {
  const filter = $<HTMLInputElement>("search").value.toLowerCase();
  return allRepos
    .filter((r) => r.full_name.toLowerCase().includes(filter))
    .sort((a, b) => {
      const sa = statuses.get(a.full_name)?.ahead_by ?? -2;
      const sb = statuses.get(b.full_name)?.ahead_by ?? -2;
      return sb - sa || a.full_name.localeCompare(b.full_name);
    });
}

function renderRepos() {
  const list = $("repo-list");
  list.innerHTML = "";
  for (const repo of sortedRepos()) {
    const li = document.createElement("li");
    li.className = "repo-row";
    li.dataset.repo = repo.full_name;
    li.append(
      rowName(repo),
      rowLamp(repo),
      rowTag(repo),
      rowAge(repo),
      rowActions(repo),
    );
    list.append(li);
  }
}

function updateRow(repo: Repo) {
  const li = document.querySelector<HTMLElement>(`[data-repo="${CSS.escape(repo.full_name)}"]`);
  if (!li) return;
  li.replaceChildren(rowName(repo), rowLamp(repo), rowTag(repo), rowAge(repo), rowActions(repo));
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
    statuses.set(repo.full_name, status);
    updateRow(repo);
    summarize();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Create release";
    showRelError(e);
  }
};

// --- Wiring ---

$("btn-refresh").onclick = loadRepos;
$("search").oninput = renderRepos;
$("btn-logout").onclick = async () => {
  await invoke("logout");
  const status = await invoke<AuthStatus>("auth_status");
  $("login-step-id").hidden = false;
  $("login-step-code").hidden = true;
  initLogin(status.client_id);
};
$<HTMLDialogElement>("release-dialog").addEventListener("close", () => {
  currentBump = null;
});

(async () => {
  const status = await invoke<AuthStatus>("auth_status");
  if (status.user) enterApp(status.user);
  else initLogin(status.client_id);
})();
