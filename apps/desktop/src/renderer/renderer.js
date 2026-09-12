const { agentBaseUrl, agentWsUrl, agentToken, openFolderDialog } = window.mobiusx;

// ---- nav ----
const VIEW_LABELS = {
  "enterprise-knowledge": "Enterprise Knowledge",
  "global-intelligence": "Global Intelligence",
  projects: "Projects",
  governance: "Governance",
};

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    const isXCoder = view === "x-coder";
    document.getElementById("view-x-coder").hidden = !isXCoder;
    document.getElementById("view-placeholder").hidden = isXCoder;
    if (!isXCoder) {
      document.getElementById("placeholder-title").textContent = VIEW_LABELS[view] ?? view;
    }
  });
});

// ---- agent client ----
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

const statusEl = document.getElementById("agent-status");

async function checkAgent() {
  try {
    const health = await api("/health");
    statusEl.textContent = `agent: ok (v${health.version})`;
    statusEl.className = "status ok";
  } catch (err) {
    statusEl.textContent = "agent: unreachable";
    statusEl.className = "status error";
  }
}
checkAgent();

// ---- project open + file tree ----
const projectPathEl = document.getElementById("project-path");
const fileTreeEl = document.getElementById("file-tree");

document.getElementById("open-project-btn").addEventListener("click", async () => {
  const folder = await openFolderDialog();
  if (!folder) return;
  projectPathEl.textContent = "Indexing…";
  try {
    const result = await api("/project/open", { method: "POST", body: JSON.stringify({ path: folder }) });
    projectPathEl.textContent = `${result.path} (${result.fileCount} files${result.isGitRepo ? ", git" : ""})`;
    await Promise.all([loadTree(), result.isGitRepo ? loadGit() : clearGit()]);
  } catch (err) {
    projectPathEl.textContent = `Failed to open project: ${err.message}`;
  }
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
        for (const [childName, childEntry] of sorted) {
          renderTreeNode(childName, childEntry, depth + 1, childWrap);
        }
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

async function openFile(path) {
  document.getElementById("editor-title").textContent = path;
  const editor = document.getElementById("editor-content");
  editor.textContent = "Loading…";
  try {
    const { content, truncated } = await api(`/fs/read?path=${encodeURIComponent(path)}`);
    editor.textContent = content + (truncated ? "\n\n… (truncated)" : "");
  } catch (err) {
    editor.textContent = `Failed to read file: ${err.message}`;
  }
}

// ---- git panel ----
function clearGit() {
  document.getElementById("git-branch").textContent = "";
  document.getElementById("git-status-list").innerHTML = "";
  document.getElementById("git-log-list").innerHTML = "";
}

async function loadGit() {
  try {
    const status = await api("/git/status");
    document.getElementById("git-branch").textContent =
      `On ${status.branch ?? "(detached)"}` +
      (status.ahead ? ` ↑${status.ahead}` : "") +
      (status.behind ? ` ↓${status.behind}` : "");
    const list = document.getElementById("git-status-list");
    list.innerHTML = "";
    if (status.entries.length === 0) {
      list.innerHTML = "<div class='git-entry'>Clean working tree</div>";
    }
    for (const entry of status.entries) {
      const div = document.createElement("div");
      div.className = "git-entry";
      div.innerHTML = `<span class="git-code">${entry.index}${entry.worktree}</span><span>${entry.path}</span>`;
      list.appendChild(div);
    }
  } catch (err) {
    document.getElementById("git-status-list").textContent = `git status failed: ${err.message}`;
  }

  try {
    const log = await api("/git/log?limit=20");
    const list = document.getElementById("git-log-list");
    list.innerHTML = "";
    for (const entry of log.entries) {
      const div = document.createElement("div");
      div.className = "log-entry";
      div.innerHTML = `<span class="log-hash">${entry.hash.slice(0, 7)}</span> <span class="log-subject">${entry.subject}</span>`;
      list.appendChild(div);
    }
  } catch (err) {
    document.getElementById("git-log-list").textContent = `git log failed: ${err.message}`;
  }
}

// ---- terminal ----
const terminalOutput = document.getElementById("terminal-output");
const terminalInput = document.getElementById("terminal-input");
let terminalSocket = null;
let cmdCounter = 0;

function appendTerminalLine(text, cls) {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  terminalOutput.appendChild(div);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function connectTerminal() {
  terminalSocket = new WebSocket(`${agentWsUrl}/terminal?token=${encodeURIComponent(agentToken)}`);
  terminalSocket.addEventListener("open", () => appendTerminalLine("[connected]", "exit"));
  terminalSocket.addEventListener("close", () => appendTerminalLine("[disconnected]", "exit"));
  terminalSocket.addEventListener("error", () => appendTerminalLine("[terminal socket error]", "stderr"));
  terminalSocket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "stdout") appendTerminalLine(msg.chunk.replace(/\n$/, ""));
    else if (msg.type === "stderr") appendTerminalLine(msg.chunk.replace(/\n$/, ""), "stderr");
    else if (msg.type === "exit") appendTerminalLine(`[exit ${msg.code}]`, "exit");
    else if (msg.type === "error") appendTerminalLine(`[error] ${msg.message}`, "stderr");
  });
}
connectTerminal();

terminalInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !terminalInput.value.trim()) return;
  const command = terminalInput.value;
  terminalInput.value = "";
  appendTerminalLine(`$ ${command}`, "cmd");
  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify({ type: "exec", id: String(++cmdCounter), command }));
  } else {
    appendTerminalLine("[not connected]", "stderr");
  }
});
