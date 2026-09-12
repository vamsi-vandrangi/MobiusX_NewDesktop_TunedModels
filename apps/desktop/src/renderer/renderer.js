const { agentBaseUrl, agentWsUrl, agentToken, cloudBaseUrl, cloudWsUrl, cloudToken, openFolderDialog } = window.mobiusx;

// ============================================================
// Nav / view switching
// ============================================================
const views = {};
document.querySelectorAll(".view").forEach((el) => (views[el.id.replace("view-", "")] = el));

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "changes") loadGit();
  if (name === "tasks") loadTasksList();
  if (name === "settings") loadSettings();
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
    await loadTree();
    showView("workspace");
  } catch (err) {
    projectChipLabel.textContent = `Failed: ${err.message}`;
  }
}

async function pickAndOpenProject() {
  const folder = await openFolderDialog();
  if (folder) await openProject(folder);
}

document.getElementById("open-project-btn").addEventListener("click", pickAndOpenProject);
document.getElementById("qa-open-project").addEventListener("click", pickAndOpenProject);

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
  for (const [name, entry] of sorted) renderTreeNode(name, entry, 0, fileTreeEl);
}

// ============================================================
// Tabbed editor
// ============================================================
const tabsBar = document.getElementById("tabs-bar");
const editorContent = document.getElementById("editor-content");
const openTabs = []; // { path, content, truncated }
let activeTabPath = null;

function closeAllTabs() {
  openTabs.length = 0;
  activeTabPath = null;
  renderTabs();
  editorContent.textContent = "Open a project, then select a file.";
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
  if (!currentProjectPath) return [];
  try {
    const result = await api(`/debug/search?q=${encodeURIComponent(query)}&k=3`);
    const hits = result.hits.map((h) => ({ relPath: h.relPath, snippet: h.snippet }));
    if (mode !== "build") return hits;
    return await Promise.all(
      hits.map(async (h) => {
        try {
          const file = await api(`/fs/read?path=${encodeURIComponent(h.relPath)}`);
          return { ...h, content: file.content };
        } catch {
          return h; // fall back to snippet-only for this file rather than failing the whole request
        }
      }),
    );
  } catch {
    return [];
  }
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

/** Renders a Reviewer-agent verdict banner's inner HTML (see EditReview in @mobiusx/protocol) — shared by buildEditsCard's initial render and a later post-hoc injection (the review event can arrive after the edits card already exists). */
function renderReviewBannerHtml(review) {
  const cls = review.verdict === "approve" ? "approve" : "concerns";
  const icon = review.verdict === "approve" ? "✓" : "⚠";
  const label = review.verdict === "approve" ? "Reviewer: Approve" : "Reviewer: Concerns";
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
function buildEditsCard(edits, taskProjectPath, review) {
  const projectMismatch = Boolean(taskProjectPath) && taskProjectPath !== currentProjectPath;

  const card = document.createElement("div");
  card.className = "edits-card";
  card.innerHTML = `
    <div class="edits-card-head">Proposed changes — ${edits.length} file${edits.length === 1 ? "" : "s"}</div>
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
    </div>
    <div class="verify-results" hidden></div>
  `;
  const list = card.querySelector(".edits-card-list");

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
    try {
      const { results } = await api("/fs/apply-edits", { method: "POST", body: JSON.stringify({ edits }) });
      const appliedCount = results.filter((r) => r.status === "applied").length;
      resultEl.textContent = `Applied ${appliedCount}/${results.length}`;
      applyBtn.textContent = "Applied";
      results.forEach((r, i) => {
        const fileEl = list.children[i];
        if (!fileEl) return;
        const status = document.createElement("span");
        status.className = `edits-file-status ${r.status}`;
        status.textContent = r.status === "applied" ? "✓ applied" : `skipped — ${r.reason ?? "unknown reason"}`;
        fileEl.querySelector(".edits-file-head").appendChild(status);
      });
      await refreshAfterApply(results.filter((r) => r.status === "applied").map((r) => r.path));
      if (appliedCount > 0) verifyBtn.hidden = false;
    } catch (err) {
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply";
      resultEl.textContent = `Failed: ${err.message}`;
    }
  });

  // ---- Verification Engine (PRD §22): real build/test evidence, not a claim ----
  const verifyBtn = card.querySelector(".edits-verify-btn");
  const verifyResultsEl = card.querySelector(".verify-results");
  verifyBtn.addEventListener("click", async () => {
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying…";
    verifyResultsEl.hidden = false;
    verifyResultsEl.innerHTML = `<div class="verify-pending">Running the project's build/test scripts…</div>`;
    try {
      const result = await api("/verify", { method: "POST" });
      if (result.overall === "no-verification-available") {
        verifyResultsEl.innerHTML = `<div class="verify-none">No build/test/lint/typecheck script found in this project's package.json — nothing to verify.</div>`;
      } else {
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
      }
    } catch (err) {
      verifyResultsEl.innerHTML = `<div class="verify-none">Verification failed to run: ${escapeHtml(err.message)}</div>`;
    }
    verifyBtn.disabled = false;
    verifyBtn.textContent = "Run verification again";
  });

  return card;
}

// ============================================================
// AI Assistant panel (Ask/Plan/Build) — wired to the Cloud Agent Gateway.
// ============================================================
function createAssistantPanel(container) {
  container.innerHTML = `
    <div class="assistant-header">
      <button class="mode-btn active" data-mode="ask">Ask</button>
      <button class="mode-btn" data-mode="plan">Plan</button>
      <button class="mode-btn" data-mode="build">Build</button>
      <button class="mode-btn" data-mode="spec" title="Requirements Engineering — generates a structured spec file for review, doesn't write code">Spec</button>
    </div>
    <div class="assistant-feed"></div>
    <div class="assistant-input-row">
      <input placeholder="Ask a follow-up question…" />
      <button class="send-btn">→</button>
    </div>
  `;
  const feed = container.querySelector(".assistant-feed");
  const input = container.querySelector(".assistant-input-row input");
  const sendBtn = container.querySelector(".send-btn");
  const modeBtns = container.querySelectorAll(".mode-btn");
  let mode = "ask";

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
        <div class="assistant-steps"></div>
        <button class="assistant-stop-btn" disabled title="Cancel this task">■ Stop</button>
      </div>
      <div class="assistant-output"></div>
    `;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
    const stopBtn = div.querySelector(".assistant-stop-btn");
    return {
      stopBtn,
      setStep(step) {
        const stepsEl = div.querySelector(".assistant-steps");
        const marker = step.status === "completed" ? "✓" : step.status === "in_progress" ? "…" : "·";
        let line = stepsEl.querySelector(`[data-step="${step.id}"]`);
        if (!line) {
          line = document.createElement("div");
          line.dataset.step = step.id;
          stepsEl.appendChild(line);
        }
        line.textContent = `${marker} ${step.label}`;
      },
      appendOutput(delta) {
        div.querySelector(".assistant-output").textContent += delta;
        feed.scrollTop = feed.scrollHeight;
      },
      setEdits(edits, taskProjectPath) {
        if (!edits?.length) return;
        div.appendChild(buildEditsCard(edits, taskProjectPath));
        feed.scrollTop = feed.scrollHeight;
      },
      setReview(review) {
        // The review event can arrive after setEdits already built the card (that's the
        // normal order — edits, then review) — inject it into the existing card rather
        // than requiring buildEditsCard to be re-called.
        const reviewSlot = div.querySelector(".edits-card-review");
        if (!reviewSlot) return; // no edits card yet — shouldn't happen given emission order, but never throw over it
        reviewSlot.innerHTML = renderReviewBannerHtml(review);
        feed.scrollTop = feed.scrollHeight;
      },
      setStatus(status) {
        if (status === "cancelled") {
          div.querySelector(".assistant-output").textContent += "\n[cancelled]";
        }
        if (status === "completed" || status === "cancelled" || status === "failed") {
          stopBtn.remove();
        }
      },
      setError(message) {
        div.querySelector(".assistant-output").textContent += `\n[error] ${message}`;
        stopBtn.remove();
      },
    };
  }

  addMsg(
    cloudBaseUrl
      ? "Connected to the local Cloud Agent Gateway (reference implementation — see docs/ARCHITECTURE.md §12). Ask / Plan / Build below is real, but reasoning quality depends on whether a real model is configured; each response says which runner served it."
      : "Cloud Agent Gateway did not start — Ask/Plan/Build is unavailable this session.",
    "system",
  );

  async function submit() {
    const text = input.value.trim();
    if (!text || !cloudBaseUrl) return;
    addMsg(text, "user");
    input.value = "";

    const stream = addStreamingMsg();
    const taskProjectPath = currentProjectPath; // captured now — the task's context is grounded in whatever project is open at submit time, not whatever's open when a later event arrives
    try {
      const relevantFiles = await findRelevantFiles(text, mode);
      const { task } = await cloudApi("/tasks", {
        method: "POST",
        body: JSON.stringify({
          mode,
          prompt: text,
          projectContext: taskProjectPath ? { projectPath: taskProjectPath, relevantFiles } : undefined,
        }),
      });
      stream.appendOutput(`[runner: ${task.runner}]\n`);
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
      await streamTask(task.id, {
        onStep: (step) => stream.setStep(step),
        onOutput: (delta) => stream.appendOutput(delta),
        onEdits: (edits) => stream.setEdits(edits, taskProjectPath),
        onReview: (review) => stream.setReview(review),
        onStatus: (status) => stream.setStatus(status),
        onError: (message) => stream.setError(message),
      });
      stream.stopBtn.remove();
    } catch (err) {
      stream.setError(err.message);
    }
  }

  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  return { addMsg };
}

createAssistantPanel(document.getElementById("assistant-embedded"));
createAssistantPanel(document.getElementById("assistant-full"));

// ============================================================
// Home "ask" box — routes into the AI Assistant view
// ============================================================
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
      card.innerHTML = `
        <div class="debug-hit-head">
          <span class="debug-hit-path">${escapeHtml(hit.relPath)}:${hit.startLine}-${hit.endLine} <span class="debug-hit-meta">(${hit.kind}, score ${hit.score.toFixed(3)})</span></span>
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
// Tasks view — list + detail, backed by the Cloud Agent Gateway.
// ============================================================
let activeTaskId = null;

function formatTaskTime(iso) {
  try {
    return new Date(iso).toLocaleString();
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

function renderTaskDetail(task) {
  if (task.id !== activeTaskId) return; // a newer selection has since superseded this render
  const detailEl = document.getElementById("task-detail");
  const cancellable = task.status === "queued" || task.status === "running";
  detailEl.innerHTML = `
    <div class="task-detail-header">
      <div class="task-row-prompt">${escapeHtml(task.prompt)}</div>
      <div class="task-row-meta">
        <span class="task-mode-badge">${task.mode}</span>
        <span class="task-status ${task.status}">${task.status}</span>
        <span>runner: ${task.runner}</span>
        ${cancellable ? `<button class="task-cancel-btn">■ Cancel</button>` : ""}
      </div>
    </div>
    <div class="task-detail-steps">
      ${task.steps
        .map((s) => `<div class="task-step-row"><span class="task-step-dot ${s.status}"></span>${escapeHtml(s.label)}</div>`)
        .join("")}
    </div>
    <pre class="task-detail-output">${escapeHtml(task.output || (task.status === "failed" ? task.error ?? "" : "…"))}</pre>
    <div class="task-detail-edits"></div>
  `;
  if (task.edits?.length) {
    detailEl.querySelector(".task-detail-edits").appendChild(buildEditsCard(task.edits, task.projectPath, task.review));
  }
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

function loadSettings() {
  loadPolicy();
  loadAuditLog();
  loadTerminalApprovalSettings();
}

document.getElementById("audit-refresh-btn").addEventListener("click", loadAuditLog);
