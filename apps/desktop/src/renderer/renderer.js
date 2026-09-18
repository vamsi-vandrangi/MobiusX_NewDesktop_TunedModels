const { agentBaseUrl, agentWsUrl, agentToken, cloudBaseUrl, cloudWsUrl, cloudToken, openFolderDialog, openInBrowser, openExternal } = window.mobiusx;

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
  if (name === "tasks") loadTasksList();
  if (name === "settings") loadSettings();
  if (name === "artifacts") loadArtifacts();
  if (name === "knowledge") loadKnowledgeView();
  if (name === "home") loadDashboard();
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
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
    throw new Error(body.error ? `${body.error}${body.detail ? ": " + body.detail : ""}` : `HTTP ${res.status}`);
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
    row.className = "recent-item";
    const name = path.split("/").filter(Boolean).pop() || path;
    row.innerHTML = `<span>${name}</span><span class="recent-item-path">${path}</span>`;
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
let currentProjectPath = null;

async function openProject(path) {
  projectChipLabel.textContent = "Indexing…";
  try {
    const result = await api("/project/open", { method: "POST", body: JSON.stringify({ path }) });
    currentProjectPath = result.path;
    projectChipLabel.textContent = `${result.path.split("/").pop()} (${result.fileCount} files${result.isGitRepo ? ", git" : ""})`;
    pushRecent(result.path);
    closeAllTabs();
    document.getElementById("debug-results").innerHTML = "";
    document.getElementById("debug-index-status").textContent = "No index built yet for this project";
    resetPreviewUI(); // switching projects — desktop-agent already stopped the previous project's dev server(s)
    resetProjectContextUI();
    await loadTree();
    showView("workspace");
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
  const folder = await openFolderDialog();
  if (folder) await openProject(folder);
}

document.getElementById("open-project-btn").addEventListener("click", pickAndOpenProject);
document.getElementById("qa-open-project").addEventListener("click", pickAndOpenProject);

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
  const parent = await openFolderDialog();
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
document.getElementById("qa-new-project").addEventListener("click", createProject);

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
const editorContent = document.getElementById("editor-content");
const editorStatusbar = document.getElementById("editor-statusbar");
const openTabs = []; // { path, content, truncated }
let activeTabPath = null;

// Extension → display label for the editor's status bar (below). Cosmetic
// only — this app doesn't have a real code-editor component (the editor is
// a plain read-only <pre>, not something with an actual text cursor), so
// unlike the mockup this reflects, there's no real "Ln 18, Col 12" to show
// honestly. What IS real and worth showing: the file's language by
// extension, its line count, and that it's read as UTF-8.
const LANGUAGE_LABELS = {
  ts: "TypeScript", tsx: "TypeScript JSX", js: "JavaScript", jsx: "JavaScript JSX",
  json: "JSON", css: "CSS", html: "HTML", md: "Markdown", py: "Python",
  yml: "YAML", yaml: "YAML", sh: "Shell Script", sql: "SQL", rs: "Rust", go: "Go",
};
function languageForPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return LANGUAGE_LABELS[ext] ?? "Plain Text";
}

function updateEditorStatusbar(tab) {
  if (!tab) {
    editorStatusbar.hidden = true;
    return;
  }
  const lineCount = tab.content.split("\n").length;
  editorStatusbar.hidden = false;
  editorStatusbar.textContent = `${languageForPath(tab.path)}  ·  ${lineCount} line${lineCount === 1 ? "" : "s"}  ·  UTF-8`;
}

function closeAllTabs() {
  openTabs.length = 0;
  activeTabPath = null;
  renderTabs();
  editorContent.textContent = "Open a project, then select a file.";
  updateEditorStatusbar(null);
}

function renderTabs() {
  tabsBar.innerHTML = "";
  for (const tab of openTabs) {
    const div = document.createElement("div");
    div.className = "file-tab" + (tab.path === activeTabPath ? " active" : "");
    const name = tab.path.split("/").pop();
    div.innerHTML = `<span>${name}</span><span class="file-tab-close">✕</span>`;
    div.querySelector("span:first-child").addEventListener("click", () => activateTab(tab.path));
    div.querySelector(".file-tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });
    tabsBar.appendChild(div);
  }
}

function activateTab(path) {
  activeTabPath = path;
  const tab = openTabs.find((t) => t.path === path);
  editorContent.textContent = tab ? tab.content + (tab.truncated ? "\n\n… (truncated)" : "") : "";
  updateEditorStatusbar(tab);
  renderTabs();
}

function closeTab(path) {
  const idx = openTabs.findIndex((t) => t.path === path);
  if (idx === -1) return;
  openTabs.splice(idx, 1);
  if (activeTabPath === path) {
    activeTabPath = openTabs.length ? openTabs[Math.max(0, idx - 1)].path : null;
    if (activeTabPath) activateTab(activeTabPath);
    else {
      editorContent.textContent = "Open a project, then select a file.";
      updateEditorStatusbar(null);
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

async function openFile(path) {
  let tab = openTabs.find((t) => t.path === path);
  if (!tab) {
    try {
      const data = await api(`/fs/read?path=${encodeURIComponent(path)}`);
      tab = { path, content: data.content, truncated: data.truncated };
      openTabs.push(tab);
    } catch (err) {
      tab = { path, content: `Failed to read file: ${err.message}`, truncated: false };
      openTabs.push(tab);
    }
  }
  activateTab(path);
}

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
let previewPollTimer = null;

function describeService(label, svc) {
  if (!svc) return null;
  const where = svc.url ? ` at ${svc.url}` : "";
  return `${label}: ${svc.status}${where} (${svc.command})`;
}

function renderPreviewStatus(status) {
  const parts = [describeService("Frontend", status.frontend), describeService("Backend", status.backend)].filter(Boolean);
  const running = Boolean(status.frontend || status.backend);
  previewStatusText.textContent = parts.length
    ? parts.join("  ·  ")
    : "No frontend \"dev\" script or recognizable FastAPI backend found in this project — nothing to preview.";

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
  const notable = [status.frontend, status.backend].find(
    (s) => s && (s.status === "failed" || s.status === "installing") && s.log.length > 0,
  );
  if (notable) {
    previewLog.textContent = notable.log.slice(-20).join("\n");
    previewLog.hidden = false;
  } else {
    previewLog.hidden = true;
  }

  const frontendUrl = status.frontend?.url ?? null;
  // Only auto-navigate the webview the FIRST time a URL becomes known for
  // this run — once the user has typed their own address into the bar
  // (e.g. to view a specific route), further polling shouldn't yank them
  // back to the root.
  if (frontendUrl && previewWebview.getAttribute("src") === "about:blank") {
    previewWebview.src = frontendUrl;
    previewUrlInput.value = frontendUrl;
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
  if (previewPollTimer) {
    clearInterval(previewPollTimer);
    previewPollTimer = null;
  }
  previewWebview.src = "about:blank";
  previewUrlInput.value = "";
  previewStatusText.textContent = "";
  previewLog.hidden = true;
  previewStopBtn.hidden = true;
  previewStartBtn.hidden = false;
  previewBackBtn.disabled = true;
  previewForwardBtn.disabled = true;
  previewReloadBtn.disabled = true;
  previewUrlInput.disabled = true;
  previewOpenBrowserBtn.disabled = true;
  previewEmpty.hidden = false;
}

async function refreshPreviewStatus() {
  try {
    const status = await api("/preview/status");
    renderPreviewStatus(status);
  } catch {
    // agent unreachable this tick — leave last known state, next poll retries
  }
}

previewStartBtn.addEventListener("click", async () => {
  if (!currentProjectPath) {
    previewStatusText.textContent = "Open a project first.";
    return;
  }
  previewStartBtn.disabled = true;
  previewStatusText.textContent = "Detecting and starting dev server(s)…";
  try {
    const result = await api("/preview/start", { method: "POST" });
    renderPreviewStatus(result);
    if (previewPollTimer) clearInterval(previewPollTimer);
    previewPollTimer = setInterval(refreshPreviewStatus, 2000);
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

/** Parses markdown into `container`, then renders every ```mermaid fence it contained as an actual SVG diagram (async, since mermaid.render() is). A diagram that fails to parse shows the error plus its raw source rather than silently disappearing -- this is exactly the kind of thing Phase 9's own evidence-grounding is meant to prevent, so a failure here should be visible, not swallowed. */
async function renderMarkdownWithMermaid(container, markdownText) {
  if (!window.marked) {
    container.textContent = markdownText;
    return;
  }
  container.innerHTML = marked.parse(markdownText);
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
    const result = await api(`/debug/search?q=${encodeURIComponent(query)}&k=3`);
    const hits = result.hits.map((h) => ({ relPath: h.relPath, snippet: h.snippet }));
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
        ws.close();
        resolve();
      }
    });
    ws.addEventListener("error", () => {
      onError?.("stream connection error");
      resolve();
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
      tab.content = data.content;
      tab.truncated = data.truncated;
      if (activeTabPath === relPath) activateTab(relPath);
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
// FIRST Diagnose & Fix click is always the user's own (unchanged from
// before this phase); what "auto" adds is everything AFTER that -- once a
// fix task's edits appear, this code drives the SAME Apply/Run
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

/**
 * Drives one more auto-chained cycle starting from a fix task's just-
 * appended edits-card (`card`) -- auto-Apply it, auto-Run verification,
 * and if still failing and under the iteration cap, auto-click ITS
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
  applyBtn.click();
  await waitForButtonSettled(applyBtn, "Applying…");
  if (applyBtn.textContent !== "Applied") return; // apply failed outright -- resultEl already shows why, stop the chain
  const verifyBtn = card.querySelector(".edits-verify-btn");
  if (!verifyBtn || verifyBtn.hidden) return;
  verifyBtn.click();
  await waitForButtonSettled(verifyBtn, "Verifying…");
  const diagnoseBtn = card.querySelector(".edits-diagnose-btn");
  const cardVerifyResultsEl = card.querySelector(".verify-results");
  if (!diagnoseBtn || diagnoseBtn.hidden) {
    appendAutoFixBanner(cardVerifyResultsEl, `✓ Auto fix loop succeeded after ${depth} attempt(s).`, "success");
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

function buildEditsCard(edits, taskProjectPath, review) {
  const projectMismatch = Boolean(taskProjectPath) && taskProjectPath !== currentProjectPath;

  const card = document.createElement("div");
  card.className = "edits-card";
  card.innerHTML = `
    <div class="edits-card-head">Proposed changes — ${edits.length} file${edits.length === 1 ? "" : "s"}</div>
    <div class="edits-card-checklist"></div>
    <div class="edits-card-review">${review ? renderReviewBannerHtml(review) : ""}</div>
    ${
      projectMismatch
        ? `<div class="edits-card-warning">This task ran against <code>${escapeHtml(taskProjectPath)}</code>, but that isn't the project currently open (${currentProjectPath ? `<code>${escapeHtml(currentProjectPath)}</code>` : "none"}). Open that project to apply these edits.</div>`
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

  for (const edit of edits) {
    const item = document.createElement("div");
    item.className = "edits-file";
    item.innerHTML = `
      <div class="edits-file-head">
        <span class="edits-file-badge ${edit.action}">${edit.action}</span>
        <span class="edits-file-path">${escapeHtml(edit.path)}</span>
        <button class="edits-file-toggle">Show diff</button>
      </div>
      <pre class="edits-file-diff" hidden></pre>
    `;
    const toggleBtn = item.querySelector(".edits-file-toggle");
    const diffEl = item.querySelector(".edits-file-diff");
    let loaded = false;
    toggleBtn.addEventListener("click", async () => {
      if (diffEl.hidden) {
        if (!loaded) {
          loaded = true;
          let oldContent = "";
          if (edit.action === "modify" && currentProjectPath) {
            try {
              const file = await api(`/fs/read?path=${encodeURIComponent(edit.path)}`);
              oldContent = file.content;
            } catch {
              // file may since have been moved/deleted — diff against empty rather than failing the card
            }
          }
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
  }

  const applyBtn = card.querySelector(".edits-apply-btn");
  const resultEl = card.querySelector(".edits-apply-result");
  applyBtn.addEventListener("click", async () => {
    if (!currentProjectPath) {
      resultEl.textContent = "Open a project first.";
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
    setChecklistStep("Apply changes", "in_progress");
    try {
      const { results, hookResults } = await api("/fs/apply-edits", { method: "POST", body: JSON.stringify({ edits }) });
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
  let lastFailingBrowserSteps = [];
  let lastFailingSteps = [];
  function recomputeFailingSteps() {
    lastFailingSteps = [...lastFailingVerifySteps, ...lastFailingBrowserSteps];
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
    browserValidateResultsEl.innerHTML = `<div class="verify-pending">Driving the running preview with a real browser…</div>`;
    lastFailingBrowserSteps = [];
    recomputeFailingSteps();
    try {
      const result = await api("/browser-validate", { method: "POST" });
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
      const steeringContext = await fetchSteeringContext();
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
async function populateModelSelect(selectEl, { includeAuto, selectedValue, autoLabel } = {}) {
  const models = await fetchModelOptions();
  selectEl.innerHTML = "";

  if (!cloudBaseUrl) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Cloud Agent Gateway unavailable this session";
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }

  if (includeAuto) {
    const opt = document.createElement("option");
    opt.value = "";
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

  const available = models.filter((m) => m.available);

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

  if (available.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No models configured — add an API key in Settings";
    opt.disabled = true;
    selectEl.appendChild(opt);
  }

  if (selectedValue !== undefined) {
    const match = [...selectEl.options].find((o) => o.value === selectedValue);
    if (match && !match.disabled) selectEl.value = selectedValue;
  }
}

// ============================================================
// AI Assistant panel (Ask/Plan/Build) — wired to the Cloud Agent Gateway.
// ============================================================
function createAssistantPanel(container) {
  container.innerHTML = `
    <div class="assistant-titlebar">
      <img class="assistant-icon" src="../../assets/logo.png" alt="" />
      <span class="assistant-title">MobiusX AI Assistant</span>
    </div>
    <div class="assistant-header">
      <div class="assistant-mode-tabs">
        <button class="mode-btn active" data-mode="ask" title="Chat only — answers questions and can show code in its reply, but never writes a file to disk">Ask</button>
        <button class="mode-btn" data-mode="plan" title="Drafts a numbered implementation plan in prose — describes what to build, never writes a file to disk">Plan</button>
        <button class="mode-btn" data-mode="build" title="The only mode that writes real files — proposes edits you review and click Apply before anything touches disk">Build</button>
        <button class="mode-btn" data-mode="spec" title="Requirements Engineering — generates a structured spec file for review, doesn't write code">Spec</button>
        <button class="mode-btn" data-mode="database" title="Database Engineering — proposes a schema, migration, and ORM model changes as one set; writes real files like Build">Database</button>
        <button class="mode-btn" data-mode="architecture" title="Architecture Generation — proposes docs/architecture/HLD.md and LLD.md with evidence-grounded Mermaid diagrams; writes real files like Build">Architecture</button>
        <button class="mode-btn" data-mode="testing" title="Testing Engine — writes real test file(s) for the code shown, grounded in this project's real detected test framework; writes real files like Build">Testing</button>
        <button class="mode-btn" data-mode="devops" title="DevOps/Infrastructure Generation — proposes Dockerfile(s), docker-compose.yml, and a CI pipeline grounded in this project's real detected services and build/test commands; writes real files like Build">DevOps</button>
        <button class="mode-btn" data-mode="auth" title="Auth/RBAC Engineering — adds or extends JWT authentication and role-based authorization, grounded in this project's real detected backend and any existing auth code; writes real files like Build">Auth</button>
      </div>
      <select class="model-select" title="Which AI model handles this task — overrides the Settings default for this task only"></select>
    </div>
    <div class="assistant-feed"></div>
    <div class="assistant-input-row">
      <input placeholder="Ask a follow-up question…" />
      <button class="mic-btn" type="button" title="Voice input"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
      <button class="send-btn">→</button>
    </div>
  `;
  const feed = container.querySelector(".assistant-feed");
  const input = container.querySelector(".assistant-input-row input");
  const sendBtn = container.querySelector(".send-btn");
  const modeBtns = container.querySelectorAll(".mode-btn");
  const modelSelect = container.querySelector(".model-select");
  let mode = "ask";
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
  const MAX_HISTORY_TURNS = 12; // keep in sync with promptShared.ts's MAX_HISTORY_TURNS
  // Token-limit alerts (feature request: "alert the token limits (50%,
  // 75%, 90% consumed) to the user while working"). Each task's usage
  // already reflects the whole conversation so far (history grows with
  // every turn — see historyMessages() on the gateway side), so tracking
  // the highest threshold already shown IN THIS PANEL is enough to alert
  // once per threshold as the conversation grows, without re-alerting on
  // every single message.
  let maxUsageThresholdShown = 0;

  populateModelSelect(modelSelect, { includeAuto: true });

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
      mode = btn.dataset.mode;
      modeBtns.forEach((b) => b.classList.toggle("active", b === btn));
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

  function addStreamingMsg() {
    const div = document.createElement("div");
    div.className = "assistant-msg system streaming";
    div.innerHTML = `
      <div class="assistant-stream-head">
        <div class="assistant-stream-left">
          <div class="assistant-stream-status">
            <img class="assistant-spinner-icon" src="../../assets/logo.png" alt="" />
            <span class="assistant-stream-label">Working…</span>
          </div>
          <div class="assistant-steps"></div>
        </div>
        <button class="assistant-stop-btn" disabled title="Cancel this task">■ Stop</button>
      </div>
      <div class="assistant-output"></div>
    `;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
    const stopBtn = div.querySelector(".assistant-stop-btn");
    const labelEl = div.querySelector(".assistant-stream-label");
    setStreamingIndicator(true);
    let finished = false;
    // Stops the spinner (both the per-message one and, once nothing else in
    // this panel is still running, the titlebar one) and freezes the status
    // label — called from whichever terminal event actually arrives
    // (setStatus's completed/cancelled/failed, or setError), and guarded so
    // a status *and* an error for the same task can't double-decrement the
    // shared activeStreamCount.
    function finish(label) {
      if (finished) return;
      finished = true;
      div.classList.add("done");
      labelEl.textContent = label;
      setStreamingIndicator(false);
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
        for (const step of task.steps) {
          const marker = step.status === "completed" ? "✓" : step.status === "in_progress" ? "…" : "·";
          const line = document.createElement("div");
          // .assistant-step-line carries the status class too (not just the
          // marker span) so CSS can strike through the whole row's label
          // once it's done -- a live todo list, not just a checkmark log.
          line.className = `assistant-step-line ${step.status}`;
          line.innerHTML = `<span class="assistant-step-marker ${step.status}">${marker}</span><span class="assistant-step-label">${escapeHtml(step.label)}</span>`;
          stepsEl.appendChild(line);
        }

        const bodyText = task.output || (task.status === "failed" ? (task.error ?? "") : "");
        outputEl.textContent = prefixLines.join("") + bodyText + (task.status === "cancelled" ? "\n[cancelled]" : "");

        if (task.usage) showUsageAlertIfNeeded(task.usage);

        if (task.edits?.length && !div.querySelector(".edits-card")) {
          div.appendChild(buildEditsCard(task.edits, taskProjectPath, task.review));
        } else if (task.review) {
          const reviewSlot = div.querySelector(".edits-card-review");
          if (reviewSlot) reviewSlot.innerHTML = renderReviewBannerHtml(task.review);
        }

        feed.scrollTop = feed.scrollHeight;

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
      },
    };
  }

  addMsg(
    cloudBaseUrl
      ? "Connected to the local Cloud Agent Gateway (reference implementation — see docs/ARCHITECTURE.md §12). Ask / Plan / Build / Spec below is real, but reasoning quality depends on whether a real model is configured; pick one above (or set a default in Settings) — each response says which runner and model actually served it. Only Build (and Spec, for a requirements doc) ever writes a real file — Ask and Plan just reply in chat, even if the reply shows code, so there's nothing to run or open from those two."
      : "Cloud Agent Gateway did not start — Ask/Plan/Build is unavailable this session.",
    "system",
  );

  async function submit() {
    const text = input.value.trim();
    if (!text || !cloudBaseUrl) return;

    // Build/Spec modes propose real file edits, and Apply refuses to write
    // anywhere without a currently-open project (see buildEditsCard's
    // "Open a project first." guard) -- catching that up front, before
    // spending a whole generation, instead of letting the user go through
    // the full response only to hit a dead end at Apply time. Confirmed
    // real friction, not a hypothetical: a user submitted a Build request
    // with no project open, got a full proposed-edits response, and had no
    // way to tell anything was wrong until Apply silently did nothing.
    if ((mode === "build" || mode === "spec" || mode === "database" || mode === "architecture" || mode === "testing" || mode === "devops" || mode === "auth") && !currentProjectPath) {
      addMsg(text, "user");
      input.value = "";
      const modeLabel = mode === "build" ? "Build" : mode === "spec" ? "Spec" : mode === "database" ? "Database" : mode === "architecture" ? "Architecture" : mode === "testing" ? "Testing" : mode === "devops" ? "DevOps" : "Auth";
      addMsg(
        `${modeLabel} mode writes real files, so it needs a project open first — click "New Project…" or "Open Project…" at the top, then send this again.`,
        "system",
      );
      return;
    }

    addMsg(text, "user");
    input.value = "";

    const stream = addStreamingMsg();
    const taskProjectPath = currentProjectPath; // captured now — the task's context is grounded in whatever project is open at submit time, not whatever's open when a later event arrives
    try {
      let relevantFiles, indexedChunkCount, architectureEvidence, testingEvidence, devopsEvidence, authEvidence;
      // Project Memory/Steering (Phase 16) + Knowledge (Phase 17) --
      // fetched for every mode with a project open, in parallel with each
      // other (independent lookups, no reason to serialize them).
      const [steeringContext, knowledgeContext] = taskProjectPath
        ? await Promise.all([fetchSteeringContext(), fetchKnowledgeContext(text)])
        : [undefined, undefined];
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
      // "" (Auto) means: omit `model` entirely and let the gateway's
      // resolveRunner() choose (Settings default, else best configured
      // provider, else demo) — see populateModelSelect above.
      const model = modelSelect.value ? JSON.parse(modelSelect.value) : undefined;
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
              }
            : undefined,
          model,
          history: historyTurns.slice(-MAX_HISTORY_TURNS),
        }),
      });
      const prefixLines = [`[runner: ${task.runner}${task.model ? " / " + task.model : ""}]\n`];
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
        const refresh = async () => {
          detail = await cloudApi(`/tasks/${task.id}`);
          stream.renderFromDetail(detail, renderOpts);
        };
        await streamTask(task.id, {
          onStep: refresh,
          onOutput: refresh,
          onEdits: refresh,
          onReview: refresh,
          onStatus: refresh,
          onError: (message) => stream.setError(message),
        });
      }
      stream.stopBtn.remove();
      // Remember this exchange for the NEXT follow-up in this panel — see
      // the historyTurns comment above. Skipped for an empty response (e.g.
      // the task was cancelled before producing anything) since there's
      // nothing worth reminding the model of.
      if (detail.output?.trim()) {
        historyTurns.push({ role: "user", content: text }, { role: "assistant", content: detail.output });
        if (historyTurns.length > MAX_HISTORY_TURNS * 2) {
          historyTurns = historyTurns.slice(-MAX_HISTORY_TURNS * 2);
        }
      }
    } catch (err) {
      stream.setError(err.message);
    }
  }

  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

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

  return {
    addMsg,
    // Used by the "New Project" flow to drop a freshly-created (empty)
    // project straight into Build mode with focus in the input, instead of
    // leaving the user to notice and click Build themselves.
    setMode(newMode) {
      mode = newMode;
      modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === newMode));
    },
    focusInput() {
      input.focus();
    },
  };
}

const embeddedAssistantPanel = createAssistantPanel(document.getElementById("assistant-embedded"));
createAssistantPanel(document.getElementById("assistant-full"));

// ============================================================
// Home "ask" box — routes into the AI Assistant view
// ============================================================
const homeModelSelectEl = document.getElementById("home-model-select");
populateModelSelect(homeModelSelectEl, { includeAuto: true });
document.querySelectorAll(".ask-modes .mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ask-modes .mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
  });
});
document.getElementById("home-ask-send").addEventListener("click", () => {
  const val = document.getElementById("home-ask-input").value.trim();
  showView("assistant");
  if (val) {
    document.getElementById("home-ask-input").value = "";
    const input = document.querySelector("#assistant-full .assistant-input-row input");
    input.value = val;
    // Carry the Home page's model choice into the panel that actually
    // sends the request — this is the whole point of the Home dropdown:
    // letting the user pick a faster model right where they noticed the lag.
    const homeModel = homeModelSelectEl.value;
    const fullModelSelect = document.querySelector("#assistant-full .model-select");
    if (homeModel && fullModelSelect) fullModelSelect.value = homeModel;
    document.querySelector("#assistant-full .send-btn").click();
  }
});
document.getElementById("home-ask-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("home-ask-send").click();
});

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
// X-Debug & Fix: ticket investigation (extends Error Intelligence above
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
// words and what X-Debug already found, rather than re-deriving it alone.
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
    const steeringContext = await fetchSteeringContext();
    const promptParts = [
      `Fix the issue described in this support ticket${ticket.ticketId ? ` (${ticket.ticketId})` : ""}${ticket.title ? `: ${ticket.title}` : ""}.`,
      "",
      "--- Ticket text (as pasted by the developer) ---",
      ticket.rawText,
      "",
      "--- X-Debug investigation findings ---",
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
                ${timeLabel ? `<div class="task-timeline-time">${escapeHtml(timeLabel)}</div>` : ""}
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
      fixLoopModeStatusEl.textContent = "Saved — applies to your next Diagnose & Fix click.";
    } catch (err) {
      fixLoopModeStatusEl.textContent = `Failed to save: ${err.message}`;
      await loadFixLoopModeSettings(); // revert the radio to whatever's actually persisted
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

function loadSettings() {
  loadPolicy();
  loadSteering();
  loadHooks();
  loadMcpServers();
  loadAuditLog();
  loadTerminalApprovalSettings();
  loadFixLoopModeSettings();
  loadDefaultModelSettings();
  loadModelRoutingSettings();
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

function initPaneResize() {
  const saved = loadPaneWidths();
  for (const [panelId, width] of Object.entries(saved)) {
    const el = document.getElementById(panelId);
    if (el) el.style.width = `${width}px`;
  }

  document.querySelectorAll(".pane-resize-handle").forEach((handle) => {
    const targetId = handle.dataset.resizeTarget;
    const target = document.getElementById(targetId);
    if (!target) return;
    // tree-panel sits to the LEFT of its handle (dragging right grows it);
    // assistant-embedded sits to the RIGHT of its handle (dragging LEFT
    // grows it instead) — data-resize-reverse on that handle flips the sign.
    const reverse = handle.hasAttribute("data-resize-reverse");
    handle.addEventListener("mousedown", (e) => {
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
