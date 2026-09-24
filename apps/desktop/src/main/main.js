const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session, safeStorage } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// In dev (`electron .` from this repo), the two sibling services
// (desktop-agent, cloud-agent-gateway) and their @mobiusx/* dependencies
// live on disk at ../../../<service> relative to this file (apps/desktop/
// src/main -> apps), exactly where npm workspaces put them.
//
// A packaged app has no such monorepo tree -- electron-builder's
// extraResources config (see apps/desktop/package.json's "build" block)
// copies a self-contained bundle assembled by
// apps/desktop/scripts/prepare-resources.js into resources/apps and
// resources/node_modules instead, sitting next to the app's own asar
// (process.resourcesPath). app.isPackaged is the one reliable signal for
// which layout applies; both branches resolve to a directory that directly
// contains desktop-agent/ and cloud-agent-gateway/ subfolders, which is all
// startService() below actually needs.
const APPS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "apps")
  : path.join(__dirname, "..", "..", "..");
const START_TIMEOUT_MS = 15000;

// package.json's "name" is the npm-scoped "@mobiusx/desktop-shell" — Electron
// can't use that as a display name, so without this it silently falls back
// to "Electron" everywhere the OS shows an app name (menu bar, Cmd+Tab,
// About panel). Must run before app.whenReady()/createWindow() to take
// effect. "productName" in package.json is set to match, for when this is
// eventually packaged with electron-builder/electron-forge, which read that
// field instead of calling this API.
app.setName("MobiusX.ai");

const ICON_PATH = path.join(__dirname, "..", "..", "assets", "icon-1024.png");

// Electron's own multi-process architecture (a separate OS process each for
// the main process, the GPU process, and every renderer — the same reason
// Chrome/VS Code/Slack each show up as several rows in Activity Monitor) is
// often mistaken for "multiple copies of the app running." That's normal and
// not a bug. What IS worth guarding against is a genuine second *instance* —
// e.g. re-running `npm run start -w apps/desktop` without having fully
// stopped a previous run — which would spawn a second full app (its own
// window, its own desktop-agent/cloud-agent-gateway child processes on their
// own ports) alongside the first. This lock makes a second launch instead
// hand off to the first instance and quit immediately.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Deep-link handoff for sign-in -- see the device-login block below and
// frontend/app/activate-device/page.tsx. Once the user approves in their
// browser, that page best-effort redirects to mobiusx://signed-in, which
// the OS routes back to this app (registered via package.json's
// build.protocols) instead of leaving the user staring at a browser tab
// wondering if anything happened. The link itself carries no secret and
// isn't trusted with anything on its own -- it's just a "come back and
// check now" nudge. The real session still only ever arrives through
// /auth/device/poll below (the same call the 3s interval already makes),
// so a forged or replayed mobiusx:// URL can't hand anyone a session by
// itself; at worst it just triggers an extra, harmless poll.
let pendingDeepLinkUrl = null;

function handleDeepLink(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("mobiusx://")) return;
  if (!mainWindow) {
    pendingDeepLinkUrl = rawUrl;
    return;
  }
  console.log("[deep-link] received", rawUrl);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // If a device-login poll is in flight, check right now instead of
  // waiting up to 3s for the next scheduled tick -- this is what makes
  // approving in the browser feel instant rather than laggy.
  if (deviceLoginPollTimer && currentDeviceLoginDeviceCode) {
    const deviceCode = currentDeviceLoginDeviceCode;
    clearInterval(deviceLoginPollTimer);
    void pollDeviceLoginOnce(deviceCode);
    deviceLoginPollTimer = setInterval(() => pollDeviceLoginOnce(deviceCode), 3000);
  }
}

if (app.isPackaged) {
  app.setAsDefaultProtocolClient("mobiusx");
}

// macOS delivers mobiusx:// launches through this event (Windows/Linux use
// second-instance below instead) -- registered up top, not inside
// app.whenReady().then(...), since it can fire before that resolves.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

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

    // THE actual cause of "3 desktop apps opening" (confirmed from a Dock
    // screenshot showing one MobiusX icon + two bare Electron icons): when a
    // sibling service has been built (dist/index.js exists), this spawns
    // `process.execPath` — which, inside an Electron app, IS the Electron
    // binary itself, not plain Node — to run that service's compiled JS.
    // Without ELECTRON_RUN_AS_NODE=1, Electron doesn't treat that argument as
    // "a script to run under Node": it treats it as "an app to launch," and
    // boots a second full Electron/Chromium instance for it — one per built
    // service, each showing its own unbranded Dock icon (since it never runs
    // this file's app.setName/dock.setIcon calls). Setting this env var makes
    // Electron behave as a pure Node.js runtime for the child, exactly like
    // the tsx branch below already does. This bug was latent (it only
    // triggers once dist/ exists) and only started firing after building
    // apps/desktop-agent and apps/cloud-agent-gateway to verify an earlier,
    // unrelated fix in this same session.
    const child = useBuilt
      ? spawn(process.execPath, [builtEntry], { cwd: dir, env: { ...spawnEnv, ELECTRON_RUN_AS_NODE: "1" } })
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
    // Sets the window icon (used on Windows/Linux taskbars, and as a
    // fallback everywhere else); macOS's Dock icon is set separately below
    // via app.dock.setIcon since that's the API macOS actually reads from
    // in unpackaged/dev-mode runs.
    icon: ICON_PATH,
    // Electron defaults this to false on macOS, meaning a click on the
    // window while it's NOT the frontmost app only focuses/activates the
    // window and does not reach the web content -- the user has to click
    // a second time for the button/tab they clicked to actually do
    // anything. That's a real, reported bug: switch to another app (the
    // embedded terminal, a browser, an editor) and back, then click a
    // button here as your first action, and nothing visibly happens.
    // true makes the very first click both focus the window AND register
    // normally, matching how most native macOS apps behave.
    acceptsFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [
        `--mobiusx-agent=${JSON.stringify(agentInfo)}`,
        `--mobiusx-cloud=${JSON.stringify(cloudInfo)}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      // Live Preview (item 6, phase 2): the Workspace's Preview panel embeds
      // a <webview> pointed at the open project's own dev server
      // (127.0.0.1, spawned by desktop-agent -- see previewOps.ts). Off by
      // default in Electron; each <webview> still runs in its own separate
      // process/context from this window, same isolation model as a regular
      // browser tab.
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

// macOS-only: sets the Dock icon at runtime. This is the one piece of
// branding that genuinely works before packaging — app.setName() fixes the
// menu bar/Cmd+Tab text in dev mode too, but the Dock icon and the
// Activity Monitor process name stay "Electron" until this app is actually
// packaged (electron-builder/electron-forge) with a real .icns/.ico, which
// is a separate, bigger step than this fix. Wrapped defensively since
// app.dock is undefined on Windows/Linux.
function setDockIcon() {
  if (process.platform !== "darwin" || !app.dock) return;
  try {
    const image = nativeImage.createFromPath(ICON_PATH);
    if (!image.isEmpty()) app.dock.setIcon(image);
  } catch (err) {
    console.error("[main] failed to set Dock icon", err);
  }
}

/**
 * Opens an arbitrary URL in the user's default OS browser -- used by the
 * Preview panel's "open in browser" button. Distinct from
 * shell:openInBrowser above, which only ever opens a path *inside the open
 * project*; this one is for a running dev server's http://127.0.0.1:PORT
 * URL, which isn't a project-relative file at all.
 */
ipcMain.handle("shell:openExternal", async (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    return { ok: false, error: "url must be an http(s) URL" };
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * Opens a project-relative file (e.g. an applied Build-mode edit's .html
 * output) in the user's default OS browser/app — the gap behind "generated
 * a frontend app but MobiusX desktop was unable to open it in the browser":
 * until this handler existed, nothing in this app ever called
 * shell.openPath/openExternal, so there was genuinely no way to launch a
 * written file outside the app itself. Mirrors the same project-root
 * containment check apps/desktop-agent/src/fsOps.ts#resolveWithinProject
 * uses server-side, since this is the same "don't let a path argument
 * escape the open project" boundary, just enforced here for a renderer-
 * supplied relative path instead.
 */
ipcMain.handle("shell:openInBrowser", async (_event, projectPath, relativePath) => {
  if (typeof projectPath !== "string" || typeof relativePath !== "string" || !projectPath || !relativePath) {
    return { ok: false, error: "missing project path or file path" };
  }
  if (path.isAbsolute(relativePath)) {
    return { ok: false, error: "path must be relative to the open project" };
  }
  const abs = path.resolve(path.join(projectPath, relativePath));
  const rel = path.relative(projectPath, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "path escapes the open project root" };
  }
  const error = await shell.openPath(abs);
  return error ? { ok: false, error } : { ok: true };
});

// ------------------------------------------------------------------
// Device sign-in (see backend/app/api/device_auth.py)
// ------------------------------------------------------------------
// Until now this app showed a hardcoded "Vamsi, AI Architect" profile no
// matter who was actually running it (a tester on Windows reported seeing
// the same fake identity). This mints a real session through the same
// device-authorization-grant flow GitHub CLI / Docker Desktop use: the app
// requests a short code, opens the user's browser to approve it (they must
// already be signed in to MobiusX.ai there), and polls until that happens.
// The resulting session is a real backend UserSession -- subject to
// sign-out, "Active Sessions", and the org's concurrent-session cap like
// any other login -- not a parallel, app-only credential.
//
// Stored encrypted at rest with Electron's safeStorage (OS keychain-backed)
// rather than plain JSON, since this is a real long-lived credential now,
// unlike the per-process CLI-flag tokens (agentToken/cloudToken) preload.js
// hands the renderer for the local agent/cloud-gateway services.
const MOBIUSX_API_URL = process.env.MOBIUSX_API_URL || "https://api.mobiusx.co";
const MOBIUSX_FRONTEND_URL = process.env.MOBIUSX_FRONTEND_URL || "https://mobiusx.co";

function deviceDisplayName() {
  const platformLabel =
    process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  return `${os.hostname()} (${platformLabel})`;
}

function sessionFilePath() {
  return path.join(app.getPath("userData"), "session.enc");
}

function loadStoredSession() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = fs.readFileSync(sessionFilePath());
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch {
    return null; // no file yet, or it's unreadable -- either way, not signed in
  }
}

function saveStoredSession(authSession) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error("[auth] OS keychain unavailable -- can't persist the session securely; you'll need to sign in again next launch.");
      return;
    }
    fs.writeFileSync(sessionFilePath(), safeStorage.encryptString(JSON.stringify(authSession)));
  } catch (err) {
    console.error("[auth] failed to persist session:", err);
  }
}

function clearStoredSession() {
  try {
    fs.unlinkSync(sessionFilePath());
  } catch {
    // Nothing to remove -- fine.
  }
}

let deviceLoginPollTimer = null;
let currentDeviceLoginDeviceCode = null;

function stopDeviceLoginPoll() {
  if (deviceLoginPollTimer) {
    clearInterval(deviceLoginPollTimer);
    deviceLoginPollTimer = null;
  }
  currentDeviceLoginDeviceCode = null;
}

// Pulled out of the setInterval below so handleDeepLink() can also fire
// one off-cycle, immediately, instead of only ever running on the 3s
// clock.
async function pollDeviceLoginOnce(deviceCode) {
  let body;
  try {
    const res = await fetch(`${MOBIUSX_API_URL}/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (!res.ok) {
      stopDeviceLoginPoll();
      mainWindow?.webContents.send("auth:deviceLoginUpdate", { status: "error", message: `HTTP ${res.status}` });
      return;
    }
    body = await res.json();
  } catch {
    // A transient network blip -- keep polling rather than failing the
    // whole flow over one dropped request.
    return;
  }

  if (body.status === "approved") {
    stopDeviceLoginPoll();
    saveStoredSession(body.session);
    mainWindow?.webContents.send("auth:deviceLoginUpdate", { status: "approved", session: body.session });
  } else if (body.status === "pending") {
    mainWindow?.webContents.send("auth:deviceLoginUpdate", { status: "pending" });
  } else {
    // expired | denied | consumed
    stopDeviceLoginPoll();
    mainWindow?.webContents.send("auth:deviceLoginUpdate", { status: body.status });
  }
}

ipcMain.handle("auth:getStoredSession", () => loadStoredSession());

ipcMain.handle("auth:signOut", () => {
  stopDeviceLoginPoll();
  clearStoredSession();
  return { ok: true };
});

ipcMain.handle("auth:cancelDeviceLogin", () => {
  stopDeviceLoginPoll();
  return { ok: true };
});

ipcMain.handle("auth:startDeviceLogin", async () => {
  stopDeviceLoginPoll();

  let start;
  try {
    const res = await fetch(`${MOBIUSX_API_URL}/auth/device/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: deviceDisplayName() }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    start = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't reach MobiusX.ai (${err.message}). Check your connection and try again.`,
    };
  }

  // Best-effort, and the URL itself never shows the user_code as anything
  // they need to read or type -- /activate-device auto-looks it up the
  // moment the page loads (see that file's docstring). If the browser
  // doesn't open (no default browser configured, remote/headless machine),
  // the sign-in overlay's "Open browser" button re-opens the same URL.
  shell.openExternal(`${start.verification_url}?code=${encodeURIComponent(start.user_code)}`).catch(() => {});

  currentDeviceLoginDeviceCode = start.device_code;
  deviceLoginPollTimer = setInterval(() => pollDeviceLoginOnce(start.device_code), 3000);

  return {
    ok: true,
    userCode: start.user_code,
    verificationUrl: start.verification_url,
    expiresAt: start.expires_at,
  };
});

// Auto-update (electron-updater), wired to the same GitHub Releases the
// packaging config publishes to (see apps/desktop/package.json's
// build.publish). A no-op in dev: app.isPackaged is false for `electron .`,
// and autoUpdater.checkForUpdates() would otherwise just fail trying to
// read the app-update.yml that only exists inside a packaged build's
// resources/. Deliberately silent/log-only on the "no update" and "checking"
// paths -- only update-downloaded is worth interrupting the user for.
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (err) => console.error("[autoUpdater]", err));
  autoUpdater.on("checking-for-update", () => console.log("[autoUpdater] checking for update"));
  autoUpdater.on("update-available", (info) => console.log("[autoUpdater] update available:", info.version));
  autoUpdater.on("update-not-available", () => console.log("[autoUpdater] up to date"));
  autoUpdater.on("update-downloaded", (info) => {
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `MobiusX.ai ${info.version} has been downloaded.`,
        detail: "Restart the app to finish installing this update. You can also keep working -- it installs automatically the next time you quit.",
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      });
  });
  autoUpdater.checkForUpdates().catch((err) => console.error("[autoUpdater] check failed", err));
}

app.whenReady().then(() => {
  // Voice input (AI Assistant add-on): the renderer's mic button uses
  // getUserMedia({ audio: true }) to record a prompt, then POSTs it to
  // MobiusX Cloud Gateway's /transcribe (see renderer.js's voice-input
  // block). Electron auto-denies "media" permission requests unless
  // explicitly allowed here -- this only controls Electron's own layer;
  // NSMicrophoneUsageDescription is already present in the branded
  // Electron.app's own Info.plist (see scripts/brand-electron-mac.js), so
  // macOS still shows its own native permission prompt on first use.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  setDockIcon();
  createWindow().then(() => {
    setupAutoUpdater();
    // Windows/Linux cold launch via a mobiusx:// link (app wasn't already
    // running): the URL arrives as a plain argv entry rather than through
    // open-url. macOS's open-url can also fire before this .then() runs,
    // in which case it's parked in pendingDeepLinkUrl above.
    const argvDeepLink = process.argv.find((arg) => typeof arg === "string" && arg.startsWith("mobiusx://"));
    if (argvDeepLink) handleDeepLink(argvDeepLink);
    else if (pendingDeepLinkUrl) handleDeepLink(pendingDeepLinkUrl);
  });
});

// See the requestSingleInstanceLock() call above — a second launch quits
// itself and instead triggers this on the first instance, which just
// refocuses the existing window rather than doing nothing silently. On
// Windows/Linux this is also how a mobiusx:// deep-link click reaches an
// already-running instance -- the OS relaunches the protocol handler,
// which immediately hands off to the first instance via this event, with
// the URL as one of commandLine's argv entries (macOS uses open-url
// instead, registered up top).
app.on("second-instance", (_event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const deepLink = commandLine.find((arg) => typeof arg === "string" && arg.startsWith("mobiusx://"));
  if (deepLink) handleDeepLink(deepLink);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  for (const child of childProcesses) child.kill();
});
