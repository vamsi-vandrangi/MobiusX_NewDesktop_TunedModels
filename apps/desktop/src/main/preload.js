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
});
