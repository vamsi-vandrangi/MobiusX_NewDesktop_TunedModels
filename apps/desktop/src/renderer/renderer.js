const { agentBaseUrl, agentWsUrl, agentToken, cloudBaseUrl, cloudWsUrl, cloudToken, openFolderDialog, openInBrowser, openExternal, auth, git, ssh, models, preview } = window.mobiusx;

// ============================================================
// Global error toast — a safety net against the exact "I clicked a button
// and nothing visibly happened" bug class (reported against New Project,
// but this file had NO app-wide handler for an unhandled promise rejection
// or a thrown error anywhere until now, meaning ANY such failure, in ANY
// feature, was previously silent to the user -- visible only in DevTools'
// console, which most people never open). Every click handler in this file
// is still encouraged to show its own specific, inline error where one
// exists (e.g. newProjectErrorEl) -- this is the catch-all underneath that,
// not a replacement for it.
// ============================================================
const globalErrorToast = document.createElement("div");
globalErrorToast.id = "global-error-toast";
globalErrorToast.hidden = true;
document.body.appendChild(globalErrorToast);
let globalErrorToastTimer = null;
function showGlobalError(message) {
  globalErrorToast.textContent = message;
  globalErrorToast.hidden = false;
  if (globalErrorToastTimer) clearTimeout(globalErrorToastTimer);
  globalErrorToastTimer = setTimeout(() => {
    globalErrorToast.hidden = true;
  }, 8000);
}
globalErrorToast.addEventListener("click", () => {
  globalErrorToast.hidden = true;
  if (globalErrorToastTimer) clearTimeout(globalErrorToastTimer);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled rejection]", e.reason);
  showGlobalError(`Something went wrong: ${e.reason?.message ?? e.reason ?? "unknown error"}`);
});
window.addEventListener("error", (e) => {
  console.error("[uncaught error]", e.error ?? e.message);
  showGlobalError(`Something went wrong: ${e.error?.message ?? e.message ?? "unknown error"}`);
});

// Task completion chime: synthesized locally so it works offline and never
// makes a provider request. Prime the context from the user's send gesture
// to satisfy Electron/Chromium's autoplay policy; task completion happens
// later, after the model stream has finished.
const TASK_SOUND_KEY = "mobiusx.taskCompletionSound";
const TASK_NOTIFICATION_KEY = "mobiusx.taskDesktopNotifications";
let taskSoundContext = null;
function taskSoundEnabled() {
  try { return localStorage.getItem(TASK_SOUND_KEY) !== "off"; } catch { return true; }
}
function primeTaskSound() {
  if (!taskSoundEnabled()) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    taskSoundContext ??= new AudioContextClass();
    if (taskSoundContext.state === "suspended") void taskSoundContext.resume().catch(() => {});
  } catch { /* audio is a convenience, never block a task */ }
}
function playTaskSound(failed = false) {
  if (!taskSoundEnabled()) return;
  primeTaskSound();
  if (!taskSoundContext || taskSoundContext.state !== "running") return;
  const now = taskSoundContext.currentTime;
  const notes = failed ? [440, 349] : [659, 784, 988];
  notes.forEach((frequency, index) => {
    const start = now + index * 0.11;
    const oscillator = taskSoundContext.createOscillator();
    const gain = taskSoundContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.19);
    oscillator.connect(gain);
    gain.connect(taskSoundContext.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.2);
  });
}
const taskSoundToggle = document.getElementById("task-sound-enabled");
const taskSoundTest = document.getElementById("task-sound-test");
const taskNotificationToggle = document.getElementById("task-desktop-notifications");
const taskNotificationStatus = document.getElementById("task-notification-status");
if (taskSoundToggle) {
  taskSoundToggle.checked = taskSoundEnabled();
  taskSoundToggle.addEventListener("change", () => {
    try { localStorage.setItem(TASK_SOUND_KEY, taskSoundToggle.checked ? "on" : "off"); } catch {}
    if (taskSoundToggle.checked) { primeTaskSound(); playTaskSound(false); }
  });
}
taskSoundTest?.addEventListener("click", () => { primeTaskSound(); playTaskSound(false); });
if (taskNotificationToggle) {
  taskNotificationToggle.checked = localStorage.getItem(TASK_NOTIFICATION_KEY) === "on";
  taskNotificationToggle.addEventListener("change", async () => {
    if (taskNotificationToggle.checked) {
      if (!("Notification" in window)) {
        taskNotificationToggle.checked = false;
        taskNotificationStatus.textContent = "Desktop notifications are unavailable in this environment.";
        return;
      }
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      if (permission !== "granted") {
        taskNotificationToggle.checked = false;
        taskNotificationStatus.textContent = "Notification permission was not granted; in-app status and sound remain available.";
        return;
      }
      localStorage.setItem(TASK_NOTIFICATION_KEY, "on");
      taskNotificationStatus.textContent = "Desktop notifications enabled.";
    } else {
      localStorage.removeItem(TASK_NOTIFICATION_KEY);
      taskNotificationStatus.textContent = "Desktop notifications disabled.";
    }
  });
}
function notifyTaskFinished(failed, prompt, fileCount) {
  if (localStorage.getItem(TASK_NOTIFICATION_KEY) !== "on" || !document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  const title = failed ? "MobiusX needs attention" : "Your MobiusX task is ready";
  const taskText = (prompt || "Development task").replace(/\s+/g, " ").slice(0, 110);
  const detail = failed ? "Open MobiusX to review the error and recovery options." : `${fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"} proposed. ` : ""}Open MobiusX to review the result.`;
  try { new Notification(title, { body: `${taskText} — ${detail}`, silent: true }); } catch { /* notification support varies by OS */ }
}

// ============================================================
// Nav / view switching
// ============================================================
const views = {};
document.querySelectorAll(".view").forEach((el) => (views[el.id.replace("view-", "")] = el));

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "changes") {
    loadGit();
    loadCheckpoints();
  }
  if (name === "workspace") refreshChangesBadge();
  if (name === "tasks") loadTasksList();
  if (name === "settings") loadSettings();
  if (name === "artifacts") loadArtifacts();
  if (name === "knowledge") loadKnowledgeView();
  if (name === "search") runGlobalSearch();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    // "New Chat" (Pillar 3): clicking it always starts a fresh conversation
    // in the right-pane assistant panel, even if the user is already
    // looking at it with an in-progress chat -- matching how every chat-
    // first app's own "New Chat" button behaves, and fixing a real,
    // confirmed gap where this click previously just re-showed whatever
    // conversation state (feed/history/attachments) was already there. Only
    // the #assistant-full instance resets here -- the classic 3-pane
    // #assistant-embedded sidebar (under "More") is a separate conversation
    // and isn't touched by this nav item.
    if (btn.dataset.view === "assistant") {
      fullAssistantPanel.resetConversation();
    }
    showView(btn.dataset.view);
  });
});
document.querySelectorAll("[data-view-link]").forEach((el) => {
  el.addEventListener("click", () => showView(el.dataset.viewLink));
});

// ============================================================
// Agent client
// ============================================================
async function api(path, opts = {}) {
  const res = await fetch(agentBaseUrl + path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const validationErrors = Array.isArray(body.validationErrors) ? body.validationErrors.filter((item) => typeof item === "string") : [];
    const validationSummary = validationErrors.length
      ? `: ${validationErrors.slice(0, 6).join("; ")}${validationErrors.length > 6 ? `; and ${validationErrors.length - 6} more` : ""}`
      : "";
    throw new Error(body.error ? `${body.error}${body.detail ? ": " + body.detail : ""}${validationSummary}` : `HTTP ${res.status}`);
  }
  return res.json();
}

const agentDot = document.getElementById("agent-dot");
const agentSubstatus = document.getElementById("agent-substatus");

async function checkAgent() {
  try {
    const health = await api("/health");
    agentDot.className = "dot ok";
    agentSubstatus.textContent = `Connected · v${health.version}`;
  } catch {
    agentDot.className = "dot error";
    agentSubstatus.textContent = "Unreachable";
  }
}
checkAgent();

// ============================================================
// Recent projects (localStorage-backed MRU — no cloud sync yet)
// ============================================================
const RECENTS_KEY = "mobiusx.recentProjects";
// Declared here (not down in "Project open + file tree" where it
// conceptually belongs) because renderRecents() below reads it to highlight
// the active project, and renderRecents() is already called once at
// module-load time further down this same section -- a `let` further down
// the file would still be in its temporal dead zone at that point.
let currentProjectPath = null;

// Feature request: "Show the projects with folder icons in the left pane."
// A small inline SVG (not an emoji) so it renders crisply and consistently
// at sidebar size and tracks the current text color (currentColor) through
// hover/active states exactly like the existing .nav-icon glyphs do.
const FOLDER_ICON_SVG =
  '<svg class="recent-item-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path d="M1.5 3.5c0-.55.45-1 1-1h3.1c.28 0 .55.12.74.33l.97 1.07H13.5c.55 0 1 .45 1 1v7.1c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1V3.5Z" fill="currentColor" fill-opacity="0.16"/>' +
  '<path d="M1.5 3.5c0-.55.45-1 1-1h3.1c.28 0 .55.12.74.33l.97 1.07H13.5c.55 0 1 .45 1 1v7.1c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1V3.5Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>' +
  "</svg>";

function getRecents() {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function pushRecent(path) {
  const list = getRecents().filter((p) => p !== path);
  list.unshift(path);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* private-mode / quota — non-fatal, just skip persisting */
  }
  renderRecents();
}

/**
 * Drops a path from Recent Projects — called when opening it just failed
 * because the folder itself is gone (moved/deleted outside the app).
 * Recents is a convenience shortcut list, not a record of anything; a dead
 * shortcut that never clears itself is a real, confirmed source of
 * confusion (a user hit exactly this with two of this app's own leftover
 * test folders after they'd been deleted) — better to quietly prune it
 * than leave a permanently-broken entry sitting there.
 */
function removeRecent(path) {
  const list = getRecents().filter((p) => p !== path);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* private-mode / quota — non-fatal */
  }
  renderRecents();
}

function renderRecents() {
  const el = document.getElementById("recent-projects");
  const list = getRecents();
  el.innerHTML = "";
  if (list.length === 0) {
    el.innerHTML = "<div class='recent-empty'>No recent projects yet — open one to get started.</div>";
    return;
  }
  for (const path of list) {
    const row = document.createElement("div");
    row.className = "recent-item" + (path === currentProjectPath ? " recent-item-active" : "");
    const name = path.split("/").filter(Boolean).pop() || path;
    row.innerHTML = `${FOLDER_ICON_SVG}<span class="recent-item-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span><span class="recent-item-path">${escapeHtml(path)}</span>`;
    row.addEventListener("click", () => openProject(path));
    el.appendChild(row);
  }
}
renderRecents();

// ============================================================
// Dashboard (roadmap Phase 18, source §32/§33/§34) -- "the single 'what
// do you want to build' entry point [the ask-box above] and a live
// per-project health dashboard (build/test/security status, artifact
// list, agent activity feed)." Only shown once a project is open;
// re-fetched every time Home is navigated to, same lazy-load-on-nav
// pattern every other view in this file already follows. Reuses
// renderCompletionReport (build/test/security) and GET /audit (activity,
// filtered client-side to this project) rather than re-implementing
// either -- see dashboard.ts's own doc comment for why.
// ============================================================
async function loadDashboard() {
  const section = document.getElementById("dashboard-section");
  if (!currentProjectPath) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  document.getElementById("dashboard-project-name").textContent = currentProjectPath.split("/").filter(Boolean).pop() || currentProjectPath;

  const completionEl = document.getElementById("dashboard-completion");
  const artifactsEl = document.getElementById("dashboard-artifacts");
  const activityEl = document.getElementById("dashboard-activity");
  completionEl.innerHTML = "<div class='verify-pending'>Computing…</div>";
  artifactsEl.innerHTML = "<div class='recent-empty'>Loading…</div>";
  activityEl.innerHTML = "<div class='debug-empty'>Loading…</div>";

  try {
    const dash = await api("/dashboard");
    renderCompletionReport(dash.completion, completionEl);
    if (dash.artifacts.length === 0) {
      artifactsEl.innerHTML = "<div class='recent-empty'>No generated artifacts yet — Architecture, DevOps, and other modes will create some as you use them.</div>";
    } else {
      artifactsEl.innerHTML = dash.artifacts
        .map((a) => `<div class="recent-item"><span>${escapeHtml(a.label)}</span><span class="recent-item-path">${escapeHtml(a.path)}</span></div>`)
        .join("");
    }
  } catch (err) {
    completionEl.innerHTML = `<div class="verify-none">Dashboard failed: ${escapeHtml(err.message)}</div>`;
    artifactsEl.innerHTML = "";
  }

  try {
    const { entries } = await api("/audit?limit=200");
    const mine = entries.filter((e) => e.detail && e.detail.projectPath === currentProjectPath).slice(-8).reverse();
    if (mine.length === 0) {
      activityEl.innerHTML = "<div class='debug-empty'>No agent activity recorded yet for this project.</div>";
    } else {
      activityEl.innerHTML = mine
        .map(
          (e) => `
        <div class="audit-entry ${e.severity}">
          <div class="audit-entry-head">
            <span class="audit-entry-time">${formatAuditTime(e.timestamp)}</span>
            <span class="audit-entry-category">${escapeHtml(e.category)}</span>
          </div>
          <div class="audit-entry-summary">${escapeHtml(e.summary)}</div>
        </div>`,
        )
        .join("");
    }
  } catch (err) {
    activityEl.innerHTML = `<div class="debug-empty">Failed to load activity: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("dashboard-refresh-btn")?.addEventListener("click", loadDashboard);

// ============================================================
// Project open + file tree
// ============================================================
const projectChipLabel = document.getElementById("project-chip-label");
const fileTreeEl = document.getElementById("file-tree");
// currentProjectPath itself is declared further up (just before the Recent
// projects section) -- renderRecents() needs to read it at module-load time
// (its first call runs before this point in the file), and `let` bindings
// are in the temporal dead zone until their own declaration line runs, so
// the declaration has to come before that first call, not here.

// Observation: "No info on Right top: Changes <no of files>, ...". A real,
// git-status-backed count next to the project chip -- hidden whenever
// there's no git repo open or the working tree is clean, never a
// fabricated number. Click navigates to the existing Changes view (same
// one the "More" menu already links to).
const changesBadge = document.getElementById("changes-badge");
changesBadge.addEventListener("click", () => showView("changes"));
async function refreshChangesBadge() {
  if (!currentProjectPath) {
    changesBadge.hidden = true;
    return;
  }
  try {
    const status = await api("/git/status");
    if (status.entries.length === 0) {
      changesBadge.hidden = true;
    } else {
      changesBadge.hidden = false;
      changesBadge.textContent = `Changes: ${status.entries.length}`;
    }
  } catch {
    // Not a git repo (yet), or desktop-agent unreachable this tick -- no
    // badge is the honest state here, not an error worth surfacing.
    changesBadge.hidden = true;
  }
}

async function openProject(path, { showWorkspace = true } = {}) {
  const previousProjectPath = currentProjectPath;
  projectChipLabel.textContent = "Indexing…";
  try {
    const result = await api("/project/open", { method: "POST", body: JSON.stringify({ path }) });
    currentProjectPath = result.path;
    if (previousProjectPath !== result.path) resetAssistantContextsForProjectSwitch(result.path);
    projectChipLabel.textContent = `${result.path.split("/").pop()} (${result.fileCount} files${result.isGitRepo ? ", git" : ""})`;
    pushRecent(result.path);
    closeAllTabs();
    document.getElementById("debug-results").innerHTML = "";
    document.getElementById("debug-index-status").textContent = "No index built yet for this project";
    resetPreviewUI(); // switching projects — desktop-agent already stopped the previous project's dev server(s)
    resetProjectContextUI();
    await loadTree();
    if (showWorkspace) showView("workspace");
  } catch (err) {
    projectChipLabel.textContent = `Failed: ${err.message}`;
    fileTreeEl.innerHTML = "<div class='debug-empty'>Open a project to see its files.</div>";
    // "path does not exist" (see desktop-agent's /project/open — a real
    // stat() check, not guessed) means the folder itself is gone, so this
    // Recents entry can never succeed again — prune it rather than leave a
    // permanently-broken shortcut in the list.
    if (/does not exist/i.test(err.message)) removeRecent(path);
  }
}

async function pickAndOpenProject() {
  try {
    const folder = await openFolderDialog();
    if (folder) await openProject(folder);
  } catch (err) {
    // openFolderDialog() itself (the native macOS/Windows folder picker)
    // failing is rare but was previously an UNHANDLED rejection here --
    // the click would look like it did nothing at all. The global toast
    // above would eventually catch it too, but this gives the specific,
    // immediately-relevant message right where the action was taken.
    showGlobalError(`Couldn't open the folder picker: ${err.message}`);
  }
}

document.getElementById("open-project-btn").addEventListener("click", pickAndOpenProject);
document.getElementById("workspace-open-project-cta")?.addEventListener("click", pickAndOpenProject);
document.getElementById("qa-open-project")?.addEventListener("click", pickAndOpenProject); // Home's quick-action card was removed in the chat-first redesign; guarded rather than deleted in case it comes back

// ============================================================
// New Project (item 6, phase 1) — create an empty folder on the user's own
// machine (inside a parent dir picked via the native folder dialog) via
// desktop-agent's real POST /project/create, open it, then hand off to
// Build mode so the user's next message scaffolds real files into it
// through the existing propose -> review -> apply pipeline. No project
// template is fabricated here — the folder starts genuinely empty.
// ============================================================
const newProjectModal = document.getElementById("new-project-modal");
const newProjectLocationEl = document.getElementById("new-project-location");
const newProjectNameInput = document.getElementById("new-project-name-input");
const newProjectErrorEl = document.getElementById("new-project-error");
const newProjectCreateBtn = document.getElementById("new-project-create-btn");
const newProjectCancelBtn = document.getElementById("new-project-cancel-btn");

async function createProject() {
  let parent;
  try {
    parent = await openFolderDialog();
  } catch (err) {
    // Same reasoning as pickAndOpenProject's catch above: without this, a
    // failure here (before the modal ever appears) was an unhandled
    // rejection -- clicking "New Project" would look like it silently did
    // nothing.
    showGlobalError(`Couldn't open the folder picker: ${err.message}`);
    return;
  }
  if (!parent) return;

  newProjectLocationEl.textContent = `New folder will be created inside: ${parent}`;
  newProjectNameInput.value = "";
  newProjectErrorEl.hidden = true;
  newProjectModal.hidden = false;
  newProjectNameInput.focus();

  return new Promise((resolveOuter) => {
    function cleanup() {
      newProjectModal.hidden = true;
      newProjectCreateBtn.removeEventListener("click", onCreate);
      newProjectCancelBtn.removeEventListener("click", onCancel);
      newProjectNameInput.removeEventListener("keydown", onKeydown);
    }
    async function onCreate() {
      const name = newProjectNameInput.value.trim();
      if (!name) {
        newProjectErrorEl.textContent = "Enter a project name.";
        newProjectErrorEl.hidden = false;
        return;
      }
      newProjectCreateBtn.disabled = true;
      newProjectCreateBtn.textContent = "Creating…";
      try {
        const result = await api("/project/create", {
          method: "POST",
          body: JSON.stringify({ parentPath: parent, name }),
        });
        cleanup();
        currentProjectPath = result.path;
        resetAssistantContextsForProjectSwitch(result.path);
        projectChipLabel.textContent = `${result.path.split("/").pop()} (${result.fileCount} files${result.isGitRepo ? ", git" : ""})`;
        pushRecent(result.path);
        closeAllTabs();
        document.getElementById("debug-results").innerHTML = "";
        document.getElementById("debug-index-status").textContent = "No index built yet for this project";
        resetPreviewUI(); // switching projects — desktop-agent already stopped the previous project's dev server(s)
        resetProjectContextUI();
        await loadTree();
        showView("workspace");
        // Hand off straight to Build mode — this is a brand-new empty
        // project, so the natural next step is describing what to scaffold.
        embeddedAssistantPanel.setMode("build");
        embeddedAssistantPanel.addMsg(
          `Created "${name}" — describe the app you want and Build mode will propose the files to scaffold it (you'll review and click Apply before anything is written).`,
          "system",
        );
        embeddedAssistantPanel.focusInput();
        resolveOuter(result.path);
      } catch (err) {
        newProjectErrorEl.textContent = err.message;
        newProjectErrorEl.hidden = false;
      } finally {
        newProjectCreateBtn.disabled = false;
        newProjectCreateBtn.textContent = "Create";
      }
    }
    function onCancel() {
      cleanup();
      resolveOuter(null);
    }
    function onKeydown(e) {
      if (e.key === "Enter") onCreate();
      if (e.key === "Escape") onCancel();
    }
    newProjectCreateBtn.addEventListener("click", onCreate);
    newProjectCancelBtn.addEventListener("click", onCancel);
    newProjectNameInput.addEventListener("keydown", onKeydown);
  });
}

document.getElementById("new-project-btn").addEventListener("click", createProject);
document.getElementById("workspace-new-project-cta")?.addEventListener("click", createProject);
document.getElementById("qa-new-project")?.addEventListener("click", createProject); // see qa-open-project comment above

// ============================================================
// Clone Repository (Phase C item 1) — clones a real remote repo via
// desktop-agent's real POST /git/clone (a genuine `git clone` shelled out
// server-side, see gitOps.ts), then opens it exactly like New Project does.
// If a personal access token was already saved for the URL's host (see the
// Connect GitHub/GitLab modal below), it's used automatically; otherwise
// the PAT field is offered but optional — a public repo needs none at all.
// ============================================================
const cloneProjectModal = document.getElementById("clone-project-modal");
const cloneProjectLocationEl = document.getElementById("clone-project-location");
const cloneProjectUrlInput = document.getElementById("clone-project-url-input");
const cloneProjectNameInput = document.getElementById("clone-project-name-input");
const cloneProjectSavedTokenNote = document.getElementById("clone-project-saved-token-note");
const cloneProjectPatInput = document.getElementById("clone-project-pat-input");
const cloneProjectErrorEl = document.getElementById("clone-project-error");
const cloneProjectCloneBtn = document.getElementById("clone-project-clone-btn");
const cloneProjectCancelBtn = document.getElementById("clone-project-cancel-btn");

// Best-effort guess at a folder name from a clone URL, e.g.
// "https://github.com/org/repo.git" -> "repo", "git@host:org/repo" -> "repo".
// Only ever used to prepopulate the (always-editable) name field.
function repoNameFromUrl(rawUrl) {
  const cleaned = rawUrl.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const last = cleaned.split(/[/:]/).pop() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(last) ? last : "";
}

async function updateSavedTokenNote() {
  const url = cloneProjectUrlInput.value.trim();
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    cloneProjectSavedTokenNote.hidden = true;
    return;
  }
  const saved = await git?.listCredentials().catch(() => []);
  const match = saved?.find((c) => c.host === host);
  if (match) {
    cloneProjectSavedTokenNote.hidden = false;
    cloneProjectSavedTokenNote.textContent = `Using your saved ${match.provider === "gitlab" ? "GitLab" : "GitHub"} token for ${host} — leave the token field below blank.`;
  } else {
    cloneProjectSavedTokenNote.hidden = true;
  }
}

async function cloneProject() {
  const parent = await openFolderDialog();
  if (!parent) return;

  cloneProjectLocationEl.textContent = `Will be cloned into a new folder inside: ${parent}`;
  cloneProjectUrlInput.value = "";
  cloneProjectNameInput.value = "";
  cloneProjectPatInput.value = "";
  cloneProjectSavedTokenNote.hidden = true;
  cloneProjectErrorEl.hidden = true;
  cloneProjectModal.hidden = false;
  cloneProjectUrlInput.focus();

  return new Promise((resolveOuter) => {
    function cleanup() {
      cloneProjectModal.hidden = true;
      cloneProjectUrlInput.removeEventListener("input", updateSavedTokenNote);
      cloneProjectCloneBtn.removeEventListener("click", onClone);
      cloneProjectCancelBtn.removeEventListener("click", onCancel);
      cloneProjectUrlInput.removeEventListener("keydown", onKeydown);
      cloneProjectNameInput.removeEventListener("keydown", onKeydown);
    }
    async function onClone() {
      const url = cloneProjectUrlInput.value.trim();
      if (!url) {
        cloneProjectErrorEl.textContent = "Enter a repository URL.";
        cloneProjectErrorEl.hidden = false;
        return;
      }
      const name = cloneProjectNameInput.value.trim() || repoNameFromUrl(url);
      if (!name) {
        cloneProjectErrorEl.textContent = "Couldn't guess a folder name from that URL — enter one.";
        cloneProjectErrorEl.hidden = false;
        return;
      }
      let pat = cloneProjectPatInput.value.trim() || undefined;
      if (!pat) {
        try {
          const host = new URL(url).hostname;
          const saved = await git?.getCredential(host);
          if (saved?.pat) pat = saved.pat;
        } catch {
          // Not a parseable URL — let the server-side validation in
          // gitOps.gitClone report that, rather than guessing here.
        }
      }
      cloneProjectCloneBtn.disabled = true;
      cloneProjectCloneBtn.textContent = "Cloning…";
      try {
        const result = await api("/git/clone", {
          method: "POST",
          body: JSON.stringify({ parentPath: parent, name, url, pat }),
        });
        cleanup();
        currentProjectPath = result.path;
        resetAssistantContextsForProjectSwitch(result.path);
        projectChipLabel.textContent = `${result.path.split("/").pop()} (${result.fileCount} files${result.isGitRepo ? ", git" : ""})`;
        pushRecent(result.path);
        closeAllTabs();
        document.getElementById("debug-results").innerHTML = "";
        document.getElementById("debug-index-status").textContent = "No index built yet for this project";
        resetPreviewUI();
        resetProjectContextUI();
        await loadTree();
        showView("workspace");
        embeddedAssistantPanel.addMsg(
          `Cloned "${name}" (${result.fileCount} files) — ask a question, or switch to Build/Debug mode to start changing it.`,
          "system",
        );
        embeddedAssistantPanel.focusInput();
        resolveOuter(result.path);
      } catch (err) {
        cloneProjectErrorEl.textContent = err.message;
        cloneProjectErrorEl.hidden = false;
      } finally {
        cloneProjectCloneBtn.disabled = false;
        cloneProjectCloneBtn.textContent = "Clone";
      }
    }
    function onCancel() {
      cleanup();
      resolveOuter(null);
    }
    function onKeydown(e) {
      if (e.key === "Enter") onClone();
      if (e.key === "Escape") onCancel();
    }
    cloneProjectUrlInput.addEventListener("input", updateSavedTokenNote);
    cloneProjectCloneBtn.addEventListener("click", onClone);
    cloneProjectCancelBtn.addEventListener("click", onCancel);
    cloneProjectUrlInput.addEventListener("keydown", onKeydown);
    cloneProjectNameInput.addEventListener("keydown", onKeydown);
  });
}

document.getElementById("clone-project-btn").addEventListener("click", cloneProject);

// ============================================================
// Connect GitHub/GitLab (Phase C item 2) — a real personal access token,
// stored via main.js's safeStorage-backed git-credentials.enc (see that
// file's doc comment). This is a working credential entry flow, not an
// OAuth "Sign in with GitHub" consent screen (see the plan's scope notes).
// ============================================================
const connectGitModal = document.getElementById("connect-git-modal");
const connectGitHostInput = document.getElementById("connect-git-host-input");
const connectGitPatInput = document.getElementById("connect-git-pat-input");
const connectGitErrorEl = document.getElementById("connect-git-error");
const connectGitSavedListEl = document.getElementById("connect-git-saved-list");
const connectGitSaveBtn = document.getElementById("connect-git-save-btn");
const connectGitCloseBtn = document.getElementById("connect-git-close-btn");
const connectGitLabel = document.getElementById("sidebar-connect-github-label");

document.querySelectorAll('input[name="connect-git-provider"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    // Prefill the host field with the standard host for whichever provider
    // was just picked, but only when the user hasn't already typed a
    // (presumably self-hosted) host of their own.
    const current = connectGitHostInput.value.trim();
    if (!current || current === "github.com" || current === "gitlab.com") {
      connectGitHostInput.value = radio.value === "gitlab" ? "gitlab.com" : "github.com";
    }
  });
});

async function refreshConnectGitUI() {
  if (!git) return;
  const saved = await git.listCredentials().catch(() => []);
  connectGitSavedListEl.innerHTML = "";
  for (const { host, provider } of saved) {
    const row = document.createElement("div");
    row.className = "connect-git-saved-row";
    row.innerHTML = `<span>✓ ${escapeHtml(provider === "gitlab" ? "GitLab" : "GitHub")} — ${escapeHtml(host)}</span><button class="connect-git-saved-row-remove" type="button">Remove</button>`;
    row.querySelector("button").addEventListener("click", async () => {
      await git.clearCredential(host);
      await refreshConnectGitUI();
    });
    connectGitSavedListEl.appendChild(row);
  }
  connectGitLabel.textContent = saved.length ? `Connected · ${saved.length}` : "Connect GitHub";
}

function openConnectGitModal() {
  connectGitPatInput.value = "";
  connectGitErrorEl.hidden = true;
  connectGitModal.hidden = false;
  refreshConnectGitUI();
  connectGitPatInput.focus();
}

async function onConnectGitSave() {
  const provider = document.querySelector('input[name="connect-git-provider"]:checked')?.value ?? "github";
  const host = connectGitHostInput.value.trim();
  const pat = connectGitPatInput.value.trim();
  if (!host || !pat) {
    connectGitErrorEl.textContent = "Enter both a host and a token.";
    connectGitErrorEl.hidden = false;
    return;
  }
  connectGitSaveBtn.disabled = true;
  connectGitSaveBtn.textContent = "Saving…";
  try {
    const result = await git.setCredential(host, provider, pat);
    if (!result?.ok) throw new Error(result?.error || "Failed to save token.");
    connectGitPatInput.value = "";
    connectGitErrorEl.hidden = true;
    await refreshConnectGitUI();
  } catch (err) {
    connectGitErrorEl.textContent = err.message;
    connectGitErrorEl.hidden = false;
  } finally {
    connectGitSaveBtn.disabled = false;
    connectGitSaveBtn.textContent = "Save Token";
  }
}

document.getElementById("sidebar-connect-github-btn").addEventListener("click", openConnectGitModal);
connectGitSaveBtn.addEventListener("click", onConnectGitSave);
connectGitCloseBtn.addEventListener("click", () => (connectGitModal.hidden = true));
connectGitPatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") onConnectGitSave();
  if (e.key === "Escape") (connectGitModal.hidden = true);
});
if (git) refreshConnectGitUI();

// ============================================================
// "This PC ▾" switcher + Connect via SSH (Phase D) — opens a real SSH
// connection + SFTP session via desktop-agent's POST /remote/connect (see
// remoteConnection.ts), then opens the resolved remote directory through
// the same post-open sequence (load tree, show workspace) Open Folder/New
// Project/Clone Repository already use for a local one. Saved targets are
// a real safeStorage-backed credential, same precedent as Connect
// GitHub/GitLab's PAT (main.js's ssh-targets.enc).
// ============================================================
let connectedRemote = null; // {host, username, label} while a remote project is open, else null

const pcSwitcherBtn = document.getElementById("pc-switcher-btn");
const pcSwitcherMenu = document.getElementById("pc-switcher-menu");
const pcSwitcherLabel = document.getElementById("pc-switcher-label");
const pcSwitcherThisPcBtn = document.getElementById("pc-switcher-this-pc-btn");
const pcSwitcherTargetsEl = document.getElementById("pc-switcher-targets");
const pcSwitcherConnectBtn = document.getElementById("pc-switcher-connect-btn");

// Mirrors the More menu's fix (see index.html's comment above the
// nav-pc-switcher block): both the toggle button and the menu itself
// stopPropagation(), so the document-level outside-click closer can't race
// a single click, and .pc-switcher-menu[hidden] is restated in styles.css
// at matching specificity so the attribute actually hides it.
function closePcSwitcherMenu() {
  if (!pcSwitcherMenu || pcSwitcherMenu.hidden) return;
  pcSwitcherMenu.hidden = true;
  pcSwitcherBtn?.setAttribute("aria-expanded", "false");
}
if (pcSwitcherBtn && pcSwitcherMenu) {
  pcSwitcherBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = pcSwitcherMenu.hidden;
    if (willOpen) renderPcSwitcherTargets();
    pcSwitcherMenu.hidden = !willOpen;
    pcSwitcherBtn.setAttribute("aria-expanded", String(willOpen));
  });
  pcSwitcherMenu.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closePcSwitcherMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePcSwitcherMenu();
  });
}

async function renderPcSwitcherTargets() {
  if (!ssh || !pcSwitcherTargetsEl) return;
  const targets = await ssh.listTargets().catch(() => []);
  pcSwitcherTargetsEl.innerHTML = "";
  for (const t of targets) {
    const isActive = connectedRemote && connectedRemote.host === t.host && connectedRemote.username === t.username;
    const row = document.createElement("div");
    row.className = "pc-switcher-target-row" + (isActive ? " pc-switcher-target-row-active" : "");
    row.innerHTML = `<button class="pc-switcher-target-connect" type="button">${isActive ? "✓ " : ""}${escapeHtml(t.label || `${t.username}@${t.host}`)}</button><button class="pc-switcher-target-remove" type="button" title="Remove this saved connection">✕</button>`;
    row.querySelector(".pc-switcher-target-connect").addEventListener("click", () => connectToSavedTarget(t));
    row.querySelector(".pc-switcher-target-remove").addEventListener("click", async (e) => {
      e.stopPropagation();
      await ssh.deleteTarget(t.id);
      await renderPcSwitcherTargets();
    });
    pcSwitcherTargetsEl.appendChild(row);
  }
  pcSwitcherThisPcBtn.classList.toggle("pc-switcher-item-active", !connectedRemote);
}

/** Shared by both entry points (a fresh Connect-via-SSH form, or clicking a
 * saved target): actually fires POST /remote/connect and, on success, runs
 * the exact same post-open sequence every other "open a project" flow
 * (Open Folder, New Project, Clone Repository) already uses. */
async function performRemoteConnect(body) {
  const result = await api("/remote/connect", { method: "POST", body: JSON.stringify(body) });
  currentProjectPath = result.path;
  resetAssistantContextsForProjectSwitch(result.path);
  connectedRemote = { host: result.host, username: result.username, label: body.label || null };
  const truncatedNote = result.truncated ? ", truncated — very large remote tree" : "";
  projectChipLabel.textContent = `${result.path.split("/").pop()} (${result.fileCount} files${result.isGitRepo ? ", git" : ""}${truncatedNote}) · SSH ${result.username}@${result.host}`;
  pcSwitcherLabel.textContent = body.label || `${result.username}@${result.host}`;
  closeAllTabs();
  document.getElementById("debug-results").innerHTML = "";
  document.getElementById("debug-index-status").textContent = "No index built yet for this project";
  resetPreviewUI(); // Live Preview is a local-dev-server feature -- not wired for a remote project in this phase
  resetProjectContextUI();
  await loadTree();
  showView("workspace");
  embeddedAssistantPanel.addMsg(
    `Connected to ${result.username}@${result.host} (${result.fileCount} files${result.isGitRepo ? ", git" : ""}) — the file tree and terminal below are now real SSH/SFTP, not local.`,
    "system",
  );
  embeddedAssistantPanel.focusInput();
  return result;
}

async function connectToSavedTarget(target) {
  closePcSwitcherMenu();
  const full = await ssh.getTarget(target.id).catch(() => null);
  if (!full) return;
  projectChipLabel.textContent = `Connecting to ${full.username}@${full.host}…`;
  try {
    await performRemoteConnect({
      host: full.host,
      port: full.port,
      username: full.username,
      authMethod: full.authMethod,
      identityPath: full.identityPath,
      password: full.authMethod === "password" ? full.password : undefined,
      passphrase: full.authMethod === "key" ? full.passphrase : undefined,
      label: full.label,
    });
  } catch (err) {
    projectChipLabel.textContent = `Failed: ${err.message}`;
  }
}

async function disconnectToThisPc() {
  closePcSwitcherMenu();
  if (!connectedRemote) return;
  try {
    await api("/remote/disconnect", { method: "POST" });
  } catch {
    // best-effort -- still reset the UI even if the disconnect call itself failed
  }
  connectedRemote = null;
  currentProjectPath = null;
  resetAssistantContextsForProjectSwitch(null);
  pcSwitcherLabel.textContent = "This PC";
  projectChipLabel.textContent = "No project open";
  fileTreeEl.innerHTML = "<div class='debug-empty'>Open a project to see its files.</div>";
  closeAllTabs();
  showView("assistant");
}
pcSwitcherThisPcBtn?.addEventListener("click", disconnectToThisPc);

const connectSshModal = document.getElementById("connect-ssh-modal");
const connectSshLabelInput = document.getElementById("connect-ssh-label-input");
const connectSshHostInput = document.getElementById("connect-ssh-host-input");
const connectSshPortInput = document.getElementById("connect-ssh-port-input");
const connectSshUsernameInput = document.getElementById("connect-ssh-username-input");
const connectSshIdentityInput = document.getElementById("connect-ssh-identity-input");
const connectSshSecretInput = document.getElementById("connect-ssh-secret-input");
const connectSshPathInput = document.getElementById("connect-ssh-path-input");
const connectSshSaveCheckbox = document.getElementById("connect-ssh-save-checkbox");
const connectSshErrorEl = document.getElementById("connect-ssh-error");
const connectSshConnectBtn = document.getElementById("connect-ssh-connect-btn");
const connectSshCancelBtn = document.getElementById("connect-ssh-cancel-btn");

function updateConnectSshAuthUI() {
  const method = document.querySelector('input[name="connect-ssh-auth"]:checked')?.value ?? "key";
  connectSshIdentityInput.hidden = method !== "key";
  connectSshSecretInput.hidden = method === "agent";
  connectSshSecretInput.placeholder = method === "password" ? "Password" : "Key passphrase (optional)";
}
document.querySelectorAll('input[name="connect-ssh-auth"]').forEach((radio) => radio.addEventListener("change", updateConnectSshAuthUI));

function openConnectSshModal() {
  closePcSwitcherMenu();
  connectSshLabelInput.value = "";
  connectSshHostInput.value = "";
  connectSshPortInput.value = "22";
  connectSshUsernameInput.value = "";
  connectSshIdentityInput.value = "~/.ssh/id_rsa";
  connectSshSecretInput.value = "";
  connectSshPathInput.value = "";
  connectSshSaveCheckbox.checked = true;
  connectSshErrorEl.hidden = true;
  document.querySelector('input[name="connect-ssh-auth"][value="key"]').checked = true;
  updateConnectSshAuthUI();
  connectSshModal.hidden = false;
  connectSshHostInput.focus();
}

async function onConnectSshConnect() {
  const host = connectSshHostInput.value.trim();
  const username = connectSshUsernameInput.value.trim();
  const authMethod = document.querySelector('input[name="connect-ssh-auth"]:checked')?.value ?? "key";
  const port = Number(connectSshPortInput.value.trim()) || 22;
  const label = connectSshLabelInput.value.trim();
  const identityPath = connectSshIdentityInput.value.trim();
  const secret = connectSshSecretInput.value;
  const remotePath = connectSshPathInput.value.trim();

  if (!host || !username) {
    connectSshErrorEl.textContent = "Enter a host and a username.";
    connectSshErrorEl.hidden = false;
    return;
  }
  if (authMethod === "key" && !identityPath) {
    connectSshErrorEl.textContent = "Enter the path to a private key, or switch to Password / SSH agent.";
    connectSshErrorEl.hidden = false;
    return;
  }
  if (authMethod === "password" && !secret) {
    connectSshErrorEl.textContent = "Enter a password, or switch to Private key / SSH agent.";
    connectSshErrorEl.hidden = false;
    return;
  }

  const body = {
    host,
    port,
    username,
    authMethod,
    ...(authMethod === "key" ? { identityPath, ...(secret ? { passphrase: secret } : {}) } : {}),
    ...(authMethod === "password" ? { password: secret } : {}),
    ...(remotePath ? { remotePath } : {}),
    ...(label ? { label } : {}),
  };

  connectSshConnectBtn.disabled = true;
  connectSshConnectBtn.textContent = "Connecting…";
  try {
    if (connectSshSaveCheckbox.checked && ssh) {
      await ssh.setTarget({
        label,
        host,
        port,
        username,
        authMethod,
        ...(authMethod === "key" ? { identityPath, ...(secret ? { passphrase: secret } : {}) } : {}),
        ...(authMethod === "password" ? { password: secret } : {}),
      });
    }
    await performRemoteConnect(body);
    connectSshModal.hidden = true;
    connectSshErrorEl.hidden = true;
  } catch (err) {
    connectSshErrorEl.textContent = err.message;
    connectSshErrorEl.hidden = false;
  } finally {
    connectSshConnectBtn.disabled = false;
    connectSshConnectBtn.textContent = "Connect";
  }
}

pcSwitcherConnectBtn?.addEventListener("click", openConnectSshModal);
connectSshConnectBtn.addEventListener("click", onConnectSshConnect);
connectSshCancelBtn.addEventListener("click", () => (connectSshModal.hidden = true));
connectSshModal.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") onConnectSshConnect();
  if (e.key === "Escape") connectSshModal.hidden = true;
});

function buildNestedTree(nodes) {
  const root = { children: new Map() };
  for (const node of nodes) {
    const parts = node.path.split("/");
    let cursor = root;
    parts.forEach((part, i) => {
      if (!cursor.children.has(part)) {
        cursor.children.set(part, { children: new Map(), node: i === parts.length - 1 ? node : null });
      }
      cursor = cursor.children.get(part);
    });
  }
  return root;
}

function renderTreeNode(name, entry, depth, container) {
  const isDir = entry.node ? entry.node.type === "dir" : entry.children.size > 0;
  const div = document.createElement("div");
  div.className = "tree-node" + (isDir ? " dir" : "");
  div.style.paddingLeft = `${depth * 14}px`;
  div.textContent = (isDir ? "▸ " : "  ") + name;
  container.appendChild(div);

  if (isDir) {
    let expanded = false;
    const childWrap = document.createElement("div");
    childWrap.hidden = true;
    container.appendChild(childWrap);
    div.addEventListener("click", () => {
      expanded = !expanded;
      childWrap.hidden = !expanded;
      div.textContent = (expanded ? "▾ " : "▸ ") + name;
      if (expanded && childWrap.childElementCount === 0) {
        const sorted = [...entry.children.entries()].sort((a, b) => {
          const aDir = a[1].node ? a[1].node.type === "dir" : a[1].children.size > 0;
          const bDir = b[1].node ? b[1].node.type === "dir" : b[1].children.size > 0;
          if (aDir !== bDir) return aDir ? -1 : 1;
          return a[0].localeCompare(b[0]);
        });
        for (const [childName, childEntry] of sorted) renderTreeNode(childName, childEntry, depth + 1, childWrap);
      }
    });
  } else {
    div.addEventListener("click", () => openFile(entry.node.path));
  }
}

async function loadTree() {
  const { nodes } = await api("/fs/tree");
  const tree = buildNestedTree(nodes);
  fileTreeEl.innerHTML = "";
  const sorted = [...tree.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (sorted.length === 0) {
    fileTreeEl.innerHTML = "<div class='debug-empty'>No files found in this project.</div>";
    return;
  }
  for (const [name, entry] of sorted) renderTreeNode(name, entry, 0, fileTreeEl);
}

// ============================================================
// Tabbed editor
// ============================================================
const tabsBar = document.getElementById("tabs-bar");
const monacoHost = document.getElementById("monaco-host");
const editorEmptyState = document.getElementById("editor-empty-state");
const editorStatusbar = document.getElementById("editor-statusbar");
const openTabs = []; // { path, model, truncated, savedVersionId }
let activeTabPath = null;
let monacoEditor = null;
let monacoReady = null;
let monacoCursorPos = null; // { lineNumber, column } of the last known cursor — statusbar reads this

// Extension → display label for the editor's status bar (below). Cosmetic
// only — distinct from MONACO_LANGUAGE_IDS below, which drives Monaco's own
// syntax highlighting/IntelliSense and uses Monaco's internal language ids
// rather than these friendly display names.
const LANGUAGE_LABELS = {
  ts: "TypeScript", tsx: "TypeScript JSX", js: "JavaScript", jsx: "JavaScript JSX",
  json: "JSON", css: "CSS", html: "HTML", md: "Markdown", py: "Python",
  yml: "YAML", yaml: "YAML", sh: "Shell Script", sql: "SQL", rs: "Rust", go: "Go",
};
function languageForPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return LANGUAGE_LABELS[ext] ?? "Plain Text";
}

// Monaco's own internal language ids (registered by its bundled
// basic-languages Monarch grammars / language services) — a different
// namespace than LANGUAGE_LABELS above. Anything not listed here still
// gets real Monarch syntax highlighting automatically (Monaco auto-detects
// ~70+ languages by extension); this map only needs entries where we want
// to be explicit or where the id differs from the obvious guess.
const MONACO_LANGUAGE_IDS = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  json: "json", css: "css", less: "less", scss: "scss", html: "html",
  md: "markdown", py: "python", yml: "yaml", yaml: "yaml", sh: "shell",
  sql: "sql", rs: "rust", go: "go", cpp: "cpp", cc: "cpp", cxx: "cpp",
  h: "cpp", hpp: "cpp", c: "c",
};
function monacoLanguageForPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return MONACO_LANGUAGE_IDS[ext] ?? "plaintext";
}

function monacoThemeForAppTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  const dark = explicit ? explicit === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return dark ? "vs-dark" : "vs";
}

// Monaco is loaded on demand (first time a file is opened), not at startup
// -- its AMD loader/workers are a real cost not worth paying before the
// user has actually opened a project. Safe to call repeatedly; only the
// first call does any work.
function initMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve) => {
    // vs/editor/editor.main's own module code sets self.MonacoEnvironment
    // itself once loaded (confirmed by inspecting the installed
    // monaco-editor@0.57.0 package directly) -- no app-side worker
    // shim/getWorkerUrl override is needed or present here.
    require.config({ paths: { vs: new URL("vendor/monaco/vs", location.href).href } });
    require(["vs/editor/editor.main"], () => {
      monacoEditor = monaco.editor.create(monacoHost, {
        automaticLayout: true,
        theme: monacoThemeForAppTheme(),
        fontFamily: '"SF Mono", Menlo, monospace',
        fontSize: 12,
        minimap: { enabled: true },
        model: null,
      });
      monacoEditor.onDidChangeCursorPosition((e) => {
        monacoCursorPos = e.position;
        const tab = openTabs.find((t) => t.path === activeTabPath);
        if (tab) updateEditorStatusbar(tab);
      });
      resolve();
    });
  });
  return monacoReady;
}

function isTabDirty(tab) {
  return !!tab && tab.model.getAlternativeVersionId() !== tab.savedVersionId;
}

function updateEditorStatusbar(tab) {
  if (!tab) {
    editorStatusbar.hidden = true;
    return;
  }
  const lineCount = tab.model.getLineCount();
  const pos = tab.path === activeTabPath ? monacoCursorPos : null;
  const posLabel = pos ? `  ·  Ln ${pos.lineNumber}, Col ${pos.column}` : "";
  // A truncated read means this model does NOT hold the file's full content
  // -- surfaced honestly (not silently) because it also means Save is
  // refused for this tab (see saveActiveTab): writing a truncated buffer
  // back to disk would silently chop off the rest of the real file.
  const truncatedLabel = tab.truncated ? "  ·  ⚠ truncated (read-only — too large to save)" : "";
  editorStatusbar.hidden = false;
  editorStatusbar.textContent = `${languageForPath(tab.path)}  ·  ${lineCount} line${lineCount === 1 ? "" : "s"}  ·  UTF-8${posLabel}${truncatedLabel}`;
}

function showEditorEmptyState() {
  monacoHost.style.display = "none";
  editorEmptyState.style.display = "";
  if (monacoEditor) monacoEditor.setModel(null);
  updateEditorStatusbar(null);
}

function closeAllTabs() {
  for (const tab of openTabs) tab.model.dispose();
  openTabs.length = 0;
  activeTabPath = null;
  renderTabs();
  showEditorEmptyState();
}

function renderTabs() {
  tabsBar.innerHTML = "";
  for (const tab of openTabs) {
    const div = document.createElement("div");
    div.className = "file-tab" + (tab.path === activeTabPath ? " active" : "");
    const name = tab.path.split("/").pop();
    const dirty = isTabDirty(tab);
    div.innerHTML = `<span>${name}</span><span class="file-tab-dirty" ${dirty ? "" : "hidden"}>●</span><span class="file-tab-close">✕</span>`;
    div.querySelector("span:first-child").addEventListener("click", () => activateTab(tab.path));
    div.querySelector(".file-tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });
    tabsBar.appendChild(div);
  }
}

async function activateTab(path) {
  activeTabPath = path;
  const tab = openTabs.find((t) => t.path === path);
  if (!tab) {
    renderTabs();
    return;
  }
  await initMonaco();
  monacoHost.style.display = "";
  editorEmptyState.style.display = "none";
  monacoEditor.setModel(tab.model);
  // A truncated read is missing the rest of the real file -- let the user
  // look at it, but don't let them type into a buffer that saveActiveTab
  // will refuse to save (readOnly, not just a save-time block, so the
  // mismatch between "I can type here" and "Cmd+S silently does nothing
  // useful" never happens in the first place).
  monacoEditor.updateOptions({ readOnly: !!tab.truncated });
  monacoCursorPos = monacoEditor.getPosition();
  updateEditorStatusbar(tab);
  renderTabs();
}

function closeTab(path) {
  const idx = openTabs.findIndex((t) => t.path === path);
  if (idx === -1) return;
  const tab = openTabs[idx];
  if (isTabDirty(tab) && !confirm(`"${path.split("/").pop()}" has unsaved changes. Close anyway?`)) return;
  tab.model.dispose();
  openTabs.splice(idx, 1);
  if (activeTabPath === path) {
    activeTabPath = openTabs.length ? openTabs[Math.max(0, idx - 1)].path : null;
    if (activeTabPath) activateTab(activeTabPath);
    else showEditorEmptyState();
    renderTabs();
  } else {
    renderTabs();
  }
}

async function openFile(path) {
  let tab = openTabs.find((t) => t.path === path);
  if (!tab) {
    let content, truncated;
    try {
      const data = await api(`/fs/read?path=${encodeURIComponent(path)}`);
      content = data.content;
      truncated = data.truncated;
    } catch (err) {
      content = `Failed to read file: ${err.message}`;
      truncated = false;
    }
    await initMonaco();
    const uri = monaco.Uri.file(path);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, monacoLanguageForPath(path), uri);
    model.onDidChangeContent(() => {
      if (tab.path === activeTabPath) renderTabs();
    });
    tab = { path, model, truncated, savedVersionId: model.getAlternativeVersionId() };
    openTabs.push(tab);
  }
  await activateTab(path);
}

// Manual save (Monaco editor, Cmd/Ctrl+S) -- deliberately separate from the
// AI "apply edits" flow: no secret-scan, no create/modify-exists gate, just
// "write what the editor currently holds for this path." See desktop-agent's
// POST /fs/write doc comment for the backend side of this distinction.
async function saveActiveTab() {
  const tab = openTabs.find((t) => t.path === activeTabPath);
  if (!tab || !isTabDirty(tab)) return;
  if (tab.truncated) {
    alert(
      `"${tab.path}" is too large for MobiusX to have read in full (over 1MB), so this buffer is missing the rest of the file. ` +
        `Saving would overwrite the real file with only this partial content, so Save is disabled for this tab.`
    );
    return;
  }
  try {
    await api("/fs/write", { method: "POST", body: JSON.stringify({ path: tab.path, content: tab.model.getValue() }) });
    tab.savedVersionId = tab.model.getAlternativeVersionId();
    renderTabs();
  } catch (err) {
    alert(`Failed to save "${tab.path}": ${err.message}`);
  }
}
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && activeTabPath) {
    e.preventDefault();
    saveActiveTab();
  }
});

// ============================================================
// Terminal — real interactive PTY (node-pty on the agent side, xterm.js
// here). Raw bytes both ways: what you type goes straight to the shell's
// stdin (including Ctrl+C, arrow-key history, tab completion), and
// whatever the shell writes — its own prompt, ANSI colors, full-screen
// programs like vim — is rendered by xterm.js exactly as a native
// terminal would. This replaced Phase 1's line-at-a-time command-exec
// terminal; see apps/desktop-agent/src/terminalWs.ts.
// ============================================================
const terminalPanel = document.getElementById("terminal-panel");
const terminalContainer = document.getElementById("terminal-xterm");
const terminalApprovalBanner = document.getElementById("terminal-approval-banner");
const terminalApprovalText = document.getElementById("terminal-approval-text");
let terminalSocket = null;
let terminalReconnectTimer = null;

const term = new Terminal({
  fontFamily: '"SF Mono", Menlo, monospace',
  fontSize: 12,
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: "#101113",
    foreground: "#e6e6e6",
    cursor: "#7c9eff",
    selectionBackground: "#2a3a63",
  },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(terminalContainer);

function sendTerminalMessage(msg) {
  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify(msg));
  }
}

function fitAndSendSize() {
  if (terminalPanel.classList.contains("collapsed")) return; // 0-size container — fit() would report garbage
  try {
    fitAddon.fit();
  } catch {
    return; // container not yet laid out (e.g. view hidden) — next resize/toggle will retry
  }
  sendTerminalMessage({ type: "resize", cols: term.cols, rows: term.rows });
}

function hideTerminalApproval() {
  terminalApprovalBanner.hidden = true;
  terminalApprovalText.textContent = "";
}

function showTerminalApproval(labels) {
  terminalApprovalText.textContent = `Held for approval — ${labels}`;
  terminalApprovalBanner.hidden = false;
}

document.getElementById("terminal-approve-btn").addEventListener("click", () => {
  sendTerminalMessage({ type: "approve" });
  hideTerminalApproval();
  term.focus();
});
document.getElementById("terminal-reject-btn").addEventListener("click", () => {
  sendTerminalMessage({ type: "reject" });
  hideTerminalApproval();
  term.focus();
});

function connectTerminal() {
  clearTimeout(terminalReconnectTimer);
  hideTerminalApproval(); // a fresh connection has no pending hold from the previous one
  const ws = new WebSocket(`${agentWsUrl}/terminal?token=${encodeURIComponent(agentToken)}`);
  terminalSocket = ws;
  ws.addEventListener("open", () => {
    term.reset();
    fitAndSendSize();
  });
  ws.addEventListener("close", () => {
    // If a newer connection has already replaced this one (e.g. a deliberate
    // reconnect from Settings), this stale socket's close is expected —
    // don't also schedule a second, redundant reconnect for it.
    if (terminalSocket !== ws) return;
    hideTerminalApproval();
    term.write("\r\n\x1b[90m[disconnected — retrying in 2s]\x1b[0m\r\n");
    terminalReconnectTimer = setTimeout(connectTerminal, 2000);
  });
  ws.addEventListener("error", () => {
    term.write("\r\n\x1b[31m[terminal socket error]\x1b[0m\r\n");
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "output") term.write(msg.data);
    else if (msg.type === "exit") term.write(`\r\n\x1b[90m[process exited${msg.code !== null ? ` (code ${msg.code})` : ""}]\x1b[0m\r\n`);
    else if (msg.type === "error") term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
    else if (msg.type === "policy") {
      const labels = msg.matches.map((m) => m.description).join("; ");
      if (msg.requiresApproval) {
        // Approval Engine (guarded mode) — the flagged command's Enter
        // keystroke is being held server-side; nothing reaches the shell
        // until Approve/Reject resolves it. See terminalWs.ts's doc comment.
        showTerminalApproval(labels);
      } else {
        // Phase 5 command guard, "off" mode — reactive, best-effort (see
        // apps/desktop-agent/src/policy.ts): the command already ran.
        term.write(`\r\n\x1b[41m\x1b[97m[command guard] flagged & interrupted: ${labels}\x1b[0m\r\n`);
      }
    } else if (msg.type === "hook") {
      // Event-driven hooks (roadmap Phase 16, source requirement §25):
      // real before-commit results, reactive same as the command guard
      // above (see terminalWs.ts#checkBeforeCommitHook).
      const summary = msg.results.map((r) => `${r.status === "passed" ? "✓" : "✗"} ${r.ruleId}`).join("  ");
      if (msg.blocked) {
        term.write(`\r\n\x1b[41m\x1b[97m[before-commit hook] FAILED, commit interrupted: ${summary}\x1b[0m\r\n`);
        for (const r of msg.results.filter((r) => r.status === "failed")) {
          term.write(`\x1b[31m  ${r.ruleId} (${r.command}) exited ${r.exitCode}\x1b[0m\r\n`);
        }
      } else {
        term.write(`\r\n\x1b[42m\x1b[30m[before-commit hook] passed: ${summary}\x1b[0m\r\n`);
      }
    }
  });
}
connectTerminal();

/** Used by the Settings view's "Reconnect Terminal" button so a changed
 * terminalApprovalMode (read once per connection by the agent) actually
 * takes effect on the terminal that's already open, without waiting for
 * an unrelated disconnect. Safe to call any time — connectTerminal()'s
 * stale-socket guard above means the old connection's "close" handler
 * won't also schedule a redundant second reconnect. */
function reconnectTerminalNow() {
  clearTimeout(terminalReconnectTimer);
  connectTerminal();
}

term.onData((data) => sendTerminalMessage({ type: "input", data }));

document.getElementById("terminal-toggle").addEventListener("click", () => {
  const collapsed = terminalPanel.classList.toggle("collapsed");
  document.getElementById("terminal-toggle").textContent = (collapsed ? "▸ " : "▾ ") + "Terminal";
  if (!collapsed) {
    // Panel was just un-collapsed — xterm needs a beat for layout to settle before measuring.
    requestAnimationFrame(() => {
      fitAndSendSize();
      term.focus();
    });
  }
});

window.addEventListener("resize", () => fitAndSendSize());
new ResizeObserver(() => fitAndSendSize()).observe(terminalContainer);

// ============================================================
// Live Preview (item 6, phase 2) — a real dev server for the open project,
// spawned server-side by desktop-agent's previewOps.ts, shown here in an
// embedded <webview>. This panel only ever reflects genuine process state
// polled from GET /preview/status — never a simulated "running" indicator.
// ============================================================
const previewPanel = document.getElementById("preview-panel");
const previewStartBtn = document.getElementById("preview-start-btn");
const previewStopBtn = document.getElementById("preview-stop-btn");
const previewBackBtn = document.getElementById("preview-back-btn");
const previewForwardBtn = document.getElementById("preview-forward-btn");
const previewReloadBtn = document.getElementById("preview-reload-btn");
const previewUrlInput = document.getElementById("preview-url-input");
const previewOpenBrowserBtn = document.getElementById("preview-open-browser-btn");
const previewStatusText = document.getElementById("preview-status-text");
const previewLog = document.getElementById("preview-log");
const previewWebview = document.getElementById("preview-webview");
const previewEmpty = document.getElementById("preview-empty");
let activeProjectPreviewUrl = null;
let displayedPreviewProjectPath = null;
let displayedPreviewUrl = null;

// ============================================================
// Dev-server console drawer (Oct 2026) — a live tail of whatever "Start
// Preview" spawned (npm run dev / uvicorn), fed by previewWatcher.js's
// "terminal:log-stream" IPC pushes (preview.onLogStream below). This is
// NOT the existing #terminal-panel/#terminal-xterm shell further down this
// file (connectTerminal(), a real interactive PTY over its own WebSocket
// straight to desktop-agent's terminalWs.ts) — this drawer is read-only,
// nested under the editor, and exists specifically so dev-server
// compilation/database errors are visible without opening that shell.
// ============================================================
const devConsoleToggle = document.getElementById("dev-console-toggle");
const devConsolePanel = document.getElementById("dev-console-panel");
const devConsoleOutput = document.getElementById("dev-console-output");
const devConsoleClear = document.getElementById("dev-console-clear");
const DEV_CONSOLE_MAX_LINES = 1000; // trims the DOM, independent of previewOps.ts's own 300-line server-side cap

function devConsoleAutoScrollNeeded() {
  // Only auto-scroll if the user was already at (or near) the bottom —
  // otherwise appending live output would yank them away from a line
  // they're actively reading further up.
  return devConsoleOutput.scrollHeight - devConsoleOutput.scrollTop - devConsoleOutput.clientHeight < 40;
}

// Debugging aid (Oct 2026): an explicit placeholder rather than a truly
// blank panel, so "nothing has arrived yet" is visibly distinguishable from
// "the drawer never got wired up at all" -- replaced the instant the first
// real line comes in (appendDevConsoleLines below removes it).
function showDevConsoleEmptyState(text) {
  devConsoleOutput.innerHTML = `<div class="dev-console-empty">${escapeHtml(text)}</div>`;
}

function appendDevConsoleLines(kind, lines) {
  if (!lines || lines.length === 0) return;
  const emptyState = devConsoleOutput.querySelector(".dev-console-empty");
  if (emptyState) emptyState.remove();
  const shouldScroll = devConsoleAutoScrollNeeded();
  const kindClass = kind === "backend" ? "dev-console-line-backend" : kind === "scan" ? "dev-console-line-scan" : "";
  // Built line-by-line with its own try/catch, not a single .map().join() --
  // one malformed line (a bad escapeHtml call, an unexpected non-string
  // value slipping through) used to be able to throw and silently drop the
  // ENTIRE batch, including every normal line alongside it, with nothing
  // in the console to show why. Now a single bad line is skipped (logged,
  // not thrown) and every other line in the same batch still renders.
  let html = "";
  for (const line of lines) {
    try {
      const errorClass = /error|traceback|exception/i.test(line) ? "dev-console-line-error" : kindClass;
      html += `<div class="${errorClass}">${escapeHtml(line) || "&nbsp;"}</div>`;
    } catch (err) {
      console.error("[dev-console] failed to render a log line, skipping it:", err, line);
    }
  }
  devConsoleOutput.insertAdjacentHTML("beforeend", html);
  while (devConsoleOutput.children.length > DEV_CONSOLE_MAX_LINES) {
    devConsoleOutput.removeChild(devConsoleOutput.firstChild);
  }
  if (shouldScroll) devConsoleOutput.scrollTop = devConsoleOutput.scrollHeight;
}

function clearDevConsole() {
  showDevConsoleEmptyState("Waiting for dev-server output…");
}
clearDevConsole(); // initial state, before Start Preview is ever clicked

function setDevConsoleExpanded(expanded) {
  devConsolePanel.classList.toggle("collapsed", !expanded);
  devConsoleToggle.textContent = (expanded ? "▾ " : "▸ ") + "Console";
}

devConsoleToggle.addEventListener("click", () => {
  setDevConsoleExpanded(devConsolePanel.classList.contains("collapsed"));
});
devConsoleClear.addEventListener("click", () => clearDevConsole());

// Pushed from the Main process (previewWatcher.js, over the preload
// bridge's preview.onLogStream) — see that file's doc comment for why the
// diffing happens there (prefix-compare against previewOps.ts's own capped
// RunningService.log) rather than here. Subscribed once for the life of
// the window, same lifetime as preview.onStatusChange above it.
preview.onLogStream(({ kind, lines, projectPath }) => {
  // Debug trace (Oct 2026): visible in this window's own DevTools console
  // (Cmd+Option+I / Ctrl+Shift+I) -- pairs with previewWatcher.js's own
  // "[previewWatcher] terminal:log-stream -> ..." trace on the Main-process
  // side (that process's stdout). If the Main-process line appears but this
  // one never does, the IPC send itself is the broken hop; if neither
  // appears, the dev server genuinely hasn't logged anything new yet; if
  // both appear but the drawer still looks empty, the bug is in
  // appendDevConsoleLines/CSS, not the pipe.
  // Ignore queued IPC from a previous project. The watcher can have one
  // status request in flight while the user creates/opens another project.
  const belongsToOpenProject = (path) => {
    if (!path || !currentProjectPath) return false;
    const root = currentProjectPath.replace(/[\\/]+$/, "");
    const cwd = path.replace(/[\\/]+$/, "");
    return cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
  };
  if (!belongsToOpenProject(projectPath)) return;
  console.log(`[dev-console] received ${lines?.length ?? 0} line(s) for ${kind}`);
  appendDevConsoleLines(kind, lines);
});

// Auto-port-discovery diagnostic (portScanner.js) — a clearly-labeled,
// separate "kind" from real stdout/stderr so it's visually distinct in the
// console (see the .dev-console-line-scan rule in styles.css) and never
// mistaken for the dev server's own output. Only pushed on an actual
// change to the open-port set, so it won't spam a line every 4s.
preview.onPortScan(({ openPorts }) => {
  const label = openPorts.length
    ? `[port-scan] listening: ${openPorts.join(", ")}`
    : "[port-scan] no dev-server ports open in 3000-3005 / 8000-8005";
  appendDevConsoleLines("scan", [label]);
});

function describeService(label, svc) {
  if (!svc) return null;
  const where = svc.url ? ` at ${svc.url}` : "";
  // Orchestrator feature request (Oct 2026): "dynamically extract the local
  // SQLite database path" -- surfaced here so the user can see exactly
  // which .db file a running backend is using without going to read
  // main.py themselves (see previewOps.ts's detectSqliteDatabasePath).
  // Absent for the frontend service and for a backend not using SQLite.
  const db = svc.databasePath ? ` · db: ${svc.databasePath}` : "";
  return `${label}: ${svc.status}${where} (${svc.command})${db}`;
}

function renderPreviewStatus(status) {
  // Ignore any late status snapshot from a project that has just been
  // closed. The watcher polls asynchronously, so one in-flight GardenApp
  // response must never put its URL back into the newly opened project's
  // preview panel.
  const belongsToOpenProject = (service) => {
    if (!service || !currentProjectPath || !service.cwd) return false;
    const root = currentProjectPath.replace(/[\\/]+$/, "");
    const cwd = service.cwd.replace(/[\\/]+$/, "");
    return cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
  };
  const frontend = belongsToOpenProject(status.frontend) ? status.frontend : null;
  const backend = belongsToOpenProject(status.backend) ? status.backend : null;
  activeProjectPreviewUrl = frontend?.url ?? null;
  const parts = [describeService("Frontend", frontend), describeService("Backend", backend)].filter(Boolean);
  const running = Boolean(frontend || backend);
  previewStatusText.textContent = parts.length
    ? parts.join("  ·  ")
    : "No runnable app files found. The latest build may not have produced edits, or proposed edits may still need applying. Check the Build task, apply any proposed files, then start Preview.";

  // Surface the actual failure, not just "failed" -- the real stdout/stderr
  // this process produced is already sent over the wire (log, capped at
  // MAX_LOG_LINES in previewOps.ts) but was never shown anywhere before
  // this. A dev server (npm run dev, uvicorn) that exits non-zero almost
  // always says exactly why in its last few lines -- missing deps, a
  // syntax error, a port already in use -- so show those instead of making
  // the user go find a terminal to re-run the same command by hand.
  // Also surfaced (not just "failed"): "installing" -- npm install / pip
  // install can genuinely take a while on a fresh project (see
  // previewOps.ts's frontendInstallSteps/backendInstallSteps), and with no
  // visible output during that stretch this looked indistinguishable from
  // being frozen. Same real-process-output principle as the "failed" case
  // below, just shown while it's still in progress rather than only after
  // it's too late to reassure anyone.
  const notable = [frontend, backend].find(
    (s) => s && (s.status === "failed" || s.status === "installing") && s.log.length > 0,
  );
  if (notable) {
    previewLog.textContent = notable.log.slice(-20).join("\n");
    previewLog.hidden = false;
  } else {
    previewLog.hidden = true;
  }

  const frontendUrl = frontend?.url ?? null;
  // Only auto-navigate the webview the FIRST time a URL becomes known for
  // this run — once the user has typed their own address into the bar
  // (e.g. to view a specific route), further polling shouldn't yank them
  // back to the root. "Still blank" covers both states the tag can be in:
  // no src attribute at all (its initial state — see index.html's comment
  // on why it's never given a literal src="about:blank") and an explicit
  // "about:blank" left by resetPreviewUI() after a previous run ended.
  if (frontendUrl && (displayedPreviewProjectPath !== currentProjectPath || displayedPreviewUrl !== frontendUrl)) {
    previewWebview.src = frontendUrl;
    previewUrlInput.value = frontendUrl;
    displayedPreviewProjectPath = currentProjectPath;
    displayedPreviewUrl = frontendUrl;
  }

  previewBackBtn.disabled = !frontendUrl;
  previewForwardBtn.disabled = !frontendUrl;
  previewReloadBtn.disabled = !frontendUrl;
  previewUrlInput.disabled = !frontendUrl;
  previewOpenBrowserBtn.disabled = !frontendUrl;
  previewEmpty.hidden = Boolean(frontendUrl);
  previewStopBtn.hidden = !running;
  previewStartBtn.hidden = running;
}

function resetPreviewUI() {
  // Setting an Electron <webview>'s src to about:blank during its guest-view
  // attach/navigation handshake rejects GUEST_VIEW_MANAGER_CALL with
  // ERR_ABORTED (-3). Remove the src entirely instead; the UI already treats
  // a missing src as the blank state, and the next preview URL can attach
  // normally without the noisy rejected navigation.
  previewWebview.removeAttribute("src");
  activeProjectPreviewUrl = null;
  displayedPreviewProjectPath = null;
  displayedPreviewUrl = null;
  // Each project switch starts with a clean browser session. This clears
  // the persistent preview partition's cache and site storage, including
  // service workers that can otherwise keep serving an older app at a
  // reused localhost port.
  preview.clearData().catch((err) => console.warn("[preview] failed to clear cached site data:", err));
  previewUrlInput.value = "";
  previewStatusText.textContent = "";
  previewLog.hidden = true;
  previewLog.textContent = "";
  clearDevConsole();
  previewStopBtn.hidden = true;
  previewStartBtn.hidden = false;
  previewBackBtn.disabled = true;
  previewForwardBtn.disabled = true;
  previewReloadBtn.disabled = true;
  previewUrlInput.disabled = true;
  previewOpenBrowserBtn.disabled = true;
  previewEmpty.hidden = false;
}

// Security-hardening pass, item 2: status no longer comes from the renderer
// polling GET /preview/status itself -- it's pushed from the Main process
// (previewWatcher.js, over the preload bridge's preview.onStatusChange) the
// instant desktop-agent's own state actually changes. renderPreviewStatus
// already does everything needed with a full status object (text, log,
// button state, and the "set webview.src the first time a URL is known"
// logic), so this alone is sufficient wiring -- no manual interval to
// create/clear anywhere below. Subscribed once, for the life of the window
// (not just while a preview is running), so a status pushed by an
// in-flight install/start survives even if this code re-runs before Start
// Preview is clicked.
preview.onStatusChange(renderPreviewStatus);

// Dedicated handler for the "project-server:ready" bridge event itself
// (main process -> preload -> here), kept as its own distinct listener
// rather than folded silently into renderPreviewStatus above, since that's
// literally the event this split-screen preview feature is built around:
// the moment the project's dev server is confirmed listening, populate the
// isolated <webview> with its real URL. renderPreviewStatus's own "first
// known URL" branch (used on every status push, including the very next
// one after this) guards against setting src twice -- both paths are safe
// to run together.
preview.onReady(({ url }) => {
  const previewSrc = previewWebview.getAttribute("src");
  if (url && url === activeProjectPreviewUrl && (!previewSrc || previewSrc === "about:blank")) {
    previewWebview.src = url;
    previewUrlInput.value = url;
    displayedPreviewProjectPath = currentProjectPath;
    displayedPreviewUrl = url;
  }
});

previewStartBtn.addEventListener("click", async () => {
  if (!currentProjectPath) {
    previewStatusText.textContent = "Open a project first.";
    return;
  }
  previewStartBtn.disabled = true;
  previewStatusText.textContent = "Detecting and starting dev server(s)…";
  // Fresh run — old output belongs to whatever was running before, and
  // previewWatcher.js will itself resend the full current log on its next
  // poll tick anyway (see its diffNewLogLines doc comment), so clearing
  // here avoids a confusing few seconds where stale and live output are
  // interleaved. Auto-expand too — the user just asked to start a server,
  // seeing its output immediately beats finding the drawer collapsed.
  clearDevConsole();
  setDevConsoleExpanded(true);
  try {
    await preview.clearData();
    // A direct, user-initiated action (same pattern as every other button
    // in this app) -- the ask to keep "server network checks" out of the
    // sandboxed window was about the repeated "is it up yet?" polling loop
    // above, not one-shot start/stop calls the user themselves triggered.
    const result = await api("/preview/start", { method: "POST" });
    renderPreviewStatus(result);
  } catch (err) {
    previewStatusText.textContent = `Failed to start preview: ${err.message}`;
  } finally {
    previewStartBtn.disabled = false;
  }
});

previewStopBtn.addEventListener("click", async () => {
  previewStopBtn.disabled = true;
  try {
    await api("/preview/stop", { method: "POST" });
  } catch {
    // best effort — the panel resets client-side regardless
  }
  resetPreviewUI();
  previewStatusText.textContent = "Preview stopped.";
  previewStopBtn.disabled = false;
});

previewBackBtn.addEventListener("click", () => {
  if (previewWebview.canGoBack()) previewWebview.goBack();
});
previewForwardBtn.addEventListener("click", () => {
  if (previewWebview.canGoForward()) previewWebview.goForward();
});
previewReloadBtn.addEventListener("click", () => previewWebview.reload());
previewUrlInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  let url = previewUrlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  previewWebview.src = url;
});
previewOpenBrowserBtn.addEventListener("click", () => {
  if (previewUrlInput.value) openExternal(previewUrlInput.value);
});

document.getElementById("preview-toggle").addEventListener("click", () => {
  const collapsed = previewPanel.classList.toggle("collapsed");
  document.getElementById("preview-toggle").textContent = (collapsed ? "▸ " : "▾ ") + "Preview";
});

// Monaco + Preview 50/50 split (security-hardening pass, item 3): purely a
// CSS layout toggle over the SAME #preview-panel/#preview-webview this file
// already drives above -- no second webview, no duplicate state, and no
// auto-starting the dev server just because the pane became visible (that
// stays an explicit "Start Preview" click, same as before this feature).
const editorPreviewSplit = document.getElementById("editor-preview-split");
const previewSplitToggleBtn = document.getElementById("preview-split-toggle");
const previewFocusToggleBtn = document.getElementById("preview-focus-toggle");
const workspaceEl = document.getElementById("workspace");
previewSplitToggleBtn.addEventListener("click", () => {
  const active = editorPreviewSplit.classList.toggle("split-active");
  previewSplitToggleBtn.classList.toggle("active", active);
  previewSplitToggleBtn.title = active
    ? "Return Preview to its own collapsible panel"
    : "View Preview side-by-side with the editor";
});
previewFocusToggleBtn.addEventListener("click", () => {
  const active = workspaceEl.classList.toggle("preview-focus-active");
  document.body.classList.toggle("preview-focus-mode", active);
  if (active) {
    previewPanel.classList.remove("collapsed");
    document.getElementById("preview-toggle").textContent = "▾ Preview";
    showView("workspace");
  }
  previewFocusToggleBtn.classList.toggle("active", active);
  previewFocusToggleBtn.setAttribute("aria-pressed", String(active));
  previewFocusToggleBtn.textContent = active ? "⛶ Exit focus" : "⛶ Focus Preview";
  previewFocusToggleBtn.title = active ? "Return to the editor workspace" : "Expand the live preview to fill the workspace";
});

// ============================================================
// Project Understanding Engine (roadmap Phase 7, source requirement §5):
// GET /project-context runs real, evidence-based tech-stack detection (see
// apps/desktop-agent/src/projectContext.ts) -- collapsed by default, the
// user expands + clicks Detect (or re-clicks any time the stack changes;
// nothing here auto-refreshes on file changes in this v1).
// ============================================================
const projectContextPanel = document.getElementById("project-context-panel");
const projectContextToggle = document.getElementById("project-context-toggle");
const projectContextDetectBtn = document.getElementById("project-context-detect-btn");
const projectContextResultsEl = document.getElementById("project-context-results");
let projectContextExpanded = false;

function resetProjectContextUI() {
  projectContextExpanded = false;
  projectContextResultsEl.hidden = true;
  projectContextResultsEl.innerHTML = "";
  projectContextToggle.textContent = "▸ Project Context";
  projectContextDetectBtn.hidden = !currentProjectPath;
}

projectContextToggle.addEventListener("click", () => {
  projectContextExpanded = !projectContextExpanded;
  projectContextResultsEl.hidden = !projectContextExpanded;
  projectContextToggle.textContent = (projectContextExpanded ? "▾ " : "▸ ") + "Project Context";
});

const CONTEXT_CATEGORY_LABELS = {
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  orm: "ORM",
  auth: "Auth",
  testFramework: "Test framework",
  infra: "Infra",
};

function renderProjectContextReport(report) {
  const byCategory = new Map();
  for (const c of report.components) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category).push(c);
  }
  const order = ["frontend", "backend", "database", "orm", "auth", "testFramework", "infra"];
  const rows = order
    .map((cat) => {
      const items = byCategory.get(cat);
      if (!items || items.length === 0) {
        return `<div class="context-row not-detected"><span class="context-row-label">${CONTEXT_CATEGORY_LABELS[cat]}</span><span class="context-row-value">Not detected</span></div>`;
      }
      const value = items.map((c) => `${escapeHtml(c.name)} <span class="context-row-loc">(${escapeHtml(c.location)}/)</span>`).join(", ");
      return `<div class="context-row"><span class="context-row-label">${CONTEXT_CATEGORY_LABELS[cat]}</span><span class="context-row-value">${value}</span></div>`;
    })
    .join("");
  projectContextResultsEl.innerHTML = `
    <div class="context-rows">${rows}</div>
    <div class="completion-meta">Generated ${new Date(report.generatedAt).toLocaleString()} · written to .mobiusx/PROJECT_CONTEXT.md</div>
  `;
}

projectContextDetectBtn.addEventListener("click", async () => {
  projectContextDetectBtn.disabled = true;
  projectContextDetectBtn.textContent = "Detecting…";
  projectContextExpanded = true;
  projectContextResultsEl.hidden = false;
  projectContextToggle.textContent = "▾ Project Context";
  projectContextResultsEl.innerHTML = `<div class="verify-pending">Scanning the project for real tech-stack evidence…</div>`;
  try {
    const report = await api("/project-context");
    renderProjectContextReport(report);
  } catch (err) {
    projectContextResultsEl.innerHTML = `<div class="verify-none">Detection failed: ${escapeHtml(err.message)}</div>`;
  }
  projectContextDetectBtn.disabled = false;
  projectContextDetectBtn.textContent = "Detect";
});

resetProjectContextUI();

// ============================================================
// Changes (git) view
// ============================================================
async function loadGit() {
  const branchEl = document.getElementById("git-branch");
  const statusEl = document.getElementById("git-status-list");
  const logEl = document.getElementById("git-log-list");
  const diffEl = document.getElementById("diff-view");

  if (!currentProjectPath) {
    branchEl.textContent = "";
    statusEl.innerHTML = "<div class='recent-empty'>Open a project to see its changes.</div>";
    logEl.innerHTML = "";
    diffEl.textContent = "Select a changed file to view its diff.";
    return;
  }

  try {
    const status = await api("/git/status");
    branchEl.textContent =
      `On ${status.branch ?? "(detached)"}` + (status.ahead ? ` ↑${status.ahead}` : "") + (status.behind ? ` ↓${status.behind}` : "");
    statusEl.innerHTML = "";
    if (status.entries.length === 0) {
      statusEl.innerHTML = "<div class='recent-empty'>Clean working tree</div>";
    }
    for (const entry of status.entries) {
      const div = document.createElement("div");
      div.className = "git-entry";
      div.innerHTML = `<span class="git-code">${entry.index}${entry.worktree}</span><span>${entry.path}</span>`;
      div.addEventListener("click", async () => {
        diffEl.textContent = "Loading diff…";
        try {
          const staged = entry.index !== " " && entry.index !== "?";
          const { diff } = await api(`/git/diff?path=${encodeURIComponent(entry.path)}&staged=${staged}`);
          diffEl.textContent = diff || "(no textual diff — binary file or no changes against this state)";
        } catch (err) {
          diffEl.textContent = `Failed to load diff: ${err.message}`;
        }
      });
      statusEl.appendChild(div);
    }
  } catch (err) {
    statusEl.innerHTML = `<div class='recent-empty'>git status failed: ${err.message}</div>`;
  }

  try {
    const log = await api("/git/log?limit=20");
    logEl.innerHTML = "";
    for (const entry of log.entries) {
      const div = document.createElement("div");
      div.className = "log-entry";
      div.innerHTML = `<span class="log-hash">${entry.hash.slice(0, 7)}</span> ${entry.subject}`;
      logEl.appendChild(div);
    }
  } catch (err) {
    logEl.textContent = `git log failed: ${err.message}`;
  }
}

// ---- Checkpoints / Rollback (roadmap Phase 15, source requirement §23) ----
// Real, git-independent restore points, taken automatically by the desktop
// agent before every applied AI edit (see checkpoints.ts). This panel is
// the read/restore/delete surface over GET/POST/DELETE /checkpoints.
async function loadCheckpoints() {
  const listEl = document.getElementById("checkpoints-list");
  const statusEl = document.getElementById("checkpoints-status");
  if (!listEl) return;
  if (statusEl) statusEl.textContent = "";

  if (!currentProjectPath) {
    listEl.innerHTML = "<div class='recent-empty'>Open a project to see its checkpoints.</div>";
    return;
  }

  try {
    const { checkpoints } = await api("/checkpoints");
    if (checkpoints.length === 0) {
      listEl.innerHTML =
        "<div class='recent-empty'>No checkpoints yet — one is taken automatically the next time the AI Assistant applies edits.</div>";
      return;
    }
    listEl.innerHTML = checkpoints
      .map(
        (cp) => `
      <div class="checkpoint-row" data-id="${escapeHtml(cp.id)}">
        <div class="checkpoint-row-main">
          <div class="checkpoint-row-label">${escapeHtml(cp.label)}</div>
          <div class="checkpoint-row-meta">${new Date(cp.createdAt).toLocaleString()} · ${cp.entryCount} file(s)</div>
        </div>
        <div class="checkpoint-row-actions">
          <button class="refresh-btn checkpoint-restore-btn">Restore</button>
          <button class="refresh-btn checkpoint-delete-btn">Delete</button>
        </div>
      </div>`,
      )
      .join("");

    listEl.querySelectorAll(".checkpoint-row").forEach((rowEl) => {
      const id = rowEl.dataset.id;

      rowEl.querySelector(".checkpoint-restore-btn").addEventListener("click", async () => {
        const btn = rowEl.querySelector(".checkpoint-restore-btn");
        btn.disabled = true;
        btn.textContent = "Restoring…";
        if (statusEl) statusEl.textContent = "";
        try {
          const result = await api(`/checkpoints/${encodeURIComponent(id)}/restore`, { method: "POST" });
          const restored = result.results.filter((r) => r.status !== "skipped").length;
          if (statusEl) {
            statusEl.textContent =
              `Restored ${restored}/${result.results.length} file(s).` +
              (result.preRestoreCheckpointId ? " A checkpoint of the prior state was saved first." : "");
          }
          btn.textContent = "Restore";
          btn.disabled = false;
          await loadCheckpoints();
          await loadGit();
        } catch (err) {
          if (statusEl) statusEl.textContent = `Restore failed: ${err.message}`;
          btn.textContent = "Restore";
          btn.disabled = false;
        }
      });

      rowEl.querySelector(".checkpoint-delete-btn").addEventListener("click", async () => {
        const btn = rowEl.querySelector(".checkpoint-delete-btn");
        btn.disabled = true;
        try {
          await api(`/checkpoints/${encodeURIComponent(id)}`, { method: "DELETE" });
          await loadCheckpoints();
        } catch (err) {
          if (statusEl) statusEl.textContent = `Delete failed: ${err.message}`;
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class='recent-empty'>Failed to load checkpoints: ${escapeHtml(err.message)}</div>`;
  }
}

// ============================================================
// Artifacts view (roadmap Phase 9, Architecture Generation) -- renders
// docs/architecture/HLD.md and LLD.md with live Mermaid diagrams. Reuses
// the app's existing no-bundler pattern (see index.html's <script> tags,
// same approach as @xterm/xterm): mermaid and marked are loaded as plain
// global-scope <script> tags, not bundled.
// ============================================================
if (window.mermaid) {
  // "dark" matches this app's own dark theme (see styles.css) -- the
  // default Mermaid theme renders near-invisible text on this background.
  mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
}
if (window.marked) {
  // Intercept ```mermaid fences specifically; every other language falls
  // through to marked's normal fenced-code-block rendering (returning
  // false is marked's documented way to say "use the default renderer").
  // The diagram source is stashed in a data attribute (URI-encoded, since
  // it can itself contain quotes/newlines) rather than rendered inline
  // here, because mermaid.render() is async and marked's renderer hooks
  // are not -- actual rendering happens in renderMarkdownWithMermaid below,
  // once the container is in the DOM.
  marked.use({
    renderer: {
      code({ text, lang }) {
        if ((lang || "").trim().toLowerCase() === "mermaid") {
          return `<div class="mermaid-pending" data-src="${encodeURIComponent(text)}">Rendering diagram…</div>`;
        }
        return false;
      },
    },
  });
}
if (window.hljs) {
  // Gap Analysis Pillar 1 ("UI/UX & Layout Gap"): marked's default renderer
  // emits a plain `<pre><code class="language-x">` for every fenced block
  // that isn't ```mermaid, with zero color -- there was no syntax
  // highlighter vendored at all before this. ignoreUnescapedHTML=true
  // because the code text here already came through marked's own HTML
  // escaping; without it hljs logs a console warning on every block.
  hljs.configure({ ignoreUnescapedHTML: true });
}

/** Parses markdown into `container`, then (1) syntax-highlights every fenced code block hljs recognizes the language of, and (2) renders every ```mermaid fence it contained as an actual SVG diagram (async, since mermaid.render() is). A diagram that fails to parse shows the error plus its raw source rather than silently disappearing -- this is exactly the kind of thing Phase 9's own evidence-grounding is meant to prevent, so a failure here should be visible, not swallowed. */
async function renderMarkdownWithMermaid(container, markdownText) {
  if (!window.marked) {
    container.textContent = markdownText;
    return;
  }
  container.innerHTML = marked.parse(markdownText);
  if (window.hljs) {
    // querySelectorAll, not just the ```mermaid fences -- those became
    // `.mermaid-pending` divs in marked's renderer override above, never
    // `<pre><code>`, so they're naturally excluded from this selector
    // without needing to filter them out by hand.
    container.querySelectorAll("pre code").forEach((codeEl) => {
      try {
        hljs.highlightElement(codeEl);
      } catch {
        // A language hljs doesn't recognize (or doesn't ship, see
        // vendor/README.md's curated list) throws rather than falling back
        // -- leave the block as plain, unhighlighted text rather than
        // losing the response's content over a cosmetic failure.
      }
    });
  }
  if (!window.mermaid) return;
  const pending = [...container.querySelectorAll(".mermaid-pending")];
  for (const el of pending) {
    const src = decodeURIComponent(el.dataset.src);
    const id = "mmd-" + Math.random().toString(36).slice(2, 10);
    try {
      const { svg } = await mermaid.render(id, src);
      el.innerHTML = svg;
      el.classList.remove("mermaid-pending");
      el.classList.add("mermaid-rendered");
    } catch (err) {
      el.classList.remove("mermaid-pending");
      el.classList.add("mermaid-error");
      el.innerHTML = `<div class="mermaid-error-msg">Mermaid render failed: ${escapeHtml(err.message)}</div><pre>${escapeHtml(src)}</pre>`;
    }
  }
}

/** Loads docs/architecture/HLD.md and LLD.md for the open project (if either exists) and renders them with live Mermaid diagrams. Fixed, well-known paths -- see fetchArchitectureRelevantFiles's doc comment for why this deliberately isn't a search. */
async function loadArtifacts() {
  const body = document.getElementById("artifacts-body");
  if (!body) return;
  if (!currentProjectPath) {
    body.innerHTML = "<div class='recent-empty'>Open a project to see its generated architecture docs.</div>";
    return;
  }
  body.innerHTML = "<div class='recent-empty'>Loading…</div>";
  const files = [
    { path: "docs/architecture/HLD.md", label: "High-Level Design" },
    { path: "docs/architecture/LLD.md", label: "Low-Level Design" },
  ];
  const sections = [];
  for (const f of files) {
    try {
      const { content } = await api(`/fs/read?path=${encodeURIComponent(f.path)}`);
      sections.push({ ...f, content });
    } catch {
      // Doesn't exist yet for this project -- not an error, just not generated.
    }
  }
  if (sections.length === 0) {
    body.innerHTML =
      "<div class='recent-empty'>No architecture docs yet for this project. Switch to Architecture mode in the AI Assistant and ask it to generate one (e.g. \"Generate the architecture docs for this project\").</div>";
    return;
  }
  body.innerHTML = "";
  for (const s of sections) {
    const wrap = document.createElement("div");
    wrap.className = "artifact-doc";
    const h3 = document.createElement("h3");
    h3.textContent = `${s.label} — ${s.path}`;
    wrap.appendChild(h3);
    const content = document.createElement("div");
    content.className = "artifact-doc-content";
    wrap.appendChild(content);
    body.appendChild(wrap);
    await renderMarkdownWithMermaid(content, s.content);
  }
}

// ============================================================
// Cloud Agent Gateway client (Phase 3) — a LOCAL REFERENCE implementation,
// not MobiusX's real production Cloud. See apps/cloud-agent-gateway/README.md
// and docs/ARCHITECTURE.md §12.
// ============================================================
async function cloudApi(path, opts = {}) {
  const res = await fetch(cloudBaseUrl + path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${cloudToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ? `${body.error}${body.detail ? ": " + body.detail : ""}` : `HTTP ${res.status}`);
  }
  return res.json();
}

/** Reads a Blob (a recorded voice clip, here) into a base64 string with no "data:" prefix — what POST /transcribe expects. */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result; // "data:<mime>;base64,<data>"
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Best-effort: ground a cloud task in locally-relevant code via Phase 2's
 * semantic search. Never blocks submission on failure.
 *
 * For build mode specifically, this also fetches each hit's FULL current
 * content via /fs/read (not just the search snippet) and attaches it as
 * relevantFiles[].content. That's the safety invariant the gateway and the
 * desktop agent both enforce (see cloud.ts's ProjectContext doc comment,
 * taskEngine.ts's redaction pass, and anthropicRunner.ts's systemPromptFor):
 * the model can only propose a "modify" edit for a path it was actually
 * shown in full here — never a file it only ever saw a snippet of.
 */
async function findRelevantFiles(query, mode) {
  // Returns { hits, storeSize } rather than a bare array -- storeSize (the
  // semantic index's total chunk count, from /debug/search's response) is
  // what distinguishes "this project is empty" from "this project has
  // files, none matched" once the caller passes it through as
  // projectContext.indexedChunkCount. Confirmed live (Sept 2026,
  // qwen/qwen3.8-27b) that leaving that ambiguous made a careful model
  // refuse to propose any files at all for a brand-new project rather than
  // guess whether "create" was safe -- see promptShared.ts's
  // relevantFilesContext for how this gets used.
  if (!currentProjectPath) return { hits: [], storeSize: undefined };
  try {
    // Small local models often touch a backend schema, route, manifest, and
    // frontend page in one build. Three semantic chunks made omitted edits
    // common because generated existing files outside that tiny set were
    // (correctly) rejected by the gateway's full-content modification guard.
    // Fetch more distinct candidates for build/fix work, while keeping other
    // chat modes light; collapse repeated chunks from the same file before
    // loading its full contents.
    const searchCount = mode === "build" ? 12 : mode === "fix" ? 8 : 3;
    const result = await api(`/debug/search?q=${encodeURIComponent(query)}&k=${searchCount}`);
    const seenPaths = new Set();
    const hits = result.hits
      .filter((h) => {
        if (seenPaths.has(h.relPath) || seenPaths.size >= (mode === "build" ? 8 : 6)) return false;
        seenPaths.add(h.relPath);
        return true;
      })
      .map((h) => ({ relPath: h.relPath, snippet: h.snippet }));
    // "fix" mode needs full content just as much as "build" does --
    // promptShared.ts's fix-mode branch only allows action "modify" for a
    // path it was shown FULL content for (fixFullContentPaths), and
    // otherwise instructs the model to only ever "create", which
    // fsOps.ts#applyEdits then correctly refuses for a path that already
    // exists. Before this fix, fix-mode hits were always snippet-only, so
    // every fix-mode task was deterministically steered into proposing
    // "create" for a file that already exists -- confirmed live against 3
    // different models (groq/gpt-oss-120b twice, openrouter/ling-3.0):
    // each either declined to edit at all, or proposed a correct fix
    // labeled "create", which Apply then silently skipped with "file
    // already exists -- refusing to overwrite a create". Not a model
    // quality problem -- the prompt's own instructions left no other
    // option once content was withheld.
    if (mode !== "build" && mode !== "fix" && mode !== "database" && mode !== "testing") return { hits, storeSize: result.storeSize };
    const withContent = await Promise.all(
      hits.map(async (h) => {
        try {
          const file = await api(`/fs/read?path=${encodeURIComponent(h.relPath)}`);
          return { ...h, content: file.content };
        } catch {
          return h; // fall back to snippet-only for this file rather than failing the whole request
        }
      }),
    );
    return { hits: withContent, storeSize: result.storeSize };
  } catch {
    return { hits: [], storeSize: undefined };
  }
}

/**
 * Project Memory/Steering (roadmap Phase 16, source requirement §24/§25):
 * fetched for EVERY mode with a project open (unlike architectureEvidence/
 * testingEvidence, which are mode-specific) -- see
 * ProjectContext.steeringContext's doc comment in @mobiusx/protocol for
 * why. Combines every non-empty .mobiusx/steering/*.md file's content
 * into one string; returns undefined (never "") when there's nothing to
 * add, so callers can spread it in with the same `...(x ? {x} : {})`
 * convention already used for architectureEvidence/testingEvidence below.
 */
async function fetchSteeringContext() {
  try {
    const { files } = await api("/steering");
    const nonEmpty = (files || []).filter((f) => f.content && f.content.trim().length > 0);
    if (nonEmpty.length === 0) return undefined;
    return nonEmpty.map((f) => `--- .mobiusx/steering/${f.name}.md ---\n${f.content.trim()}`).join("\n\n");
  } catch {
    return undefined;
  }
}

/**
 * Assistant Memory (Oct 2026 addition — see MemoryFile's doc comment in
 * @mobiusx/protocol's agent.ts for the full feature background). Mirrors
 * fetchSteeringContext directly above, with one real difference: memory is
 * GLOBAL (~/.mobiusx/memory/, not a per-project .mobiusx/ folder), so this
 * is safe and meaningful to call even with no project open, unlike
 * fetchSteeringContext — callers should NOT gate this behind a
 * taskProjectPath check the way steering/knowledge fetches are gated.
 */
async function fetchAssistantMemoryContext() {
  try {
    const { files } = await api("/memory");
    const nonEmpty = (files || []).filter((f) => f.content && f.content.trim().length > 0);
    if (nonEmpty.length === 0) return undefined;
    return nonEmpty.map((f) => `--- memory/${f.name}.md ---\n${f.content.trim()}`).join("\n\n");
  } catch {
    return undefined;
  }
}

/**
 * Enterprise Knowledge / Global Intelligence local substitute (roadmap
 * Phase 17, source requirement §29/§30) -- see KnowledgeSearchHit's doc
 * comment in @mobiusx/protocol. Runs a real search over the user's own
 * configured knowledge sources against the CURRENT prompt text, the same
 * way findRelevantFiles greps the project's code -- so a generation
 * prompt is grounded in the user's own docs/standards when they've added
 * any, and silently contributes nothing when they haven't (never a fake
 * "no knowledge configured" placeholder inside the prompt itself).
 */
async function fetchKnowledgeContext(queryText) {
  try {
    const { hits } = await api(`/knowledge/search?q=${encodeURIComponent(queryText)}&k=5`);
    if (!hits || hits.length === 0) return undefined;
    return hits.map((h) => ({ sourceLabel: h.sourceLabel, relPath: h.relPath, snippet: h.snippet }));
  } catch {
    return undefined;
  }
}

/**
 * Architecture mode (roadmap Phase 9) does NOT ground itself in semantic
 * search -- its real grounding is the pre-computed evidence bundle (GET
 * /architecture-evidence, fetched in submit() below), per
 * promptShared.ts's "architecture" branch. This function has one narrow
 * job instead: if docs/architecture/HLD.md and/or LLD.md already exist,
 * fetch their FULL current content so the model can correctly propose
 * "modify" rather than "create" against a file that's already there --
 * the same "CREATE on an existing file gets silently skipped by Apply"
 * failure mode Database mode hit in Phase 8 (see phase-8 phase notes).
 * Fixed, well-known paths fetched directly via /fs/read -- deliberately
 * NOT dependent on semantic search top-k, since these two paths are known
 * in advance for every project, not something a query needs to find.
 */
async function fetchArchitectureRelevantFiles() {
  const paths = ["docs/architecture/HLD.md", "docs/architecture/LLD.md"];
  const hits = [];
  for (const relPath of paths) {
    try {
      const file = await api(`/fs/read?path=${encodeURIComponent(relPath)}`);
      hits.push({ relPath, content: file.content });
    } catch {
      // Doesn't exist yet in this project -- fine, action "create" is the
      // correct proposal for it; nothing to fetch.
    }
  }
  return hits;
}

/**
 * Creates a task, streams its progress into the given render callbacks, and
 * resolves once the task reaches a terminal state. Shared by the assistant
 * panel and the Tasks view's live detail pane.
 */
function streamTask(taskId, { onStep, onOutput, onEdits, onReview, onStatus, onError, onDone }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      onDone?.();
      resolve();
    };
    const ws = new WebSocket(`${cloudWsUrl}/tasks/${taskId}/stream?token=${encodeURIComponent(cloudToken)}`);
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "step") onStep?.(msg.step);
      else if (msg.type === "output") onOutput?.(msg.delta);
      else if (msg.type === "edits") onEdits?.(msg.edits);
      else if (msg.type === "review") onReview?.(msg.review);
      else if (msg.type === "status") onStatus?.(msg.status);
      else if (msg.type === "error") onError?.(msg.message);
      else if (msg.type === "done") {
        try {
          ws.close();
        } catch {
          /* already closing — fine */
        }
        finish();
      }
    });
    ws.addEventListener("error", () => {
      onError?.("stream connection error");
      finish();
    });
    // Real, observed failure mode (Oct 2026): a build-mode (and every other
    // MODES_WITH_STRUCTURED_EDITS) response is buffered and parsed as one
    // block server-side, not streamed token-by-token (see promptShared.ts),
    // so for a genuinely large response this socket can sit completely
    // silent for 5-10+ minutes while Anthropic generates the full reply.
    // If the underlying connection drops during that silence -- confirmed
    // live: a real task had already finished server-side (GET /tasks/:id
    // showed status "completed" with real output) while this exact panel
    // stayed on "Working… Streaming response from Anthropic API" for 8+
    // minutes afterward, because the final "done" frame never arrived and
    // nothing here ever resolved the promise -- the UI hung forever with
    // no error, no retry, nothing. A WebSocket "close" that fires without
    // "done" ever having been seen is the unambiguous signal for exactly
    // this: fall back to one REST read of the task's actual final state so
    // the UI always reaches a terminal state instead of hanging.
    ws.addEventListener("close", async () => {
      if (settled) return;
      try {
        const task = await cloudApi(`/tasks/${taskId}`);
        for (const step of task.steps || []) onStep?.(step);
        if (task.output) onOutput?.(task.output);
        if (task.edits && task.edits.length > 0) onEdits?.(task.edits);
        if (task.review) onReview?.(task.review);
        const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
        onStatus?.(terminalStatuses.has(task.status) ? task.status : "failed");
        if (!terminalStatuses.has(task.status)) {
          onError?.("Lost connection to the task stream before it finished.");
        } else if (task.status === "failed" && task.error) {
          onError?.(task.error);
        }
      } catch (err) {
        onError?.(`Lost connection to the task stream and couldn't recover its final state: ${err.message}`);
      } finally {
        finish();
      }
    });
  });
}

// ============================================================
// Proposed-edits review UI — shared by the AI Assistant panel and the
// Tasks view's detail pane. Renders each build-mode ProposedEdit (see
// @mobiusx/protocol) as a file card with an on-demand diff (computed
// client-side via jsdiff — see index.html's <script> tag — never sent
// anywhere), and an Apply button that is the ONLY UI path that ever calls
// the desktop agent's POST /fs/apply-edits (see fsOps.ts#applyEdits) —
// nothing here writes to disk itself.
// ============================================================

/**
 * Mirrors the AgentPersona -> label mapping in
 * apps/cloud-agent-gateway/src/runners/personas.ts's PERSONAS export
 * (roadmap Phase 11, source §26) — duplicated here by hand rather than
 * fetched at runtime, since renderer.js is a plain script (no bundler/
 * import of gateway source) and this list is small and rarely changes. If
 * a persona is ever added/renamed there, mirror it here too.
 */
const PERSONA_LABELS = {
  architecture: "Architecture Agent",
  database: "Database Agent",
  backend: "Backend Agent",
  frontend: "Frontend Agent",
  api: "API Agent",
  testing: "Testing Agent",
  devops: "DevOps Agent",
  auth: "Auth Agent",
  documentation: "Documentation Agent",
  debugger: "Debugger Agent",
};

/** Renders a Reviewer-agent verdict banner's inner HTML (see EditReview in @mobiusx/protocol) — shared by buildEditsCard's initial render and a later post-hoc injection (the review event can arrive after the edits card already exists). Roadmap Phase 11 (source §26) named the previously-generic "Reviewer" persona -- an older task (or a runner that somehow didn't attach one) falls back to the plain "Reviewer" label rather than showing "undefined". */
function renderReviewBannerHtml(review) {
  const cls = review.verdict === "approve" ? "approve" : "concerns";
  const icon = review.verdict === "approve" ? "✓" : "⚠";
  const reviewerName = (review.persona && PERSONA_LABELS[review.persona]) || "Reviewer";
  const label = review.verdict === "approve" ? `${reviewerName}: Approve` : `${reviewerName}: Concerns`;
  return `<div class="review-banner ${cls}"><div class="review-banner-head"><span class="review-banner-icon">${icon}</span><span class="review-banner-label">${label}</span></div><div class="review-banner-summary">${escapeHtml(review.summary)}</div></div>`;
}

/** Renders a unified-style line diff as HTML. Falls back to plain (escaped) new-content text if the diff library somehow isn't loaded, rather than throwing. */
function renderDiffHtml(oldStr, newStr) {
  if (typeof Diff === "undefined") {
    return `<div class="diff-line diff-context">${escapeHtml(newStr ?? "")}</div>`;
  }
  const parts = Diff.diffLines(oldStr ?? "", newStr ?? "");
  return parts
    .map((part) => {
      const cls = part.added ? "diff-added" : part.removed ? "diff-removed" : "diff-context";
      const prefix = part.added ? "+" : part.removed ? "-" : " ";
      const lines = part.value.split("\n");
      if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact from a final newline
      return lines.map((line) => `<div class="diff-line ${cls}">${prefix} ${escapeHtml(line)}</div>`).join("");
    })
    .join("");
}

function countDiffPartLines(value) {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing split artifact from a final newline
  return lines.length;
}

/**
 * Numerical lines-added/lines-removed stats for one file's proposed change
 * (feature request: "created/modified pages list and numerical statistics
 * should be shown", matching Cursor's own reference UI of per-file "+N -M"
 * next to each changed file). Reuses the same jsdiff `Diff.diffLines` the
 * "Show diff" view already depends on, so the number always matches what
 * the expanded diff actually shows -- never a separately-eyeballed guess.
 */
function diffLineStats(oldStr, newStr) {
  if (typeof Diff === "undefined") {
    // no diff engine available -- fall back to a whole-file-added estimate
    // rather than showing nothing.
    return { added: (newStr ?? "").split("\n").length, removed: 0 };
  }
  const parts = Diff.diffLines(oldStr ?? "", newStr ?? "");
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const n = countDiffPartLines(part.value);
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed };
}

function diffStatsHtml(stats) {
  if (!stats) return `<span class="edits-file-stats edits-file-stats-pending">···</span>`;
  const { added, removed } = stats;
  const parts = [];
  if (added > 0) parts.push(`<span class="diff-stat-added">+${added}</span>`);
  if (removed > 0) parts.push(`<span class="diff-stat-removed">-${removed}</span>`);
  if (parts.length === 0) parts.push(`<span class="diff-stat-none">±0</span>`);
  return `<span class="edits-file-stats">${parts.join(" ")}</span>`;
}

/** Best-effort: refreshes the file tree and any already-open tabs for files an apply just touched. Never throws — a stale tree/tab is a cosmetic problem, not a reason to hide that the apply itself succeeded. */
async function refreshAfterApply(appliedRelPaths) {
  try {
    if (currentProjectPath) await loadTree();
  } catch {
    /* cosmetic — ignore */
  }
  for (const relPath of appliedRelPaths) {
    const tab = openTabs.find((t) => t.path === relPath);
    if (!tab) continue;
    try {
      const data = await api(`/fs/read?path=${encodeURIComponent(relPath)}`);
      tab.truncated = data.truncated;
      // Apply the new disk content as a real edit operation (not a model
      // replace) so undo history survives. An AI-applied edit IS a save —
      // the new disk content becomes this tab's baseline, not a pending
      // local edit — so re-baseline savedVersionId too; otherwise a false
      // dirty-dot would appear right after a successful apply.
      tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: data.content }], () => null);
      tab.savedVersionId = tab.model.getAlternativeVersionId();
      if (activeTabPath === relPath) updateEditorStatusbar(tab);
      renderTabs();
    } catch {
      /* cosmetic — ignore */
    }
  }
}

/**
 * Builds the "Proposed changes" card for a set of edits. `edits` is never
 * mutated. `taskProjectPath` (when known — see TaskSummary.projectPath) is
 * checked against whichever project is currently open in the desktop
 * agent: applying against the wrong open project would silently write
 * these files somewhere the user didn't intend, so a mismatch disables
 * Apply with an explicit explanation instead of guessing.
 */
// Autonomous Build/Test/Fix Loop -- "auto" autonomy mode (roadmap Phase 22,
// source requirement §16, filling in the gap Phase 6's own phase-notes
// doc explicitly left open: "an 'auto' fix-loop mode that chains Apply ->
// Verify -> Diagnose cycles without a click each time"). AgentSettings.
// fixLoopMode has accepted "auto" as a valid value since Phase 6 (see its
// doc comment in packages/protocol/src/agent.ts) but nothing ever read it
// -- PATCH /settings would happily store it, and it would do NOTHING.
//
// Deliberately additive, not a rewrite of the existing "manual" flow: the
// first Diagnose & Fix can be user-initiated in Manual mode, or automatically
// started after a failed post-apply verification in Auto mode. Once a fix
// task's edits appear, this code drives the SAME Apply/Run
// verification/Diagnose & Fix buttons that a manual user would click,
// via real DOM clicks + polling for each button's own already-existing
// "done" signal (its text content leaving its "…ing" state -- e.g.
// "Applying…" settling to "Applied" or back to "Apply"), so a manual user
// and the auto loop are indistinguishable to the rest of this file: same
// API calls, same rendered evidence, same buildEditsCard structure at
// every recursion level. Capped at MAX_AUTO_FIX_ITERATIONS so a
// genuinely unfixable failure reports an honest "still failing after N
// attempts" instead of looping forever.
const MAX_AUTO_FIX_ITERATIONS = 3;

function waitForButtonSettled(btn, busyText) {
  return new Promise((resolve) => {
    const check = () => {
      if (!btn || btn.textContent !== busyText) {
        resolve();
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

function appendAutoFixBanner(container, text, kind) {
  const el = document.createElement("div");
  el.className = `verify-summary ${kind === "success" ? "passed" : "failed"}`;
  el.textContent = text;
  container.appendChild(el);
}

/** Start or reuse this project's preview and wait for install/start to
 * settle. Startup failures return the real command output for repair context;
 * a timeout is never reported as a successful launch. */
async function ensurePreviewForValidation(projectPath) {
  try {
    const belongsToProject = (service) => {
      if (!service?.cwd || !projectPath) return false;
      const root = projectPath.replace(/[\\/]+$/, "");
      const cwd = service.cwd.replace(/[\\/]+$/, "");
      return cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
    };
    let status = await api("/preview/status");
    const currentServices = [status.frontend, status.backend].filter(belongsToProject);
    let detected = currentServices.length > 0;
    const reusable = currentServices.length > 0 && currentServices.every((service) => !["failed", "exited"].includes(service.status));
    if (!reusable) {
      const started = await api("/preview/start", { method: "POST" });
      detected = Boolean(started.detected?.frontend || started.detected?.backend);
      status = { frontend: started.frontend, backend: started.backend };
      renderPreviewStatus(status);
    }
    if (!detected) return { state: "not-detected", failures: [] };

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const services = [status.frontend, status.backend].filter(belongsToProject);
      const failed = services.filter((service) => ["failed", "exited"].includes(service.status));
      if (failed.length) {
        return {
          state: "failed",
          failures: failed.map((service) => ({
            label: `${service.kind === "backend" ? "Backend" : "Frontend"} preview startup failed`,
            command: service.command,
            output: service.log?.slice(-80).join("\n") || `Process exited with code ${service.exitCode ?? "unknown"}.`,
          })),
        };
      }
      const pending = services.some((service) => ["installing", "starting"].includes(service.status));
      if (services.length > 0 && !pending && services.every((service) => service.status === "running")) {
        return { state: "running", failures: [] };
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      status = await api("/preview/status");
      renderPreviewStatus(status);
    }
    return { state: "timed-out", failures: [] };
  } catch (err) {
    return {
      state: "failed",
      failures: [{ label: "Preview startup could not be checked", command: "MobiusX Preview", output: err.message || String(err) }],
    };
  }
}

/**
 * Drives one more auto-chained cycle starting from a fix task's just-
 * appended edits-card (`card`) -- auto-Apply it, auto-Run verification and
 * preview/browser checks, and if still failing and under the iteration cap, auto-click ITS
 * Diagnose & Fix button and recurse into whatever nested card THAT
 * produces. `depth` is 1 for the cycle right after the user's own first
 * (manual) Diagnose & Fix click -- that first click and its resulting
 * card are attempt 1; this function only ever handles attempt 2+.
 */
async function autoChainFix(card, depth) {
  const verifyResultsEl = card.parentElement; // the outer card's .verify-results this nested card was appended into
  if (depth > MAX_AUTO_FIX_ITERATIONS) {
    appendAutoFixBanner(verifyResultsEl, `Auto fix loop stopped after ${MAX_AUTO_FIX_ITERATIONS} attempt(s) — still failing. Continue manually with Diagnose & Fix above, or review the output.`, "stopped");
    return;
  }
  const applyBtn = card.querySelector(".edits-apply-btn");
  if (!applyBtn || applyBtn.disabled) return; // can't auto-apply (e.g. project mismatch) -- stop here, leave it for manual review
  card.dataset.skipPostApplyVerify = "1"; // this loop owns the verify click immediately below
  applyBtn.click();
  await waitForButtonSettled(applyBtn, "Applying…");
  if (applyBtn.textContent !== "Applied") return; // apply failed outright -- resultEl already shows why, stop the chain
  const verifyBtn = card.querySelector(".edits-verify-btn");
  if (!verifyBtn || verifyBtn.hidden) return;
  verifyBtn.click();
  await waitForButtonSettled(verifyBtn, "Verifying…");
  card.mobiusxPreviewStarting?.();
  const previewResult = await ensurePreviewForValidation(currentProjectPath);
  card.mobiusxSetPreviewState?.(previewResult);
  const browserValidateBtn = card.querySelector(".edits-browser-validate-btn");
  if (previewResult.state === "running" && browserValidateBtn && !browserValidateBtn.hidden && !browserValidateBtn.disabled) {
    browserValidateBtn.click();
    await waitForButtonSettled(browserValidateBtn, "Validating…");
  }
  const diagnoseBtn = card.querySelector(".edits-diagnose-btn");
  const cardVerifyResultsEl = card.querySelector(".verify-results");
  if (!diagnoseBtn || diagnoseBtn.hidden) {
    const verifyOutcome = card.dataset.verifyOverall;
    const browserOutcome = card.dataset.browserOverall;
    const previewOutcome = card.dataset.previewOverall;
    const anyCheckPassed = verifyOutcome === "passed" || browserOutcome === "passed";
    const anyCheckFailed = verifyOutcome === "failed" || browserOutcome === "failed" || previewOutcome === "failed";
    if (anyCheckFailed) {
      appendAutoFixBanner(cardVerifyResultsEl, `Auto fix loop ended after ${depth} attempt(s), but a validation check failed and no repair task is available. Review the failure details.`, "stopped");
    } else if (!anyCheckPassed) {
      appendAutoFixBanner(cardVerifyResultsEl, `Auto fix loop ended after ${depth} attempt(s), but no build/test or browser checks were available to confirm the result.`, "stopped");
    } else if (previewOutcome === "timed-out") {
      appendAutoFixBanner(cardVerifyResultsEl, `Configured checks passed after ${depth} attempt(s), but preview startup did not settle before the timeout. Runtime behavior remains unverified.`, "stopped");
    } else if (previewOutcome === "not-detected" || browserOutcome === "no-preview-running") {
      appendAutoFixBanner(cardVerifyResultsEl, `✓ Configured checks passed after ${depth} attempt(s); browser validation was skipped because no runnable preview was available.`, "success");
    } else {
      appendAutoFixBanner(cardVerifyResultsEl, `✓ Auto fix loop succeeded after ${depth} attempt(s).`, "success");
    }
    return;
  }
  if (depth >= MAX_AUTO_FIX_ITERATIONS) {
    appendAutoFixBanner(cardVerifyResultsEl, `Auto fix loop stopped after ${depth} attempt(s) — still failing. Continue manually with Diagnose & Fix above, or review the output.`, "stopped");
    return;
  }
  const beforeCount = cardVerifyResultsEl.children.length;
  diagnoseBtn.click();
  await waitForButtonSettled(diagnoseBtn, "Diagnosing…");
  const newCard = [...cardVerifyResultsEl.children].slice(beforeCount).find((el) => el.classList?.contains("edits-card"));
  if (!newCard) return; // no concrete fix proposed this cycle -- the "No concrete fix was proposed" message is already shown, chain ends honestly
  await autoChainFix(newCard, depth + 1);
}

// Observations: "It should Automatically appears: Commit & Push to Git",
// "auto generates the entire code and asks to open http://localhost:3000/",
// "Finally it should show the Summary: Files changed and Review". Renders
// into the reserved `.edits-card-postbuild` slot once Apply has actually
// succeeded (never before -- there's nothing to commit or preview yet).
// "Automatically appears" means the BUTTONS appear without being asked for;
// committing/pushing/starting a server are still real side effects, so each
// one still waits for its own explicit click, the same way Apply itself
// does -- this panel never commits, pushes, or starts a server on its own.
//
// Feature request (Oct 2026): "If it is running in :3000, user should able
// to see the web application and if he satisfies then only he should
// commit. Also, give a commit & push button for the user flexibility."
// Two changes from the previous single combined button: (1) Preview is now
// listed first and the summary carries an explicit "preview, then commit"
// hint -- a nudge, not a hard gate, since forcing a preview click before
// allowing Commit would block a user who already tested another way (e.g.
// their own terminal); (2) Commit and Push are now two independent actions
// instead of one button that always pushed immediately after committing --
// the user can commit locally and push later (after more manual testing,
// after squashing, whenever), or push a batch of several prior commits at
// once. `editStatsByPath` (built eagerly in buildEditsCard, Map<path,
// {added,removed}>) feeds the aggregate "+N -M" lines-changed figure next
// to the file count, matching the reference Cursor UI's per-file stats.
function renderPostBuildPanel(slot, edits, results, editStatsByPath) {
  const applied = results.filter((r) => r.status === "applied");
  if (applied.length === 0) return; // nothing was actually written -- nothing to summarize, commit, or preview
  const appliedPaths = applied.map((r) => r.path);
  const editByPath = new Map(edits.map((e) => [e.path, e]));
  const createdCount = appliedPaths.filter((p) => editByPath.get(p)?.action === "create").length;
  const modifiedCount = appliedPaths.length - createdCount;

  let totalAdded = 0;
  let totalRemoved = 0;
  for (const p of appliedPaths) {
    const s = editStatsByPath?.get(p);
    if (s) {
      totalAdded += s.added;
      totalRemoved += s.removed;
    }
  }
  const statsHtml = totalAdded + totalRemoved > 0 ? ` · ${diffStatsHtml({ added: totalAdded, removed: totalRemoved })}` : "";

  slot.hidden = false;
  slot.innerHTML = `
    <div class="postbuild-summary">
      <strong>Summary:</strong> ${appliedPaths.length} file${appliedPaths.length === 1 ? "" : "s"} changed
      (${createdCount} created, ${modifiedCount} modified)${statsHtml} — review the diffs above (“Show diff”) before committing.
    </div>
    <div class="postbuild-hint">▸ Review the app in the live preview before committing. Open Preview switches to an expanded view.</div>
    <div class="postbuild-actions">
      <button class="postbuild-preview-btn">▸ Open Preview</button>
      <button class="postbuild-commit-btn">⎇ Commit</button>
      <button class="postbuild-push-btn">↑ Push</button>
    </div>
    <div class="postbuild-preview-result"></div>
    <div class="postbuild-commit-result"></div>
    <div class="postbuild-push-result"></div>
  `;

  const hintEl = slot.querySelector(".postbuild-hint");
  const previewBtn = slot.querySelector(".postbuild-preview-btn");
  const previewResultEl = slot.querySelector(".postbuild-preview-result");
  let unsubscribePreviewReady = null;
  previewBtn.addEventListener("click", async () => {
    if (!currentProjectPath) {
      previewResultEl.textContent = "Open a project first.";
      return;
    }
    previewBtn.disabled = true;
    previewBtn.textContent = "Starting…";
    if (unsubscribePreviewReady) {
      unsubscribePreviewReady();
      unsubscribePreviewReady = null;
    }
    // Self-unsubscribing: this panel only cares about the next ready event
    // that follows ITS OWN click, not every future preview run for the rest
    // of the session (which would otherwise leak one listener per build).
    unsubscribePreviewReady = preview.onReady(({ url }) => {
      if (slot.isConnected) {
        previewResultEl.innerHTML = `Ready — <a href="#" class="postbuild-open-link">open ${escapeHtml(url)}</a>`;
        previewResultEl.querySelector(".postbuild-open-link")?.addEventListener("click", (e) => {
          e.preventDefault();
          openExternal(url);
        });
        hintEl.textContent = "✓ Previewed — commit once you're satisfied with what you saw.";
        hintEl.classList.add("postbuild-hint-done");
      }
      if (unsubscribePreviewReady) {
        unsubscribePreviewReady();
        unsubscribePreviewReady = null;
      }
    });
    try {
      const status = await api("/preview/start", { method: "POST" });
      renderPreviewStatus(status);
      previewPanel.classList.remove("collapsed");
      document.getElementById("preview-toggle").textContent = "▾ Preview";
      showView("workspace");
      if (!workspaceEl.classList.contains("preview-focus-active")) previewFocusToggleBtn.click();
      previewResultEl.textContent = "Opening the live preview… use Exit focus to return to the editor.";
    } catch (err) {
      previewResultEl.textContent = `Failed to start preview: ${err.message}`;
      if (unsubscribePreviewReady) {
        unsubscribePreviewReady();
        unsubscribePreviewReady = null;
      }
    }
    previewBtn.disabled = false;
    previewBtn.textContent = "▸ Open Preview";
  });

  // Commit only -- no longer auto-pushes. Pushing is the Push button's own
  // explicit, separately-clicked action (see below), so the user can commit
  // now and push whenever they're ready.
  const commitBtn = slot.querySelector(".postbuild-commit-btn");
  const commitResultEl = slot.querySelector(".postbuild-commit-result");
  commitBtn.addEventListener("click", async () => {
    if (!currentProjectPath) {
      commitResultEl.textContent = "Open a project first.";
      return;
    }
    commitBtn.disabled = true;
    commitBtn.textContent = "Committing…";
    const message = `MobiusX: ${appliedPaths.length} file${appliedPaths.length === 1 ? "" : "s"} changed (${createdCount} created, ${modifiedCount} modified)`;
    let commitRes;
    try {
      commitRes = await api("/git/commit", { method: "POST", body: JSON.stringify({ message, paths: appliedPaths }) });
    } catch (err) {
      commitResultEl.textContent = `Commit failed: ${err.message}`;
      commitBtn.disabled = false;
      commitBtn.textContent = "⎇ Commit";
      return;
    }
    refreshChangesBadge(); // reflect the commit immediately, regardless of which view is active
    if (!commitRes.committed) {
      commitResultEl.textContent = "Nothing to commit — already up to date.";
      commitBtn.disabled = false;
      commitBtn.textContent = "⎇ Commit";
      return;
    }
    const shortHash = commitRes.hash.slice(0, 7);
    commitResultEl.textContent = `Committed ${shortHash} locally. Push when you're ready.`;
    commitBtn.textContent = "Committed ✓";
    commitBtn.disabled = false;
  });

  // Push -- independent of Commit, so it can push this commit right away,
  // several prior commits batched together, or (honestly) nothing at all if
  // there's nothing new to push or no remote configured yet.
  const pushBtn = slot.querySelector(".postbuild-push-btn");
  const pushResultEl = slot.querySelector(".postbuild-push-result");
  pushBtn.addEventListener("click", async () => {
    if (!currentProjectPath) {
      pushResultEl.textContent = "Open a project first.";
      return;
    }
    pushBtn.disabled = true;
    pushBtn.textContent = "Pushing…";
    try {
      const pushRes = await api("/git/push", { method: "POST" });
      if (pushRes.pushed) {
        pushResultEl.textContent = "Pushed to origin.";
        pushBtn.textContent = "Pushed ✓";
      } else {
        pushResultEl.textContent = `Push skipped: ${pushRes.reason}.`;
        pushBtn.textContent = "↑ Push";
      }
    } catch (err) {
      pushResultEl.textContent = `Push failed: ${err.message}`;
      pushBtn.textContent = "↑ Push";
    }
    pushBtn.disabled = false;
  });
}

function buildEditsCard(edits, taskProjectPath, review) {
  const projectMismatch = Boolean(taskProjectPath) && taskProjectPath !== currentProjectPath;

  const card = document.createElement("div");
  card.className = "edits-card";
  card.innerHTML = `
    <div class="edits-card-head">Proposed changes — ${edits.length} file${edits.length === 1 ? "" : "s"} <span class="edits-card-stats-total"></span></div>
    <div class="edits-card-checklist"></div>
    <div class="edits-card-review">${review ? renderReviewBannerHtml(review) : ""}</div>
    ${
      projectMismatch
        ? `<div class="edits-card-warning">This task's files belong to <code>${escapeHtml(taskProjectPath)}</code>, but MobiusX currently has <code>${currentProjectPath ? escapeHtml(currentProjectPath) : "no project"}</code> open. Open the task project to apply these edits. <button class="edits-open-project-btn">Open task project</button><span class="edits-open-project-result" role="status"></span></div>`
        : ""
    }
    <div class="edits-card-list"></div>
    <div class="edits-card-actions">
      <button class="edits-apply-btn" ${agentBaseUrl && !projectMismatch ? "" : "disabled"}>Apply</button>
      <span class="edits-apply-result"></span>
      <button class="edits-verify-btn" hidden>Run verification</button>
      <button class="edits-browser-validate-btn" hidden>Run browser validation</button>
      <button class="edits-diagnose-btn" hidden>Diagnose &amp; Fix</button>
    </div>
    <div class="verify-results" hidden></div>
    <div class="browser-validate-results" hidden></div>
    <div class="edits-card-postbuild" hidden></div>
  `;
  const list = card.querySelector(".edits-card-list");

  // Lifecycle todo list (feature request: "show the todos (progress) to
  // complete the task and strike off once completed, like Claude or
  // Cursor"). Distinct from the .assistant-steps log (which only covers
  // the initial model call + review) -- this tracks what's actually left
  // to DO with this proposed change: apply it, verify it, and (only if
  // verification fails) diagnose/fix it. Seeded upfront so the user sees
  // the whole plan, not just a retroactive log of what already happened.
  const checklistEl = card.querySelector(".edits-card-checklist");
  const checklistRows = new Map(); // label -> row element
  function setChecklistStep(label, status) {
    let row = checklistRows.get(label);
    if (!row) {
      row = document.createElement("div");
      row.innerHTML = `<span class="edits-checklist-marker"></span><span class="edits-checklist-label">${escapeHtml(label)}</span>`;
      checklistEl.appendChild(row);
      checklistRows.set(label, row);
    }
    row.className = `edits-checklist-row ${status}`;
    const marker = row.querySelector(".edits-checklist-marker");
    marker.className = `edits-checklist-marker ${status}`;
    marker.textContent =
      status === "completed" ? "✓" : status === "failed" ? "✗" : status === "skipped" ? "–" : status === "in_progress" ? "…" : "○";
  }
  setChecklistStep("Apply changes", "pending");
  setChecklistStep("Run verification", "pending");

  // Project Understanding + Specification Engine (roadmap Phase 7, source
  // requirement §6): Spec mode now emits a structured .mobiusx/specs/*.json
  // twin alongside the markdown doc (see promptShared.ts's spec-mode
  // prompt) -- when one is present among this card's edits, render a real
  // REQ-NNN checklist instead of leaving the user to read raw JSON via
  // "Show diff". The underlying edit still applies exactly like any other
  // file; this is purely an additional, friendlier view of the same data.
  const specJsonEdit = edits.find((e) => /^\.mobiusx\/specs\/[^/]+\.json$/.test(e.path));
  if (specJsonEdit) {
    let spec = null;
    try {
      spec = JSON.parse(specJsonEdit.content);
    } catch {
      // model didn't produce valid JSON this time -- fall through silently,
      // the raw file is still shown in the normal file list below so
      // nothing is hidden from the user, just not double-rendered as a
      // checklist we can't trust.
    }
    if (spec && Array.isArray(spec.requirements)) {
      const reqRows = spec.requirements
        .map((r) => {
          const acCount = Array.isArray(r.acceptanceCriteria) ? r.acceptanceCriteria.length : 0;
          const acHtml = (r.acceptanceCriteria || [])
            .map((ac) => `<div class="spec-req-ac">Given ${escapeHtml(ac.given || "")}, when ${escapeHtml(ac.when || "")}, then ${escapeHtml(ac.then || "")}.</div>`)
            .join("");
          return `
            <div class="spec-req">
              <div class="spec-req-head">
                <span class="spec-req-id">${escapeHtml(r.id || "REQ-???")}</span>
                <span class="spec-req-category ${escapeHtml(r.category || "")}">${escapeHtml(r.category || "")}</span>
                <span class="spec-req-statement">${escapeHtml(r.statement || "")}</span>
              </div>
              ${acCount > 0 ? `<div class="spec-req-acs">${acHtml}</div>` : `<div class="spec-req-ac spec-req-ac-missing">No acceptance criteria proposed for this requirement.</div>`}
            </div>`;
        })
        .join("");
      const openQ = Array.isArray(spec.openQuestions) && spec.openQuestions.length > 0
        ? `<div class="spec-open-questions"><strong>Open questions:</strong> ${spec.openQuestions.map((q) => escapeHtml(q)).join(" · ")}</div>`
        : "";
      const checklist = document.createElement("div");
      checklist.className = "spec-checklist";
      checklist.innerHTML = `
        <div class="spec-checklist-head">${escapeHtml(spec.feature || "Requirements")} — ${spec.requirements.length} requirement${spec.requirements.length === 1 ? "" : "s"}</div>
        <div class="spec-req-list">${reqRows}</div>
        ${openQ}
      `;
      card.insertBefore(checklist, list);
    }
  }

  // Per-file old-content cache, keyed by index (not path -- a path could in
  // principle repeat across a malformed edit set). Populated by the eager
  // stats pass below and reused by "Show diff" so a file's content is never
  // fetched twice. `editStatsByPath` is exposed to the caller (via the
  // `card.editStatsByPath` property set below) so the post-build summary
  // can report an aggregate +added/-removed across only the files that were
  // actually applied, without re-running its own diff pass.
  const oldContentCache = new Array(edits.length).fill(null);
  const editStatsByPath = new Map();
  let statsLoadedCount = 0;
  const headTotalEl = card.querySelector(".edits-card-stats-total");
  function refreshHeadTotal() {
    if (statsLoadedCount < edits.length || edits.length === 0) return; // only show a total once every file is in, to avoid a misleadingly partial number
    let added = 0;
    let removed = 0;
    for (const s of editStatsByPath.values()) {
      if (!s) continue;
      added += s.added;
      removed += s.removed;
    }
    headTotalEl.innerHTML = diffStatsHtml({ added, removed });
  }

  edits.forEach((edit, i) => {
    const item = document.createElement("div");
    item.className = "edits-file";
    item.innerHTML = `
      <div class="edits-file-head">
        <span class="edits-file-badge ${edit.action}">${edit.action}</span>
        <span class="edits-file-path">${escapeHtml(edit.path)}</span>
        ${diffStatsHtml(null)}
        <button class="edits-file-toggle">Show diff</button>
      </div>
      <pre class="edits-file-diff" hidden></pre>
    `;
    const toggleBtn = item.querySelector(".edits-file-toggle");
    const diffEl = item.querySelector(".edits-file-diff");
    const statsEl = item.querySelector(".edits-file-stats");

    async function loadOldContent() {
      if (oldContentCache[i] !== null) return oldContentCache[i];
      let oldContent = "";
      if (edit.action === "modify" && currentProjectPath) {
        try {
          const file = await api(`/fs/read?path=${encodeURIComponent(edit.path)}`);
          oldContent = file.content;
        } catch {
          // file may since have been moved/deleted — diff against empty rather than failing the card
        }
      }
      oldContentCache[i] = oldContent;
      return oldContent;
    }

    // Eager, not click-gated: the numeric +/- next to each file is part of
    // deciding whether to even open "Show diff", so it loads as soon as the
    // card renders (same network call "Show diff" would make later --
    // cached above, so clicking afterwards never re-fetches).
    loadOldContent().then((oldContent) => {
      const stats = diffLineStats(oldContent, edit.content);
      editStatsByPath.set(edit.path, stats);
      statsLoadedCount++;
      statsEl.outerHTML = diffStatsHtml(stats);
      refreshHeadTotal();
    });

    toggleBtn.addEventListener("click", async () => {
      if (diffEl.hidden) {
        if (!diffEl.dataset.loaded) {
          diffEl.dataset.loaded = "1";
          const oldContent = await loadOldContent();
          diffEl.innerHTML = renderDiffHtml(oldContent, edit.content);
        }
        diffEl.hidden = false;
        toggleBtn.textContent = "Hide diff";
      } else {
        diffEl.hidden = true;
        toggleBtn.textContent = "Show diff";
      }
    });
    list.appendChild(item);
  });
  card.editStatsByPath = editStatsByPath;

  const applyBtn = card.querySelector(".edits-apply-btn");
  const resultEl = card.querySelector(".edits-apply-result");
  const openTaskProjectBtn = card.querySelector(".edits-open-project-btn");
  if (openTaskProjectBtn) {
    const openProjectResult = card.querySelector(".edits-open-project-result");
    openTaskProjectBtn.addEventListener("click", async () => {
      openTaskProjectBtn.disabled = true;
      openTaskProjectBtn.textContent = "Opening…";
      openProjectResult.textContent = "";
      await openProject(taskProjectPath, { showWorkspace: false });
      if (currentProjectPath === taskProjectPath) {
        card.querySelector(".edits-card-warning")?.remove();
        applyBtn.disabled = !agentBaseUrl;
        openProjectResult.textContent = "Project opened. Review the proposed files, then click Apply.";
      } else {
        openTaskProjectBtn.disabled = false;
        openTaskProjectBtn.textContent = "Try again";
        openProjectResult.textContent = "Could not open the task project. Check that the folder still exists.";
      }
    });
  }
  applyBtn.addEventListener("click", async () => {
    if (!currentProjectPath) {
      resultEl.textContent = "Open a project first.";
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
    setChecklistStep("Apply changes", "in_progress");
    try {
      const { results, hookResults, checkpointId } = await api("/fs/apply-edits", { method: "POST", body: JSON.stringify({ edits }) });
      const appliedCount = results.filter((r) => r.status === "applied").length;
      resultEl.textContent = `Applied ${appliedCount}/${results.length}`;
      applyBtn.textContent = "Applied";
      // Event-driven hooks (roadmap Phase 16, source requirement §25):
      // "after-api-change" -- present only when this project had at least
      // one such hook configured and it actually fired (see routes.ts's
      // POST /fs/apply-edits).
      if (hookResults && hookResults.length > 0) {
        const hooksEl = document.createElement("div");
        hooksEl.className = "edits-hook-results";
        hooksEl.innerHTML = hookResults
          .map(
            (r) =>
              `<div class="edits-hook-result ${r.status}">${r.status === "passed" ? "✓" : "✗"} <strong>${escapeHtml(r.ruleId)}</strong> — <code>${escapeHtml(r.command)}</code>${r.status === "failed" ? `<pre>${escapeHtml(r.output.slice(0, 800))}</pre>` : ""}</div>`,
          )
          .join("");
        resultEl.after(hooksEl);
      }
      results.forEach((r, i) => {
        const fileEl = list.children[i];
        if (!fileEl) return;
        const status = document.createElement("span");
        status.className = `edits-file-status ${r.status}`;
        status.textContent = r.status === "applied" ? "✓ applied" : `skipped — ${r.reason ?? "unknown reason"}`;
        fileEl.querySelector(".edits-file-head").appendChild(status);
        // Real fix for "generated a frontend app but couldn't open it in a
        // browser": until now this app had NO way to launch a written file
        // outside itself (no shell.openPath/openExternal wired up anywhere —
        // openFile() above only opens files in-app, in the editor pane). For
        // an applied .html file, offer a button that asks the Electron main
        // process to hand it to the OS's default browser. Only offered when
        // openInBrowser exists (preload.js) and the project is genuinely open
        // on disk (currentProjectPath) — nothing to open otherwise.
        if (r.status === "applied" && /\.html?$/i.test(r.path) && openInBrowser && currentProjectPath) {
          const openBtn = document.createElement("button");
          openBtn.className = "edits-file-open-btn";
          openBtn.textContent = "Open in Browser";
          openBtn.addEventListener("click", async () => {
            openBtn.disabled = true;
            const prevLabel = openBtn.textContent;
            try {
              const result = await openInBrowser(currentProjectPath, r.path);
              if (!result.ok) {
                openBtn.textContent = `Failed: ${result.error}`;
              } else {
                openBtn.textContent = "Opened ✓";
                setTimeout(() => {
                  openBtn.textContent = prevLabel;
                  openBtn.disabled = false;
                }, 2000);
                return;
              }
            } catch (err) {
              openBtn.textContent = `Failed: ${err.message}`;
            }
            openBtn.disabled = false;
          });
          fileEl.querySelector(".edits-file-head").appendChild(openBtn);
        }
      });
      await refreshAfterApply(results.filter((r) => r.status === "applied").map((r) => r.path));
      if (appliedCount > 0) {
        verifyBtn.hidden = false;
        browserValidateBtn.hidden = false;
        setChecklistStep("Apply changes", "completed");
        const postbuildSlot = card.querySelector(".edits-card-postbuild");
        if (postbuildSlot) renderPostBuildPanel(postbuildSlot, edits, results, editStatsByPath);
        refreshChangesBadge(); // reflect the just-applied edits immediately, regardless of which view is active

        // Phases 3–5 of the shared build contract: after local Apply, run
        // project scripts, start or reuse the app preview (including the
        // existing dependency installation path), then browser-check it.
        // Startup logs feed the same diagnose-and-repair context.
        // Auto-chain fixes mark their Apply so this doesn't race the verify
        // click that autoChainFix() performs itself.
        if (checkpointId && card.dataset.skipPostApplyVerify !== "1") {
          resultEl.textContent = `Applied ${appliedCount}/${results.length} — running project verification…`;
          verifyBtn.click();
          await waitForButtonSettled(verifyBtn, "Verifying…");

          card.mobiusxPreviewStarting?.();
          const previewResult = await ensurePreviewForValidation(currentProjectPath);
          card.mobiusxSetPreviewState?.(previewResult);
          if (previewResult.state === "running" && !browserValidateBtn.hidden && !browserValidateBtn.disabled) {
            browserValidateBtn.click();
            await waitForButtonSettled(browserValidateBtn, "Validating…");
          }

          // Manual mode shows the failure and leaves repair to the user.
          // Auto mode starts the existing bounded repair loop only after
          // this verification has actually failed.
          if (!diagnoseBtn.hidden) {
            try {
              const settings = await api("/settings");
              if (settings.fixLoopMode === "auto" && !diagnoseBtn.disabled) diagnoseBtn.click();
            } catch {
              // Keep the verification result; settings failures fall back to
              // the safe manual repair flow.
            }
          }
        }
      } else {
        // every file was skipped (e.g. CREATE-vs-existing-file safety, or a
        // project mismatch caught late) -- nothing to verify off the back
        // of an apply that didn't actually change anything.
        setChecklistStep("Apply changes", "failed");
        setChecklistStep("Run verification", "skipped");
      }
    } catch (err) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply";
      resultEl.textContent = `Failed: ${err.message}`;
      setChecklistStep("Apply changes", "failed");
      setChecklistStep("Run verification", "skipped");
    }
  });

  // ---- Verification Engine (PRD §22): real build/test evidence, not a claim ----
  const verifyBtn = card.querySelector(".edits-verify-btn");
  const verifyResultsEl = card.querySelector(".verify-results");
  // Browser / Application Validation (roadmap Phase 12, source requirement
  // §18): a second, independent evidence source alongside build/test
  // verification -- drives the already-running preview with a real
  // headless browser (see apps/desktop-agent/src/browserOps.ts) and
  // reports genuine console/network/screenshot evidence.
  const browserValidateBtn = card.querySelector(".edits-browser-validate-btn");
  const browserValidateResultsEl = card.querySelector(".browser-validate-results");
  // Autonomous Build/Test/Fix Loop (roadmap Phase 6, source requirement §16):
  // the failing steps from the MOST RECENT verify run AND the most recent
  // browser validation run, in the shape a "fix"-mode task's
  // ProjectContext.failingVerification expects -- kept here (not
  // re-derived from the DOM later) so Diagnose & Fix always acts on real,
  // just-captured evidence rather than stale text scraped back out of the
  // rendered output. Two sources are tracked separately and merged, so a
  // fresh verify run never wipes out browser-validation findings (or vice
  // versa) -- both are still-valid evidence about the same open project
  // until their own "run again" is clicked.
  const diagnoseBtn = card.querySelector(".edits-diagnose-btn");
  let lastFailingVerifySteps = [];
  let lastFailingPreviewSteps = [];
  let lastFailingBrowserSteps = [];
  let lastFailingSteps = [];
  function recomputeFailingSteps() {
    lastFailingSteps = [...lastFailingVerifySteps, ...lastFailingPreviewSteps, ...lastFailingBrowserSteps];
    if (lastFailingSteps.length > 0 && cloudBaseUrl) {
      diagnoseBtn.hidden = false;
      diagnoseBtn.disabled = false;
      diagnoseBtn.textContent = "Diagnose & Fix";
      // Only added to the todo list once it's actually relevant (a real
      // failure exists to diagnose) -- most tasks verify clean on the
      // first try and never need this row at all.
      if (!checklistRows.has("Diagnose & Fix")) setChecklistStep("Diagnose & Fix", "pending");
    } else {
      diagnoseBtn.hidden = true;
    }
  }
  card.mobiusxSetPreviewState = (result) => {
    card.dataset.previewOverall = result.state;
    lastFailingPreviewSteps = result.failures || [];
    lastFailingBrowserSteps = [];
    delete card.dataset.browserOverall;
    recomputeFailingSteps();
    setChecklistStep("Start preview", result.state === "running" ? "completed" : result.state === "failed" ? "failed" : "skipped");
    if (result.state === "failed") {
      browserValidateResultsEl.hidden = false;
      browserValidateResultsEl.innerHTML = `<div class="verify-summary failed">Preview startup failed. Real process output is included for diagnosis.</div>${lastFailingPreviewSteps.map((step) => `<div class="verify-step"><div class="verify-step-label">${escapeHtml(step.label)} — ${escapeHtml(step.command)}</div><pre class="verify-step-output">${escapeHtml(step.output)}</pre></div>`).join("")}`;
      setChecklistStep("Run browser validation", "failed");
    } else if (result.state === "timed-out") {
      browserValidateResultsEl.hidden = false;
      browserValidateResultsEl.innerHTML = `<div class="verify-none">Preview is still installing or starting. Check the Preview console; runtime validation has not completed.</div>`;
      setChecklistStep("Run browser validation", "skipped");
    } else if (result.state === "not-detected") {
      browserValidateResultsEl.hidden = false;
      browserValidateResultsEl.innerHTML = `<div class="verify-none">No runnable frontend or backend was detected, so preview validation was skipped.</div>`;
      setChecklistStep("Run browser validation", "skipped");
    }
  };
  card.mobiusxPreviewStarting = () => setChecklistStep("Start preview", "in_progress");
  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying…";
    setChecklistStep("Run verification", "in_progress");
    verifyResultsEl.hidden = false;
    verifyResultsEl.innerHTML = `<div class="verify-pending">Running the project's build/test scripts…</div>`;
    lastFailingVerifySteps = [];
    recomputeFailingSteps();
    try {
      const result = await api("/verify", { method: "POST" });
      card.dataset.verifyOverall = result.overall;
      if (result.overall === "no-verification-available") {
        verifyResultsEl.innerHTML = `<div class="verify-none">No build/test/lint/typecheck script found in this project's package.json — nothing to verify.</div>`;
        setChecklistStep("Run verification", "skipped");
      } else {
        setChecklistStep("Run verification", result.overall === "passed" ? "completed" : "failed");
        const passedCount = result.steps.filter((s) => s.status === "passed").length;
        verifyResultsEl.innerHTML = `
          <div class="verify-summary ${result.overall}">${result.overall === "passed" ? "✓" : "✗"} Verification ${result.overall} — ${passedCount}/${result.steps.length} step(s) passed</div>
          <div class="verify-steps"></div>
        `;
        const stepsEl = verifyResultsEl.querySelector(".verify-steps");
        for (const step of result.steps) {
          const stepEl = document.createElement("div");
          stepEl.className = "verify-step";
          const icon = step.status === "passed" ? "✓" : step.status === "timed_out" ? "⏱" : "✗";
          stepEl.innerHTML = `
            <div class="verify-step-head">
              <span class="verify-step-status ${step.status}">${icon}</span>
              <span class="verify-step-label">${escapeHtml(step.label)}</span>
              <span class="verify-step-meta">${step.durationMs}ms${step.exitCode !== null ? `, exit ${step.exitCode}` : ""}</span>
              <button class="verify-step-toggle">Show output</button>
            </div>
            <pre class="verify-step-output" hidden>${escapeHtml(step.output)}${step.truncated ? "\n… (truncated)" : ""}</pre>
          `;
          stepEl.querySelector(".verify-step-toggle").addEventListener("click", () => {
            const out = stepEl.querySelector(".verify-step-output");
            out.hidden = !out.hidden;
            stepEl.querySelector(".verify-step-toggle").textContent = out.hidden ? "Show output" : "Hide output";
          });
          stepsEl.appendChild(stepEl);
        }
        lastFailingVerifySteps = result.steps
          .filter((s) => s.status !== "passed")
          .map((s) => ({ label: s.label, command: s.command, output: s.output }));
        recomputeFailingSteps();
      }
    } catch (err) {
      verifyResultsEl.innerHTML = `<div class="verify-none">Verification failed to run: ${escapeHtml(err.message)}</div>`;
      setChecklistStep("Run verification", "failed");
    }
    verifyBtn.disabled = false;
    verifyBtn.textContent = "Run verification again";
  });

  // ---- Browser / Application Validation (roadmap Phase 12, source requirement §18) ----
  browserValidateBtn.addEventListener("click", async () => {
    browserValidateBtn.disabled = true;
    browserValidateBtn.textContent = "Validating…";
    // Added to the todo list lazily (on first click), not seeded upfront
    // like Apply/Verify -- a lot of projects have no preview running yet,
    // making this an opt-in extra evidence source rather than a standard
    // step every task needs.
    setChecklistStep("Run browser validation", "in_progress");
    browserValidateResultsEl.hidden = false;
    browserValidateResultsEl.innerHTML = `<div class="verify-pending">Preparing Playwright Chromium if needed, then driving the running preview…</div>`;
    lastFailingBrowserSteps = [];
    recomputeFailingSteps();
    try {
      const result = await api("/browser-validate", { method: "POST" });
      card.dataset.browserOverall = result.overall;
      if (result.overall === "no-preview-running") {
        browserValidateResultsEl.innerHTML = `<div class="verify-none">${escapeHtml(result.previewUnavailableReason || "No preview is running yet.")}</div>`;
        setChecklistStep("Run browser validation", "skipped");
      } else {
        setChecklistStep("Run browser validation", result.overall === "passed" ? "completed" : "failed");
        const passedCount = result.steps.filter((s) => s.status === "passed").length;
        browserValidateResultsEl.innerHTML = `
          <div class="verify-summary ${result.overall}">${result.overall === "passed" ? "✓" : "✗"} Browser validation ${result.overall} — ${passedCount}/${result.steps.length} page(s) passed (starting from ${escapeHtml(result.previewUrl || "")})</div>
          <div class="verify-steps"></div>
        `;
        const stepsEl = browserValidateResultsEl.querySelector(".verify-steps");
        for (const step of result.steps) {
          const stepEl = document.createElement("div");
          stepEl.className = "verify-step";
          const icon = step.status === "passed" ? "✓" : step.status === "timed_out" ? "⏱" : "✗";
          stepEl.innerHTML = `
            <div class="verify-step-head">
              <span class="verify-step-status ${step.status}">${icon}</span>
              <span class="verify-step-label">${escapeHtml(step.label)}</span>
              <span class="verify-step-meta">${step.durationMs}ms</span>
              <button class="verify-step-toggle">Show details</button>
            </div>
            <div class="browser-step-detail" hidden>
              ${step.screenshot ? `<img class="browser-step-screenshot" src="${step.screenshot}" alt="Screenshot of ${escapeHtml(step.url)}" />` : ""}
              <pre class="verify-step-output">${escapeHtml(step.output)}</pre>
            </div>
          `;
          stepEl.querySelector(".verify-step-toggle").addEventListener("click", () => {
            const out = stepEl.querySelector(".browser-step-detail");
            out.hidden = !out.hidden;
            stepEl.querySelector(".verify-step-toggle").textContent = out.hidden ? "Show details" : "Hide details";
          });
          stepsEl.appendChild(stepEl);
        }
        lastFailingBrowserSteps = result.steps
          .filter((s) => s.status !== "passed")
          .map((s) => ({ label: s.label, command: s.command, output: s.output }));
        recomputeFailingSteps();
      }
    } catch (err) {
      browserValidateResultsEl.innerHTML = `<div class="verify-none">Browser validation failed to run: ${escapeHtml(err.message)}</div>`;
      setChecklistStep("Run browser validation", "failed");
    }
    browserValidateBtn.disabled = false;
    browserValidateBtn.textContent = "Run browser validation again";
  });

  // Autonomous Build/Test/Fix Loop (roadmap Phase 6, source requirement
  // §16): takes the real failing-step evidence just captured above,
  // creates a "fix"-mode task grounded in it (same propose -> review ->
  // apply pipeline as any other task -- see AgentMode's doc comment in
  // @mobiusx/protocol), and renders its proposed edits as ANOTHER
  // edits-card nested inside this one's verify-results area, so the user
  // can Apply -> Run verification -> (if still failing) Diagnose & Fix
  // again, chaining as many cycles as the failure actually needs. This is
  // the "manual" autonomy mode (AgentSettings.fixLoopMode) -- each cycle
  // still requires an explicit Apply click; an "auto" mode that chains
  // cycles without a click is a documented follow-up (see
  // docs/AI_ENGINEERING_PLATFORM_ROADMAP.md's Phase 6 entry), not built here.
  diagnoseBtn.addEventListener("click", async () => {
    if (!currentProjectPath || !cloudBaseUrl || lastFailingSteps.length === 0) return;
    diagnoseBtn.disabled = true;
    diagnoseBtn.textContent = "Diagnosing…";
    setChecklistStep("Diagnose & Fix", "in_progress");
    const pendingEl = document.createElement("div");
    pendingEl.className = "verify-pending";
    pendingEl.textContent = "Diagnosing the verification failure and drafting a fix…";
    verifyResultsEl.appendChild(pendingEl);
    try {
      const searchText = lastFailingSteps.map((s) => `${s.label}\n${s.output}`).join("\n\n").slice(0, 2000);
      const { hits: relevantFiles, storeSize: indexedChunkCount } = await findRelevantFiles(searchText || "build failure", "fix");
      const [steeringContext, assistantMemoryContext] = await Promise.all([fetchSteeringContext(), fetchAssistantMemoryContext()]);
      const prompt = `Diagnose and fix the failing verification step(s): ${lastFailingSteps.map((s) => s.label).join(", ")}.`;
      const { task } = await cloudApi("/tasks", {
        method: "POST",
        body: JSON.stringify({
          mode: "fix",
          prompt,
          projectContext: {
            projectPath: currentProjectPath,
            relevantFiles,
            indexedChunkCount,
            failingVerification: lastFailingSteps,
            ...(steeringContext ? { steeringContext } : {}),
            ...(assistantMemoryContext ? { assistantMemoryContext } : {}),
          },
        }),
      });
      let detail = await cloudApi(`/tasks/${task.id}`);
      if (detail.status === "queued" || detail.status === "running") {
        const refresh = async () => {
          detail = await cloudApi(`/tasks/${task.id}`);
        };
        await streamTask(task.id, { onEdits: refresh, onStatus: refresh, onError: refresh, onOutput: refresh, onStep: refresh, onReview: refresh });
        // streamTask() resolves as soon as the WS "done" message arrives,
        // which can race ahead of the in-flight refresh() an earlier
        // "edits"/"status" message kicked off (that refresh's own GET may
        // still be in flight when "done" shows up right behind it) --
        // observed live: a fix-mode task whose Tasks-view detail clearly
        // had 1 proposed edit still rendered "No concrete fix was
        // proposed" here because `detail` hadn't caught up yet. "done"
        // means the task is terminal server-side, so one guaranteed-fresh
        // fetch after the WS closes removes the race instead of trusting
        // whichever refresh() happened to finish last.
        detail = await cloudApi(`/tasks/${task.id}`);
      }
      pendingEl.remove();
      const prefix = document.createElement("div");
      prefix.className = "verify-pending";
      prefix.textContent = `[runner: ${detail.runner}${detail.model ? " / " + detail.model : ""}]${detail.modelNote ? ` — ${detail.modelNote}` : ""}`;
      verifyResultsEl.appendChild(prefix);
      if (detail.edits && detail.edits.length > 0) {
        // "Completed" here means "a concrete fix was proposed and is ready
        // to apply", not "the bug is confirmed fixed" -- that confirmation
        // is the NESTED card's own "Apply changes"/"Run verification" rows
        // (a fresh checklist instance from the same buildEditsCard()), so
        // the real proof-of-fix still shows up as its own todo list.
        setChecklistStep("Diagnose & Fix", "completed");
        const nestedCard = buildEditsCard(detail.edits, detail.projectPath, detail.review);
        verifyResultsEl.appendChild(nestedCard);
        // "auto" autonomy mode (roadmap Phase 22): fetched fresh on every
        // Diagnose & Fix click (never cached) so a mid-session Settings
        // change takes effect on the very next cycle, same as
        // terminalApprovalMode's own "next connection" semantics.
        try {
          const settings = await api("/settings");
          if (settings.fixLoopMode === "auto") {
            void autoChainFix(nestedCard, 1);
          }
        } catch {
          // Settings fetch failed -- fall back to manual behavior (no auto-chain) rather than blocking this cycle's own result.
        }
      } else {
        const none = document.createElement("div");
        none.className = "verify-none";
        none.textContent = detail.output?.trim()
          ? `No concrete fix was proposed. Runner said: ${detail.output.trim().slice(0, 400)}`
          : "No concrete fix was proposed.";
        verifyResultsEl.appendChild(none);
        setChecklistStep("Diagnose & Fix", "failed");
      }
    } catch (err) {
      pendingEl.textContent = `Diagnose & Fix failed: ${err.message}`;
      setChecklistStep("Diagnose & Fix", "failed");
    }
    diagnoseBtn.disabled = false;
    diagnoseBtn.textContent = "Diagnose & Fix";
  });

  return card;
}

// ============================================================
// Multi-model support (PRD's model-selection requirement): GET /models on
// the Cloud Agent Gateway returns every provider this gateway knows about
// (demo, anthropic, openrouter, groq, ollama), INCLUDING ones that aren't
// currently usable — see ModelOption's doc comment in @mobiusx/protocol.
// This one function builds a <select>'s options from that response and is
// shared by the per-task pickers in the AI Assistant panel and the
// Settings "Default AI Model" section below, so the two never drift.
// ============================================================
async function fetchModelOptions() {
  if (!cloudBaseUrl) return [];
  try {
    const { models } = await cloudApi("/models");
    return models;
  } catch {
    return [];
  }
}

function modelOptionLabel(m) {
  return m.available ? m.label : `${m.label} — ${m.unavailableReason}`;
}

/**
 * Populates `selectEl` with one <option> per model, grouped by provider,
 * value-encoded as JSON ({provider, model}) so callers can round-trip it
 * straight into a ModelSelection without inventing their own encoding.
 * `includeAuto` adds a leading, selected-by-default "Auto" option whose
 * value is "" — submitting a task with no model means exactly this: let
 * the gateway's own resolveRunner() choose (Settings default, else the
 * best configured provider, else demo).
 *
 * Models with no configured key/endpoint are filtered out entirely (not
 * just disabled) — explicit user request (Sept 2026), after this list's
 * previous "show everything, disable what's unavailable" behavior (this
 * app's usual "never hidden" governance-UI principle) left an unusable
 * model sitting in the list as dead weight. A provider being configured
 * doesn't imply every model on it is reliable, though -- see
 * groqRunner.ts's removal of qwen/qwen3.8-27b for a case this filter does
 * NOT catch on its own (a key was present; the model just didn't work).
 */
async function populateModelSelect(selectEl, { includeAuto, selectedValue, autoLabel, autoValue, providerFilter } = {}) {
  const modelOptions = await fetchModelOptions();
  selectEl.innerHTML = "";

  if (!cloudBaseUrl) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Cloud Agent Gateway unavailable this session";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return 0;
  }

  if (includeAuto) {
    const opt = document.createElement("option");
    opt.value = autoValue ?? "";
    // Roadmap Phase 11 (source §27): per-task-type model routing reuses this
    // same populate function for each mode's row, but "" there means
    // something different from the Default AI Model select's "" -- "no
    // routing rule for this mode, fall through to Default AI Model /
    // automatic" rather than "let the gateway choose automatically". Callers
    // that care (see the modelRouting rows below) pass their own label;
    // everyone else keeps the original "Auto (recommended)" text.
    opt.textContent = autoLabel ?? "Auto (recommended)";
    selectEl.appendChild(opt);
  }

  // providerFilter (Phase C build-target picker): "Local" scopes this list
  // to just {provider: "ollama"}, "Cloud" scopes it to configured cloud
  // providers (anthropic/openrouter/groq/deepseek/cerebras) -- same underlying live-checked
  // /models list either way, just a narrower view of it. Omitted (every
  // other caller) means the original, unfiltered behavior.
  const available = modelOptions.filter((m) => m.available && (!providerFilter || providerFilter.includes(m.provider)));
  let savedButNotLoaded = [];
  try {
    const configured = await models?.list?.();
    const saved = new Set((configured || []).filter((entry) => entry.configured).map((entry) => entry.provider));
    savedButNotLoaded = [...new Set(modelOptions
      .filter((m) => !m.available && saved.has(m.provider) && (!providerFilter || providerFilter.includes(m.provider)))
      .map((m) => m.provider))];
  } catch { /* model availability remains useful even if key status cannot be read */ }

  const byProvider = new Map();
  for (const m of available) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }

  for (const [provider, providerModels] of byProvider) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const m of providerModels) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ provider: m.provider, model: m.model });
      opt.textContent = modelOptionLabel(m);
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }

  // A key saved after the gateway started is valid and persisted, but that
  // process cannot see it until restart. Keep such providers visible and
  // disabled with the exact recovery action instead of making them appear to
  // have vanished from MobiusX.
  for (const provider of savedButNotLoaded) {
    const group = document.createElement("optgroup");
    group.label = `${provider} — restart MobiusX to load saved key`;
    for (const m of modelOptions.filter((option) => option.provider === provider && !option.available)) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ provider: m.provider, model: m.model });
      opt.textContent = m.label;
      opt.disabled = true;
      group.appendChild(opt);
    }
    selectEl.appendChild(group);
  }

  if (available.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    if (providerFilter && providerFilter.includes("ollama") && providerFilter.length === 1) {
      opt.textContent = "No local Ollama models detected — install Ollama and pull a model";
    } else {
      opt.textContent = savedButNotLoaded.length
        ? `Saved ${savedButNotLoaded.join(", ")} key — restart MobiusX to load it`
        : "No models configured — add an API key in Settings";
    }
    opt.disabled = true;
    selectEl.appendChild(opt);
  }

  if (selectedValue !== undefined) {
    const match = [...selectEl.options].find((o) => o.value === selectedValue);
    if (match && !match.disabled) selectEl.value = selectedValue;
  } else if (!includeAuto && available.length > 0) {
    // Build-target "Local" doesn't offer an Auto option (there's only ever
    // one real place "local" can mean), so pin the first live-checked
    // available Ollama tag automatically rather than leaving the picker on
    // a disabled placeholder the user would have to notice and change.
    selectEl.value = selectEl.options[0].value;
  }

  return available.length;
}

const CLOUD_AUTO_VALUE = "__mobiusx_cloud_auto__";
// Keep this order aligned with cloud-agent-gateway/src/runners/registry.ts
// AUTO_PRIORITY. Cloud Auto must never inherit a local Ollama default or
// silently choose providers that the gateway excludes from automatic use.
const CLOUD_AUTO_PRIORITY = ["anthropic", "groq", "openrouter"];

function availableModel(models, selection) {
  if (!selection) return null;
  return models.find((m) => m.available && m.provider === selection.provider && m.model === selection.model) ?? null;
}

function preferredCloudModel(models) {
  for (const provider of CLOUD_AUTO_PRIORITY) {
    const match = models.find((m) => m.available && m.provider === provider);
    if (match) return match;
  }
  return null;
}

function parseModelSelection(value) {
  if (!value || value === CLOUD_AUTO_VALUE) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ============================================================
// AI Assistant panel (Ask/Plan/Build) — wired to the Cloud Agent Gateway.
// ============================================================
const MODE_LABELS = { ask: "Ask", plan: "Plan", build: "Build", spec: "Spec", database: "Database", architecture: "Architecture", testing: "Testing", devops: "DevOps", auth: "Auth", fix: "Debug" };
// Modes that write real files (build/spec/... and now fix/Debug) need a
// project open, same guard submit() always had for the original 7 --
// extended here rather than duplicated so Multitask (which reuses this
// same set) can't drift out of sync with the single-mode guard.
const PROJECT_REQUIRED_MODES = new Set(["build", "spec", "database", "architecture", "testing", "devops", "auth", "fix"]);

function createAssistantPanel(container, opts = {}) {
  container.innerHTML = `
    <div class="assistant-titlebar">
      <img class="assistant-icon" src="../../assets/logo.png" alt="" />
      <span class="assistant-title">MobiusX AI Assistant</span>
      <button class="assistant-rightpane-toggle" type="button" title="Browser / Changelog / Docs" hidden>⊞</button>
    </div>
    <div class="build-target-note" hidden></div>
    <div class="assistant-feed"></div>
    <div class="assistant-attach-chips" hidden></div>
    <div class="assistant-multitask-bar" hidden>
      <div class="assistant-multitask-label">⚡ Multitask — run this prompt through several modes at once:</div>
      <div class="assistant-multitask-modes"></div>
      <button class="assistant-multitask-cancel" type="button">Cancel Multitask</button>
    </div>
    <div class="assistant-plus-popover files-popover" hidden>
      <input class="files-popover-search" placeholder="Search project files by name…" />
      <div class="files-popover-list"></div>
    </div>
    <div class="assistant-plus-popover mcp-popover" hidden>
      <div class="scope-note-small">MCP tools run through this project's connected servers; the Cloud/Local model choice does not apply.</div>
      <div class="mcp-popover-list"></div>
    </div>
    <div class="at-popover" hidden>
      <div class="at-popover-list"></div>
    </div>
    <div class="assistant-input-row">
      <div class="assistant-plus-wrap">
        <button class="plus-btn" type="button" aria-label="Choose mode or add context" aria-haspopup="true" aria-expanded="false" title="Choose a mode or add context">+</button>
        <div class="plus-menu" hidden>
          <div class="plus-menu-group">
            <div class="plus-menu-label">Mode</div>
            <div class="compose-mode-grid">
              <button class="mode-btn" data-mode="ask" title="Answer questions without changing project files">Ask</button>
              <button class="mode-btn" data-mode="plan" title="Draft an implementation plan without changing files">Plan</button>
              <button class="mode-btn active" data-mode="build" title="Generate project files for review and application">Build</button>
              <button class="mode-btn" data-mode="spec" title="Create a requirements specification">Spec</button>
              <button class="mode-btn" data-mode="database" title="Generate database schema and model changes">Database</button>
              <button class="mode-btn" data-mode="architecture" title="Generate architecture documentation">Architecture</button>
              <button class="mode-btn" data-mode="testing" title="Generate tests for this project">Testing</button>
              <button class="mode-btn" data-mode="devops" title="Generate deployment and infrastructure files">DevOps</button>
              <button class="mode-btn" data-mode="auth" title="Generate authentication and access-control changes">Auth</button>
              <button class="mode-btn" data-mode="fix" hidden title="Investigate a bug and propose a fix">Debug</button>
            </div>
          </div>
          <div class="plus-menu-group plus-menu-settings">
            <div class="plus-menu-option">
              <span class="plus-menu-label">Run on</span>
              <div class="build-target-row" title="Choose cloud models, a local Ollama model, or both">
                <button class="build-target-btn active" type="button" data-target="cloud">Cloud</button>
                <button class="build-target-btn" type="button" data-target="local">Local</button>
                <button class="build-target-btn" type="button" data-target="both">Both</button>
              </div>
            </div>
            <div class="plus-menu-option plus-menu-option-wide">
              <span class="plus-menu-label">App style</span>
              <div class="arch-mode-row" title="Choose Web App, Enterprise, Core App, or Embedded Apps guidance">
                <button class="arch-mode-btn active" type="button" data-arch="web">Web App</button>
                <button class="arch-mode-btn" type="button" data-arch="enterprise">Enterprise</button>
                <button class="arch-mode-btn" type="button" data-arch="core">Core App</button>
                <button class="arch-mode-btn" type="button" data-arch="embedded">Embedded Apps</button>
              </div>
            </div>
          </div>
          <div class="plus-menu-divider"></div>
          <button class="plus-menu-item" data-action="debug">🐞 Debug this</button>
          <button class="plus-menu-item" data-action="multitask">⚡ Multitask</button>
          <button class="plus-menu-item" data-action="files">📎 Attach files</button>
          <button class="plus-menu-item" data-action="mcp">🔌 Run an MCP tool</button>
        </div>
      </div>
      <span class="composer-mode-label" aria-live="polite">Build</span>
      <textarea class="assistant-textarea" placeholder="Ask a follow-up question… (Shift+Enter for a new line, @ for context)" rows="1"></textarea>
      <select class="model-select chatbar-model-select" title="Select the model for this task"></select>
      <div class="composer-tools-spacer"></div>
      <button class="mic-btn" type="button" title="Voice input"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
      <button class="send-btn">→</button>
    </div>
  `;
  const feed = container.querySelector(".assistant-feed");
  const input = container.querySelector(".assistant-textarea");
  const sendBtn = container.querySelector(".send-btn");
  const modeBtns = container.querySelectorAll(".mode-btn");
  const composerModeLabel = container.querySelector(".composer-mode-label");
  const modelSelect = container.querySelector(".model-select");
  const buildTargetBtns = container.querySelectorAll(".build-target-btn");
  const buildTargetNote = container.querySelector(".build-target-note");
  const archModeBtns = container.querySelectorAll(".arch-mode-btn");
  const plusBtn = container.querySelector(".plus-btn");
  const plusMenu = container.querySelector(".plus-menu");
  const filesPopover = container.querySelector(".files-popover");
  const filesSearchInput = container.querySelector(".files-popover-search");
  const filesListEl = container.querySelector(".files-popover-list");
  const mcpPopover = container.querySelector(".mcp-popover");
  const mcpListEl = container.querySelector(".mcp-popover-list");
  const atPopover = container.querySelector(".at-popover");
  const atPopoverList = container.querySelector(".at-popover-list");
  const attachChipsEl = container.querySelector(".assistant-attach-chips");
  const multitaskBar = container.querySelector(".assistant-multitask-bar");
  const multitaskModesEl = container.querySelector(".assistant-multitask-modes");
  const multitaskCancelBtn = container.querySelector(".assistant-multitask-cancel");
  const rightPaneToggleBtn = container.querySelector(".assistant-rightpane-toggle");
  let mode = "build";
  const modeGuidance = {
    ask: ["Ask a question; this mode replies without changing project files.", "Ask a question… (Shift+Enter for a new line)"],
    plan: ["Get a step-by-step plan before implementation. No files are changed.", "Describe what you want to plan…"],
    build: ["Open a project, describe the app or code change, then review MobiusX's proposed files and click Apply.", "Describe the app or code change to build…"],
    spec: ["Draft a requirements document, then review and apply it to your project.", "Describe the requirements to document…"],
    database: ["Generate database schema and model changes for your open project.", "Describe the data and database changes…"],
    architecture: ["Generate architecture documentation grounded in your open project.", "Describe the architecture you need…"],
    testing: ["Generate tests that fit the frameworks detected in your open project.", "Describe what should be tested…"],
    devops: ["Generate deployment and infrastructure files for your open project.", "Describe your deployment needs…"],
    auth: ["Generate authentication and access-control changes for your open project.", "Describe the sign-in and access rules…"],
    fix: ["Describe a bug and MobiusX will investigate the project and propose a fix.", "Describe the bug and what you expected…"],
  };
  function applyPanelMode(nextMode) {
    mode = nextMode;
    modeBtns.forEach((button) => {
      const active = button.dataset.mode === nextMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    const [guidance, placeholder] = modeGuidance[nextMode] ?? modeGuidance.build;
    composerModeLabel.textContent = MODE_LABELS[nextMode] ?? "Build";
    composerModeLabel.title = guidance;
    input.placeholder = placeholder;
  }
  applyPanelMode(mode);
  let attachedFiles = []; // [{relPath, content, label?}] -- attached via the "+" menu's Files action OR the "@" mention popover below (label is set only by an "@"-attached selection, for chip display; relPath/content are what actually reach the model, merged into this turn's relevantFiles in runTaskForMode
  // Prior turns from THIS panel instance, sent back on every follow-up so a
  // request like "show me the output" can be understood without repeating
  // what "it" refers to — the gateway is otherwise fully stateless between
  // tasks (see promptShared.ts#historyMessages on the gateway side, which
  // is what actually feeds these to the model). Kept mode-agnostic on
  // purpose: a user asking about something in Ask mode and then wanting it
  // Built is one continuous conversation, not per-mode threads. Capped to
  // bound how much context grows; not persisted across a page reload or a
  // different project — a fresh session starts a fresh conversation.
  let historyTurns = [];
  let historyProjectPath = currentProjectPath ?? null;
  let conversationEpoch = 0;
  const MAX_HISTORY_TURNS = 12; // keep in sync with promptShared.ts's MAX_HISTORY_TURNS
  // Conversation threads (Pillar 3 -- protocol-level support in
  // @mobiusx/protocol's ThreadSummary + cloud-agent-gateway's /threads
  // routes). Lazily created via ensureThreadId() the first time THIS panel
  // instance actually sends something -- never eagerly on app launch, so
  // opening the app (or switching to "New Chat" and not typing anything)
  // never leaves a phantom empty thread behind. Independent per panel
  // instance, same as historyTurns above -- #assistant-full and
  // #assistant-embedded each track their own currentThreadId and never
  // share one.
  let currentThreadId = null;
  let threadCreationPromise = null;
  async function ensureThreadId() {
    if (currentThreadId) return currentThreadId;
    if (!threadCreationPromise) {
      const requestEpoch = conversationEpoch;
      let creation;
      creation = (async () => {
        try {
          const { thread } = await cloudApi("/threads", { method: "POST", body: JSON.stringify({}) });
          if (requestEpoch !== conversationEpoch) return null;
          currentThreadId = thread.id;
        } catch {
          // Thread creation is best-effort: the task this is guarding still
          // gets created and works normally without a threadId (see
          // CreateTaskRequest.threadId's doc comment in @mobiusx/protocol)
          // -- it just won't show up in any thread list or be reloadable
          // later. Not worth failing (or even flagging in-feed) a real send
          // over a bookkeeping call.
        } finally {
          if (threadCreationPromise === creation) threadCreationPromise = null;
        }
        return requestEpoch === conversationEpoch ? currentThreadId : null;
      })();
      threadCreationPromise = creation;
    }
    return threadCreationPromise;
  }
  // Token-limit alerts (feature request: "alert the token limits (50%,
  // 75%, 90% consumed) to the user while working"). Each task's usage
  // already reflects the whole conversation so far (history grows with
  // every turn — see historyMessages() on the gateway side), so tracking
  // the highest threshold already shown IN THIS PANEL is enough to alert
  // once per threshold as the conversation grows, without re-alerting on
  // every single message.
  let maxUsageThresholdShown = 0;
  // Build-target picker (Phase C item 3): a friendly wrapper over the model
  // picker above it, not a second execution backend -- desktop-agent has no
  // local runner of its own (see cloud-agent-gateway's registry.ts), only
  // Ollama genuinely runs on-device. "cloud" scopes model-select to
  // anthropic/openrouter/groq/deepseek; "local" scopes it to whatever
  // Ollama models are actually pulled (live-checked, same /models call);
  // "both" hides the single-select and fires this prompt against one auto
  // -picked cloud model and one local Ollama model concurrently, reusing
  // the exact lane-grid pattern submitMultitask below already established.
  let buildTarget = "cloud";
  const CLOUD_PROVIDERS = ["anthropic", "openrouter", "groq", "deepseek", "cerebras", "xkiro", "apinex"];

  async function applyBuildTarget(target) {
    buildTarget = target;
    buildTargetBtns.forEach((btn) => btn.classList.toggle("active", btn.dataset.target === target));
    buildTargetNote.hidden = true;
    if (target === "both") {
      modelSelect.hidden = true;
      buildTargetNote.hidden = false;
      buildTargetNote.textContent = "Runs once on an auto-eligible Cloud model and once on an installed Ollama model when both are available.";
      return;
    }
    modelSelect.hidden = false;
    if (target === "local") {
      const count = await populateModelSelect(modelSelect, { includeAuto: false, providerFilter: ["ollama"] });
      if (count === 0) {
        buildTargetNote.hidden = false;
        buildTargetNote.textContent = "No local Ollama models detected — install Ollama (ollama.com) and run e.g. \"ollama pull llama3\", or switch back to Cloud.";
      }
    } else {
      const count = await populateModelSelect(modelSelect, {
        includeAuto: true,
        autoLabel: "Auto (Cloud)",
        autoValue: CLOUD_AUTO_VALUE,
        providerFilter: CLOUD_PROVIDERS,
      });
      if (count === 0) {
        buildTargetNote.hidden = false;
        buildTargetNote.textContent = "No configured cloud models are available. Choose Local or add a cloud provider in Settings.";
      } else {
        const liveModels = await fetchModelOptions();
        if (!preferredCloudModel(liveModels)) {
          buildTargetNote.hidden = false;
          buildTargetNote.textContent = "Auto (Cloud) avoids providers excluded from automatic selection. Choose a listed model explicitly to use DeepSeek or Cerebras.";
        }
      }
    }
  }

  buildTargetBtns.forEach((btn) => {
    btn.addEventListener("click", () => applyBuildTarget(btn.dataset.target));
  });

  // Web App / Enterprise / Core / Embedded app-style toggle (Oct 2026 addition) --
  // independent of buildTarget above (that picks WHERE a task runs, this
  // picks the architectural register every mode answers in; see
  // AppArchitectureMode's doc comment in @mobiusx/protocol and
  // archModeGuidanceBlock in promptShared.ts). Plain in-memory state, not
  // persisted to ~/.mobiusx/settings.json -- same choice buildTarget itself
  // makes (it's a per-session toggle on this one panel, not a standing
  // default like defaultModel), so it resets to "web" on next launch
  // rather than carrying a stale global setting across unrelated projects.
  let archMode = "web";
  archModeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      archMode = btn.dataset.arch;
      archModeBtns.forEach((b) => b.classList.toggle("active", b.dataset.arch === archMode));
    });
  });

  populateModelSelect(modelSelect, {
    includeAuto: true,
    autoLabel: "Auto (Cloud)",
    autoValue: CLOUD_AUTO_VALUE,
    providerFilter: CLOUD_PROVIDERS,
  });

  // Spins the panel's header logo for as long as at least one streaming
  // response in this feed is still in flight (a follow-up can be sent while
  // an older message has already finished, so this is a count, not a flag).
  const titlebarIcon = container.querySelector(".assistant-icon");
  let activeStreamCount = 0;
  function setStreamingIndicator(active) {
    activeStreamCount += active ? 1 : -1;
    titlebarIcon.classList.toggle("spinning", activeStreamCount > 0);
  }

  // Token-limit alerts. `usage` is TokenUsage from @mobiusx/protocol (see
  // its doc comment) -- real counts read back from the provider's own
  // response, never estimated. Silent when contextWindow is unknown (an
  // Ollama-served local model, or a model this gateway's best-effort
  // lookup table doesn't recognize) rather than computing a percentage
  // against a guessed limit -- an honest "can't tell" beats a wrong number.
  function showUsageAlertIfNeeded(usage) {
    if (!usage.contextWindow) return;
    const percent = Math.round((usage.totalTokens / usage.contextWindow) * 100);
    for (const threshold of [90, 75, 50]) {
      if (percent >= threshold && maxUsageThresholdShown < threshold) {
        maxUsageThresholdShown = threshold;
        const banner = document.createElement("div");
        banner.className = `usage-alert usage-alert-${threshold}`;
        const guidance =
          threshold >= 90
            ? "Consider starting a fresh task soon — replies can get slower, less accurate, or truncated as a model nears its context limit."
            : threshold >= 75
              ? "Getting close to this model's context limit — a fresh task will have more room once this one wraps up."
              : "Just a heads up as this conversation grows.";
        banner.innerHTML = `⚠ This conversation has used ~${percent}% of this model's context window (${usage.totalTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens). ${escapeHtml(guidance)}`;
        feed.appendChild(banner);
        feed.scrollTop = feed.scrollHeight;
        break; // only the single highest threshold just crossed, not every one at once
      }
    }
  }

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      applyPanelMode(btn.dataset.mode);
      closePlusMenu();
      input.focus();
    });
  });

  function addMsg(text, cls) {
    const div = document.createElement("div");
    div.className = `assistant-msg ${cls}`;
    div.textContent = text;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
    return div;
  }

  function addStreamingMsg(mountEl = feed, msgOpts = {}) {
    const isMainFeed = mountEl === feed;
    const mirrorEl = msgOpts.mirrorEl ?? null;
    const div = document.createElement("div");
    div.className = "assistant-msg system streaming";
    div.innerHTML = `
      <div class="assistant-stream-head">
        <div class="assistant-stream-left">
          <div class="assistant-stream-status">
            <img class="assistant-spinner-icon" src="../../assets/logo.png" alt="" />
            <span class="assistant-stream-label">Working…</span>
            <span class="assistant-stream-phase">Preparing project context</span>
          </div>
          <details class="assistant-progress" open>
            <summary>Task activity <span class="assistant-progress-count"></span></summary>
            <div class="assistant-steps"></div>
          </details>
        </div>
        <button class="assistant-stop-btn" disabled title="Cancel this task">■ Stop</button>
      </div>
      <div class="assistant-output"></div>
    `;
    mountEl.appendChild(div);
    if (isMainFeed) feed.scrollTop = feed.scrollHeight;
    const stopBtn = div.querySelector(".assistant-stop-btn");
    const labelEl = div.querySelector(".assistant-stream-label");
    const phaseEl = div.querySelector(".assistant-stream-phase");
    const progressDetails = div.querySelector(".assistant-progress");
    const progressCount = div.querySelector(".assistant-progress-count");
    let completedFileCount = 0;
    let activeTaskPrompt = "";
    setStreamingIndicator(true);
    let finished = false;

    // Observation: "No Status of the actions with time, no of files
    // edited." -- a real elapsed-time ticker (the file count already
    // appears the moment it's known, in buildEditsCard's own "Proposed
    // changes — N files" header below; the task's edits are only ever
    // known as ONE complete array at the end of a response, per
    // promptShared.ts's single-fenced-json-block format, so there is no
    // honest way to show it growing incrementally mid-stream without
    // reworking that wire format -- this is the real, available-today
    // information: how long the model has actually been working).
    const startedAt = Date.now();
    let elapsedTimer = null;
    function formatElapsed(ms) {
      const s = Math.round(ms / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }
    function tickElapsed() {
      labelEl.textContent = `Working… (${formatElapsed(Date.now() - startedAt)})`;
    }
    tickElapsed();
    elapsedTimer = setInterval(tickElapsed, 1000);

    // Stops the spinner (both the per-message one and, once nothing else in
    // this panel is still running, the titlebar one) and freezes the status
    // label — called from whichever terminal event actually arrives
    // (setStatus's completed/cancelled/failed, or setError), and guarded so
    // a status *and* an error for the same task can't double-decrement the
    // shared activeStreamCount.
    function finish(label) {
      if (finished) return;
      finished = true;
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
      div.classList.add("done");
      labelEl.textContent = `${label} (${formatElapsed(Date.now() - startedAt)})${completedFileCount ? ` · ${completedFileCount} file${completedFileCount === 1 ? "" : "s"}` : ""}`;
      phaseEl.textContent = "";
      progressDetails.open = false;
      setStreamingIndicator(false);
      if (label === "Done" || label === "Failed") {
        const failed = label === "Failed";
        playTaskSound(failed);
        notifyTaskFinished(failed, activeTaskPrompt, completedFileCount);
      }
    }
    const stepsEl = div.querySelector(".assistant-steps");
    const outputEl = div.querySelector(".assistant-output");
    return {
      stopBtn,
      // Re-renders this message from an AUTHORITATIVE, freshly GET-ed
      // TaskDetail, instead of accumulating individual WS event deltas.
      // Why: the demo runner (and a fast real model) routinely finishes in
      // well under a second — faster than this client can finish the POST
      // /tasks round trip and open the streaming WebSocket, so this can
      // easily be subscribing after some or all of a task's events already
      // fired. The gateway does replay current state to a late subscriber
      // (see server.ts's upgrade handler), but trusting a client-side
      // accumulator to have seen every delta, in order, exactly once is
      // exactly the kind of assumption that leaves a panel stuck forever on
      // "Composing response" if any single message is missed or reordered.
      // Re-fetching ground truth on every signal — the same thing the Tasks
      // view's showTaskDetail()/renderTaskDetail() already does — sidesteps
      // that class of bug entirely: whatever we render is always this
      // task's actual current state, never a guess built from a delta log.
      // Safe to call repeatedly, including with a snapshot no newer than
      // the last one.
      renderFromDetail(task, { prefixLines = [], taskProjectPath } = {}) {
        stepsEl.innerHTML = "";
        const steps = task.steps ?? [];
        activeTaskPrompt = task.prompt ?? activeTaskPrompt;
        completedFileCount = task.edits?.length ?? 0;
        const activeStep = [...steps].reverse().find((step) => step.status === "in_progress");
        if (activeStep) phaseEl.textContent = activeStep.label;
        const completedSteps = steps.filter((step) => step.status === "completed").length;
        progressCount.textContent = steps.length ? `${completedSteps}/${steps.length} actions${task.edits?.length ? ` · ${task.edits.length} files` : ""}` : "";
        for (const step of steps) {
          const marker = step.status === "completed" ? "✓" : step.status === "failed" ? "!" : step.status === "in_progress" ? "…" : "·";
          const line = document.createElement("div");
          // .assistant-step-line carries the status class too (not just the
          // marker span) so CSS can strike through the whole row's label
          // once it's done -- a live todo list, not just a checkmark log.
          line.className = `assistant-step-line ${step.status}`;
          const time = step.startedAt ? new Date(step.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
          const duration = step.startedAt && step.completedAt
            ? ` · ${formatElapsed(Math.max(0, new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()))}`
            : "";
          line.innerHTML = `<span class="assistant-step-marker ${step.status}">${marker}</span><span class="assistant-step-label">${escapeHtml(step.label)}</span><time class="assistant-step-time">${escapeHtml(time + duration)}</time>`;
          stepsEl.appendChild(line);
        }

        const bodyText = task.output || (task.status === "failed" ? (task.error ?? "") : "");
        // Was outputEl.textContent = ... (plain text) -- chat responses are
        // markdown (the model is instructed accordingly), so this rendered
        // literal "**bold**"/```code``` fences etc. instead of formatting
        // them. renderMarkdownWithMermaid is already vendored and used
        // elsewhere (HLD/LLD docs, artifacts); fire-and-forget is fine here,
        // same as those call sites -- this fn is explicitly safe to call
        // repeatedly and streaming already re-renders this element often.
        renderMarkdownWithMermaid(outputEl, prefixLines.join("") + bodyText + (task.status === "cancelled" ? "\n[cancelled]" : ""));

        if (task.usage) showUsageAlertIfNeeded(task.usage);

        if (task.edits?.length && !div.querySelector(".edits-card")) {
          div.appendChild(buildEditsCard(task.edits, taskProjectPath, task.review));
        } else if (task.review) {
          const reviewSlot = div.querySelector(".edits-card-review");
          if (reviewSlot) reviewSlot.innerHTML = renderReviewBannerHtml(task.review);
        }

        if (isMainFeed) feed.scrollTop = feed.scrollHeight;
        if (mirrorEl) {
          mirrorEl.innerHTML = div.innerHTML;
          mirrorEl.querySelector(".assistant-stop-btn")?.remove();
        }

        if (task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
          stopBtn.remove();
          finish(task.status === "completed" ? "Done" : task.status === "cancelled" ? "Cancelled" : "Failed");
        }
      },
      // For failures that never got as far as a task existing at all (e.g.
      // the initial POST /tasks itself rejected) — nothing to re-fetch.
      setError(message) {
        outputEl.textContent += `\n[error] ${message}`;
        stopBtn.remove();
        finish("Failed");
        if (mirrorEl) {
          mirrorEl.innerHTML = div.innerHTML;
          mirrorEl.querySelector(".assistant-stop-btn")?.remove();
        }
      },
      setPhase(phase) {
        phaseEl.textContent = phase;
      },
    };
  }

  // Pulled into a named function (rather than inlined once, as before) so
  // resetConversation() below can show the exact same greeting a fresh
  // panel starts with -- "New Chat" should land somewhere identical to
  // what the user saw the first time this panel was ever created, not a
  // blank feed with no explanation of what the mode buttons below do.
  function showConnectBanner() {
    addMsg(
      cloudBaseUrl
        ? "Connected to the local Cloud Agent Gateway (reference implementation — see docs/ARCHITECTURE.md §12). Ask / Plan / Build / Spec below is real, but reasoning quality depends on whether a real model is configured; pick one above (or set a default in Settings) — each response says which runner and model actually served it. Only Build (and Spec, for a requirements doc) ever writes a real file — Ask and Plan just reply in chat, even if the reply shows code, so there's nothing to run or open from those two."
        : "Cloud Agent Gateway did not start — Ask/Plan/Build is unavailable this session.",
      "system",
    );
  }
  showConnectBanner();

  // Build-target "Both" (Phase C item 3, "optionally parallel"): the same
  // prompt/mode run twice concurrently, once against an auto-picked cloud
  // provider and once against a locally-installed Ollama model -- reuses
  // the exact 2-lane grid pattern submitMultitask (below) uses for its
  // N-mode case, just fixed at 2 lanes keyed by build target instead of by
  // mode. A live /models check happens right before firing so "which Ollama
  // tag" always reflects what's actually pulled at send time, not whatever
  // was true when the picker last rendered.
  async function resolveTargetModels(requestPrompt = "") {
    const models = await fetchModelOptions();
    const cloudModel = preferredCloudModel(models);
    const selectedForBoth = availableModel(models, parseModelSelection(modelSelect.value));
    const localModel = selectedForBoth?.provider === "ollama"
      ? selectedForBoth
      : recommendedLocalModel(models, mode, archMode, requestPrompt);

    if (buildTarget === "both") {
      const lanes = [];
      if (cloudModel) lanes.push({ label: `☁ Cloud — Auto (${cloudModel.label} first)`, model: null, autoCloud: true });
      if (localModel) lanes.push({ label: `💻 Local — ${localModel.label}`, model: { provider: localModel.provider, model: localModel.model } });
      return { lanes, missing: [!cloudModel ? "Cloud" : null, !localModel ? "Local" : null].filter(Boolean) };
    }

    const selected = parseModelSelection(modelSelect.value);
    if (buildTarget === "local") {
      const explicitlySelectedLocal = availableModel(models, selected)?.provider === "ollama"
        ? availableModel(models, selected)
        : null;
      const chosen = explicitlySelectedLocal ?? recommendedLocalModel(models, mode, archMode, requestPrompt);
      return {
        lanes: chosen?.provider === "ollama" ? [{ label: `💻 Local — ${chosen.label}`, model: { provider: chosen.provider, model: chosen.model } }] : [],
        missing: chosen?.provider === "ollama" ? [] : ["Local"],
      };
    }

    const isAuto = modelSelect.value === CLOUD_AUTO_VALUE || !selected;
    const chosen = isAuto ? cloudModel : availableModel(models, selected);
    return {
      lanes: chosen && CLOUD_PROVIDERS.includes(chosen.provider)
        ? [{ label: isAuto ? `☁ Cloud — Auto (${chosen.label} first)` : `☁ Cloud — ${chosen.label}`, model: isAuto ? null : { provider: chosen.provider, model: chosen.model }, autoCloud: isAuto }]
        : [],
      missing: chosen && CLOUD_PROVIDERS.includes(chosen.provider) ? [] : ["Cloud"],
    };
  }

  // Task-role mapping for the exact Qwen tags installed in the user's Ollama.
  // An explicit local selection wins; this recommendation is only the local
  // default for Build Target = Local / Both and does not alter Settings.
  function recommendedLocalModel(models, taskMode, applicationStyle, requestPrompt = "") {
    const available = models.filter((model) => model.provider === "ollama" && model.available);
    if (!available.length) return null;
    const has = (fragment) => available.find((model) => model.model.toLowerCase().includes(fragment));
    const taskIsCode = ["build", "fix", "testing", "database", "devops", "auth"].includes(taskMode);
    const complexPlan = taskMode === "plan" && (
      requestPrompt.length > 700
      || /\b(enterprise|distributed|microservices?|multi-tenant|high availability|fault tolerant|compliance|security architecture|data migration|event-driven|real-time)\b/i.test(requestPrompt)
    );
    const needsArchitectureReasoning = ["architecture", "spec"].includes(taskMode)
      || complexPlan
      || (["enterprise", "embedded"].includes(applicationStyle) && taskMode === "plan");
    const preferred = taskIsCode
      ? has("qwen2.5-coder:7b-instruct")
      : needsArchitectureReasoning
        ? has("qwen2.5:14b-instruct")
        : has("qwen2.5:7b-instruct");
    return preferred ?? available.find((model) => model.model.toLowerCase().includes("qwen2.5-coder")) ?? available[0];
  }

  async function submitBothTargets(text, lanes, missing = []) {
    addMsg(text, "user");
    input.value = "";
    resizeInput();
    if (missing.length) {
      addMsg(`No ${missing.join(" or ")} model is available, so this request will run only on ${lanes.map((lane) => lane.label.startsWith("☁") ? "Cloud" : "Local").join(" and ")}.`, "system");
    }
    const wrapper = document.createElement("div");
    wrapper.className = "assistant-msg system multitask-run";
    wrapper.innerHTML = `<div class="multitask-run-head">⇄ ${escapeHtml(MODE_LABELS[mode])} — running on ${lanes.map((lane) => escapeHtml(lane.label)).join(" and ")}</div><div class="multitask-run-grid"></div>`;
    feed.appendChild(wrapper);
    feed.scrollTop = feed.scrollHeight;
    const grid = wrapper.querySelector(".multitask-run-grid");
    await Promise.all(
      lanes.map(async (l) => {
        const lane = document.createElement("div");
        lane.className = "multitask-lane";
        lane.innerHTML = `<div class="multitask-lane-label">${escapeHtml(l.label)}</div>`;
        grid.appendChild(lane);
        const stream = addStreamingMsg(lane);
        await runTaskForMode(mode, text, stream, l.model, l.autoCloud);
      }),
    );
    if (attachedFiles.length) {
      attachedFiles = [];
      renderAttachChips();
    }
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || !cloudBaseUrl) return;
    primeTaskSound();

    // Build/Spec modes propose real file edits, and Apply refuses to write
    // anywhere without a currently-open project (see buildEditsCard's
    // "Open a project first." guard) -- catching that up front, before
    // spending a whole generation, instead of letting the user go through
    // the full response only to hit a dead end at Apply time. Confirmed
    // real friction, not a hypothetical: a user submitted a Build request
    // with no project open, got a full proposed-edits response, and had no
    // way to tell anything was wrong until Apply silently did nothing.
    if (PROJECT_REQUIRED_MODES.has(mode) && !currentProjectPath) {
      addMsg(text, "user");
      input.value = "";
      resizeInput();
      addMsg(
        `${MODE_LABELS[mode]} mode writes real files, so it needs a project open first — click "New Project…" or "Open Project…" at the top, then send this again.`,
        "system",
      );
      return;
    }

    // A user can reopen an old thread while a different project is active.
    // Keep old threads available, but never send their prompts or generated
    // code as context for the current workspace.
    if (historyProjectPath !== (currentProjectPath ?? null)) {
      resetConversation();
      addMsg("Started a fresh conversation for the current project. Earlier messages from another project were excluded.", "system");
    }

    const targetModels = await resolveTargetModels(text);
    if (targetModels.lanes.length === 0) {
      addMsg(`No available ${targetModels.missing.join(" or ")} model is configured for this target. Check Models in Settings, then try again.`, "system");
      return;
    }
    if (buildTarget === "both") {
      await submitBothTargets(text, targetModels.lanes, targetModels.missing);
      return;
    }

    addMsg(text, "user");
    input.value = "";
    resizeInput();
    if (targetModels.missing.length) {
      addMsg(`No ${targetModels.missing.join(" or ")} model is available, so this request will run only on ${targetModels.lanes[0].label.startsWith("☁") ? "Cloud" : "Local"}.`, "system");
    }

    const mirrorEl = opts.rightPane ? document.getElementById("right-pane-generation") : null;
    const stream = addStreamingMsg(feed, { mirrorEl });
    if (opts.rightPane) revealGeneration();
    await runTaskForMode(mode, text, stream, targetModels.lanes[0].model, targetModels.lanes[0].autoCloud);
    if (attachedFiles.length) {
      attachedFiles = [];
      renderAttachChips();
    }
  }

  async function runTaskForMode(mode, text, stream, modelOverride, autoCloudOverride = false) {
    const taskConversationEpoch = conversationEpoch;
    const taskProjectPath = currentProjectPath; // captured now — the task's context is grounded in whatever project is open at submit time, not whatever's open when a later event arrives
    stream.setPhase("Gathering project context");
    try {
      let relevantFiles, indexedChunkCount, architectureEvidence, testingEvidence, devopsEvidence, authEvidence;
      // Project Memory/Steering (Phase 16) + Knowledge (Phase 17) --
      // fetched for every mode with a project open, in parallel with each
      // other (independent lookups, no reason to serialize them).
      // Assistant Memory (Oct 2026 addition) is fetched unconditionally,
      // NOT gated on taskProjectPath like the two above -- it's global,
      // meaningful even with no project open (e.g. a plain "ask" chat).
      const [steeringContext, knowledgeContext, assistantMemoryContext] = await Promise.all([
        taskProjectPath ? fetchSteeringContext() : Promise.resolve(undefined),
        taskProjectPath ? fetchKnowledgeContext(text) : Promise.resolve(undefined),
        fetchAssistantMemoryContext(),
      ]);
      if (mode === "architecture") {
        relevantFiles = await fetchArchitectureRelevantFiles();
        indexedChunkCount = undefined;
        try {
          architectureEvidence = await api("/architecture-evidence");
        } catch {
          // Honest fallback -- promptShared.ts's "architecture" branch
          // explicitly handles an absent bundle rather than assuming it's
          // always present.
          architectureEvidence = undefined;
        }
      } else if (mode === "devops") {
        // DevOps mode (roadmap Phase 14) doesn't ground itself in semantic
        // search either -- its real grounding is the pre-computed evidence
        // bundle below, per promptShared.ts's "devops" branch. Its own
        // existingInfraFiles ALREADY carries full content for any
        // Dockerfile/compose/CI file this project already has (see
        // devopsContext.ts), so relevantFiles is built directly from that
        // bundle -- no separate /fs/read round trip needed, unlike
        // Architecture mode's fixed-path fetch above.
        indexedChunkCount = undefined;
        try {
          devopsEvidence = await api("/devops-evidence");
          relevantFiles = (devopsEvidence.existingInfraFiles ?? []).map((f) => ({ relPath: f.relPath, snippet: f.content.slice(0, 200), content: f.content }));
        } catch {
          devopsEvidence = undefined;
          relevantFiles = [];
        }
      } else if (mode === "auth") {
        // Auth mode (roadmap Phase 19) doesn't ground itself in semantic
        // search either -- its real grounding is the pre-computed evidence
        // bundle below, per promptShared.ts's "auth" branch. Its own
        // existingAuthFiles ALREADY carries full content for any
        // auth-shaped file this project already has (see authContext.ts),
        // so relevantFiles is built directly from that bundle -- same
        // pattern DevOps mode's fetch above already established.
        indexedChunkCount = undefined;
        try {
          authEvidence = await api("/auth-evidence");
          relevantFiles = (authEvidence.existingAuthFiles ?? []).map((f) => ({ relPath: f.relPath, snippet: f.content.slice(0, 200), content: f.content }));
        } catch {
          authEvidence = undefined;
          relevantFiles = [];
        }
      } else {
        ({ hits: relevantFiles, storeSize: indexedChunkCount } = await findRelevantFiles(text, mode));
      }
      // Testing mode's prompt is grounded in this bundle (real detected test
      // framework(s) + an existing test file sample, see testingContext.ts),
      // and Build mode uses it too for its conditional companion-test
      // instruction (buildModeTestingBlock in promptShared.ts) -- so both
      // modes fetch it here, honestly falling back to undefined (never a
      // guessed shape) if the desktop agent has no project open or errors.
      if (mode === "build" || mode === "testing") {
        try {
          testingEvidence = await api("/testing-evidence");
        } catch {
          testingEvidence = undefined;
        }
      }
      // Files attached via the "+" menu's Files action -- merged in ahead
      // of whatever semantic search already found (never replacing it), so
      // an attached file always has full content available, same as
      // build/fix's own full-content fetch above.
      if (attachedFiles.length) {
        const manualHits = attachedFiles.map((f) => ({ relPath: f.relPath, snippet: f.content.slice(0, 200), content: f.content }));
        const already = new Set(manualHits.map((h) => h.relPath));
        relevantFiles = [...manualHits, ...(relevantFiles ?? []).filter((h) => !already.has(h.relPath))];
      }
      stream.setPhase("Submitting task to the selected model");
      // "" (Auto) means: omit `model` entirely and let the gateway's
      // resolveRunner() choose (Settings default, else best configured
      // provider, else demo) — see populateModelSelect above. modelOverride
      // (Phase C's "Both" build target) bypasses the picker entirely so two
      // concurrent lanes can each pin their own model without fighting over
      // one shared <select>'s value — see submitBothTargets.
      const model = modelOverride !== undefined ? modelOverride || undefined : modelSelect.value && modelSelect.value !== CLOUD_AUTO_VALUE ? JSON.parse(modelSelect.value) : undefined;
      const autoCloud = modelOverride !== undefined ? Boolean(autoCloudOverride) : modelSelect.value === CLOUD_AUTO_VALUE || !model;
      // Lazily creates this panel's thread on its first real send (never
      // eagerly) -- see ensureThreadId's doc comment above. Awaited here,
      // ahead of the POST /tasks below, so concurrent lanes (submitBothTargets'
      // 2 lanes, submitMultitask's N lanes -- both fan out via Promise.all
      // into this same function) share the one in-flight creation instead
      // of racing to create 2+ threads for what's really one conversation.
      const threadId = (await ensureThreadId()) ?? undefined;
      const { task } = await cloudApi("/tasks", {
        method: "POST",
        body: JSON.stringify({
          mode,
          prompt: text,
          projectContext: taskProjectPath
            ? {
                projectPath: taskProjectPath,
                relevantFiles,
                indexedChunkCount,
                ...(architectureEvidence ? { architectureEvidence } : {}),
                ...(testingEvidence ? { testingEvidence } : {}),
                ...(devopsEvidence ? { devopsEvidence } : {}),
                ...(authEvidence ? { authEvidence } : {}),
                ...(steeringContext ? { steeringContext } : {}),
                ...(knowledgeContext ? { knowledgeContext } : {}),
                ...(assistantMemoryContext ? { assistantMemoryContext } : {}),
              }
            : assistantMemoryContext
              ? { assistantMemoryContext }
              : undefined,
          model,
          autoCloud,
          archMode,
          history: historyTurns.slice(-MAX_HISTORY_TURNS),
          threadId,
        }),
      });
      stream.setPhase("Receiving model response and task updates");
      const styleLabel = archMode === "enterprise" ? "🏢 Enterprise" : archMode === "embedded" ? "🔩 Embedded Apps" : archMode === "core" ? "⚙️ Core App" : "🌐 Web App";
      const prefixLines = [`[runner: ${task.runner}${task.model ? " / " + task.model : ""}]\n`, `[app style: ${styleLabel}]\n`];
      if (task.modelNote) prefixLines.push(`[model note] ${task.modelNote}\n`);
      const renderOpts = { prefixLines, taskProjectPath };
      stream.stopBtn.disabled = false;
      stream.stopBtn.addEventListener("click", async () => {
        stream.stopBtn.disabled = true;
        stream.stopBtn.textContent = "Stopping…";
        try {
          await cloudApi(`/tasks/${task.id}/cancel`, { method: "POST" });
        } catch (err) {
          stream.stopBtn.disabled = false;
          stream.stopBtn.textContent = `Cancel failed: ${err.message}`;
        }
      });

      // Fetch ground truth immediately, before ever opening the streaming
      // WebSocket — see renderFromDetail's doc comment. A fast task (the
      // demo runner typically finishes in under 1.5s) can easily already be
      // "completed" by this point, in which case we render the final result
      // right away and never open the WS at all.
      let detail = await cloudApi(`/tasks/${task.id}`);
      stream.renderFromDetail(detail, renderOpts);

      if (detail.status === "queued" || detail.status === "running") {
        let refreshInFlight = false;
        let refreshQueued = false;
        let lastRefreshAt = 0;
        const refresh = async () => {
          refreshQueued = true;
          if (refreshInFlight) return;
          refreshInFlight = true;
          try {
            while (refreshQueued) {
              refreshQueued = false;
              const pause = Math.max(0, 150 - (Date.now() - lastRefreshAt));
              if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
              detail = await cloudApi(`/tasks/${task.id}`);
              lastRefreshAt = Date.now();
              stream.renderFromDetail(detail, renderOpts);
              if (["completed", "failed", "cancelled"].includes(detail.status)) refreshQueued = false;
            }
          } finally {
            refreshInFlight = false;
          }
        };
        await streamTask(task.id, {
          onStep: refresh,
          onOutput: refresh,
          onEdits: refresh,
          onReview: refresh,
          onStatus: refresh,
          onError: (message) => stream.setError(message),
        });
        detail = await cloudApi(`/tasks/${task.id}`);
        stream.renderFromDetail(detail, renderOpts);
      }
      stream.stopBtn.remove();
      // Remember this exchange for the NEXT follow-up in this panel — see
      // the historyTurns comment above. Skipped for an empty response (e.g.
      // the task was cancelled before producing anything) since there's
      // nothing worth reminding the model of.
      if (taskConversationEpoch === conversationEpoch && detail.output?.trim()) {
        historyTurns.push({ role: "user", content: text }, { role: "assistant", content: detail.output });
        if (historyTurns.length > MAX_HISTORY_TURNS * 2) {
          historyTurns = historyTurns.slice(-MAX_HISTORY_TURNS * 2);
        }
      }
    } catch (err) {
      stream.setError(err.message);
    }
  }

  // Multitask (source requirement: "orchestrate multiple subagents in
  // parallel") -- no separate backend concept for this exists (see
  // apps/cloud-agent-gateway), so this fires one real POST /tasks per
  // selected mode CONCURRENTLY against the same prompt/project, reusing
  // runTaskForMode/addStreamingMsg exactly as a single-mode send does --
  // just N times, each with its own lane in one grouped run card.
  async function submitMultitask(modes) {
    const text = input.value.trim();
    if (!text || !cloudBaseUrl) return;
    const targetModels = await resolveTargetModels(text);
    if (targetModels.lanes.length === 0) {
      addMsg(`No available ${targetModels.missing.join(" or ")} model is configured for this target. Check Models in Settings, then try again.`, "system");
      return;
    }
    const runnable = modes.filter((m) => !PROJECT_REQUIRED_MODES.has(m) || currentProjectPath);
    const skipped = modes.filter((m) => !runnable.includes(m));
    addMsg(text, "user");
    input.value = "";
    resizeInput();
    if (skipped.length) {
      addMsg(`Skipped ${skipped.map((m) => MODE_LABELS[m]).join(", ")} — needs a project open first.`, "system");
    }
    if (targetModels.missing.length) {
      addMsg(`No ${targetModels.missing.join(" or ")} model is available, so Multi-task will run only on the configured ${targetModels.lanes.map((lane) => lane.label.startsWith("☁") ? "Cloud" : "Local").join(" and ")} target.`, "system");
    }
    if (runnable.length === 0) return;
    const wrapper = document.createElement("div");
    wrapper.className = "assistant-msg system multitask-run";
    wrapper.innerHTML = `<div class="multitask-run-head">⚡ Multitask — ${runnable.length} mode${runnable.length === 1 ? "" : "s"} × ${targetModels.lanes.length} target${targetModels.lanes.length === 1 ? "" : "s"}</div><div class="multitask-run-grid"></div>`;
    feed.appendChild(wrapper);
    feed.scrollTop = feed.scrollHeight;
    const grid = wrapper.querySelector(".multitask-run-grid");
    const jobs = runnable.flatMap((m) => targetModels.lanes.map((target) => ({ mode: m, target })));
    await Promise.all(
      jobs.map(async ({ mode: taskMode, target }) => {
        const lane = document.createElement("div");
        lane.className = "multitask-lane";
        lane.innerHTML = `<div class="multitask-lane-label">${escapeHtml(MODE_LABELS[taskMode] ?? taskMode)} · ${escapeHtml(target.label)}</div>`;
        grid.appendChild(lane);
        const stream = addStreamingMsg(lane);
        await runTaskForMode(taskMode, text, stream, target.model, target.autoCloud);
      }),
    );
    multitaskBar.hidden = true;
    multitaskModesEl.querySelectorAll("input").forEach((cb) => (cb.checked = false));
    if (attachedFiles.length) {
      attachedFiles = [];
      renderAttachChips();
    }
  }

  function currentMultitaskSelection() {
    if (multitaskBar.hidden) return [];
    return Array.from(multitaskModesEl.querySelectorAll("input:checked")).map((cb) => cb.value);
  }

  function handleSend() {
    closeAtPopover(); // defensive -- Enter can't reach here while the popover is open (see keydown below), but a direct click on sendBtn while it happens to still be open could
    const selected = currentMultitaskSelection();
    if (selected.length >= 2) {
      submitMultitask(selected);
    } else {
      submit();
    }
  }

  sendBtn.addEventListener("click", handleSend);
  input.addEventListener("keydown", (e) => {
    // The "@" mention popover (set up below) needs first refusal on these
    // keys while it's open -- otherwise, e.g., Enter here would send the
    // message with "@partial-query" still literally sitting in the text
    // instead of letting Enter pick the highlighted candidate the way
    // every other "@"-mention UI (this one is modeled on Cursor's own,
    // confirmed live -- see the Gap Analysis) behaves.
    if (!atPopover.hidden) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        atHighlightIndex = Math.min(atHighlightIndex + 1, atCandidates.length - 1);
        renderAtPopover();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        atHighlightIndex = Math.max(atHighlightIndex - 1, 0);
        renderAtPopover();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (atCandidates.length) {
          e.preventDefault();
          selectAtCandidate(atHighlightIndex);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeAtPopover();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-expanding textarea (replaces the old single-line input) -- capped
  // by CSS max-height (see .assistant-textarea), beyond which it scrolls
  // internally instead of growing the whole panel.
  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }
  input.addEventListener("input", resizeInput);

  // ---- "+" menu: Debug / Multitask / Attach files / MCP tool ----
  function closePlusMenu() {
    plusMenu.hidden = true;
    plusBtn.setAttribute("aria-expanded", "false");
  }
  plusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    plusMenu.hidden = !plusMenu.hidden;
    plusBtn.setAttribute("aria-expanded", String(!plusMenu.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!plusMenu.hidden && !plusMenu.contains(e.target) && e.target !== plusBtn) closePlusMenu();
    if (!filesPopover.hidden && !filesPopover.contains(e.target) && e.target !== plusBtn) filesPopover.hidden = true;
    if (!mcpPopover.hidden && !mcpPopover.contains(e.target) && e.target !== plusBtn) mcpPopover.hidden = true;
  });
  plusMenu.querySelectorAll(".plus-menu-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      // Without this, the click bubbles to the document-level "close
      // popover if the click landed outside it" listener above, which
      // fires in the same tick right after this handler opens the
      // files/MCP popover -- immediately closing it again. Debug and
      // Multitask never hit this because they aren't covered by that
      // outside-click check.
      e.stopPropagation();
      const action = item.dataset.action;
      closePlusMenu();
      if (action === "debug") {
        const fixBtn = container.querySelector('.mode-btn[data-mode="fix"]');
        fixBtn.hidden = false;
        fixBtn.click();
        input.focus();
      } else if (action === "multitask") {
        multitaskBar.hidden = !multitaskBar.hidden;
      } else if (action === "files") {
        mcpPopover.hidden = true;
        filesPopover.hidden = !filesPopover.hidden;
        if (!filesPopover.hidden) {
          filesSearchInput.value = "";
          filesSearchInput.focus();
          renderFilesPopoverList("");
        }
      } else if (action === "mcp") {
        filesPopover.hidden = true;
        mcpPopover.hidden = !mcpPopover.hidden;
        if (!mcpPopover.hidden) loadMcpPopover();
      }
    });
  });

  // ---- Multitask mode-select checkboxes ----
  multitaskModesEl.innerHTML = Object.entries(MODE_LABELS)
    .map(([m, label]) => `<label class="multitask-mode-chk"><input type="checkbox" value="${m}" />${escapeHtml(label)}</label>`)
    .join("");
  multitaskCancelBtn.addEventListener("click", () => {
    multitaskBar.hidden = true;
    multitaskModesEl.querySelectorAll("input").forEach((cb) => (cb.checked = false));
  });

  // ---- Files popover: attach real project files as extra context ----
  function renderAttachChips() {
    attachChipsEl.hidden = attachedFiles.length === 0;
    attachChipsEl.innerHTML = attachedFiles
      .map(
        // f.label overrides the plain relPath for display only -- set by
        // the "@" mention popover below for a selection chip (e.g.
        // "renderer.js (L120-135)"), never by the "+" menu's own Files
        // action, which always attaches a whole file under its real path.
        (f, i) =>
          `<span class="attach-chip">${f.label ? "✂️" : "📎"} ${escapeHtml(f.label || f.relPath)}<button type="button" class="attach-chip-remove" data-idx="${i}" title="Remove">✕</button></span>`,
      )
      .join("");
    attachChipsEl.querySelectorAll(".attach-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        attachedFiles.splice(Number(btn.dataset.idx), 1);
        renderAttachChips();
      });
    });
  }
  async function renderFilesPopoverList(query) {
    if (!currentProjectPath) {
      filesListEl.innerHTML = `<div class="debug-empty">Open a project first.</div>`;
      return;
    }
    filesListEl.innerHTML = `<div class="debug-empty">Loading…</div>`;
    try {
      const { nodes } = await api("/fs/tree");
      const q = query.trim().toLowerCase();
      const files = Object.values(nodes)
        .filter((n) => n.type === "file" && (!q || n.relPath.toLowerCase().includes(q)))
        .slice(0, 40);
      if (files.length === 0) {
        filesListEl.innerHTML = `<div class="debug-empty">No matching files.</div>`;
        return;
      }
      filesListEl.innerHTML = files
        .map((f) => `<button type="button" class="files-popover-item" data-path="${escapeHtml(f.relPath)}">${escapeHtml(f.relPath)}</button>`)
        .join("");
      filesListEl.querySelectorAll(".files-popover-item").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const relPath = btn.dataset.path;
          if (attachedFiles.some((f) => f.relPath === relPath)) {
            filesPopover.hidden = true;
            return;
          }
          btn.disabled = true;
          btn.textContent = `Attaching ${relPath}…`;
          try {
            const file = await api(`/fs/read?path=${encodeURIComponent(relPath)}`);
            attachedFiles.push({ relPath, content: file.content });
            renderAttachChips();
          } catch (err) {
            addMsg(`[attach] Couldn't read ${relPath}: ${err.message}`, "system");
          }
          filesPopover.hidden = true;
        });
      });
    } catch (err) {
      filesListEl.innerHTML = `<div class="debug-empty">${escapeHtml(err.message)}</div>`;
    }
  }
  let filesSearchDebounce;
  filesSearchInput.addEventListener("input", () => {
    clearTimeout(filesSearchDebounce);
    filesSearchDebounce = setTimeout(() => renderFilesPopoverList(filesSearchInput.value), 150);
  });

  // ---- "@" inline context mention (Gap Analysis Pillar 4: "no inline
  // @-keystroke trigger -- today it's a separate + button -> popover
  // click-path, not a @-character-triggered floating suggestion list
  // anchored at the text cursor, which is what Cursor itself does"). This
  // reuses the exact same /fs/tree search and attachedFiles array the
  // Files popover just above already does -- same data layer, just reached
  // by typing "@" instead of clicking "+", plus two entries that popover
  // never offered: the file actually open in the editor right now (free --
  // openTabs/activeTabPath are already in memory, see their declaration
  // near the top of this file), and whatever's selected in it (also real,
  // despite the editor being a plain read-only <pre> and not a rich
  // component -- see its own comment: plain DOM text selection doesn't
  // need a rich editor, it just means no real line/column tracking, which
  // this works around honestly below by counting the file's own newlines
  // rather than claiming a cursor position that isn't real). ----
  let atTriggerStart = null; // index into input.value of the "@" that opened the popover, or null when it's closed
  let atHighlightIndex = 0;
  let atCandidates = [];
  let atLastQuery = null; // dedupe guard -- re-running updateAtCandidates (an /fs/tree round trip) on every keystroke when neither the trigger position nor the query actually changed would be wasteful and could race itself
  let atCapturedSelection = null; // { relPath, content, label } snapshotted the instant "@" was typed -- opening/using this popover moves focus off the editor, which would otherwise collapse the live selection before a click on "Selection" could read it back

  // Caret-PIXEL-position measurement for a plain <textarea> -- browsers
  // only expose selectionStart/End as character indices, nothing in
  // viewport coordinates. Standard technique (same one the textarea-caret
  // npm package uses): lay the same text out in a hidden mirror element
  // with every text-affecting CSS property copied from the real textarea,
  // then measure where a marker span lands inside it. Built once on first
  // use, reused after.
  let caretMirror = null;
  const CARET_MIRROR_PROPS = [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "tabSize",
  ];
  function getCaretViewportPosition(textarea, index) {
    if (!caretMirror) {
      caretMirror = document.createElement("div");
      caretMirror.style.position = "absolute";
      caretMirror.style.visibility = "hidden";
      caretMirror.style.top = "0";
      caretMirror.style.left = "-9999px";
      caretMirror.style.whiteSpace = "pre-wrap";
      caretMirror.style.wordWrap = "break-word";
      document.body.appendChild(caretMirror);
    }
    const style = window.getComputedStyle(textarea);
    for (const prop of CARET_MIRROR_PROPS) caretMirror.style[prop] = style[prop];
    caretMirror.textContent = textarea.value.substring(0, index);
    const marker = document.createElement("span");
    marker.textContent = "​"; // zero-width space -- an empty span can collapse to 0 width and mis-measure right at a line-wrap boundary
    caretMirror.appendChild(marker);
    const textareaRect = textarea.getBoundingClientRect();
    const left = textareaRect.left + (marker.offsetLeft - textarea.scrollLeft);
    const top = textareaRect.top + (marker.offsetTop - textarea.scrollTop);
    caretMirror.textContent = ""; // don't leak content (or the marker) into the next call
    return { left, top };
  }

  function positionAtPopover() {
    const pos = getCaretViewportPosition(input, atTriggerStart);
    atPopover.style.left = `${Math.round(pos.left)}px`;
    // Opens ABOVE the caret line, not below -- this input sits at the very
    // bottom of the panel (.assistant-input-row), so a dropdown opening
    // downward would usually render mostly or entirely outside the panel.
    atPopover.style.bottom = `${Math.round(window.innerHeight - pos.top + 4)}px`;
  }

  function closeAtPopover() {
    atTriggerStart = null;
    atLastQuery = null;
    atPopover.hidden = true;
    atCandidates = [];
  }

  function renderAtPopover() {
    if (atCandidates.length === 0) {
      atPopoverList.innerHTML = `<div class="at-popover-empty">No matches</div>`;
      return;
    }
    atHighlightIndex = Math.min(atHighlightIndex, atCandidates.length - 1);
    atPopoverList.innerHTML = atCandidates
      .map(
        (c, i) =>
          `<button type="button" class="at-popover-item${i === atHighlightIndex ? " highlighted" : ""}" data-idx="${i}">` +
          `<span class="at-popover-item-icon">${c.icon}</span>` +
          `<span class="at-popover-item-path">${escapeHtml(c.label)}</span>` +
          (c.meta ? `<span class="at-popover-item-meta">${escapeHtml(c.meta)}</span>` : "") +
          `</button>`,
      )
      .join("");
    atPopoverList.querySelectorAll(".at-popover-item").forEach((btn) => {
      btn.addEventListener("mouseenter", () => {
        atHighlightIndex = Number(btn.dataset.idx);
        renderAtPopover();
      });
      btn.addEventListener("click", () => selectAtCandidate(Number(btn.dataset.idx)));
    });
  }

  async function selectAtCandidate(idx) {
    const c = atCandidates[idx];
    if (!c || atTriggerStart === null) return;
    const triggerStart = atTriggerStart;
    const queryEnd = input.selectionStart;
    if (c.kind === "selection") {
      attachedFiles.push({ relPath: c.relPath, content: c.content, label: c.label });
      renderAttachChips();
    } else if (c.content !== undefined) {
      // Active-file candidate -- content already in memory via openTabs, no round trip needed.
      attachedFiles.push({ relPath: c.relPath, content: c.content });
      renderAttachChips();
    } else {
      try {
        const file = await api(`/fs/read?path=${encodeURIComponent(c.relPath)}`);
        attachedFiles.push({ relPath: c.relPath, content: file.content });
        renderAttachChips();
      } catch (err) {
        addMsg(`[attach] Couldn't read ${c.relPath}: ${err.message}`, "system");
      }
    }
    // Remove the typed "@query" text -- the attachment now shows as a chip
    // above the input instead, same end state as using the "+" menu's
    // Files action, just reached by typing "@" instead of clicking it.
    const before = input.value.slice(0, triggerStart);
    const after = input.value.slice(queryEnd);
    input.value = before + after;
    input.selectionStart = input.selectionEnd = before.length;
    resizeInput();
    closeAtPopover();
    input.focus();
  }

  async function updateAtCandidates(query) {
    const q = query.trim().toLowerCase();
    const candidates = [];
    if (activeTabPath && (!q || activeTabPath.toLowerCase().includes(q) || "active file".includes(q))) {
      const tab = openTabs.find((t) => t.path === activeTabPath);
      if (tab) {
        candidates.push({
          kind: "file", relPath: activeTabPath, content: tab.model.getValue(),
          icon: "📄", label: activeTabPath.split("/").pop(), meta: "active file",
        });
      }
    }
    if (atCapturedSelection && (!q || "selection".includes(q))) {
      candidates.push({ kind: "selection", icon: "✂️", ...atCapturedSelection });
    }
    if (currentProjectPath) {
      try {
        const { nodes } = await api("/fs/tree");
        const already = new Set(candidates.map((c) => c.relPath));
        Object.values(nodes)
          .filter((n) => n.type === "file" && !already.has(n.relPath) && (!q || n.relPath.toLowerCase().includes(q)))
          .slice(0, 20)
          .forEach((f) => candidates.push({ kind: "file", relPath: f.relPath, icon: "📎", label: f.relPath }));
      } catch {
        // Search just comes back short (the pinned entries above still
        // work) -- same honest degrade the Files popover's own try/catch
        // above already takes rather than surfacing a hard error here.
      }
    }
    atCandidates = candidates;
    atHighlightIndex = 0;
    renderAtPopover();
  }

  // Monaco's own Selection already carries line/column natively -- no
  // DOM TreeWalker/newline-counting needed now that the editor is a real
  // Monaco instance rather than a plain <pre>.
  function captureEditorSelectionForAt() {
    atCapturedSelection = null;
    if (!activeTabPath || !monacoEditor) return;
    const tab = openTabs.find((t) => t.path === activeTabPath);
    if (!tab || monacoEditor.getModel() !== tab.model) return;
    const sel = monacoEditor.getSelection();
    if (!sel || sel.isEmpty()) return;
    const text = tab.model.getValueInRange(sel);
    if (!text.trim()) return;
    const startLine = sel.startLineNumber;
    const endLine = sel.endLineNumber;
    const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
    atCapturedSelection = {
      relPath: activeTabPath,
      content: text,
      label: `${activeTabPath.split("/").pop()} (${lineLabel})`,
    };
  }

  function checkAtTrigger() {
    const caret = input.selectionStart;
    const text = input.value;
    // Scan back from the caret for a "@" that starts the current word --
    // i.e. stop at the first whitespace/newline (so "user@example.com"
    // doesn't trigger mid-word) and only treat it as a trigger if that "@"
    // itself sits at the very start of the text or right after whitespace
    // (so a finished "@mention " earlier in the message doesn't re-open).
    let i = caret - 1;
    while (i >= 0 && !/\s/.test(text[i]) && text[i] !== "@") i--;
    const isTrigger = i >= 0 && text[i] === "@" && (i === 0 || /\s/.test(text[i - 1]));
    if (!isTrigger) {
      if (atTriggerStart !== null) closeAtPopover();
      return;
    }
    const query = text.slice(i + 1, caret);
    if (atTriggerStart === i && query === atLastQuery) return; // nothing actually changed -- skip the /fs/tree round trip
    atTriggerStart = i;
    if (atLastQuery === null) captureEditorSelectionForAt(); // only on the OPENING keystroke -- re-querying mustn't re-snapshot a selection that's long gone now that focus is in this textarea
    atLastQuery = query;
    atPopover.hidden = false;
    positionAtPopover();
    updateAtCandidates(query);
  }
  input.addEventListener("input", checkAtTrigger);
  document.addEventListener("click", (e) => {
    if (!atPopover.hidden && !atPopover.contains(e.target) && e.target !== input) closeAtPopover();
  });

  // ---- MCP popover: real call to /mcp/tools/call (source requirement §28)
  // -- GET /mcp/status already powers Settings' read-only server list; this
  // is the first actual FRONTEND CALLER of POST /mcp/tools/call, which until
  // now only had a real backend and zero UI to reach it. ----
  async function loadMcpPopover() {
    if (!currentProjectPath) {
      mcpListEl.innerHTML = `<div class="debug-empty">Open a project first — MCP servers are configured per-project (.mobiusx/mcp.json).</div>`;
      return;
    }
    mcpListEl.innerHTML = `<div class="debug-empty">Loading MCP servers…</div>`;
    try {
      const { servers } = await api("/mcp/status");
      const connected = (servers ?? []).filter((s) => s.connected && s.tools.length > 0);
      if (connected.length === 0) {
        mcpListEl.innerHTML = `<div class="debug-empty">No connected MCP servers with tools — see .mobiusx/mcp.json in Settings.</div>`;
        return;
      }
      mcpListEl.innerHTML = connected
        .map(
          (s) => `
        <div class="mcp-popover-server">
          <div class="mcp-popover-server-name">${escapeHtml(s.name)}</div>
          ${s.tools
            .map(
              (t) => `
            <div class="mcp-popover-tool">
              <button type="button" class="mcp-popover-tool-btn" data-tool="${escapeHtml(t.name)}">${escapeHtml(t.toolName)}</button>
              ${t.description ? `<div class="scope-note-small">${escapeHtml(t.description)}</div>` : ""}
            </div>`,
            )
            .join("")}
        </div>`,
        )
        .join("");
      mcpListEl.querySelectorAll(".mcp-popover-tool-btn").forEach((btn) => {
        btn.addEventListener("click", () => openMcpRunner(btn.dataset.tool, btn.closest(".mcp-popover-tool")));
      });
    } catch (err) {
      mcpListEl.innerHTML = `<div class="debug-empty">${escapeHtml(err.message)}</div>`;
    }
  }
  function openMcpRunner(toolName, anchorEl) {
    if (anchorEl.querySelector(".mcp-runner")) return; // already open
    const runner = document.createElement("div");
    runner.className = "mcp-runner";
    runner.innerHTML = `
      <textarea class="mcp-runner-args" placeholder="Arguments as JSON, e.g. {}" rows="2">{}</textarea>
      <button type="button" class="mcp-runner-run">Run ${escapeHtml(toolName)}</button>
    `;
    anchorEl.appendChild(runner);
    const runButton = runner.querySelector(".mcp-runner-run");
    runButton.addEventListener("click", async () => {
      const argsEl = runner.querySelector(".mcp-runner-args");
      let args;
      try {
        args = JSON.parse(argsEl.value || "{}");
      } catch {
        argsEl.style.borderColor = "var(--red-10)";
        return;
      }
      mcpPopover.hidden = true;
      runButton.disabled = true;
      runButton.textContent = `Running ${toolName}…`;
      addMsg(`Running MCP tool ${toolName}…`, "system");
      try {
        const result = await api("/mcp/tools/call", { method: "POST", body: JSON.stringify({ tool: toolName, arguments: args }) });
        const content = Array.isArray(result.content)
          ? result.content.map((part) => {
              if (part?.type === "text") return part.text ?? "";
              if (part?.type === "image") return "[Image result omitted from text view]";
              if (part?.type === "resource") return part.resource?.text ?? "[Resource result]";
              return JSON.stringify(part);
            }).filter(Boolean).join("\n")
          : typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "");
        addMsg(`[${toolName}]${result.isError ? " (error)" : ""}\n${content || "(No text content returned)"}`, "system");
      } catch (err) {
        addMsg(`[${toolName}] MCP call failed: ${err.message}`, "system");
      } finally {
        runButton.disabled = false;
        runButton.textContent = `Run ${toolName}`;
      }
    });
  }

  // ============================================================
  // Voice input add-on (AI Assistant page): records with MediaRecorder,
  // then POSTs the clip to MobiusX Cloud Gateway's /transcribe (Groq
  // Whisper — see apps/cloud-agent-gateway/src/voice.ts). Electron doesn't
  // ship Chrome's built-in SpeechRecognition web service, so a
  // browser-only Web Speech API approach reliably fails here with a
  // "network" error — this real server round-trip is what actually works.
  // ============================================================
  const micBtn = container.querySelector(".mic-btn");
  let mediaRecorder = null;
  let recordedChunks = [];

  if (cloudBaseUrl) {
    cloudApi("/transcribe/status")
      .then((status) => {
        if (!status.available) {
          micBtn.disabled = true;
          micBtn.title = `Voice input unavailable — ${status.reason}`;
        }
      })
      .catch(() => {
        // Couldn't even reach the gateway to check — leave the button
        // enabled and let an actual record attempt surface the real error,
        // rather than guessing "unavailable" from a transient failure.
      });
  } else {
    micBtn.disabled = true;
    micBtn.title = "Voice input unavailable — Cloud Agent Gateway did not start";
  }

  async function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop(); // the rest happens in onstop below
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      addMsg(`[voice input] Microphone access failed: ${err.message}`, "system");
      return;
    }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop()); // release the OS mic indicator promptly
      micBtn.classList.remove("recording");
      micBtn.disabled = true;
      micBtn.title = "Transcribing…";
      try {
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        const audio = await blobToBase64(blob);
        const { text } = await cloudApi("/transcribe", {
          method: "POST",
          body: JSON.stringify({ audio, mimeType: blob.type }),
        });
        if (text) {
          input.value = input.value ? `${input.value} ${text}` : text;
          resizeInput();
          input.focus();
        } else {
          addMsg("[voice input] No speech was recognized in that clip.", "system");
        }
      } catch (err) {
        addMsg(`[voice input] Transcription failed: ${err.message}`, "system");
      } finally {
        micBtn.disabled = false;
        micBtn.title = "Voice input";
      }
    };
    mediaRecorder.start();
    micBtn.classList.add("recording");
    micBtn.title = "Recording… click to stop";
  }

  micBtn.addEventListener("click", toggleRecording);

  // ---- Right pane: Browser / Changelog / Docs / live Generation mirror
  // (only the full-page "New Chat" instance gets this -- see opts.rightPane
  // below -- the Workspace sidebar copy already sits next to its own file
  // tree/editor/terminal, so a second browser/docs panel there would just
  // be redundant chrome). ----
  let switchRightTab = () => {};
  let revealGeneration = () => {};
  if (opts.rightPane) {
    const rightPane = document.getElementById("assistant-right-pane");
    const rightPaneHandle = document.getElementById("assistant-right-pane-handle");
    const rightTabs = document.querySelectorAll(".right-pane-tab");
    const rightPanels = {
      browser: document.getElementById("right-pane-browser"),
      changelog: document.getElementById("right-pane-changelog"),
      docs: document.getElementById("right-pane-docs"),
      generation: document.getElementById("right-pane-generation"),
    };
    const genTab = document.getElementById("right-pane-gen-tab");
    const closeBtn = document.getElementById("right-pane-close-btn");
    rightPaneToggleBtn.hidden = false;

    switchRightTab = function (name) {
      rightPane.hidden = false;
      rightPaneHandle.hidden = false;
      rightTabs.forEach((t) => t.classList.toggle("active", t.dataset.rightTab === name));
      Object.entries(rightPanels).forEach(([n, el]) => {
        if (el) el.hidden = n !== name;
      });
      if (name === "changelog" && !rightPanels.changelog.dataset.loaded) loadChangelog();
      if (name === "docs" && !rightPanels.docs.dataset.loaded) loadDocsTab();
    };
    revealGeneration = function () {
      genTab.hidden = false;
      switchRightTab("generation");
    };

    rightPaneToggleBtn.addEventListener("click", () => {
      if (rightPane.hidden) {
        switchRightTab("browser");
      } else {
        rightPane.hidden = true;
        rightPaneHandle.hidden = true;
      }
    });
    rightTabs.forEach((t) => t.addEventListener("click", () => switchRightTab(t.dataset.rightTab)));
    closeBtn.addEventListener("click", () => {
      rightPane.hidden = true;
      rightPaneHandle.hidden = true;
    });

    const browserUrlInput = document.getElementById("right-pane-browser-url");
    const browserGoBtn = document.getElementById("right-pane-browser-go");
    const webview = document.getElementById("right-pane-webview");
    function navigateBrowser() {
      let url = browserUrlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      webview.src = url;
    }
    browserGoBtn.addEventListener("click", navigateBrowser);
    browserUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") navigateBrowser();
    });

    // Changelog: real GitHub Releases for this repo (no CHANGELOG.md exists
    // in the repo -- confirmed by search -- and apps/desktop/package.json's
    // own electron-builder publish config already names this owner/repo for
    // update distribution, so this reuses that same real source rather than
    // fabricating placeholder release notes).
    async function loadChangelog() {
      const el = rightPanels.changelog;
      el.dataset.loaded = "1";
      el.innerHTML = `<div class="debug-empty">Loading releases from GitHub…</div>`;
      try {
        const res = await fetch("https://api.github.com/repos/vamsi-vandrangi/MobiusX_WDC/releases");
        if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
        const releases = await res.json();
        if (!Array.isArray(releases) || releases.length === 0) {
          el.innerHTML = `<div class="debug-empty">No GitHub releases published yet for this repo.</div>`;
          return;
        }
        el.innerHTML = releases
          .slice(0, 20)
          .map(
            (r) => `
          <div class="changelog-entry">
            <div class="changelog-entry-head">
              <span class="changelog-entry-tag">${escapeHtml(r.tag_name ?? r.name ?? "")}</span>
              <span class="changelog-entry-date">${r.published_at ? new Date(r.published_at).toLocaleDateString() : ""}</span>
            </div>
            <div class="changelog-entry-body"></div>
          </div>`,
          )
          .join("");
        el.querySelectorAll(".changelog-entry-body").forEach((bodyEl, i) => {
          renderMarkdownWithMermaid(bodyEl, releases[i].body || "_No description provided._");
        });
      } catch (err) {
        el.innerHTML = `<div class="debug-empty">Couldn't load GitHub releases: ${escapeHtml(err.message)}</div>`;
      }
    }

    // Docs: this project's own real docs/ARCHITECTURE.md, bundled into the
    // packaged app under src/renderer/docs/ -- electron-builder's "files"
    // config already includes everything under src/**/*, so this ships for
    // real rather than being a fabricated placeholder.
    async function loadDocsTab() {
      const el = rightPanels.docs;
      el.dataset.loaded = "1";
      el.innerHTML = `<div class="debug-empty">Loading…</div>`;
      try {
        const res = await fetch("docs/architecture.md");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const md = await res.text();
        el.innerHTML = "";
        renderMarkdownWithMermaid(el, md);
      } catch (err) {
        el.innerHTML = `<div class="debug-empty">Couldn't load bundled docs: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  // "New Chat" (Pillar 3): previously clicking the nav item just called
  // showView("assistant") -- a real, confirmed-by-grep gap, since nothing
  // actually reset this panel's state, so every prior conversation's feed/
  // history/attachments silently stuck around no matter how many times
  // "New Chat" was clicked. This is the real reset: a fresh thread (lazily
  // created on the next send, same as a brand-new panel), an empty feed
  // back to the same greeting a first-ever load shows, and every piece of
  // per-conversation state zeroed. Wired to the nav item below.
  // Shared by resetConversation/loadThread below -- clears every piece of
  // per-conversation UI back to a blank feed. Deliberately doesn't touch
  // currentThreadId/historyTurns: the two callers disagree on what those
  // should become next (zeroed vs. repopulated from a loaded thread).
  function clearConversationUI() {
    closeAtPopover();
    maxUsageThresholdShown = 0;
    if (attachedFiles.length) {
      attachedFiles = [];
      renderAttachChips();
    }
    input.value = "";
    resizeInput();
    multitaskBar.hidden = true;
    multitaskModesEl.querySelectorAll("input").forEach((cb) => (cb.checked = false));
    feed.innerHTML = "";
  }

  function resetConversation() {
    conversationEpoch++;
    clearConversationUI();
    currentThreadId = null;
    threadCreationPromise = null;
    historyTurns = [];
    historyProjectPath = currentProjectPath ?? null;
    showConnectBanner();
  }

  function startFreshProjectConversation(projectName) {
    resetConversation();
    addMsg(`Switched to ${projectName}. This conversation starts with fresh project context; earlier chats remain in history.`, "system");
  }

  // Thread-list/history browser (Pillar 3's final piece -- the protocol/
  // store/routes were already real; this is the first UI that actually
  // calls GET /threads/:id). Re-opens a past conversation by replaying
  // every one of its real tasks into the feed via the exact same
  // addStreamingMsg()/renderFromDetail() a live task uses, just rendered
  // already-finished instead of starting at "Working…". Also repopulates
  // historyTurns from the replayed tasks (same shape/cap runTaskForMode
  // itself maintains) so a follow-up message sent after loading actually
  // continues this conversation's real context server-side, not a blank
  // one -- "reopen" means resume, not just "look at a transcript."
  async function loadThread(threadId) {
    const loadEpoch = ++conversationEpoch;
    clearConversationUI();
    addMsg("Loading chat…", "system");
    let detail;
    try {
      detail = await cloudApi(`/threads/${threadId}`);
    } catch (err) {
      if (loadEpoch !== conversationEpoch) return;
      feed.innerHTML = "";
      addMsg(`Couldn't load this chat: ${err.message}`, "system");
      return;
    }
    if (loadEpoch !== conversationEpoch) return;
    feed.innerHTML = "";
    currentThreadId = detail.thread.id;
    threadCreationPromise = null;
    historyTurns = [];
    const taskProjectPaths = [...new Set(detail.tasks.map((task) => task.projectPath).filter(Boolean))];
    const mixedProjectHistory = taskProjectPaths.length > 1;
    historyProjectPath = mixedProjectHistory
      ? "__mixed-project-history__"
      : detail.thread.projectPath ?? taskProjectPaths[0] ?? null;
    // listTasksByThread (gateway-side) already returns tasks oldest-first
    // by createdAt -- the same order the user actually sent them in.
    for (const task of detail.tasks) {
      addMsg(task.prompt, "user");
      addStreamingMsg(feed).renderFromDetail(task, { taskProjectPath: task.projectPath });
      if (task.output?.trim()) {
        historyTurns.push({ role: "user", content: task.prompt }, { role: "assistant", content: task.output });
      }
    }
    if (historyTurns.length > MAX_HISTORY_TURNS * 2) {
      historyTurns = historyTurns.slice(-MAX_HISTORY_TURNS * 2);
    }
    if (mixedProjectHistory) {
      addMsg("This older chat includes more than one project. Its messages will not be sent as model context; start a fresh chat for the current project.", "system");
    }
    if (!detail.tasks.length) addMsg("This chat has no messages yet.", "system");
  }

  return {
    addMsg,
    // Used by the "New Project" flow to drop a freshly-created (empty)
    // project straight into Build mode with focus in the input, instead of
    // leaving the user to notice and click Build themselves.
    setMode(newMode) {
      applyPanelMode(newMode);
    },
    focusInput() {
      input.focus();
    },
    resetConversation,
    startFreshProjectConversation,
    loadThread,
  };
}

const embeddedAssistantPanel = createAssistantPanel(document.getElementById("assistant-embedded"));
const fullAssistantPanel = createAssistantPanel(document.getElementById("assistant-full"), { rightPane: true });

// ============================================================
// Chat-first shell wiring (2026 redesign) -- replaces the old Home
// page's ask-box router (Home itself is gone; #assistant-full is now
// the default view and has its own real input/mode-picker/model-select).
// ============================================================

// ---- Theme (light/dark/system) ----
// Persisted in localStorage, same lightweight pattern as Recent Projects
// below -- a cross-process (agent-settings) version can follow later if
// the theme needs to sync across this app's other surfaces.
const THEME_KEY = "mobiusx.theme"; // "light" | "dark" | absent = system
function getThemeChoice() {
  try {
    return localStorage.getItem(THEME_KEY) || "system";
  } catch {
    return "system";
  }
}
function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
  else root.removeAttribute("data-theme");
  document.querySelectorAll(".theme-picker-btn").forEach((b) => b.classList.toggle("active", b.dataset.themeChoice === choice));
  const toggleBtn = document.getElementById("theme-toggle-btn");
  if (toggleBtn) toggleBtn.textContent = choice === "light" ? "☀" : choice === "dark" ? "☾" : "◐";
  if (window.monaco) monaco.editor.setTheme(monacoThemeForAppTheme());
}

// A conversation can contain prompts and files from several projects. The
// gateway correctly replays that history to the selected model, so carrying
// it across a project switch can make a new build answer an earlier project's
// request (observed with consecutive employee-onboarding and Bosch builds).
// Start a fresh thread for both assistant panels whenever the active project
// changes; the previous thread remains available in chat history.
function resetAssistantContextsForProjectSwitch(projectPath) {
  const projectName = projectPath?.split(/[\\/]/).filter(Boolean).pop() || "this workspace";
  for (const panel of [embeddedAssistantPanel, fullAssistantPanel]) {
    panel.startFreshProjectConversation(projectName);
  }
}

function setThemeChoice(choice) {
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* private-mode / quota — non-fatal, theme just won't persist */
  }
  applyTheme(choice);
}
applyTheme(getThemeChoice());
document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(getThemeChoice()) + 1) % order.length];
  setThemeChoice(next);
});
document.querySelectorAll(".theme-picker-btn").forEach((btn) => {
  btn.addEventListener("click", () => setThemeChoice(btn.dataset.themeChoice));
});

// ---- "More" menu (topbar) — bridge to views not yet folded into the
// chat-first redesign (Workspace, Knowledge, Tasks, Debug, Changes,
// Artifacts). Reuses the existing [data-view-link] wiring below.
//
// Mirrors the user-chip-menu pattern below: the toggle button and the
// menu itself both stopPropagation() so a single click can never race
// against the document-level outside-click closer (the earlier version
// relied only on a hidden-state check in that closer, which is fragile
// -- the toggle button's own click also bubbles to document, and any
// re-render or timing quirk could leave hidden state stale so the menu
// never closes). ----
const moreMenuBtn = document.getElementById("more-menu-btn");
const moreMenuEl = document.getElementById("more-menu");
function closeMoreMenu() {
  if (!moreMenuEl || moreMenuEl.hidden) return;
  moreMenuEl.hidden = true;
  moreMenuBtn?.setAttribute("aria-expanded", "false");
}
if (moreMenuBtn && moreMenuEl) {
  moreMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = moreMenuEl.hidden;
    moreMenuEl.hidden = !willOpen;
    moreMenuBtn.setAttribute("aria-expanded", String(willOpen));
  });
  moreMenuEl.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", closeMoreMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMoreMenu();
  });
}
document.querySelectorAll("#more-menu .more-menu-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    closeMoreMenu();
  });
});

// ---- Profile menu's new entries -- Docs/Contact Us are real external
// links (openExternal is the same IPC call the rest of the app already
// uses); Create Profile/Shortcuts are marked disabled with an honest
// reason in index.html rather than wired to nothing silently. ----
document.getElementById("user-chip-menu-docs")?.addEventListener("click", () => openExternal("https://mobiusx.ai/download"));
document.getElementById("user-chip-menu-contact")?.addEventListener("click", () => openExternal("mailto:support@mobiusx.ai"));

// Short, honest "how long ago" label for a thread's updatedAt -- no
// library needed for the handful of buckets this UI actually needs.
function formatRelativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Switches to New Chat and loads a past conversation into it -- the
// thread-list/history-browser entry point (Pillar 3's final piece: the
// protocol/store/routes were already real, this is the first UI that
// actually calls GET /threads/:id and replays it). Only #assistant-full
// supports this (it's the one New Chat/Search operate on); the embedded
// sidebar instance has no thread-browser UI of its own.
function openThreadInChat(threadId) {
  showView("assistant");
  fullAssistantPanel.loadThread(threadId);
}

// ---- Global Search view -- real filter over Recent Chats (threads --
// Pillar 3's /threads store), Recent Projects (local), and live Tasks
// (GET /tasks, already real). ----
async function runGlobalSearch() {
  const input = document.getElementById("global-search-input");
  const chatsEl = document.getElementById("global-search-chats");
  const projectsEl = document.getElementById("global-search-projects");
  const tasksEl = document.getElementById("global-search-tasks");
  if (!input || !chatsEl || !projectsEl || !tasksEl) return;
  const render = async () => {
    const q = input.value.trim().toLowerCase();
    const projects = getRecents().filter((p) => !q || p.toLowerCase().includes(q));
    projectsEl.innerHTML = projects.length
      ? projects
          .map(
            (p) =>
              `<div class="recent-item" data-path="${escapeHtml(p)}"><span>${escapeHtml(p.split("/").filter(Boolean).pop() || p)}</span><span class="recent-item-path">${escapeHtml(p)}</span></div>`,
          )
          .join("")
      : "<div class='recent-empty'>No matching projects.</div>";
    projectsEl.querySelectorAll(".recent-item").forEach((el) => el.addEventListener("click", () => openProject(el.dataset.path)));

    if (!cloudBaseUrl) {
      chatsEl.innerHTML = "<div class='debug-empty'>Cloud Agent Gateway is not running.</div>";
      tasksEl.innerHTML = "<div class='debug-empty'>Cloud Agent Gateway is not running.</div>";
      return;
    }

    try {
      const { threads } = await cloudApi("/threads");
      const matches = threads.filter((t) => !q || t.title.toLowerCase().includes(q));
      // Most-recently-active first -- same ordering a chat-first app's
      // history list is expected to use, not creation order.
      matches.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      chatsEl.innerHTML = matches.length
        ? matches
            .map((t) => {
              const projectLabel = t.projectPath ? escapeHtml(t.projectPath.split("/").filter(Boolean).pop() || t.projectPath) : null;
              return `<div class="task-row" data-id="${t.id}"><div class="task-row-prompt">${escapeHtml(t.title)}</div><div class="task-row-meta"><span>${formatRelativeTime(t.updatedAt)}</span>${projectLabel ? `<span>· ${projectLabel}</span>` : ""}</div></div>`;
            })
            .join("")
        : `<div class='debug-empty'>${q ? "No matching chats." : "No chats yet — start one from New Chat."}</div>`;
      chatsEl.querySelectorAll(".task-row").forEach((el) => el.addEventListener("click", () => openThreadInChat(el.dataset.id)));
    } catch (err) {
      chatsEl.innerHTML = `<div class="debug-empty">Failed to load chats: ${escapeHtml(err.message)}</div>`;
    }

    try {
      const { tasks } = await cloudApi("/tasks");
      const matches = tasks.filter((t) => !q || t.prompt.toLowerCase().includes(q) || t.mode.toLowerCase().includes(q));
      tasksEl.innerHTML = matches.length
        ? matches
            .map(
              (t) =>
                `<div class="task-row" data-id="${t.id}"><div class="task-row-prompt">${escapeHtml(t.prompt)}</div><div class="task-row-meta"><span class="task-mode-badge">${t.mode}</span><span class="task-status ${t.status}">${t.status}</span></div></div>`,
            )
            .join("")
        : "<div class='debug-empty'>No matching tasks.</div>";
      tasksEl.querySelectorAll(".task-row").forEach((el) => el.addEventListener("click", () => showTaskDetail(el.dataset.id)));
    } catch (err) {
      tasksEl.innerHTML = `<div class="debug-empty">Failed to load tasks: ${escapeHtml(err.message)}</div>`;
    }
  };
  input.oninput = render;
  render();
}

// ============================================================
// Debug (Intelligent Debugger) view — static code search + git history.
// Deliberately NOT live trace/log analysis — see the scope note in the UI
// and docs/ARCHITECTURE.md §5.3 / §12 for why that's Phase 3, not this.
// ============================================================
const debugResultsEl = document.getElementById("debug-results");
const debugIndexStatus = document.getElementById("debug-index-status");
const debugQueryInput = document.getElementById("debug-query-input");

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function runDebugSearch() {
  const query = debugQueryInput.value.trim();
  if (!query) return;
  if (!currentProjectPath) {
    debugResultsEl.innerHTML = "<div class='debug-empty'>Open a project first.</div>";
    return;
  }

  debugResultsEl.innerHTML = "<div class='debug-empty'>Searching…</div>";
  try {
    const result = await api(`/debug/search?q=${encodeURIComponent(query)}&k=8`);
    debugIndexStatus.textContent = result.indexedJustNow
      ? `Index built just now (${result.storeSize} chunks, ${result.provider})`
      : `${result.storeSize} chunks indexed (${result.provider})`;

    if (result.hits.length === 0) {
      debugResultsEl.innerHTML = "<div class='debug-empty'>No matching code found for that description.</div>";
      return;
    }

    debugResultsEl.innerHTML = "";
    for (const hit of result.hits) {
      const card = document.createElement("div");
      card.className = "debug-hit";
      // Real relevance score from the local semantic-ish index (see
      // /debug/search) — not a fabricated "confidence" figure. Banded into
      // high/medium/low just for the badge's color, same number either way.
      const scoreBand = hit.score >= 0.7 ? "high" : hit.score >= 0.4 ? "medium" : "low";
      card.innerHTML = `
        <div class="debug-hit-head">
          <span class="debug-hit-path">${escapeHtml(hit.relPath)}:${hit.startLine}-${hit.endLine}</span>
          <span class="debug-hit-badges">
            <span class="debug-hit-kind-badge">${escapeHtml(hit.kind)}</span>
            <span class="debug-hit-score-badge ${scoreBand}">${hit.score.toFixed(2)} match</span>
          </span>
        </div>
        <pre class="debug-hit-snippet">${escapeHtml(hit.snippet)}</pre>
        <div class="debug-hit-history">
          <div class="debug-hit-history-title">Recent changes to this file</div>
          <div class="debug-hit-history-list">Loading…</div>
        </div>
      `;
      card.querySelector(".debug-hit-path").addEventListener("click", () => {
        openFile(hit.relPath);
        showView("workspace");
      });
      debugResultsEl.appendChild(card);

      // Fire-and-forget per-card history lookup so one slow/failed file doesn't block the rest.
      api(`/debug/history?path=${encodeURIComponent(hit.relPath)}&limit=5`)
        .then((history) => {
          const listEl = card.querySelector(".debug-hit-history-list");
          if (history.entries.length === 0) {
            listEl.textContent = "No history found (untracked or new file).";
            return;
          }
          listEl.innerHTML = history.entries
            .map((e) => `<div class="log-entry"><span class="log-hash">${e.hash.slice(0, 7)}</span> ${escapeHtml(e.subject)}</div>`)
            .join("");
        })
        .catch((err) => {
          card.querySelector(".debug-hit-history-list").textContent = `History unavailable: ${err.message}`;
        });
    }
  } catch (err) {
    debugResultsEl.innerHTML = `<div class='debug-empty'>Search failed: ${err.message}</div>`;
  }
}

document.getElementById("debug-search-btn").addEventListener("click", runDebugSearch);
debugQueryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runDebugSearch();
});

// ============================================================
// Error Intelligence + Debugger v2 (roadmap Phase 13, source requirement
// §19/§20) — extends the Debug view above with full-stack tracing +
// root-cause classification over Phase 12's real browser-validation
// evidence. See apps/desktop-agent/src/errorIntelligence.ts's doc comment.
// ============================================================
const CATEGORY_LABELS = {
  "frontend-runtime-error": "Frontend runtime error",
  "backend-unreachable": "Backend unreachable",
  "route-not-implemented": "Route not implemented",
  "backend-error-db-layer": "Backend error — database layer",
  "backend-error-logic": "Backend error — logic",
  "client-error": "Client error (4xx)",
  unclassified: "Unclassified",
};
const LAYER_ORDER = ["ticket", "browser", "frontend", "api", "backend", "database"];

async function runErrorIntelligence() {
  const btn = document.getElementById("error-intel-run-btn");
  const resultsEl = document.getElementById("error-intel-results");
  if (!currentProjectPath) {
    resultsEl.innerHTML = "<div class='debug-empty'>Open a project first.</div>";
    return;
  }
  btn.disabled = true;
  btn.textContent = "Tracing…";
  resultsEl.innerHTML = "<div class='debug-empty'>Driving a real browser against the running preview and correlating evidence…</div>";
  try {
    const result = await api("/debug/error-intelligence", { method: "POST" });
    if (result.overall === "no-preview-running") {
      resultsEl.innerHTML = `<div class="verify-none">${escapeHtml(result.previewUnavailableReason || "No preview is running yet.")}</div>`;
    } else if (result.overall === "no-errors-observed") {
      resultsEl.innerHTML = `<div class="verify-summary passed">✓ No errors observed at ${escapeHtml(result.previewUrl || "")} — nothing to trace.</div>`;
    } else {
      resultsEl.innerHTML = `<div class="verify-summary failed">✗ ${result.traces.length} traceable error(s) found at ${escapeHtml(result.previewUrl || "")}</div><div class="error-trace-list"></div>`;
      const listEl = resultsEl.querySelector(".error-trace-list");
      for (const trace of result.traces) {
        const card = document.createElement("div");
        card.className = "error-trace-card";
        const sortedEvidence = [...trace.evidence].sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
        card.innerHTML = `
          <div class="error-trace-head">
            <span class="error-trace-category ${escapeHtml(trace.category)}">${escapeHtml(CATEGORY_LABELS[trace.category] || trace.category)}</span>
            <span class="error-trace-confidence ${escapeHtml(trace.confidence)}">${escapeHtml(trace.confidence)} confidence</span>
            <span class="error-trace-url">${escapeHtml(trace.url)}</span>
          </div>
          <p class="error-trace-reasoning">${escapeHtml(trace.reasoning)}</p>
          <div class="error-trace-chain"></div>
        `;
        const chainEl = card.querySelector(".error-trace-chain");
        for (const ev of sortedEvidence) {
          const evEl = document.createElement("div");
          evEl.className = "error-trace-evidence";
          evEl.innerHTML = `
            <div class="error-trace-evidence-head">
              <span class="error-trace-layer-badge ${escapeHtml(ev.layer)}">${escapeHtml(ev.layer)}</span>
              <span class="error-trace-evidence-label">${escapeHtml(ev.label)}</span>
              ${ev.source ? `<span class="error-trace-evidence-source">${escapeHtml(ev.source)}${ev.line ? `:${ev.line}` : ""}</span>` : ""}
            </div>
            <pre class="error-trace-evidence-detail">${escapeHtml(ev.detail)}</pre>
          `;
          if (ev.source) {
            evEl.querySelector(".error-trace-evidence-source").addEventListener("click", () => {
              openFile(ev.source);
              showView("workspace");
            });
          }
          chainEl.appendChild(evEl);
        }
        listEl.appendChild(card);
      }
    }
  } catch (err) {
    resultsEl.innerHTML = `<div class="verify-none">Error intelligence failed to run: ${escapeHtml(err.message)}</div>`;
  }
  btn.disabled = false;
  btn.textContent = "Run full-stack trace again";
}
document.getElementById("error-intel-run-btn").addEventListener("click", runErrorIntelligence);
// ============================================================
// Debug & Fix: ticket investigation (extends Error Intelligence above
// with a developer-pasted-ticket entry point instead of a live browser
// failure). See apps/desktop-agent/src/ticketOps.ts's doc comment for
// the scope note: no live Jira/Service Desk integration -- the developer
// pastes the ticket's text in, and everything below is real correlation
// against THIS project's own evidence, never sent to a ticket system.
// ============================================================
const ticketTextInput = document.getElementById("ticket-text-input");
const ticketInvestigateBtn = document.getElementById("ticket-investigate-btn");
const ticketResultsEl = document.getElementById("ticket-investigation-results");

const TICKET_CATEGORY_LABELS = Object.assign({ "insufficient-evidence": "Insufficient evidence" }, CATEGORY_LABELS);

function renderEvidenceChain(container, evidence) {
  const sorted = [...evidence].sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
  for (const ev of sorted) {
    const evEl = document.createElement("div");
    evEl.className = "error-trace-evidence";
    evEl.innerHTML = `
      <div class="error-trace-evidence-head">
        <span class="error-trace-layer-badge ${escapeHtml(ev.layer)}">${escapeHtml(ev.layer)}</span>
        <span class="error-trace-evidence-label">${escapeHtml(ev.label)}</span>
        ${ev.source ? `<span class="error-trace-evidence-source">${escapeHtml(ev.source)}${ev.line ? `:${ev.line}` : ""}</span>` : ""}
      </div>
      <pre class="error-trace-evidence-detail">${escapeHtml(ev.detail)}</pre>
    `;
    if (ev.source) {
      evEl.querySelector(".error-trace-evidence-source").addEventListener("click", () => {
        openFile(ev.source);
        showView("workspace");
      });
    }
    container.appendChild(evEl);
  }
}

function renderTicketInvestigation(report) {
  const { ticket, category, confidence, reasoning, evidence, relevantFiles, knowledgeHits, livePreviewCorroboration } = report;

  ticketResultsEl.innerHTML = `
    <div class="ticket-report-head">
      ${ticket.ticketId ? `<span class="ticket-id-badge">${escapeHtml(ticket.ticketId)}</span>` : ""}
      <span class="error-trace-category ${escapeHtml(category)}">${escapeHtml(TICKET_CATEGORY_LABELS[category] || category)}</span>
      <span class="error-trace-confidence ${escapeHtml(confidence)}">${escapeHtml(confidence)} confidence</span>
      ${livePreviewCorroboration ? '<span class="ticket-live-badge">corroborated by live preview</span>' : ""}
    </div>
    ${ticket.title ? `<div class="ticket-title">${escapeHtml(ticket.title)}</div>` : ""}
    <p class="error-trace-reasoning">${escapeHtml(reasoning)}</p>
    <div class="error-trace-chain" id="ticket-evidence-chain"></div>
    <div class="ticket-relevant-files"></div>
    <div class="ticket-knowledge-hits"></div>
    <div class="ticket-generate-fix"></div>
  `;

  renderEvidenceChain(ticketResultsEl.querySelector("#ticket-evidence-chain"), evidence);

  const filesEl = ticketResultsEl.querySelector(".ticket-relevant-files");
  if (relevantFiles.length > 0) {
    const title = document.createElement("div");
    title.className = "ticket-section-title";
    title.textContent = "Relevant files (semantic search over the ticket text)";
    filesEl.appendChild(title);
    for (const hit of relevantFiles) {
      const scoreBand = hit.score >= 0.7 ? "high" : hit.score >= 0.4 ? "medium" : "low";
      const card = document.createElement("div");
      card.className = "debug-hit";
      card.innerHTML = `
        <div class="debug-hit-head">
          <span class="debug-hit-path">${escapeHtml(hit.relPath)}:${hit.startLine}-${hit.endLine}</span>
          <span class="debug-hit-badges">
            <span class="debug-hit-kind-badge">${escapeHtml(hit.kind)}</span>
            <span class="debug-hit-score-badge ${scoreBand}">${hit.score.toFixed(2)} match</span>
          </span>
        </div>
        <pre class="debug-hit-snippet">${escapeHtml(hit.snippet)}</pre>
      `;
      card.querySelector(".debug-hit-path").addEventListener("click", () => {
        openFile(hit.relPath);
        showView("workspace");
      });
      filesEl.appendChild(card);
    }
  }

  const knowledgeEl = ticketResultsEl.querySelector(".ticket-knowledge-hits");
  if (knowledgeHits.length > 0) {
    const title = document.createElement("div");
    title.className = "ticket-section-title";
    title.textContent = "Enterprise Knowledge";
    knowledgeEl.appendChild(title);
    for (const hit of knowledgeHits) {
      const card = document.createElement("div");
      card.className = "debug-hit";
      card.innerHTML = `
        <div class="debug-hit-head">
          <span class="debug-hit-path">${escapeHtml(hit.sourceLabel)} — ${escapeHtml(hit.relPath)}${hit.heading ? ` — ${escapeHtml(hit.heading)}` : ""}</span>
          <span class="debug-hit-badges"><span class="debug-hit-score-badge ${hit.score >= 0.7 ? "high" : hit.score >= 0.4 ? "medium" : "low"}">${hit.score.toFixed(2)} match</span></span>
        </div>
        <pre class="debug-hit-snippet">${escapeHtml(hit.snippet)}</pre>
      `;
      knowledgeEl.appendChild(card);
    }
  }

  const fixEl = ticketResultsEl.querySelector(".ticket-generate-fix");
  fixEl.innerHTML = `<button id="ticket-generate-fix-btn" class="refresh-btn">Generate Fix</button><div class="ticket-fix-results"></div>`;
  const fixBtn = fixEl.querySelector("#ticket-generate-fix-btn");
  const fixResultsEl = fixEl.querySelector(".ticket-fix-results");
  fixBtn.addEventListener("click", () => generateFixFromTicket(report, fixResultsEl, fixBtn));
}

async function runTicketInvestigation() {
  const ticketText = ticketTextInput.value.trim();
  if (!ticketText) return;
  if (!currentProjectPath) {
    ticketResultsEl.innerHTML = "<div class='debug-empty'>Open a project first.</div>";
    return;
  }
  ticketInvestigateBtn.disabled = true;
  ticketInvestigateBtn.textContent = "Investigating…";
  ticketResultsEl.innerHTML = "<div class='debug-empty'>Correlating the ticket against this project's real evidence…</div>";
  try {
    const report = await api("/debug/ticket-investigate", { method: "POST", body: JSON.stringify({ ticketText }) });
    renderTicketInvestigation(report);
  } catch (err) {
    ticketResultsEl.innerHTML = `<div class="verify-none">Ticket investigation failed: ${escapeHtml(err.message)}</div>`;
  }
  ticketInvestigateBtn.disabled = false;
  ticketInvestigateBtn.textContent = "Investigate ticket";
}

// Autonomous Build/Test/Fix Loop (roadmap Phase 6), triggered from a
// ticket instead of a failing verification step -- reuses the exact same
// mode:"fix" task pipeline and buildEditsCard() rendering diagnoseBtn's
// handler uses (see buildEditsCard's own diagnoseBtn listener), grounded
// in the ticket's raw text plus this investigation's own cited evidence
// (matched route/file, reasoning) so the model sees both the developer's
// words and what the ticket investigation already found, rather than re-deriving it alone.
async function generateFixFromTicket(report, resultsEl, triggerBtn) {
  if (!currentProjectPath || !cloudBaseUrl) return;
  triggerBtn.disabled = true;
  triggerBtn.textContent = "Generating fix…";
  const pendingEl = document.createElement("div");
  pendingEl.className = "verify-pending";
  pendingEl.textContent = "Drafting a fix grounded in the ticket and the investigation above…";
  resultsEl.appendChild(pendingEl);
  try {
    const { ticket, reasoning, category } = report;
    const focusFiles = report.evidence.filter((e) => e.source).map((e) => `${e.source}${e.line ? `:${e.line}` : ""}`);
    const searchText = `${ticket.title ?? ""}\n${ticket.rawText}`.slice(0, 2000);
    const { hits: relevantFiles, storeSize: indexedChunkCount } = await findRelevantFiles(searchText || "ticket fix", "fix");
    const [steeringContext, assistantMemoryContext] = await Promise.all([fetchSteeringContext(), fetchAssistantMemoryContext()]);
    const promptParts = [
      `Fix the issue described in this support ticket${ticket.ticketId ? ` (${ticket.ticketId})` : ""}${ticket.title ? `: ${ticket.title}` : ""}.`,
      "",
      "--- Ticket text (as pasted by the developer) ---",
      ticket.rawText,
      "",
      "--- Debug & Fix investigation findings ---",
      `Category: ${category}`,
      reasoning,
      focusFiles.length > 0 ? `Files already cited as evidence by the investigation above: ${focusFiles.join(", ")}` : "",
    ].filter(Boolean);
    const prompt = promptParts.join("\n");
    const { task } = await cloudApi("/tasks", {
      method: "POST",
      body: JSON.stringify({
        mode: "fix",
        prompt,
        projectContext: {
          projectPath: currentProjectPath,
          relevantFiles,
          indexedChunkCount,
          ...(steeringContext ? { steeringContext } : {}),
          ...(assistantMemoryContext ? { assistantMemoryContext } : {}),
        },
      }),
    });
    let detail = await cloudApi(`/tasks/${task.id}`);
    if (detail.status === "queued" || detail.status === "running") {
      const refresh = async () => {
        detail = await cloudApi(`/tasks/${task.id}`);
      };
      await streamTask(task.id, { onEdits: refresh, onStatus: refresh, onError: refresh, onOutput: refresh, onStep: refresh, onReview: refresh });
      // Same "done" race documented on diagnoseBtn's handler above -- one
      // guaranteed-fresh fetch after the WS closes rather than trusting
      // whichever refresh() happened to land last.
      detail = await cloudApi(`/tasks/${task.id}`);
    }
    pendingEl.remove();
    const prefix = document.createElement("div");
    prefix.className = "verify-pending";
    prefix.textContent = `[runner: ${detail.runner}${detail.model ? " / " + detail.model : ""}]${detail.modelNote ? ` — ${detail.modelNote}` : ""}`;
    resultsEl.appendChild(prefix);
    if (detail.edits && detail.edits.length > 0) {
      const card = buildEditsCard(detail.edits, detail.projectPath, detail.review);
      resultsEl.appendChild(card);
    } else {
      const none = document.createElement("div");
      none.className = "verify-none";
      none.textContent = detail.output?.trim()
        ? `No concrete fix was proposed. Runner said: ${detail.output.trim().slice(0, 400)}`
        : "No concrete fix was proposed.";
      resultsEl.appendChild(none);
    }
  } catch (err) {
    pendingEl.textContent = `Generate Fix failed: ${err.message}`;
  }
  triggerBtn.disabled = false;
  triggerBtn.textContent = "Generate Fix again";
}

ticketInvestigateBtn.addEventListener("click", runTicketInvestigation);
ticketTextInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runTicketInvestigation();
});


// ============================================================
// Project Completion Contract (roadmap Phase 6, source requirement §31):
// GET /completion returns a real, computed report of what's actually
// verifiable about the open project right now -- see
// apps/desktop-agent/src/completion.ts's doc comment for exactly which
// criteria are measured vs honestly reported "not_configured". This is a
// pull-on-demand panel (no auto-refresh) since computing it re-runs the
// project's verification steps.
// ============================================================
const completionCheckBtn = document.getElementById("completion-check-btn");
const completionResultsEl = document.getElementById("completion-results");

function renderCompletionReport(report, targetEl = completionResultsEl) {
  const overallLabel = { verified: "Verified", in_progress: "In progress", not_started: "Not started", unknown: "Unknown" }[report.overall] || report.overall;
  const rows = report.criteria
    .map((c) => {
      const icon = c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "○";
      return `
        <div class="completion-criterion ${c.status}">
          <span class="completion-criterion-status ${c.status}">${icon}</span>
          <span class="completion-criterion-label">${escapeHtml(c.label)}</span>
          ${c.detail ? `<span class="completion-criterion-detail">${escapeHtml(c.detail)}</span>` : ""}
        </div>`;
    })
    .join("");
  targetEl.innerHTML = `
    <div class="completion-summary ${report.overall}">${overallLabel} — ${report.completionPercent}% of measured criteria pass</div>
    <div class="completion-criteria">${rows}</div>
    <div class="completion-meta">Generated ${new Date(report.generatedAt).toLocaleString()} · written to .mobiusx/PROJECT_COMPLETION.json</div>
  `;
}

completionCheckBtn?.addEventListener("click", async () => {
  completionCheckBtn.disabled = true;
  completionCheckBtn.textContent = "Checking…";
  completionResultsEl.innerHTML = `<div class="verify-pending">Computing the completion report (re-runs verification)…</div>`;
  try {
    const report = await api("/completion");
    renderCompletionReport(report);
  } catch (err) {
    completionResultsEl.innerHTML = `<div class="verify-none">Completion check failed: ${escapeHtml(err.message)}</div>`;
  }
  completionCheckBtn.disabled = false;
  completionCheckBtn.textContent = "Check completion";
});

// ============================================================
// Database Engineering (roadmap Phase 8, source requirement §8): GET
// /db/consistency runs a real cross-check between the project's SQL
// schema/migration source(s) and its ORM model file(s) -- see dbOps.ts's
// doc comment for exactly what's parsed (v1: Python SQLModel/SQLAlchemy
// only) and what's honestly left unrecognized rather than guessed.
// ============================================================
const dbConsistencyCheckBtn = document.getElementById("db-consistency-check-btn");
const dbConsistencyResultsEl = document.getElementById("db-consistency-results");

const DB_OVERALL_LABELS = { consistent: "Consistent", mismatches_found: "Mismatches found", unknown: "Not enough to cross-check yet" };

function renderDbConsistencyReport(report) {
  const mismatchRows = report.mismatches
    .map(
      (m) => `
        <div class="completion-criterion fail">
          <span class="completion-criterion-status fail">✗</span>
          <span class="completion-criterion-label">${escapeHtml(m.tableName)}</span>
          <span class="completion-criterion-detail">${escapeHtml(m.detail)}</span>
        </div>`,
    )
    .join("");
  const schemaList = report.schemaTables.length
    ? report.schemaTables.map((t) => `${escapeHtml(t.name)} <span class="context-row-loc">(${escapeHtml(t.source)}:${t.line})</span>`).join(", ")
    : "None found";
  const ormList = report.ormEntities.length
    ? report.ormEntities.map((e) => `${escapeHtml(e.name)} → "${escapeHtml(e.tableName)}" <span class="context-row-loc">(${escapeHtml(e.source)}:${e.line})</span>`).join(", ")
    : "None found";
  dbConsistencyResultsEl.innerHTML = `
    <div class="completion-summary ${report.overall}">${DB_OVERALL_LABELS[report.overall] || report.overall}${report.mismatches.length > 0 ? ` — ${report.mismatches.length} issue${report.mismatches.length === 1 ? "" : "s"}` : ""}</div>
    ${report.mismatches.length > 0 ? `<div class="completion-criteria">${mismatchRows}</div>` : ""}
    <div class="context-rows" style="margin-top:8px;">
      <div class="context-row"><span class="context-row-label">Schema tables</span><span class="context-row-value">${schemaList}</span></div>
      <div class="context-row"><span class="context-row-label">ORM entities</span><span class="context-row-value">${ormList}</span></div>
      <div class="context-row"><span class="context-row-label">ORM convention recognized</span><span class="context-row-value">${report.ormDetected ? escapeHtml(report.ormDetected) : "None (Python SQLModel/SQLAlchemy is the only convention this v1 recognizes)"}</span></div>
    </div>
    <div class="completion-meta">Generated ${new Date(report.generatedAt).toLocaleString()}</div>
  `;
}

dbConsistencyCheckBtn?.addEventListener("click", async () => {
  dbConsistencyCheckBtn.disabled = true;
  dbConsistencyCheckBtn.textContent = "Checking…";
  dbConsistencyResultsEl.innerHTML = `<div class="verify-pending">Scanning for schema sources and ORM model files…</div>`;
  try {
    const report = await api("/db/consistency");
    renderDbConsistencyReport(report);
  } catch (err) {
    dbConsistencyResultsEl.innerHTML = `<div class="verify-none">Consistency check failed: ${escapeHtml(err.message)}</div>`;
  }
  dbConsistencyCheckBtn.disabled = false;
  dbConsistencyCheckBtn.textContent = "Check consistency";
});

// ============================================================
// Testing Engine (roadmap Phase 10, source requirement §15): GET
// /testing-evidence surfaces the exact evidence bundle Testing mode's
// prompt is grounded in (apps/desktop-agent/src/testingContext.ts) -- this
// project's real detected test framework(s) (reusing Phase 7's own
// detection) and up to a couple of real existing test files found by
// filename convention. Shown here so it's inspectable before asking for
// generated tests, same as Database Consistency and Completion above.
// ============================================================
const testingEvidenceCheckBtn = document.getElementById("testing-evidence-check-btn");
const testingEvidenceResultsEl = document.getElementById("testing-evidence-results");

function renderTestingEvidenceReport(evidence) {
  const frameworkRows = evidence.testFrameworks.length
    ? evidence.testFrameworks.map((f) => `${escapeHtml(f.name)} <span class="context-row-loc">(${escapeHtml(f.location)}/ — ${escapeHtml(f.evidence)})</span>`).join(", ")
    : "None detected";
  const testFileList = evidence.existingTestFiles.length
    ? evidence.existingTestFiles.map((t) => escapeHtml(t.relPath)).join(", ")
    : "None found";
  testingEvidenceResultsEl.innerHTML = `
    <div class="completion-summary ${evidence.testFrameworks.length ? "consistent" : "unknown"}">${evidence.testFrameworks.length ? `${evidence.testFrameworks.length} test framework${evidence.testFrameworks.length === 1 ? "" : "s"} detected` : "No test framework detected"}</div>
    <div class="context-rows" style="margin-top:8px;">
      <div class="context-row"><span class="context-row-label">Test framework(s)</span><span class="context-row-value">${frameworkRows}</span></div>
      <div class="context-row"><span class="context-row-label">Existing test file(s) found</span><span class="context-row-value">${testFileList}</span></div>
    </div>
    <div class="completion-meta">Generated ${new Date(evidence.generatedAt).toLocaleString()}</div>
  `;
}

testingEvidenceCheckBtn?.addEventListener("click", async () => {
  testingEvidenceCheckBtn.disabled = true;
  testingEvidenceCheckBtn.textContent = "Checking…";
  testingEvidenceResultsEl.innerHTML = `<div class="verify-pending">Scanning for test frameworks and existing test files…</div>`;
  try {
    const evidence = await api("/testing-evidence");
    renderTestingEvidenceReport(evidence);
  } catch (err) {
    testingEvidenceResultsEl.innerHTML = `<div class="verify-none">Testing evidence check failed: ${escapeHtml(err.message)}</div>`;
  }
  testingEvidenceCheckBtn.disabled = false;
  testingEvidenceCheckBtn.textContent = "Check testing evidence";
});

// ============================================================
// DevOps/Infrastructure Generation (roadmap Phase 14, source requirement
// §21): GET /devops-evidence surfaces the exact evidence bundle DevOps
// mode's prompt is grounded in (apps/desktop-agent/src/devopsContext.ts)
// -- this project's real detected frontend/backend components, any infra
// file it already has, and its own real build/test/lint commands. Shown
// here so it's inspectable before asking for generated Dockerfiles/
// compose/CI, same transparency precedent as Database Consistency,
// Architecture Evidence, and Testing Evidence above.
// ============================================================
const devopsEvidenceCheckBtn = document.getElementById("devops-evidence-check-btn");
const devopsEvidenceResultsEl = document.getElementById("devops-evidence-results");

function renderDevopsEvidenceReport(evidence) {
  const svcComponents = evidence.projectContext.components.filter((c) => c.category === "frontend" || c.category === "backend" || c.category === "database");
  const svcRows = svcComponents.length
    ? svcComponents.map((c) => `${escapeHtml(c.name)} <span class="context-row-loc">(${escapeHtml(c.category)}, ${escapeHtml(c.location)}/)</span>`).join(", ")
    : "None detected";
  const infraList = evidence.existingInfraFiles.length
    ? evidence.existingInfraFiles.map((f) => escapeHtml(f.relPath)).join(", ")
    : "None found";
  const stepsList = evidence.verificationSteps.length
    ? evidence.verificationSteps.map((s) => `${escapeHtml(s.label)} <span class="context-row-loc">(${escapeHtml(s.cwd)}/)</span>`).join(", ")
    : "None detected";
  devopsEvidenceResultsEl.innerHTML = `
    <div class="completion-summary ${svcComponents.length ? "consistent" : "unknown"}">${svcComponents.length ? `${svcComponents.length} containerizable component${svcComponents.length === 1 ? "" : "s"} detected` : "No frontend/backend/database component detected"}</div>
    <div class="context-rows" style="margin-top:8px;">
      <div class="context-row"><span class="context-row-label">Detected components</span><span class="context-row-value">${svcRows}</span></div>
      <div class="context-row"><span class="context-row-label">Existing infra file(s) found</span><span class="context-row-value">${infraList}</span></div>
      <div class="context-row"><span class="context-row-label">Real verification command(s)</span><span class="context-row-value">${stepsList}</span></div>
    </div>
    <div class="completion-meta">Generated ${new Date(evidence.generatedAt).toLocaleString()}</div>
  `;
}

devopsEvidenceCheckBtn?.addEventListener("click", async () => {
  devopsEvidenceCheckBtn.disabled = true;
  devopsEvidenceCheckBtn.textContent = "Checking…";
  devopsEvidenceResultsEl.innerHTML = `<div class="verify-pending">Scanning for containerizable components, existing infra files, and verification commands…</div>`;
  try {
    const evidence = await api("/devops-evidence");
    renderDevopsEvidenceReport(evidence);
  } catch (err) {
    devopsEvidenceResultsEl.innerHTML = `<div class="verify-none">DevOps evidence check failed: ${escapeHtml(err.message)}</div>`;
  }
  devopsEvidenceCheckBtn.disabled = false;
  devopsEvidenceCheckBtn.textContent = "Check devops evidence";
});

// ============================================================
// Auth/RBAC Engineering (roadmap Phase 19, source requirement §12):
// GET /auth-evidence surfaces the exact evidence bundle Auth mode's
// prompt is grounded in (apps/desktop-agent/src/authContext.ts) -- this
// project's real detected auth library (if any), its real detected
// backend location(s), and any existing auth-shaped file found. Same
// transparency precedent as Testing Evidence and DevOps Evidence above.
// ============================================================
const authEvidenceCheckBtn = document.getElementById("auth-evidence-check-btn");
const authEvidenceResultsEl = document.getElementById("auth-evidence-results");

function renderAuthEvidenceReport(evidence) {
  const authRows = evidence.authComponents.length
    ? evidence.authComponents.map((c) => `${escapeHtml(c.name)} <span class="context-row-loc">(${escapeHtml(c.location)}/ — ${escapeHtml(c.evidence)})</span>`).join(", ")
    : "None detected";
  const backendRows = evidence.backendComponents.length
    ? evidence.backendComponents.map((c) => `${escapeHtml(c.name)} <span class="context-row-loc">(${escapeHtml(c.location)}/)</span>`).join(", ")
    : "None detected";
  const fileList = evidence.existingAuthFiles.length
    ? evidence.existingAuthFiles.map((f) => escapeHtml(f.relPath)).join(", ")
    : "None found";
  authEvidenceResultsEl.innerHTML = `
    <div class="completion-summary ${evidence.authComponents.length ? "consistent" : "unknown"}">${evidence.authComponents.length ? `${evidence.authComponents.length} auth dependenc${evidence.authComponents.length === 1 ? "y" : "ies"} detected` : "No auth dependency detected"}</div>
    <div class="context-rows" style="margin-top:8px;">
      <div class="context-row"><span class="context-row-label">Auth dependenc(ies)</span><span class="context-row-value">${authRows}</span></div>
      <div class="context-row"><span class="context-row-label">Backend component(s)</span><span class="context-row-value">${backendRows}</span></div>
      <div class="context-row"><span class="context-row-label">Existing auth-shaped file(s) found</span><span class="context-row-value">${fileList}</span></div>
    </div>
    <div class="completion-meta">Generated ${new Date(evidence.generatedAt).toLocaleString()}</div>
  `;
}

authEvidenceCheckBtn?.addEventListener("click", async () => {
  authEvidenceCheckBtn.disabled = true;
  authEvidenceCheckBtn.textContent = "Checking…";
  authEvidenceResultsEl.innerHTML = `<div class="verify-pending">Scanning for auth dependencies, backend components, and existing auth files…</div>`;
  try {
    const evidence = await api("/auth-evidence");
    renderAuthEvidenceReport(evidence);
  } catch (err) {
    authEvidenceResultsEl.innerHTML = `<div class="verify-none">Auth evidence check failed: ${escapeHtml(err.message)}</div>`;
  }
  authEvidenceCheckBtn.disabled = false;
  authEvidenceCheckBtn.textContent = "Check auth evidence";
});

// ============================================================
// Security Scanning Engine (roadmap Phase 20, source requirement §15):
// POST /security-scan runs a real, bounded pattern scan (reusing
// packages/secret-scan's own detector, plus a small set of additional
// high-signal patterns -- see apps/desktop-agent/src/securityScan.ts)
// across the whole project, plus a best-effort npm/pip dependency audit.
// Unlike the evidence panels above this has a real side effect (a
// "security-scan" audit-log entry) that completion.ts's
// security_scan_clean criterion reads back as a cache -- same POST
// pattern "Run browser validation" already established for e2e_tests_pass.
// ============================================================
const securityScanRunBtn = document.getElementById("security-scan-run-btn");
const securityScanResultsEl = document.getElementById("security-scan-results");

function renderSecurityScanReport(report) {
  const totalVulns = report.dependencyAudits.reduce((sum, a) => sum + (a.vulnerabilityCount ?? 0), 0);
  const clean = report.patternFindings.length === 0 && totalVulns === 0;
  const findingRows = report.patternFindings.length
    ? report.patternFindings.map((f) => `<div class="audit-entry ${f.severity === "high" ? "warning" : "info"}"><div class="audit-entry-head"><span class="audit-entry-category">${escapeHtml(f.severity)}</span></div><div class="audit-entry-summary">${escapeHtml(f.description)} — <code>${escapeHtml(f.relPath)}</code></div></div>`).join("")
    : `<div class="recent-empty">No pattern findings.</div>`;
  const auditRows = report.dependencyAudits.length
    ? report.dependencyAudits.map((a) => `<div class="context-row"><span class="context-row-label">${escapeHtml(a.ecosystem)} (${escapeHtml(a.location)}/)</span><span class="context-row-value">${escapeHtml(a.summary)}</span></div>`).join("")
    : `<div class="context-row"><span class="context-row-value">No JS/Python dependency manifest detected to audit.</span></div>`;
  securityScanResultsEl.innerHTML = `
    <div class="completion-summary ${clean ? "consistent" : "unknown"}">${clean ? "Clean — no pattern findings or known dependency vulnerabilities" : `${report.patternFindings.length} pattern finding(s), ${totalVulns} dependency vulnerabilit${totalVulns === 1 ? "y" : "ies"}`}</div>
    <div style="margin-top:8px;">${findingRows}</div>
    <div class="context-rows" style="margin-top:8px;">${auditRows}</div>
    <div class="completion-meta">Scanned ${report.filesScanned} file(s) — generated ${new Date(report.generatedAt).toLocaleString()}. Bounded pattern scan, not a comprehensive SAST guarantee.</div>
  `;
}

securityScanRunBtn?.addEventListener("click", async () => {
  securityScanRunBtn.disabled = true;
  securityScanRunBtn.textContent = "Scanning…";
  securityScanResultsEl.innerHTML = `<div class="verify-pending">Scanning source files for risky patterns and auditing dependencies (this can take up to a minute)…</div>`;
  try {
    const report = await api("/security-scan", { method: "POST" });
    renderSecurityScanReport(report);
  } catch (err) {
    securityScanResultsEl.innerHTML = `<div class="verify-none">Security scan failed: ${escapeHtml(err.message)}</div>`;
  }
  securityScanRunBtn.disabled = false;
  securityScanRunBtn.textContent = "Run security scan again";
});

// ============================================================
// Config/env-file generation (roadmap Phase 23, source requirement §13):
// GET /env-vars surfaces every real environment-variable reference found
// in this project's own source (apps/desktop-agent/src/envFileOps.ts);
// POST /env-file/generate adds any missing ones to .env.example as
// placeholder lines, never touching an already-set value.
// ============================================================
const envVarsCheckBtn = document.getElementById("env-vars-check-btn");
const envFileGenerateBtn = document.getElementById("env-file-generate-btn");
const envVarsResultsEl = document.getElementById("env-vars-results");

function renderEnvVarsList(references) {
  envVarsResultsEl.innerHTML = references.length
    ? `
      <div class="completion-summary consistent">${references.length} real environment variable reference${references.length === 1 ? "" : "s"} detected</div>
      <div class="context-rows" style="margin-top:8px;">
        ${references.map((r) => `<div class="context-row"><span class="context-row-label">${escapeHtml(r.name)}</span><span class="context-row-value">${escapeHtml(r.relPath)}</span></div>`).join("")}
      </div>
    `
    : `<div class="recent-empty">No process.env / os.environ / os.getenv references found in this project's source.</div>`;
}

envVarsCheckBtn?.addEventListener("click", async () => {
  envVarsCheckBtn.disabled = true;
  envVarsCheckBtn.textContent = "Checking…";
  envVarsResultsEl.innerHTML = `<div class="verify-pending">Scanning source files for real environment-variable references…</div>`;
  try {
    const { references } = await api("/env-vars");
    renderEnvVarsList(references);
  } catch (err) {
    envVarsResultsEl.innerHTML = `<div class="verify-none">Env var check failed: ${escapeHtml(err.message)}</div>`;
  }
  envVarsCheckBtn.disabled = false;
  envVarsCheckBtn.textContent = "Check env vars";
});

envFileGenerateBtn?.addEventListener("click", async () => {
  envFileGenerateBtn.disabled = true;
  envFileGenerateBtn.textContent = "Updating…";
  envVarsResultsEl.innerHTML = `<div class="verify-pending">Scanning and updating .env.example…</div>`;
  try {
    const result = await api("/env-file/generate", { method: "POST" });
    renderEnvVarsList(result.references);
    const banner = document.createElement("div");
    banner.className = `verify-summary ${result.wroteFile ? "passed" : "failed"}`;
    banner.textContent = result.wroteFile
      ? `Added ${result.addedKeys.length} key(s) to .env.example: ${result.addedKeys.join(", ")}`
      : ".env.example already covers every real reference detected — nothing to add.";
    envVarsResultsEl.prepend(banner);
  } catch (err) {
    envVarsResultsEl.innerHTML = `<div class="verify-none">.env.example update failed: ${escapeHtml(err.message)}</div>`;
  }
  envFileGenerateBtn.disabled = false;
  envFileGenerateBtn.textContent = "Update .env.example";
});

// ============================================================
// Tasks view — list + detail, backed by the Cloud Agent Gateway.
// ============================================================
let activeTaskId = null;
// Which Task Details tab is showing — persisted across the repeated
// renderTaskDetail() re-renders a streaming task triggers (see showTaskDetail),
// and reset to "overview" only when the user actually selects a different task.
let activeTaskTab = "overview";

function formatTaskTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatStepTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

async function loadTasksList() {
  const listEl = document.getElementById("tasks-list");
  if (!cloudBaseUrl) {
    listEl.innerHTML = "<div class='debug-empty'>Cloud Agent Gateway is not running.</div>";
    return;
  }
  try {
    const { tasks } = await cloudApi("/tasks");
    listEl.innerHTML = "";
    if (tasks.length === 0) {
      listEl.innerHTML = "<div class='debug-empty'>No tasks yet — send something from the AI Assistant panel.</div>";
      return;
    }
    for (const task of tasks) {
      const row = document.createElement("div");
      row.className = "task-row" + (task.id === activeTaskId ? " active" : "");
      row.innerHTML = `
        <div class="task-row-prompt">${escapeHtml(task.prompt)}</div>
        <div class="task-row-meta">
          <span class="task-mode-badge">${task.mode}</span>
          <span class="task-status ${task.status}">${task.status}</span>
          <span>${formatTaskTime(task.createdAt)}</span>
        </div>
      `;
      row.addEventListener("click", () => showTaskDetail(task.id));
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.innerHTML = `<div class='debug-empty'>Failed to load tasks: ${err.message}</div>`;
  }
}

async function showTaskDetail(taskId) {
  if (taskId !== activeTaskId) activeTaskTab = "overview"; // fresh selection — don't carry over e.g. "Changes" from a prior task
  activeTaskId = taskId;
  document.querySelectorAll(".task-row").forEach((el) => el.classList.remove("active"));
  const detailEl = document.getElementById("task-detail");

  try {
    const task = await cloudApi(`/tasks/${taskId}`);
    renderTaskDetail(task);

    if (task.status === "queued" || task.status === "running") {
      await streamTask(taskId, {
        onStep: async () => renderTaskDetail(await cloudApi(`/tasks/${taskId}`)),
        onOutput: async () => renderTaskDetail(await cloudApi(`/tasks/${taskId}`)),
        onEdits: async () => renderTaskDetail(await cloudApi(`/tasks/${taskId}`)),
        onReview: async () => renderTaskDetail(await cloudApi(`/tasks/${taskId}`)),
        onStatus: async () => renderTaskDetail(await cloudApi(`/tasks/${taskId}`)),
      });
      loadTasksList(); // refresh the status badge in the list once it settles
    }
  } catch (err) {
    detailEl.innerHTML = `<div class='debug-empty'>Failed to load task: ${err.message}</div>`;
  }
}

// ---- Task Details tab bodies -------------------------------------------
// Every number/timestamp below comes straight off the real TaskDetail the
// gateway returned (see packages/protocol/src/cloud.ts) — the progress ring
// is a real steps-completed fraction, the timeline uses each step's real
// startedAt/completedAt. The one thing this reference gateway genuinely
// doesn't track (token/cost usage) is called out as a labeled, disabled
// preview rather than shown with invented numbers.

function buildTaskOverviewTab(task) {
  const total = task.steps.length;
  const completed = task.steps.filter((s) => s.status === "completed").length;
  const fraction = task.status === "completed" ? 1 : total > 0 ? completed / total : 0;
  const r = 26;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - fraction);
  const ringColor =
    task.status === "failed" ? "#e0685f" : task.status === "cancelled" ? "#8a8b92" : task.status === "completed" ? "#6fcf73" : "#7c9eff";
  const startedMs = Date.parse(task.createdAt);
  const endedMs = task.status === "queued" || task.status === "running" ? Date.now() : Date.parse(task.updatedAt);
  const duration = Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : null;
  const durationText = duration === null ? "—" : duration < 60_000 ? `${Math.round(duration / 1000)}s` : `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1000)}s`;

  return `
    <div class="task-overview">
      <div class="task-progress-ring">
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r="${r}" fill="none" stroke="#232429" stroke-width="6" />
          <circle cx="36" cy="36" r="${r}" fill="none" stroke="${ringColor}" stroke-width="6"
            stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
            stroke-linecap="round" transform="rotate(-90 36 36)" />
        </svg>
        <div class="task-progress-ring-label">${total > 0 ? `${completed}/${total}` : "—"}</div>
      </div>
      <div class="task-overview-stats">
        <div class="task-overview-stat"><span>Status</span><span class="task-status ${task.status}">${task.status}</span></div>
        <div class="task-overview-stat"><span>Runner</span><span>${escapeHtml(task.runner)}</span></div>
        <div class="task-overview-stat"><span>Model</span><span>${task.model ? escapeHtml(task.model) : "—"}</span></div>
        <div class="task-overview-stat"><span>Created</span><span>${formatTaskTime(task.createdAt)}</span></div>
        <div class="task-overview-stat"><span>Elapsed</span><span>${durationText}</span></div>
        <div class="task-overview-stat"><span>Updated</span><span>${formatTaskTime(task.updatedAt)}</span></div>
        ${
          task.edits?.length
            ? `<div class="task-overview-stat"><span>Changes</span><span>${task.edits.length} file${task.edits.length === 1 ? "" : "s"} proposed${task.review ? ` · review: ${escapeHtml(task.review.verdict)}${task.review.persona && PERSONA_LABELS[task.review.persona] ? ` (${escapeHtml(PERSONA_LABELS[task.review.persona])})` : ""}` : ""}</span></div>`
            : ""
        }
      </div>
    </div>
    ${task.modelNote ? `<div class="task-model-note">${escapeHtml(task.modelNote)}</div>` : ""}
    <div class="task-usage-preview" title="This local reference gateway doesn't do token/cost accounting — a real Cloud Agent backend would report it here.">
      Token &amp; cost usage <span class="status-text">(preview — not tracked by this reference gateway)</span>
    </div>
  `;
}

function buildTaskStepsTab(task) {
  if (task.steps.length === 0) {
    return `<div class="debug-empty">No steps recorded yet.</div>`;
  }
  return `
    <div class="task-timeline">
      ${task.steps
        .map((s) => {
          const completedAt = formatStepTime(s.completedAt);
          const startedAt = formatStepTime(s.startedAt);
          const timeLabel = completedAt ?? (startedAt ? `started ${startedAt}` : "");
          return `
            <div class="task-timeline-item">
              <span class="task-step-dot ${s.status}"></span>
              <div class="task-timeline-body">
                <div class="task-timeline-label">${escapeHtml(s.label)}</div>
                ${timeLabel || (s.startedAt && s.completedAt) ? `<div class="task-timeline-time">${escapeHtml(timeLabel)}${s.startedAt && s.completedAt ? ` · ${Math.max(0, Math.round((Date.parse(s.completedAt) - Date.parse(s.startedAt)) / 1000))}s` : ""}</div>` : ""}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function buildTaskLogsTab(task) {
  const text = task.output || (task.status === "failed" ? (task.error ?? "") : "");
  if (!text) return `<div class="debug-empty">No output yet.</div>`;
  return `<pre class="task-detail-output">${escapeHtml(text)}</pre>`;
}

function buildTaskArtifactsTab() {
  return `
    <div class="task-artifacts-preview">
      Generated artifacts (specs, diagrams, docs) from this task would appear here.
      <span class="status-text">(preview — the Artifacts pipeline is Phase 3; see the Artifacts nav item)</span>
    </div>
  `;
}

function renderTaskDetail(task) {
  if (task.id !== activeTaskId) return; // a newer selection has since superseded this render
  const detailEl = document.getElementById("task-detail");
  const cancellable = task.status === "queued" || task.status === "running";
  const changesCount = task.edits?.length ?? 0;

  detailEl.innerHTML = `
    <div class="task-detail-header">
      <div class="task-row-prompt">${escapeHtml(task.prompt)}</div>
      <div class="task-row-meta">
        <span class="task-mode-badge">${task.mode}</span>
        <span class="task-status ${task.status}">${task.status}</span>
        <span>runner: ${task.runner}${task.model ? " / " + escapeHtml(task.model) : ""}</span>
        ${cancellable ? `<button class="task-cancel-btn">■ Cancel</button>` : ""}
      </div>
    </div>
    <div class="task-tabs">
      <button class="task-tab-btn" data-task-tab="overview">Overview</button>
      <button class="task-tab-btn" data-task-tab="steps">Steps${task.steps.length ? ` (${task.steps.length})` : ""}</button>
      <button class="task-tab-btn" data-task-tab="changes">Changes${changesCount ? ` (${changesCount})` : ""}</button>
      <button class="task-tab-btn" data-task-tab="logs">Logs</button>
      <button class="task-tab-btn" data-task-tab="artifacts">Artifacts</button>
    </div>
    <div class="task-tab-panel" data-task-tab-panel="overview">${buildTaskOverviewTab(task)}</div>
    <div class="task-tab-panel" data-task-tab-panel="steps">${buildTaskStepsTab(task)}</div>
    <div class="task-tab-panel" data-task-tab-panel="changes"></div>
    <div class="task-tab-panel" data-task-tab-panel="logs">${buildTaskLogsTab(task)}</div>
    <div class="task-tab-panel" data-task-tab-panel="artifacts">${buildTaskArtifactsTab()}</div>
  `;

  const changesPanel = detailEl.querySelector('[data-task-tab-panel="changes"]');
  if (task.edits?.length) {
    changesPanel.appendChild(buildEditsCard(task.edits, task.projectPath, task.review));
  } else {
    changesPanel.innerHTML = `<div class="debug-empty">No changes proposed for this task.</div>`;
  }

  detailEl.querySelectorAll(".task-tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.taskTab === activeTaskTab);
    btn.addEventListener("click", () => {
      activeTaskTab = btn.dataset.taskTab;
      detailEl.querySelectorAll(".task-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      detailEl.querySelectorAll(".task-tab-panel").forEach((p) => {
        p.hidden = p.dataset.taskTabPanel !== activeTaskTab;
      });
    });
  });
  detailEl.querySelectorAll(".task-tab-panel").forEach((p) => {
    p.hidden = p.dataset.taskTabPanel !== activeTaskTab;
  });

  if (cancellable) {
    const btn = detailEl.querySelector(".task-cancel-btn");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Cancelling…";
      try {
        await cloudApi(`/tasks/${task.id}/cancel`, { method: "POST" });
        // The in-flight streamTask() subscription in showTaskDetail() will
        // pick up the resulting "status: cancelled" event and re-render.
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Cancel failed: ${err.message}`;
      }
    });
  }
}

// ============================================================
// Settings — Phase 5 local-reference slice: the terminal command guard's
// effective policy and the shared audit log (desktop-agent + cloud-agent-
// gateway both write to it). Advisory governance, not enterprise policy
// management or a security sandbox — see the scope note in the view itself.
// ============================================================
function formatAuditTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function loadPolicy() {
  const rulesEl = document.getElementById("policy-rules");
  const noteEl = document.getElementById("policy-project-note");
  try {
    const policy = await api("/policy");
    if (policy.projectPolicyError) {
      noteEl.innerHTML = `<span class="policy-error">⚠ ${escapeHtml(policy.projectPolicyError)}</span>`;
    } else if (policy.projectPolicyPath) {
      noteEl.textContent = `Project policy loaded from ${policy.projectPolicyPath} — ${policy.project.length} extra rule(s), added on top of the built-ins below (a project can only add rules, never remove or weaken one).`;
    } else {
      noteEl.textContent = "No project .mobiusx/policy.json found — only the built-in rules below are active. A project can add its own by creating one (see docs/ARCHITECTURE.md §12).";
    }

    const allRules = [...policy.builtIn.map((r) => ({ ...r, scope: "built-in" })), ...policy.project.map((r) => ({ ...r, scope: "project" }))];
    rulesEl.innerHTML = allRules
      .map(
        (r) => `
      <div class="policy-rule">
        <span class="policy-rule-scope ${r.scope}">${r.scope}</span>
        <span class="policy-rule-id">${escapeHtml(r.id)}</span>
        <span class="policy-rule-desc">${escapeHtml(r.description)}</span>
      </div>`,
      )
      .join("");
  } catch (err) {
    rulesEl.innerHTML = `<div class="debug-empty">Failed to load policy: ${err.message}</div>`;
  }
}

// ---- Project Memory/Steering (roadmap Phase 16, source requirement §24/§25) ----
async function loadSteering() {
  const listEl = document.getElementById("steering-file-list");
  const statusEl = document.getElementById("steering-status");
  if (!currentProjectPath) {
    listEl.innerHTML = "<div class='recent-empty'>Open a project to view/edit its steering files.</div>";
    return;
  }
  try {
    const { files } = await api("/steering");
    if (files.length === 0) {
      listEl.innerHTML = "<div class='recent-empty'>No steering files yet — click \"Create default templates\" or add one below.</div>";
      return;
    }
    listEl.innerHTML = files
      .map(
        (f) => `
      <div class="steering-file" data-name="${escapeHtml(f.name)}">
        <div class="steering-file-head">
          <span class="steering-file-name">.mobiusx/steering/${escapeHtml(f.name)}.md</span>
        </div>
        <textarea class="steering-file-textarea">${escapeHtml(f.content)}</textarea>
        <div class="steering-file-actions">
          <button class="refresh-btn steering-save-btn">Save</button>
          <button class="refresh-btn steering-delete-btn">Delete</button>
        </div>
      </div>`,
      )
      .join("");
    listEl.querySelectorAll(".steering-file").forEach((fileEl) => {
      const name = fileEl.dataset.name;
      fileEl.querySelector(".steering-save-btn").addEventListener("click", async () => {
        const btn = fileEl.querySelector(".steering-save-btn");
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          const content = fileEl.querySelector(".steering-file-textarea").value;
          await api("/steering", { method: "PUT", body: JSON.stringify({ name, content }) });
          btn.textContent = "Saved ✓";
          setTimeout(() => {
            btn.textContent = "Save";
            btn.disabled = false;
          }, 1500);
        } catch (err) {
          btn.textContent = `Failed: ${err.message}`;
          btn.disabled = false;
        }
      });
      fileEl.querySelector(".steering-delete-btn").addEventListener("click", async () => {
        try {
          await api(`/steering/${encodeURIComponent(name)}`, { method: "DELETE" });
          loadSteering();
        } catch (err) {
          statusEl.textContent = `Delete failed: ${err.message}`;
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="debug-empty">Failed to load steering files: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("steering-refresh-btn")?.addEventListener("click", loadSteering);
document.getElementById("steering-scaffold-btn")?.addEventListener("click", async () => {
  if (!currentProjectPath) return;
  const btn = document.getElementById("steering-scaffold-btn");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    await api("/steering/scaffold", { method: "POST" });
    await loadSteering();
  } catch (err) {
    document.getElementById("steering-status").textContent = `Failed: ${err.message}`;
  }
  btn.disabled = false;
  btn.textContent = "Create default templates";
});
document.getElementById("steering-new-btn")?.addEventListener("click", async () => {
  if (!currentProjectPath) return;
  const input = document.getElementById("steering-new-name");
  const name = input.value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    document.getElementById("steering-status").textContent = "Name must contain only letters, numbers, hyphens, and underscores.";
    return;
  }
  try {
    await api("/steering", { method: "PUT", body: JSON.stringify({ name, content: `# ${name}\n\n` }) });
    input.value = "";
    await loadSteering();
  } catch (err) {
    document.getElementById("steering-status").textContent = `Failed: ${err.message}`;
  }
});

// ---- Assistant Memory (Oct 2026 addition) ----
// Mirrors the Project Steering block directly above -- same list/edit/
// save/delete UI pattern -- with one real difference: no currentProjectPath
// guard anywhere here, since memory is global, not tied to whichever
// project (if any) happens to be open.
async function loadMemory() {
  const listEl = document.getElementById("memory-file-list");
  const statusEl = document.getElementById("memory-status");
  try {
    const { files } = await api("/memory");
    if (files.length === 0) {
      listEl.innerHTML = "<div class='recent-empty'>No memory yet — click \"Create default templates\" or add one below. Memory is written here either by you directly, or automatically after a task when Memory Mode (below) is set to Automatic.</div>";
      return;
    }
    listEl.innerHTML = files
      .map(
        (f) => `
      <div class="steering-file memory-file" data-name="${escapeHtml(f.name)}">
        <div class="steering-file-head">
          <span class="steering-file-name">memory/${escapeHtml(f.name)}.md</span>
        </div>
        <textarea class="steering-file-textarea memory-file-textarea">${escapeHtml(f.content)}</textarea>
        <div class="steering-file-actions">
          <button class="refresh-btn memory-save-btn">Save</button>
          <button class="refresh-btn memory-delete-btn">Delete</button>
        </div>
      </div>`,
      )
      .join("");
    listEl.querySelectorAll(".memory-file").forEach((fileEl) => {
      const name = fileEl.dataset.name;
      fileEl.querySelector(".memory-save-btn").addEventListener("click", async () => {
        const btn = fileEl.querySelector(".memory-save-btn");
        btn.disabled = true;
        btn.textContent = "Saving…";
        try {
          const content = fileEl.querySelector(".memory-file-textarea").value;
          await api("/memory", { method: "PUT", body: JSON.stringify({ name, content }) });
          btn.textContent = "Saved ✓";
          setTimeout(() => {
            btn.textContent = "Save";
            btn.disabled = false;
          }, 1500);
        } catch (err) {
          btn.textContent = `Failed: ${err.message}`;
          btn.disabled = false;
        }
      });
      fileEl.querySelector(".memory-delete-btn").addEventListener("click", async () => {
        try {
          await api(`/memory/${encodeURIComponent(name)}`, { method: "DELETE" });
          loadMemory();
        } catch (err) {
          statusEl.textContent = `Delete failed: ${err.message}`;
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="debug-empty">Failed to load memory: ${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById("memory-refresh-btn")?.addEventListener("click", loadMemory);
document.getElementById("memory-scaffold-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("memory-scaffold-btn");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    await api("/memory/scaffold", { method: "POST" });
    await loadMemory();
  } catch (err) {
    document.getElementById("memory-status").textContent = `Failed: ${err.message}`;
  }
  btn.disabled = false;
  btn.textContent = "Create default templates";
});
document.getElementById("memory-new-btn")?.addEventListener("click", async () => {
  const input = document.getElementById("memory-new-name");
  const name = input.value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    document.getElementById("memory-status").textContent = "Name must contain only letters, numbers, hyphens, and underscores.";
    return;
  }
  try {
    await api("/memory", { method: "PUT", body: JSON.stringify({ name, content: `# ${name}\n\n` }) });
    input.value = "";
    await loadMemory();
  } catch (err) {
    document.getElementById("memory-status").textContent = `Failed: ${err.message}`;
  }
});

// ---- Hooks (roadmap Phase 16, source requirement §25, event-driven) ----
async function loadHooks() {
  const listEl = document.getElementById("hooks-rule-list");
  const errorEl = document.getElementById("hooks-error");
  try {
    const { rules, error } = await api("/hooks");
    if (error) {
      errorEl.style.display = "";
      errorEl.textContent = `⚠ ${error}`;
    } else {
      errorEl.style.display = "none";
    }
    if (rules.length === 0) {
      listEl.innerHTML = "<div class='recent-empty'>No .mobiusx/hooks.json found for the open project (or none is open) — see the example above.</div>";
      return;
    }
    listEl.innerHTML = rules
      .map(
        (r) => `
      <div class="hooks-rule">
        <span class="hooks-rule-id">${escapeHtml(r.id)}</span><span class="hooks-rule-event">${escapeHtml(r.event)}</span>
        <code class="hooks-rule-cmd">${escapeHtml(r.command)}</code>
        ${r.description ? `<span class="hooks-rule-desc">${escapeHtml(r.description)}</span>` : ""}
      </div>`,
      )
      .join("");
  } catch (err) {
    listEl.innerHTML = `<div class="debug-empty">Failed to load hooks: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("hooks-refresh-btn")?.addEventListener("click", loadHooks);

// ---- MCP tool support (source requirement §28) ----
async function loadMcpServers() {
  const listEl = document.getElementById("mcp-server-list");
  const errorEl = document.getElementById("mcp-error");
  try {
    const { servers, error } = await api("/mcp/status");
    if (error) {
      errorEl.style.display = "";
      errorEl.textContent = `⚠ ${error}`;
    } else {
      errorEl.style.display = "none";
    }
    if (!servers || servers.length === 0) {
      listEl.innerHTML = "<div class='recent-empty'>No .mobiusx/mcp.json found for the open project (or none is open) — see the example above.</div>";
      return;
    }
    listEl.innerHTML = servers
      .map(
        (s) => `
      <div class="mcp-server">
        <div class="mcp-server-head">
          <span class="mcp-server-name">${escapeHtml(s.name)}</span>
          <span class="mcp-server-status ${s.connected ? "connected" : "error"}">${s.connected ? "connected" : "not connected"}</span>
        </div>
        ${s.error ? `<div class="scope-note-small">${escapeHtml(s.error)}</div>` : ""}
        ${s.tools.length > 0 ? `<div class="mcp-server-tools">${s.tools.map((t) => escapeHtml(t.toolName)).join(", ")}</div>` : ""}
      </div>`,
      )
      .join("");
  } catch (err) {
    listEl.innerHTML = `<div class="debug-empty">Failed to load MCP servers: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("mcp-refresh-btn")?.addEventListener("click", loadMcpServers);

async function loadAuditLog() {
  const el = document.getElementById("audit-log");
  el.innerHTML = "<div class='debug-empty'>Loading…</div>";
  try {
    const { entries } = await api("/audit?limit=100");
    if (entries.length === 0) {
      el.innerHTML = "<div class='debug-empty'>No audit entries yet — they'll appear here when the command guard flags something or a task's context gets redacted.</div>";
      return;
    }
    el.innerHTML = entries
      .slice()
      .reverse()
      .map(
        (e) => `
      <div class="audit-entry ${e.severity}">
        <div class="audit-entry-head">
          <span class="audit-entry-time">${formatAuditTime(e.timestamp)}</span>
          <span class="audit-entry-source">${escapeHtml(e.source)}</span>
          <span class="audit-entry-category">${escapeHtml(e.category)}</span>
        </div>
        <div class="audit-entry-summary">${escapeHtml(e.summary)}</div>
      </div>`,
      )
      .join("");
  } catch (err) {
    el.innerHTML = `<div class="debug-empty">Failed to load audit log: ${err.message}</div>`;
  }
}

// ---- Default AI Model (multi-model support) ----
const defaultModelSelectEl = document.getElementById("default-model-select");
const defaultModelStatusEl = document.getElementById("default-model-status");

async function loadDefaultModelSettings() {
  try {
    const settings = await api("/settings");
    const selectedValue = settings.defaultModel ? JSON.stringify(settings.defaultModel) : "";
    await populateModelSelect(defaultModelSelectEl, { includeAuto: true, selectedValue });
    defaultModelStatusEl.textContent = "";
  } catch (err) {
    defaultModelStatusEl.textContent = `Failed to load: ${err.message}`;
  }
}

defaultModelSelectEl.addEventListener("change", async () => {
  // "" (Auto) means: clear the standing default -- PUT { defaultModel: null }
  // explicitly, distinct from omitting the field (see @mobiusx/agent-settings's
  // SettingsPatch doc comment for why that distinction exists).
  const defaultModel = defaultModelSelectEl.value ? JSON.parse(defaultModelSelectEl.value) : null;
  defaultModelStatusEl.textContent = "Saving…";
  try {
    await api("/settings", { method: "PUT", body: JSON.stringify({ defaultModel }) });
    defaultModelStatusEl.textContent = "Saved.";
  } catch (err) {
    defaultModelStatusEl.textContent = `Failed to save: ${err.message}`;
    await loadDefaultModelSettings(); // revert the select to whatever's actually persisted
  }
});

document.getElementById("model-refresh-btn").addEventListener("click", loadDefaultModelSettings);

// ---- Per-Task-Type Model Routing (roadmap Phase 11, source §27) ----
// One row/select per real AgentMode this gateway accepts in a
// CreateTaskRequest (see AgentMode in @mobiusx/protocol) -- "fix" has no
// tab of its own in the AI Assistant panel (it's triggered by "Diagnose &
// Fix" against a real verification failure, see buildEditsCard) but is
// still a real, routable mode, so it's listed here too.
const MODEL_ROUTING_MODES = [
  { mode: "ask", label: "Ask" },
  { mode: "plan", label: "Plan" },
  { mode: "build", label: "Build" },
  { mode: "spec", label: "Spec" },
  { mode: "fix", label: "Fix" },
  { mode: "database", label: "Database" },
  { mode: "architecture", label: "Architecture" },
  { mode: "testing", label: "Testing" },
  { mode: "devops", label: "DevOps" },
  { mode: "auth", label: "Auth" },
];
const modelRoutingRowsEl = document.getElementById("model-routing-rows");
const modelRoutingStatusEl = document.getElementById("model-routing-status");

// Built once: one <select> per AgentMode, addressed by data-mode for the
// single delegated change handler below rather than 8 separate listeners.
modelRoutingRowsEl.innerHTML = MODEL_ROUTING_MODES.map(
  ({ mode, label }) => `
    <div class="model-routing-row">
      <span class="model-routing-row-label">${label}</span>
      <select class="model-select" data-mode="${mode}"></select>
    </div>
  `,
).join("");

async function loadModelRoutingSettings() {
  try {
    const settings = await api("/settings");
    const routing = settings.modelRouting ?? {};
    await Promise.all(
      MODEL_ROUTING_MODES.map(({ mode }) => {
        const selectEl = modelRoutingRowsEl.querySelector(`select[data-mode="${mode}"]`);
        const selectedValue = routing[mode] ? JSON.stringify(routing[mode]) : "";
        // "Use default" (not "Auto (recommended)") for these rows -- "" here
        // means "no routing rule for this mode", which falls through to the
        // Default AI Model select above, not straight to automatic choice.
        return populateModelSelect(selectEl, { includeAuto: true, selectedValue, autoLabel: "Use default" });
      }),
    );
    modelRoutingStatusEl.textContent = "";
  } catch (err) {
    modelRoutingStatusEl.textContent = `Failed to load: ${err.message}`;
  }
}

modelRoutingRowsEl.addEventListener("change", async (e) => {
  const selectEl = e.target.closest("select[data-mode]");
  if (!selectEl) return;
  const mode = selectEl.dataset.mode;
  // "" (Use default) clears just THIS mode's rule -- sent as null, per
  // @mobiusx/agent-settings's SettingsPatch.modelRouting doc comment: a
  // per-mode MERGE, so setting one mode to null never touches any other
  // mode's already-saved rule.
  const selection = selectEl.value ? JSON.parse(selectEl.value) : null;
  modelRoutingStatusEl.textContent = "Saving…";
  try {
    await api("/settings", { method: "PUT", body: JSON.stringify({ modelRouting: { [mode]: selection } }) });
    modelRoutingStatusEl.textContent = "Saved.";
  } catch (err) {
    modelRoutingStatusEl.textContent = `Failed to save: ${err.message}`;
    await loadModelRoutingSettings(); // revert this row (and re-sync the others) to whatever's actually persisted
  }
});

document.getElementById("model-routing-refresh-btn").addEventListener("click", loadModelRoutingSettings);

// ---- Terminal Approval (Approval Engine: guarded autonomy level) ----
const terminalApprovalModeStatusEl = document.getElementById("terminal-approval-mode-status");
const terminalApprovalModeInputs = document.querySelectorAll('input[name="terminal-approval-mode"]');

async function loadTerminalApprovalSettings() {
  try {
    const settings = await api("/settings");
    terminalApprovalModeInputs.forEach((input) => {
      input.checked = input.value === settings.terminalApprovalMode;
    });
    terminalApprovalModeStatusEl.textContent = "";
  } catch (err) {
    terminalApprovalModeStatusEl.textContent = `Failed to load: ${err.message}`;
  }
}

terminalApprovalModeInputs.forEach((input) => {
  input.addEventListener("change", async (e) => {
    if (!e.target.checked) return;
    const mode = e.target.value;
    terminalApprovalModeStatusEl.textContent = "Saving…";
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ terminalApprovalMode: mode }) });
      terminalApprovalModeStatusEl.textContent = "Saved — click “Reconnect Terminal” to apply it now.";
    } catch (err) {
      terminalApprovalModeStatusEl.textContent = `Failed to save: ${err.message}`;
      await loadTerminalApprovalSettings(); // revert the radio to whatever's actually persisted
    }
  });
});

document.getElementById("terminal-reconnect-btn").addEventListener("click", () => {
  reconnectTerminalNow();
  terminalApprovalModeStatusEl.textContent = "Reconnected.";
});

// ---- Autonomous Build/Test/Fix Loop -- "auto" mode (roadmap Phase 22) ----
const fixLoopModeStatusEl = document.getElementById("fix-loop-mode-status");
const fixLoopModeInputs = document.querySelectorAll('input[name="fix-loop-mode"]');

async function loadFixLoopModeSettings() {
  try {
    const settings = await api("/settings");
    const current = settings.fixLoopMode ?? "manual"; // absent in storage means "manual" (Phase 6's own doc comment) -- never leave every radio unchecked
    fixLoopModeInputs.forEach((input) => {
      input.checked = input.value === current;
    });
    fixLoopModeStatusEl.textContent = "";
  } catch (err) {
    fixLoopModeStatusEl.textContent = `Failed to load: ${err.message}`;
  }
}

fixLoopModeInputs.forEach((input) => {
  input.addEventListener("change", async (e) => {
    if (!e.target.checked) return;
    const mode = e.target.value;
    fixLoopModeStatusEl.textContent = "Saving…";
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ fixLoopMode: mode }) });
      fixLoopModeStatusEl.textContent = "Saved — applies to your next Apply or Diagnose & Fix action.";
    } catch (err) {
      fixLoopModeStatusEl.textContent = `Failed to save: ${err.message}`;
      await loadFixLoopModeSettings(); // revert the radio to whatever's actually persisted
    }
  });
});

// ---- Assistant Memory's automatic-extraction toggle (Oct 2026 addition) ----
// Mirrors the Autonomous Build/Test/Fix Loop toggle directly above exactly
// -- same off/auto radio shape, same "absent means off" default, same
// revert-on-failure behavior. See AgentSettings.memoryMode's doc comment.
const memoryModeStatusEl = document.getElementById("memory-mode-status");
const memoryModeInputs = document.querySelectorAll('input[name="memory-mode"]');

async function loadMemoryModeSettings() {
  try {
    const settings = await api("/settings");
    const current = settings.memoryMode ?? "off"; // absent in storage means "off" -- never leave every radio unchecked
    memoryModeInputs.forEach((input) => {
      input.checked = input.value === current;
    });
    memoryModeStatusEl.textContent = "";
  } catch (err) {
    memoryModeStatusEl.textContent = `Failed to load: ${err.message}`;
  }
}

memoryModeInputs.forEach((input) => {
  input.addEventListener("change", async (e) => {
    if (!e.target.checked) return;
    const mode = e.target.value;
    memoryModeStatusEl.textContent = "Saving…";
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ memoryMode: mode }) });
      memoryModeStatusEl.textContent = "Saved — applies to your next completed task.";
    } catch (err) {
      memoryModeStatusEl.textContent = `Failed to save: ${err.message}`;
      await loadMemoryModeSettings(); // revert the radio to whatever's actually persisted
    }
  });
});

// Settings' two sub-tabs (Workspace Settings / Application Settings) — a
// purely visual split matching the mockup's structure; both tabs' contents
// still live in the same view-settings section and share its scroll.
document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const target = btn.dataset.settingsTab;
    document.getElementById("settings-tab-workspace").hidden = target !== "workspace";
    document.getElementById("settings-tab-application").hidden = target !== "application";
  });
});

/** Workspace Settings' "Repositories" section — the one real thing that section
 * has to show, since this app has no multi-repo linking (see the Repositories
 * nav item's own placeholder view). Renders the currently open project as a
 * single real entry, or an honest empty state — never a fabricated repo list. */
function renderSettingsRepositories() {
  const el = document.getElementById("settings-repositories");
  if (!currentProjectPath) {
    el.innerHTML = "<div class='recent-empty'>No project open — open one from Home or the top bar.</div>";
    return;
  }
  const name = currentProjectPath.split("/").filter(Boolean).pop();
  el.innerHTML = `
    <div class="settings-repo-item">
      <div>
        <div class="settings-repo-name">${escapeHtml(name)} <span class="status-text">main</span></div>
        <div class="settings-repo-path">${escapeHtml(currentProjectPath)}</div>
      </div>
    </div>
  `;
}

// ============================================================
// AI Model Provider Keys ("Configure the real models") — the user's own
// API key for each real provider, typed directly into this window and
// stored via main.js's safeStorage-backed model-keys.enc (window.mobiusx.
// models, see preload.js's doc comment). One row per provider; a
// configured row shows a masked "Key saved" state (never the key itself,
// same discipline as the Connect GitHub/GitLab list above) with a Remove
// button, an unconfigured row shows a password-style input + Save.
// "ollama" is the one row with no key field at all, just an optional
// base-URL override, since a local Ollama install needs no credential.
const MODEL_KEY_PROVIDERS_UI = [
  { provider: "anthropic", label: "Anthropic (Claude)", hint: "console.anthropic.com/settings/keys", hasModel: true, modelPlaceholder: "claude-sonnet-4-5-20250929 (optional — default shown)" },
  { provider: "groq", label: "Groq", hint: "console.groq.com/keys — also powers voice dictation" },
  { provider: "openrouter", label: "OpenRouter", hint: "openrouter.ai/keys" },
  { provider: "deepseek", label: "DeepSeek", hint: "platform.deepseek.com/api_keys — paid/metered, only used when you explicitly pick it" },
  { provider: "cerebras", label: "Cerebras", hint: "cloud.cerebras.ai/platform/ — $5 free trial then metered, only used when you explicitly pick it" },
  { provider: "xkiro", label: "xKiro", hint: "xkiro.com — advertises 500K free tokens/day (1M/day with Telegram verification); prompts pass through xKiro and its upstream provider" },
  { provider: "apinex", label: "APInex", hint: "apinex.bond — advertises 1M free-category tokens/day; prompts pass through APInex and its upstream provider" },
  { provider: "ollama", label: "Ollama (local)", hint: "no key needed — only set this if Ollama isn't on the default local port", isBaseUrl: true, baseUrlPlaceholder: "http://127.0.0.1:11434" },
];
const modelKeyRowsEl = document.getElementById("model-key-rows");
const modelKeysStatusEl = document.getElementById("model-keys-status");

function renderModelKeyRow({ provider, label, hint, hasModel, modelPlaceholder, isBaseUrl, baseUrlPlaceholder }, state) {
  const configured = state?.configured;
  const valueField = isBaseUrl
    ? `<input type="text" class="model-key-input" data-field="baseUrl" placeholder="${escapeHtml(baseUrlPlaceholder || "")}" value="${configured ? escapeHtml(state.baseUrl || "") : ""}" />`
    : `<input type="password" class="model-key-input" data-field="apiKey" placeholder="${configured ? "•••••••••••• (saved — paste a new key to replace it)" : "Paste your API key"}" />`;
  return `
    <div class="model-key-row" data-provider="${provider}">
      <div class="model-key-row-head">
        <span class="model-key-row-label">${escapeHtml(label)}</span>
        <span class="model-key-row-status">${configured ? "✓ Configured" : ""}</span>
        <span class="status-text model-key-row-hint">${escapeHtml(hint)}</span>
      </div>
      <div class="model-key-row-fields">
        ${valueField}
        ${hasModel ? `<input type="text" class="model-key-input model-key-model-input" data-field="model" placeholder="${escapeHtml(modelPlaceholder || "")}" value="${escapeHtml(state?.model || "")}" />` : ""}
        <button class="refresh-btn model-key-save-btn" type="button">Save</button>
        ${provider === "ollama" ? `<button class="refresh-btn model-key-ollama-diagnose-btn" type="button">Test local</button>` : ""}
        ${configured ? `<button class="connect-git-saved-row-remove model-key-remove-btn" type="button">Remove</button>` : ""}
      </div>
      ${provider === "ollama" ? `<div class="status-text model-key-ollama-diagnostics" aria-live="polite"></div>` : ""}
    </div>
  `;
}

async function loadModelKeysSettings() {
  if (!models) return;
  try {
    const list = await models.list();
    const byProvider = Object.fromEntries(list.map((entry) => [entry.provider, entry]));
    modelKeyRowsEl.innerHTML = MODEL_KEY_PROVIDERS_UI.map((p) => renderModelKeyRow(p, byProvider[p.provider])).join("");
    modelKeysStatusEl.textContent = "";
  } catch (err) {
    modelKeysStatusEl.textContent = `Failed to load: ${err.message}`;
  }
}

modelKeyRowsEl.addEventListener("click", async (e) => {
  const rowEl = e.target.closest(".model-key-row");
  if (!rowEl) return;
  const provider = rowEl.dataset.provider;

  if (e.target.closest(".model-key-save-btn")) {
    const apiKeyInput = rowEl.querySelector('[data-field="apiKey"]');
    const baseUrlInput = rowEl.querySelector('[data-field="baseUrl"]');
    const modelInput = rowEl.querySelector('[data-field="model"]');
    const value = baseUrlInput ? { baseUrl: baseUrlInput.value } : { apiKey: apiKeyInput.value, model: modelInput?.value };
    if (!baseUrlInput && !apiKeyInput.value.trim()) return; // nothing typed — don't clobber a saved key with a blank
    modelKeysStatusEl.textContent = "Saving…";
    try {
      const result = await models.setKey(provider, value);
      if (!result?.ok) throw new Error(result?.error || "Failed to save.");
      modelKeysStatusEl.textContent = "Saved securely. Restart MobiusX to load the key into the model list.";
      await loadModelKeysSettings();
    } catch (err) {
      modelKeysStatusEl.textContent = `Failed to save: ${err.message}`;
    }
  } else if (e.target.closest(".model-key-ollama-diagnose-btn")) {
    const diagnosticsEl = rowEl.querySelector(".model-key-ollama-diagnostics");
    diagnosticsEl.textContent = "Checking the configured local endpoint from MobiusX’s model gateway…";
    try {
      const result = await cloudApi("/ollama/diagnostics");
      const installed = result.installedModels?.length ? ` Installed models: ${result.installedModels.join(", ")}.` : " No local chat models were found.";
      diagnosticsEl.textContent = `${result.detail}${installed}`;
    } catch (err) {
      diagnosticsEl.textContent = `Diagnostic failed: ${err.message}`;
    }
  } else if (e.target.closest(".model-key-remove-btn")) {
    modelKeysStatusEl.textContent = "Removing…";
    await models.clearKey(provider);
    await loadModelKeysSettings();
  }
});

function loadSettings() {
  loadPolicy();
  loadSteering();
  loadMemory();
  loadMemoryModeSettings();
  loadHooks();
  loadMcpServers();
  loadAuditLog();
  loadTerminalApprovalSettings();
  loadFixLoopModeSettings();
  loadDefaultModelSettings();
  loadModelRoutingSettings();
  loadModelKeysSettings();
  renderSettingsRepositories();
}

document.getElementById("audit-refresh-btn").addEventListener("click", loadAuditLog);

// ============================================================
// Knowledge (roadmap Phase 17, source requirement §29/§30 local
// substitute) — see knowledgeOps.ts's doc comment.
// ============================================================
async function loadKnowledgeSourceList() {
  const listEl = document.getElementById("knowledge-source-list");
  if (!listEl) return;
  try {
    const { sources } = await api("/knowledge/sources");
    if (sources.length === 0) {
      listEl.innerHTML = "<div class='recent-empty'>No knowledge sources added yet — add a folder of your own docs below.</div>";
      return;
    }
    listEl.innerHTML = sources
      .map(
        (s) => `
      <div class="knowledge-source" data-id="${escapeHtml(s.id)}">
        <div>
          <div>${escapeHtml(s.label)}</div>
          <div class="knowledge-source-path">${escapeHtml(s.path)}</div>
        </div>
        <div class="steering-file-actions">
          <button class="refresh-btn knowledge-build-btn">Build index</button>
          <button class="refresh-btn knowledge-remove-btn">Remove</button>
        </div>
      </div>`,
      )
      .join("");
    listEl.querySelectorAll(".knowledge-source").forEach((el) => {
      const id = el.dataset.id;
      el.querySelector(".knowledge-build-btn").addEventListener("click", async () => {
        const btn = el.querySelector(".knowledge-build-btn");
        btn.disabled = true;
        btn.textContent = "Indexing…";
        try {
          const { results } = await api("/knowledge/index", { method: "POST", body: JSON.stringify({ sourceId: id }) });
          const r = results[0];
          btn.textContent = r ? `✓ ${r.chunksIndexed} chunks` : "Done";
        } catch (err) {
          btn.textContent = `Failed: ${err.message}`;
        }
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = "Build index";
        }, 2500);
      });
      el.querySelector(".knowledge-remove-btn").addEventListener("click", async () => {
        try {
          await api(`/knowledge/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
          loadKnowledgeSourceList();
        } catch (err) {
          document.getElementById("knowledge-sources-status").textContent = `Failed: ${err.message}`;
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = `<div class="debug-empty">Failed to load knowledge sources: ${escapeHtml(err.message)}</div>`;
  }
}

function loadKnowledgeView() {
  loadKnowledgeSourceList();
}

document.getElementById("knowledge-sources-refresh-btn")?.addEventListener("click", loadKnowledgeSourceList);
document.getElementById("knowledge-add-btn")?.addEventListener("click", async () => {
  const pathInput = document.getElementById("knowledge-new-path");
  const labelInput = document.getElementById("knowledge-new-label");
  const path = pathInput.value.trim();
  if (!path) return;
  const statusEl = document.getElementById("knowledge-sources-status");
  try {
    await api("/knowledge/sources", { method: "POST", body: JSON.stringify({ path, label: labelInput.value.trim() }) });
    pathInput.value = "";
    labelInput.value = "";
    statusEl.textContent = "";
    await loadKnowledgeSourceList();
  } catch (err) {
    statusEl.textContent = `Failed to add: ${err.message}`;
  }
});

async function runKnowledgeSearch() {
  const input = document.getElementById("knowledge-search-input");
  const resultsEl = document.getElementById("knowledge-search-results");
  const query = input.value.trim();
  if (!query) return;
  resultsEl.innerHTML = "<div class='verify-pending'>Searching…</div>";
  try {
    const { hits } = await api(`/knowledge/search?q=${encodeURIComponent(query)}&k=10`);
    if (hits.length === 0) {
      resultsEl.innerHTML = "<div class='recent-empty'>No matches — make sure at least one source has been indexed above.</div>";
      return;
    }
    resultsEl.innerHTML = hits
      .map(
        (h) => `
      <div class="knowledge-hit">
        <div class="knowledge-hit-head">
          <span>${escapeHtml(h.sourceLabel)} — ${escapeHtml(h.relPath)}${h.heading ? ` § ${escapeHtml(h.heading)}` : ""}</span>
          <span>score ${h.score.toFixed(3)}</span>
        </div>
        <div class="knowledge-hit-snippet">${escapeHtml(h.snippet)}</div>
      </div>`,
      )
      .join("");
  } catch (err) {
    resultsEl.innerHTML = `<div class="debug-empty">Search failed: ${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById("knowledge-search-btn")?.addEventListener("click", runKnowledgeSearch);
document.getElementById("knowledge-search-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runKnowledgeSearch();
});

// ============================================================
// Resizable 3-pane Workspace (feature request: "the 3 pane view can be
// increased or decreased width, user can drag to increase/decreased the
// width"). tree-panel and assistant-embedded get a drag handle each;
// center-panel is flex:1 so it always absorbs whatever the other two
// give up or take. Widths persist across restarts the same way Recent
// Projects does (localStorage — no cloud sync, this is a per-device UI
// preference, not project data).
// ============================================================
const PANE_WIDTHS_KEY = "mobiusx.workspacePaneWidths";
const PANE_COLLAPSED_KEY = "mobiusx.workspacePaneCollapsed";
const PANE_MIN_WIDTH = 160;
const PANE_MAX_WIDTH = 640;

function loadPaneWidths() {
  try {
    return JSON.parse(localStorage.getItem(PANE_WIDTHS_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePaneWidth(panelId, width) {
  const widths = loadPaneWidths();
  widths[panelId] = width;
  try {
    localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Best-effort — a failed save just means the width resets to default
    // next launch, not worth surfacing to the user over a UI preference.
  }
}

// Collapse state (Gap Analysis Pillar 1: "no collapse/hide toggle, only
// resize-down-to-160px") — same localStorage-JSON-blob pattern as pane
// widths above, kept as a separate key rather than folded into
// PANE_WIDTHS_KEY's object so a pane's last real width is never
// overwritten by "0" while it's collapsed; expanding just restores
// whatever width was already saved.
function loadPaneCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(PANE_COLLAPSED_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePaneCollapsed(panelId, collapsed) {
  const state = loadPaneCollapsed();
  state[panelId] = collapsed;
  try {
    localStorage.setItem(PANE_COLLAPSED_KEY, JSON.stringify(state));
  } catch {
    // Best-effort, same as savePaneWidth above.
  }
}

function setPaneCollapsed(panelId, collapsed, { persist = true } = {}) {
  const panel = document.getElementById(panelId);
  const toggle = document.getElementById(`${panelId}-collapse-toggle`);
  if (!panel) return;
  panel.classList.toggle("collapsed", collapsed);
  if (toggle) {
    toggle.textContent = collapsed ? "‹" : "›";
    toggle.title = collapsed ? "Expand AI Assistant panel" : "Collapse AI Assistant panel";
  }
  if (persist) savePaneCollapsed(panelId, collapsed);
}

function initPaneResize() {
  const saved = loadPaneWidths();
  for (const [panelId, width] of Object.entries(saved)) {
    const el = document.getElementById(panelId);
    if (el) el.style.width = `${width}px`;
  }
  const savedCollapsed = loadPaneCollapsed();
  for (const [panelId, collapsed] of Object.entries(savedCollapsed)) {
    if (collapsed) setPaneCollapsed(panelId, true, { persist: false });
  }

  document.querySelectorAll(".pane-collapse-toggle").forEach((toggle) => {
    const handle = toggle.closest(".pane-resize-handle");
    const targetId = handle?.dataset.resizeTarget;
    if (!targetId) return;
    toggle.id = `${targetId}-collapse-toggle`;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation(); // don't let the click also start a drag on the handle underneath it
      const panel = document.getElementById(targetId);
      const nowCollapsed = !panel.classList.contains("collapsed");
      setPaneCollapsed(targetId, nowCollapsed);
    });
  });

  document.querySelectorAll(".pane-resize-handle").forEach((handle) => {
    const targetId = handle.dataset.resizeTarget;
    const target = document.getElementById(targetId);
    if (!target) return;
    // tree-panel sits to the LEFT of its handle (dragging right grows it);
    // assistant-embedded sits to the RIGHT of its handle (dragging LEFT
    // grows it instead) — data-resize-reverse on that handle flips the sign.
    const reverse = handle.hasAttribute("data-resize-reverse");
    handle.addEventListener("mousedown", (e) => {
      // A collapsed pane has width:0 — dragging it would just "resize" an
      // invisible 0px box in a way that's confusing to land in. The
      // explicit toggle button (handled above) is the only way back from
      // collapsed; plain drag is a no-op until then.
      if (target.classList.contains("collapsed")) return;
      e.preventDefault();
      handle.classList.add("dragging");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const startX = e.clientX;
      const startWidth = target.getBoundingClientRect().width;
      function onMove(moveEvent) {
        const delta = moveEvent.clientX - startX;
        const signedDelta = reverse ? -delta : delta;
        const newWidth = Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, startWidth + signedDelta));
        target.style.width = `${newWidth}px`;
      }
      function onUp() {
        handle.classList.remove("dragging");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        savePaneWidth(targetId, Math.round(target.getBoundingClientRect().width));
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}
initPaneResize();

// ============================================================
// Real sign-in (see main.js's device-login block and
// backend/app/api/device_auth.py for the full flow)
// ============================================================
// Replaces the app's old hardcoded "Vamsi, AI Architect" placeholder --
// AuthUser has no display-name field on the backend (see
// frontend/app/services/authApi.ts), so email + role + org is the real
// identity data that actually exists, and that's what's shown here.
function applyUserProfile(user) {
  const initial = (user.email || "?").charAt(0).toUpperCase();
  const roleLabel = user.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : "Member";
  const firstName = (user.email || "").split("@")[0];

  for (const id of ["header-user-avatar", "settings-member-avatar"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = initial;
  }
  for (const id of ["header-user-name", "settings-member-name"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = user.email;
  }
  for (const id of ["header-user-role", "settings-member-role"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = roleLabel;
  }

  // Workspace Settings uses the signed-in user's actual org name rather than
  // a hardcoded placeholder; the top bar stays focused on project controls.
  const settingsWorkspaceName = document.getElementById("settings-workspace-name");
  if (settingsWorkspaceName) settingsWorkspaceName.textContent = user.org_name || "—";

  const greeting = document.getElementById("home-greeting");
  if (greeting && firstName) {
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    greeting.textContent = `${timeGreeting}, ${firstName}`;
  }

  const acctEmail = document.getElementById("settings-account-email");
  if (acctEmail) acctEmail.textContent = user.email;
  const acctOrg = document.getElementById("settings-account-org");
  if (acctOrg) acctOrg.textContent = user.org_name ? `${roleLabel} at ${user.org_name}` : roleLabel;

  const menuEmail = document.getElementById("user-chip-menu-email");
  if (menuEmail) menuEmail.textContent = user.email;
  const menuOrg = document.getElementById("user-chip-menu-org");
  if (menuOrg) menuOrg.textContent = user.org_name ? `${roleLabel} at ${user.org_name}` : roleLabel;
}

const signinOverlay = document.getElementById("signin-overlay");
const signinStatus = document.getElementById("signin-status");
const signinOpenBrowserBtn = document.getElementById("signin-open-browser-btn");
const signinRetryBtn = document.getElementById("signin-retry-btn");
const signoutBtn = document.getElementById("settings-signout-btn");
const userChipBtn = document.getElementById("user-chip");
const userChipMenu = document.getElementById("user-chip-menu");
const headerSignoutBtn = document.getElementById("header-signout-btn");

let currentDeviceLoginVerificationUrl = null;
let unsubscribeDeviceLoginUpdates = null;

function setSigninStatus(text, kind) {
  signinStatus.textContent = text;
  signinStatus.classList.toggle("is-error", kind === "error");
  signinStatus.classList.toggle("is-success", kind === "success");
}

async function beginSignIn() {
  signinRetryBtn.hidden = true;
  signinOpenBrowserBtn.disabled = true;
  setSigninStatus("Preparing sign-in\u2026");

  const result = await auth.startDeviceLogin();
  if (!result.ok) {
    setSigninStatus(result.error || "Couldn't start sign-in.", "error");
    signinRetryBtn.hidden = false;
    return;
  }

  // No code shown here -- the browser tab this opens is already signed
  // in (or prompts sign-in/signup) and auto-recognizes this request, so
  // there's nothing for the user to read or type. Approving there hands
  // the session back to this window automatically.
  currentDeviceLoginVerificationUrl = `${result.verificationUrl}?code=${encodeURIComponent(result.userCode)}`;
  signinOpenBrowserBtn.disabled = false;
  setSigninStatus("Waiting for approval in your browser\u2026");

  if (unsubscribeDeviceLoginUpdates) unsubscribeDeviceLoginUpdates();
  unsubscribeDeviceLoginUpdates = auth.onDeviceLoginUpdate((update) => {
    if (update.status === "pending") {
      setSigninStatus("Waiting for approval in your browser\u2026");
    } else if (update.status === "approved") {
      setSigninStatus("Signed in!", "success");
      applyUserProfile(update.session.user);
      setTimeout(() => {
        signinOverlay.hidden = true;
      }, 500);
    } else if (update.status === "denied") {
      setSigninStatus("Sign-in was denied.", "error");
      signinRetryBtn.hidden = false;
    } else if (update.status === "expired") {
      setSigninStatus("This code expired.", "error");
      signinRetryBtn.hidden = false;
    } else if (update.status === "consumed") {
      setSigninStatus("This code was already used.", "error");
      signinRetryBtn.hidden = false;
    } else {
      setSigninStatus(update.message || "Something went wrong.", "error");
      signinRetryBtn.hidden = false;
    }
  });
}

signinOpenBrowserBtn.addEventListener("click", () => {
  if (currentDeviceLoginVerificationUrl) openExternal(currentDeviceLoginVerificationUrl);
});

signinRetryBtn.addEventListener("click", () => {
  void beginSignIn();
});

async function doSignOut() {
  await auth.signOut();
  location.reload();
}

if (signoutBtn) {
  signoutBtn.addEventListener("click", () => {
    void doSignOut();
  });
}

if (headerSignoutBtn) {
  headerSignoutBtn.addEventListener("click", () => {
    void doSignOut();
  });
}

function closeUserChipMenu() {
  if (!userChipMenu || userChipMenu.hidden) return;
  userChipMenu.hidden = true;
  if (userChipBtn) userChipBtn.setAttribute("aria-expanded", "false");
}

if (userChipBtn && userChipMenu) {
  userChipBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = userChipMenu.hidden;
    userChipMenu.hidden = !willOpen;
    userChipBtn.setAttribute("aria-expanded", String(willOpen));
  });
  // Real bug (found live-testing "Configure the real models"): this used
  // to stopPropagation() on every click inside the menu, including on its
  // own item buttons (Settings, Docs, Log out, ...). Each item's own
  // listener still ran -- Settings really did call showView("settings")
  // -- but that click's bubble to `document` (where closeUserChipMenu is
  // registered, right below) never happened, so the menu overlay stayed
  // open and visually covered the view that had, in fact, already
  // switched underneath it: clicking Settings looked like it did nothing.
  // Every item here is a one-shot action (not an input a user types into),
  // so letting the click reach `document` is exactly the right behavior --
  // the item's own handler fires first (it's the actual click target),
  // then the bubble closes the menu right after.
  document.addEventListener("click", closeUserChipMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeUserChipMenu();
  });
}

async function initAuth() {
  const stored = await auth.getStoredSession();
  if (stored && stored.user) {
    applyUserProfile(stored.user);
    signinOverlay.hidden = true;
    return;
  }
  await beginSignIn();
}
void initAuth();
