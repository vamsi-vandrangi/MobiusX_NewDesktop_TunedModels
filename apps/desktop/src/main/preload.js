const { contextBridge, ipcRenderer } = require("electron");

function readAgentInfo() {
  const flag = process.argv.find((a) => a.startsWith("--mobiusx-agent="));
  if (!flag) return { port: null, token: null };
  try {
    return JSON.parse(flag.slice("--mobiusx-agent=".length));
  } catch {
    return { port: null, token: null };
  }
}

const { port, token } = readAgentInfo();

contextBridge.exposeInMainWorld("mobiusx", {
  agentBaseUrl: port ? `http://127.0.0.1:${port}` : null,
  agentWsUrl: port ? `ws://127.0.0.1:${port}` : null,
  agentToken: token,
  openFolderDialog: () => ipcRenderer.invoke("dialog:openFolder"),
});
