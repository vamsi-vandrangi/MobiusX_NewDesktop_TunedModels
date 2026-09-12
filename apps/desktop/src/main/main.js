const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const APPS_DIR = path.join(__dirname, "..", "..", "..");
const START_TIMEOUT_MS = 15000;

const childProcesses = [];
let mainWindow = null;

function resolveTsxBin() {
  // Hoisted to the workspace root by npm workspaces.
  const bin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  return path.join(APPS_DIR, "..", "node_modules", ".bin", bin);
}

/**
 * Spawns a sibling Node service (desktop-agent or cloud-agent-gateway) and
 * resolves once it prints its `<readyPrefix> {"port":...,"token":...}`
 * handshake line on stdout — the same pattern both services use so this one
 * function can start either of them.
 */
function startService({ label, dir, readyPrefix, env }) {
  return new Promise((resolve, reject) => {
    const builtEntry = path.join(dir, "dist", "index.js");
    const useBuilt = fs.existsSync(builtEntry);
    const spawnEnv = { ...process.env, ...env };

    const child = useBuilt
      ? spawn(process.execPath, [builtEntry], { cwd: dir, env: spawnEnv })
      : spawn(resolveTsxBin(), [path.join(dir, "src", "index.ts")], { cwd: dir, env: spawnEnv });

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`${label} did not report ready within ${START_TIMEOUT_MS}ms`));
      }
    }, START_TIMEOUT_MS);

    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(readyPrefix) && !settled) {
          settled = true;
          clearTimeout(timeout);
          try {
            const { port, token } = JSON.parse(line.slice(readyPrefix.length));
            resolve({ port, token });
          } catch (err) {
            reject(err);
          }
        } else if (line.trim().length > 0) {
          console.log(`[${label}]`, line);
        }
      }
    });
    child.stderr.on("data", (chunk) => console.error(`[${label}:err]`, chunk.toString("utf8")));
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
        reject(new Error(`${label} exited early with code ${code}`));
      }
    });

    childProcesses.push(child);
  });
}

function startAgent() {
  return startService({
    label: "desktop-agent",
    dir: path.join(APPS_DIR, "desktop-agent"),
    readyPrefix: "MOBIUSX_AGENT_READY ",
  });
}

function startCloudGateway() {
  // ANTHROPIC_API_KEY / ANTHROPIC_MODEL, if the user has them set in their
  // own shell environment, pass straight through — this process never sets
  // or hardcodes either. See apps/cloud-agent-gateway/README.md.
  return startService({
    label: "cloud-agent-gateway",
    dir: path.join(APPS_DIR, "cloud-agent-gateway"),
    readyPrefix: "MOBIUSX_CLOUD_READY ",
  });
}

async function createWindow() {
  let agentInfo;
  let cloudInfo;
  try {
    // Independent services — start them concurrently rather than serially.
    [agentInfo, cloudInfo] = await Promise.all([startAgent(), startCloudGateway()]);
  } catch (err) {
    dialog.showErrorBox(
      "MobiusX Desktop — a background service failed to start",
      String(err && err.message ? err.message : err) +
        '\n\nRun `npm install` at the repo root, then `npm run build -w apps/desktop-agent -w apps/cloud-agent-gateway` and try again.',
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
      additionalArguments: [
        `--mobiusx-agent=${JSON.stringify(agentInfo)}`,
        `--mobiusx-cloud=${JSON.stringify(cloudInfo)}`,
      ],
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
  for (const child of childProcesses) child.kill();
});
