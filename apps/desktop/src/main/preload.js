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
});
