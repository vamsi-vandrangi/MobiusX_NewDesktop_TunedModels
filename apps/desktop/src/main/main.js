const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const AGENT_DIR = path.join(__dirname, "..", "..", "..", "desktop-agent");
const READY_PREFIX = "MOBIUSX_AGENT_READY ";
const AGENT_START_TIMEOUT_MS = 15000;

let agentProcess = null;
let mainWindow = null;

function resolveTsxBin() {
  // Hoisted to the workspace root by npm workspaces.
  const bin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return path.join(__dirname, "..", "..", "..", "..", "node_modules", ".bin", bin);
}

/** Spawns the Local Agent Service and resolves once it reports its port+token on stdout. */
function startAgent() {
  return new Promise((resolve, reject) => {
    const builtEntry = path.join(AGENT_DIR, "dist", "index.js");
    const useBuilt = fs.existsSync(builtEntry);

    const child = useBuilt
      ? spawn(process.execPath, [builtEntry], { cwd: AGENT_DIR })
      : spawn(resolveTsxBin(), [path.join(AGENT_DIR, "src", "index.ts")], { cwd: AGENT_DIR });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("desktop-agent did not report ready within " + AGENT_START_TIMEOUT_MS + "ms"));
      }
    }, AGENT_START_TIMEOUT_MS);

    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(READY_PREFIX) && !settled) {
          settled = true;
          clearTimeout(timeout);
          try {
            const { port, token } = JSON.parse(line.slice(READY_PREFIX.length));
            resolve({ port, token });
          } catch (err) {
            reject(err);
          }
        } else if (line.trim().length > 0) {
          console.log("[desktop-agent]", line);
        }
      }
    });
    child.stderr.on("data", (chunk) => console.error("[desktop-agent:err]", chunk.toString("utf8")));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("desktop-agent exited early with code " + code));
      }
    });

    agentProcess = child;
  });
}

async function createWindow() {
  let agentInfo;
  try {
    agentInfo = await startAgent();
  } catch (err) {
    dialog.showErrorBox(
      "MobiusX Desktop — Local Agent failed to start",
      String(err && err.message ? err.message : err) +
        "\n\nRun `npm install` at the repo root, then `npm run build -w apps/desktop-agent` and try again.",
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "MobiusX Desktop",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--mobiusx-agent=${JSON.stringify(agentInfo)}`],
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  if (agentProcess) agentProcess.kill();
});
