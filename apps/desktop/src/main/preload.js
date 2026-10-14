// Security-hardening pass: this file IS the minimized preload bridge --
// contextBridge.exposeInMainWorld is the only thing that reaches the
// renderer's window object, every exposed function is an ipcRenderer.invoke
// call (request/response, not a raw channel), and the one subscription case
// (auth.onDeviceLoginUpdate) wraps ipcRenderer.on/removeListener in a
// closure that hands back an unsubscribe function -- the renderer never
// receives ipcRenderer itself, a bare .on, or a bare .removeListener to call
// with an arbitrary channel name. Only contextBridge/ipcRenderer are
// required from "electron"; nothing else from Node (fs/path/os/child_process/
// etc.) is touched, so this file needs no changes to run under main.js's
// sandbox: true. The exposed global is window.mobiusx (not window.mobiusAPI)
// -- kept as-is rather than renamed, since renderer.js references it
// throughout and a rename here is a pure naming change with zero effect on
// the isolation this file already provides.
const { contextBridge, ipcRenderer } = require("electron");

function readFlag(name) {
  const prefix = `--${name}=`;
  const flag = process.argv.find((a) => a.startsWith(prefix));
  if (!flag) return { port: null, token: null };
  try {
    return JSON.parse(flag.slice(prefix.length));
  } catch {
    return { port: null, token: null };
  }
}

const agent = readFlag("mobiusx-agent");
const cloud = readFlag("mobiusx-cloud");

contextBridge.exposeInMainWorld("mobiusx", {
  agentBaseUrl: agent.port ? `http://127.0.0.1:${agent.port}` : null,
  agentWsUrl: agent.port ? `ws://127.0.0.1:${agent.port}` : null,
  agentToken: agent.token,

  cloudBaseUrl: cloud.port ? `http://127.0.0.1:${cloud.port}` : null,
  cloudWsUrl: cloud.port ? `ws://127.0.0.1:${cloud.port}` : null,
  cloudToken: cloud.token,

  // Security-hardening pass, item 2: the Main process (previewWatcher.js)
  // does the actual "is localhost:3000 up yet" network checking now --
  // never the sandboxed renderer -- and pushes these two events here. Same
  // subscribe/unsubscribe-closure shape as auth.onDeviceLoginUpdate below;
  // the renderer never gets ipcRenderer itself or a bare .on/.removeListener
  // it could call with an arbitrary channel name.
  preview: {
    // Clear cached HTTP responses, service workers, and local storage before
    // changing project previews so a reused localhost port cannot display
    // the previous app's cached page.
    clearData: () => ipcRenderer.invoke("preview:clearData"),
    // Fires once, the first time the frontend dev server's URL becomes
    // known and it reports genuinely running (not just "a port was seen in
    // its output", which previewOps.ts deliberately treats as insufficient
    // -- see its own doc comment on why). Wire channel: "project-server:ready".
    onReady: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("project-server:ready", listener);
      return () => ipcRenderer.removeListener("project-server:ready", listener);
    },
    // Fires on every change to the full {frontend, backend} status object
    // (installing/starting/running/failed/exited, log lines, etc.) -- the
    // same shape GET /preview/status already returned, just pushed instead
    // of polled.
    onStatusChange: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("preview:statusChange", listener);
      return () => ipcRenderer.removeListener("preview:statusChange", listener);
    },
    // Oct 2026 addition: live dev-server console output. previewWatcher.js
    // diffs each service's captured stdout/stderr log against what it last
    // sent and pushes only the new lines here, payload {kind: "frontend" |
    // "backend", lines: string[]} -- NOT the same thing as the existing,
    // unrelated #terminal-panel/xterm.js shell (that's a real interactive
    // PTY, streamed over its own WebSocket straight from desktop-agent's
    // terminalWs.ts, never through Main-process IPC at all -- no channel-
    // name or protocol collision with this one). Channel name
    // "terminal:log-stream" per spec.
    onLogStream: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("terminal:log-stream", listener);
      return () => ipcRenderer.removeListener("terminal:log-stream", listener);
    },
    // Oct 2026 addition: auto-port-discovery diagnostic. portScanner.js
    // pings the standard dev-server ranges (3000-3005, 8000-8005) with
    // Node's native net module and pushes the set of ports currently
    // accepting connections -- informational only, see that file's doc
    // comment for why it never drives preview run status itself. Payload
    // {openPorts: number[], scannedRanges: {frontend:[lo,hi], backend:[lo,hi]}}.
    onPortScan: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("port-scan:update", listener);
      return () => ipcRenderer.removeListener("port-scan:update", listener);
    },
  },

  openFolderDialog: () => ipcRenderer.invoke("dialog:openFolder"),
  // See main.js's "shell:openInBrowser" handler's doc comment.
  openInBrowser: (projectPath, relativePath) => ipcRenderer.invoke("shell:openInBrowser", projectPath, relativePath),
  // See main.js's "shell:openExternal" handler's doc comment -- for a
  // running dev server's URL, not a project-relative file.
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // Real device sign-in -- see main.js's device-login block and
  // backend/app/api/device_auth.py for the full flow.
  auth: {
    getStoredSession: () => ipcRenderer.invoke("auth:getStoredSession"),
    startDeviceLogin: () => ipcRenderer.invoke("auth:startDeviceLogin"),
    cancelDeviceLogin: () => ipcRenderer.invoke("auth:cancelDeviceLogin"),
    signOut: () => ipcRenderer.invoke("auth:signOut"),
    // Polling updates pushed from the main process while a device login is
    // in progress -- {status: "pending"|"approved"|"denied"|"expired"|
    // "consumed"|"error", session?, message?}. Returns an unsubscribe fn.
    onDeviceLoginUpdate: (callback) => {
      const listener = (_event, update) => callback(update);
      ipcRenderer.on("auth:deviceLoginUpdate", listener);
      return () => ipcRenderer.removeListener("auth:deviceLoginUpdate", listener);
    },
  },

  // Real GitHub/GitLab PAT storage (Phase C, "Connect GitHub/GitLab") --
  // see main.js's git-credentials.enc block for the safeStorage-backed
  // implementation. listCredentials() never returns token values, only
  // {host, provider} pairs, for rendering "Connected: github.com" in the UI;
  // getCredential(host) is the one call that returns an actual token, used
  // immediately before a clone request and never cached by the renderer.
  git: {
    listCredentials: () => ipcRenderer.invoke("git:listCredentials"),
    getCredential: (host) => ipcRenderer.invoke("git:getCredential", host),
    setCredential: (host, provider, pat) => ipcRenderer.invoke("git:setCredential", host, provider, pat),
    clearCredential: (host) => ipcRenderer.invoke("git:clearCredential", host),
  },

  // Real SSH remote-target storage (Phase D, "Connect via SSH") -- see
  // main.js's ssh-targets.enc block for the safeStorage-backed
  // implementation. listTargets() never returns password/passphrase
  // values, only connection metadata, for rendering the "This PC ▾"
  // picker's saved list; getTarget(id) is the one call that returns a
  // target's full entry (including any saved secret), used immediately
  // before a POST /remote/connect call and never cached by the renderer.
  ssh: {
    listTargets: () => ipcRenderer.invoke("ssh:listTargets"),
    getTarget: (id) => ipcRenderer.invoke("ssh:getTarget", id),
    setTarget: (target) => ipcRenderer.invoke("ssh:setTarget", target),
    deleteTarget: (id) => ipcRenderer.invoke("ssh:deleteTarget", id),
  },

  // "Configure the real models" -- real AI provider API keys, typed by the
  // user directly into this app's own Settings window and stored via
  // main.js's safeStorage-backed model-keys.enc (same pattern as git.*
  // above). list() never returns key values, only {provider, configured,
  // model?, baseUrl?} -- for rendering which providers are already set up
  // without the renderer ever holding a real secret. setKey(provider,
  // {apiKey, model?}) (or {baseUrl} for "ollama") is the one call that
  // carries an actual secret, sent straight to the main process over the
  // already-isolated IPC channel and never written anywhere else by the
  // renderer itself.
  models: {
    list: () => ipcRenderer.invoke("models:list"),
    setKey: (provider, value) => ipcRenderer.invoke("models:setKey", provider, value),
    clearKey: (provider) => ipcRenderer.invoke("models:clearKey", provider),
  },
});
