const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session, safeStorage, net } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { startPreviewWatcher } = require("./previewWatcher");
const { startPortScanWatcher } = require("./portScanner");

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

// ------------------------------------------------------------------
// Real model provider keys ("Configure the real models")
// ------------------------------------------------------------------
// cloud-agent-gateway's runners (see its src/runners/registry.ts) read
// ANTHROPIC_API_KEY/ANTHROPIC_MODEL, GROQ_API_KEY, OPENROUTER_API_KEY,
// DEEPSEEK_API_KEY, CEREBRAS_API_KEY, and OLLAMA_BASE_URL directly off
// process.env -- there
// has never been an in-app Settings field for any of these, only a comment
// pointing at "your own shell environment". That comment was quietly wrong
// for the app's actual normal usage: a packaged app launched by double-
// clicking it from Finder/the Dock/Spotlight gets a minimal env from
// launchd, NOT the shell-profile exports in ~/.zshrc or ~/.zprofile (those
// only apply to a shell you open yourself and only reach this app if you
// then start it from THAT shell, e.g. `open -a MobiusX.ai`) -- so a key a
// user "export"s in their profile and expects the app to pick up on a
// normal launch silently never arrives, and the app falls back to the demo
// reviewer with no visible explanation why.
//
// Fix: a small, user-editable, plain KEY=VALUE file at ~/.mobiusx/model-
// keys.env (same ~/.mobiusx convention already used for settings.json,
// knowledge-sources.json, etc. -- see packages/agent-settings), loaded here
// and merged into cloud-agent-gateway's spawn env on every launch,
// regardless of how the app itself was started. This file is created once,
// empty/commented-out, the first time the app runs if it doesn't exist yet,
// so there is always one obvious, discoverable place to paste a real key --
// never typed, pasted, or generated by this code itself.
//
// That file is still a Terminal/text-editor workflow, though, so there is
// ALSO a real in-app field for this now (Settings → Application Settings →
// "AI Model Provider Keys"): the user types their own key directly into a
// password-style input in this app's own window, exactly like the existing
// Connect GitHub/GitLab PAT field, and it's stored the same safeStorage
// (OS-keychain-backed) way as git-credentials.enc/ssh-targets.enc below --
// see modelKeysSecretFilePath() a few lines down. That UI path and this
// file are deliberately independent and additive (the UI field is checked
// first, see startCloudGateway() below) -- this file remains useful for
// OLLAMA_BASE_URL (not a secret, no natural "key" field) and for anyone who
// just prefers editing a text file.
function modelKeysFilePath() {
  return path.join(os.homedir(), ".mobiusx", "model-keys.env");
}

// Single source of truth for the Anthropic default model id, referenced
// below in the plain-file template AND (see secretModelKeysToEnv) actually
// applied when the in-app Settings field is left blank -- see that
// function's comment for why this one needs to be a real, applied default
// rather than just a suggestion.
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

const MODEL_KEYS_TEMPLATE = `# MobiusX Desktop -- real AI model provider keys
#
# This file is read once, each time MobiusX Desktop starts, and merged into
# the background AI service's environment. It is NOT part of the app bundle,
# NOT committed to any git repo (it lives in your home folder, outside any
# project). The configured key is used to call the selected API endpoint
# over HTTPS. For routing services such as xKiro and APInex, prompts also
# pass through that service and its chosen upstream model provider.
#
# To enable a provider: delete the leading "# " from its lines below and
# paste your real key after the "=". Save the file, then quit and reopen
# MobiusX Desktop (it only reads this file at launch). Leave a provider's
# lines commented out (or delete them) to leave it unconfigured -- the app
# will just skip it and fall back to whichever configured provider is next,
# or to the clearly-labeled demo reviewer if none are configured.
#
# You can enable as many of these as you like at once; a per-task model
# picker in the app lets you choose which one actually runs a given task.

# --- Anthropic (Claude) ------------------------------------------------
# Get a key at https://console.anthropic.com/settings/keys
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_MODEL=${ANTHROPIC_DEFAULT_MODEL}

# --- Groq (fast open-weight models; also powers voice dictation) -------
# Get a key at https://console.groq.com/keys
# GROQ_API_KEY=gsk_...

# --- OpenRouter (routes to many hosted models) --------------------------
# Get a key at https://openrouter.ai/keys
# OPENROUTER_API_KEY=sk-or-...

# --- DeepSeek (paid/metered -- never auto-selected, must be chosen by hand) -
# Get a key at https://platform.deepseek.com/api_keys
# DEEPSEEK_API_KEY=sk-...

# --- Cerebras (fast inference; $5 free trial then metered -- never auto-
#     selected, must be chosen by hand, same as DeepSeek) ----------------
# Get a key at https://cloud.cerebras.ai/platform/
# CEREBRAS_API_KEY=csk-...

# --- xKiro (OpenAI-compatible model router; free-tier limits apply) -----
# Create a key at https://xkiro.com
# XKIRO_API_KEY=...

# --- APInex (OpenAI-compatible model router; free-tier limits apply) ----
# Create a key at https://apinex.bond
# APINEX_API_KEY=...

# --- Ollama (local, on this machine -- no key needed) -------------------
# Only needed if Ollama isn't running on the default local port. Install
# from https://ollama.com, then \`ollama pull <model>\` at least one model.
# OLLAMA_BASE_URL=http://127.0.0.1:11434
`;

/**
 * Creates ~/.mobiusx/model-keys.env with the commented-out template if it
 * doesn't exist yet (first launch only -- never overwrites a file the user
 * has since edited), then parses whatever's there into a plain {KEY: value}
 * object. Deliberately minimal (not a full dotenv implementation): one
 * KEY=VALUE per line, optional surrounding quotes stripped, '#' lines and
 * blank lines skipped, no multi-line values, no variable interpolation --
 * all that's needed for pasting in API keys.
 */
function loadModelKeysEnv() {
  const filePath = modelKeysFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, MODEL_KEYS_TEMPLATE, { mode: 0o600 });
      return {};
    }
  } catch (err) {
    console.error("[models] couldn't create/access", filePath, err);
    return {};
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    console.error("[models] couldn't read", filePath, err);
    return {};
  }

  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  const configured = Object.keys(env).filter((k) => k.endsWith("_API_KEY"));
  if (configured.length > 0) {
    console.log(`[models] loaded ${configured.length} provider key(s) from ${filePath}:`, configured.join(", "));
  }
  return env;
}

// In-app "key in your own API key" field (Settings → Application Settings →
// "AI Model Provider Keys"). Same safeStorage (OS-keychain-backed)
// encrypt-at-rest pattern, and the same never-log-the-secret discipline, as
// gitCredentialsFilePath()/sshTargetsFilePath() above -- its own small
// file, its own shape: { [provider]: { apiKey?: string, model?: string,
// baseUrl?: string } } for provider in "anthropic"|"groq"|"openrouter"|
// "deepseek"|"cerebras"|"xkiro"|"apinex"|"ollama" (ollama has no apiKey,
// just an optional baseUrl).
const MODEL_KEY_PROVIDERS = ["anthropic", "groq", "openrouter", "deepseek", "cerebras", "xkiro", "apinex", "ollama"];

function modelKeysSecretFilePath() {
  return path.join(app.getPath("userData"), "model-keys.enc");
}

function loadSecretModelKeys() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const encrypted = fs.readFileSync(modelKeysSecretFilePath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // no file yet, or it's unreadable -- either way, no saved keys
  }
}

function saveSecretModelKeys(all) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error("[models] OS keychain unavailable -- can't persist this key securely; you'll need to paste it in again next time.");
      return false;
    }
    fs.writeFileSync(modelKeysSecretFilePath(), safeStorage.encryptString(JSON.stringify(all)));
    return true;
  } catch (err) {
    console.error("[models] failed to persist provider key:", err);
    return false;
  }
}

/** Translates the saved {provider: {apiKey, model, baseUrl}} shape into the
 * exact env var names cloud-agent-gateway's runners read (see registry.ts).
 *
 * Bug fixed Oct 2026 (found live: a real user saved an Anthropic key via
 * Settings, left the model field blank exactly as its own placeholder text
 * invites -- "claude-sonnet-4-5-20250929 (optional — default shown)" -- and
 * restarted, expecting Claude to be available. It silently never was: this
 * function used to set ANTHROPIC_MODEL only `if (entry.model)`, so a blank
 * field meant the env var was never set at all, and anthropicRunner.ts's
 * isAnthropicConfigured() requires BOTH ANTHROPIC_API_KEY and
 * ANTHROPIC_MODEL -- by design, that runner never assumes a model version
 * on its own (see its doc comment: "a wrong hardcoded model string fails
 * louder than just staying on the demo runner"). That's the right call
 * for cloud-agent-gateway itself, but it means THIS layer, the one place
 * that actually renders a Settings UI promising a default, is the one
 * place a real default has to be applied -- otherwise "optional, default
 * shown" is simply false, and the Settings page shows "Configured" for an
 * integration that can never run a task. Only applies when an API key was
 * actually saved; an empty model field with no key still yields no env var,
 * same as before. */
function secretModelKeysToEnv(all) {
  const env = {};
  const apiKeyEnvVar = { anthropic: "ANTHROPIC_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY", deepseek: "DEEPSEEK_API_KEY", cerebras: "CEREBRAS_API_KEY", xkiro: "XKIRO_API_KEY", apinex: "APINEX_API_KEY" };
  for (const [provider, entry] of Object.entries(all || {})) {
    if (!entry) continue;
    if (apiKeyEnvVar[provider] && entry.apiKey) env[apiKeyEnvVar[provider]] = entry.apiKey;
    if (provider === "anthropic" && entry.apiKey) env.ANTHROPIC_MODEL = (entry.model && entry.model.trim()) || ANTHROPIC_DEFAULT_MODEL;
    if (provider === "ollama" && entry.baseUrl) env.OLLAMA_BASE_URL = entry.baseUrl;
  }
  return env;
}

// `list` only ever reports WHICH providers have a saved key/value and (for
// Anthropic) which model, never the key itself -- same pattern as
// git:listCredentials above, for rendering "configured" state in Settings
// without the renderer ever holding a real secret.
ipcMain.handle("models:list", () => {
  const all = loadSecretModelKeys();
  return MODEL_KEY_PROVIDERS.map((provider) => {
    const entry = all[provider];
    return {
      provider,
      configured: provider === "ollama" ? Boolean(entry?.baseUrl) : Boolean(entry?.apiKey),
      model: provider === "anthropic" ? entry?.model || "" : undefined,
      baseUrl: provider === "ollama" ? entry?.baseUrl || "" : undefined,
    };
  });
});

ipcMain.handle("models:setKey", (_event, provider, value) => {
  if (!MODEL_KEY_PROVIDERS.includes(provider)) return { ok: false, error: "unknown provider" };
  const all = loadSecretModelKeys();
  if (provider === "ollama") {
    const baseUrl = (value?.baseUrl || "").trim();
    if (!baseUrl) return { ok: false, error: "base URL is required" };
    all.ollama = { baseUrl };
  } else {
    const apiKey = (value?.apiKey || "").trim();
    if (!apiKey) return { ok: false, error: "API key is required" };
    all[provider] = { apiKey, ...(provider === "anthropic" && value?.model ? { model: value.model.trim() } : {}) };
  }
  const ok = saveSecretModelKeys(all);
  return ok ? { ok: true } : { ok: false, error: "Couldn't reach the OS keychain to store this key securely." };
});

ipcMain.handle("models:clearKey", (_event, provider) => {
  const all = loadSecretModelKeys();
  delete all[provider];
  saveSecretModelKeys(all);
  return { ok: true };
});

function startCloudGateway() {
  // Real model provider env vars, two sources, layered on top of whatever
  // this process's own environment already has (so a real shell-exported
  // key from a dev workflow still works, unshadowed by either source being
  // empty): first ~/.mobiusx/model-keys.env (loadModelKeysEnv() above),
  // then the in-app Settings field's encrypted store (secretModelKeysToEnv
  // above) -- the in-app field wins when both set the same var, since it's
  // the more discoverable, more recently-touched path. This process never
  // sets, generates, or hardcodes any key itself -- only relays what the
  // user put in one of these two places.
  return startService({
    label: "cloud-agent-gateway",
    dir: path.join(APPS_DIR, "cloud-agent-gateway"),
    readyPrefix: "MOBIUSX_CLOUD_READY ",
    env: { ...loadModelKeysEnv(), ...secretModelKeysToEnv(loadSecretModelKeys()) },
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
      // Explicit, not relied-upon-as-default: Electron only *implies*
      // sandbox:true when contextIsolation is on and nodeIntegration is
      // off (both true here) -- which happens to match this window's
      // settings today, but a later edit to either of those two flags
      // would silently also turn sandboxing off with it if this weren't
      // spelled out on its own line. Nothing in preload.js needs opting
      // out: it only calls contextBridge/ipcRenderer (both fully
      // available to a sandboxed preload) and touches no other Node
      // builtin (fs/path/os/crypto etc. all stay main-process-only).
      sandbox: true,
      // Live Preview (item 6, phase 2): the Workspace's Preview panel embeds
      // a <webview> pointed at the open project's own dev server
      // (127.0.0.1, spawned by desktop-agent -- see previewOps.ts). Off by
      // default in Electron; each <webview> still runs in its own separate
      // process/context from this window, same isolation model as a regular
      // browser tab. The <webview> tags themselves carry their own
      // sandbox="true" + partition attributes (index.html) -- webviewTag
      // here only makes the *element* legal to use at all, it does not
      // relax anything about how each individual tag then runs.
      webviewTag: true,
      // Explicit, matching the default: a project's own live preview (and
      // the right-pane's general browser tab) must never get same-origin
      // access to another origin's resources just because it's inside a
      // <webview> -- this window's webSecurity is never disabled anywhere,
      // for the main renderer or for any embedded <webview>.
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Security-hardening pass, item 2: Main-process port-watcher for the Live
  // Preview feature (see previewWatcher.js's doc comment for the full
  // reasoning) -- polls desktop-agent's existing /preview/status itself and
  // pushes "project-server:ready"/"preview:statusChange" over IPC, rather than
  // leaving that polling to the sandboxed renderer. Uses the exact same
  // agentInfo this window's own --mobiusx-agent flag was built from above.
  startPreviewWatcher(mainWindow, `http://127.0.0.1:${agentInfo.port}`, agentInfo.token);

  // Oct 2026 addition: auto-port-discovery diagnostic (see portScanner.js's
  // doc comment for why this stays a diagnostic signal -- pushed to the dev
  // console drawer, not the preview run-status state machine above).
  startPortScanWatcher(mainWindow);
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

ipcMain.handle("preview:clearData", async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error("preview data can only be cleared by the MobiusX window");
  }
  const previewSession = session.fromPartition("project-preview");
  await Promise.all([
    previewSession.clearCache(),
    previewSession.clearStorageData(),
  ]);
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
    // net.fetch (Electron's own fetch, routed through Chromium's network
    // stack -- the same one the renderer/browser uses) rather than the
    // global Node fetch. Node's fetch makes a direct connection and does
    // NOT pick up the OS's configured proxy, so on a network that routes
    // HTTPS through a system/corporate proxy it can hang indefinitely
    // with no error -- exactly the "stuck on Preparing sign-in..." /
    // "waiting forever" symptom this was fixed for. net.fetch inherits
    // Electron's session proxy resolution (which defaults to the system
    // proxy), matching what a real browser tab on this machine does.
    const res = await net.fetch(`${MOBIUSX_API_URL}/auth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      stopDeviceLoginPoll();
      mainWindow?.webContents.send("auth:deviceLoginUpdate", { status: "error", message: `HTTP ${res.status}` });
      return;
    }
    body = await res.json();
  } catch {
    // A transient network blip (including a poll that timed out) -- keep
    // polling rather than failing the whole flow over one dropped
    // request. The 10s timeout above just guarantees this catch is
    // reached instead of the call hanging past the next scheduled tick.
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
    // net.fetch, not the global fetch -- see pollDeviceLoginOnce's comment
    // below for why (Node's fetch bypasses the OS/session proxy and can
    // hang indefinitely on some networks). The 15s timeout means a hung
    // request always resolves into a visible, retryable error rather than
    // leaving "Preparing sign-in..." spinning forever with no way out
    // short of force-quitting the app.
    const res = await net.fetch(`${MOBIUSX_API_URL}/auth/device/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: deviceDisplayName() }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    start = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: err.name === "TimeoutError" || err.name === "AbortError"
        ? "Couldn't reach MobiusX.ai (timed out). Check your connection and try again."
        : `Couldn't reach MobiusX.ai (${err.message}). Check your connection and try again.`,
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

// Git host credentials (Phase C, "Connect GitHub/GitLab"): a personal
// access token the user pastes in, one per host (github.com, gitlab.com, or
// a self-hosted instance's hostname), used to authenticate real `git clone`
// calls the desktop agent makes and to enable the git host's HTTPS remotes
// for a project already open. This is deliberately NOT the same file as
// session.enc above -- that's the MobiusX.ai account session; this is a
// separate, unrelated third-party credential -- and it is NEVER written into
// the plain-JSON ~/.mobiusx/settings.json the agent-settings package reads,
// exactly like the account session. Same safeStorage (OS keychain-backed)
// encrypt-at-rest pattern, its own file, its own small key/value shape:
// { [host]: { provider: "github" | "gitlab", pat: string } }.
function gitCredentialsFilePath() {
  return path.join(app.getPath("userData"), "git-credentials.enc");
}

function loadGitCredentials() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const encrypted = fs.readFileSync(gitCredentialsFilePath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // no file yet, or it's unreadable -- either way, no saved credentials
  }
}

function saveGitCredentials(all) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error("[git] OS keychain unavailable -- can't persist this token securely; you'll need to paste it in again next time.");
      return false;
    }
    fs.writeFileSync(gitCredentialsFilePath(), safeStorage.encryptString(JSON.stringify(all)));
    return true;
  } catch (err) {
    console.error("[git] failed to persist credential:", err);
    return false;
  }
}

// `list` only ever reports WHICH hosts have a saved token and what provider
// they're tagged as (for rendering "Connected: github.com" in the UI) --
// never the token itself. `get` is the one call that returns the actual
// token, used right before the renderer fires a clone request with it; the
// renderer never persists what `get` returns, only forwards it into that
// one request body over the already-authenticated agentBaseUrl HTTP channel.
ipcMain.handle("git:listCredentials", () => {
  const all = loadGitCredentials();
  return Object.entries(all).map(([host, entry]) => ({ host, provider: entry?.provider ?? "github" }));
});

ipcMain.handle("git:getCredential", (_event, host) => {
  const entry = loadGitCredentials()[host];
  return entry ? { ...entry } : null;
});

ipcMain.handle("git:setCredential", (_event, host, provider, pat) => {
  if (!host || typeof host !== "string" || !pat || typeof pat !== "string") {
    return { ok: false, error: "host and token are required" };
  }
  const all = loadGitCredentials();
  all[host] = { provider: provider === "gitlab" ? "gitlab" : "github", pat };
  const ok = saveGitCredentials(all);
  return ok ? { ok: true } : { ok: false, error: "Couldn't reach the OS keychain to store this token securely." };
});

ipcMain.handle("git:clearCredential", (_event, host) => {
  const all = loadGitCredentials();
  delete all[host];
  saveGitCredentials(all);
  return { ok: true };
});

// SSH remote targets (Phase D, "Connect via SSH"): host/user/auth details
// for a real remote machine the desktop shell can open as a project over
// SFTP + a real interactive PTY (see apps/desktop-agent/src/
// remoteConnection.ts and terminalWs.ts). Same safeStorage (OS
// keychain-backed) encrypt-at-rest pattern as git-credentials.enc above,
// its own file, its own shape: { [id]: { label, host, port, username,
// authMethod, identityPath?, password?, passphrase? } }. identityPath is a
// path on THIS machine, not a secret by itself (the key file's own OS
// permissions already protect it) -- only password/passphrase are
// genuinely sensitive, but the whole entry is encrypted at rest regardless,
// same as git-credentials.enc keeps non-secret fields (host, provider)
// alongside its one real secret (pat) in a single encrypted blob.
function sshTargetsFilePath() {
  return path.join(app.getPath("userData"), "ssh-targets.enc");
}

function loadSshTargets() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const encrypted = fs.readFileSync(sshTargetsFilePath());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {}; // no file yet, or it's unreadable -- either way, no saved targets
  }
}

function saveSshTargets(all) {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error("[ssh] OS keychain unavailable -- can't persist this target securely; you'll need to re-enter it next time.");
      return false;
    }
    fs.writeFileSync(sshTargetsFilePath(), safeStorage.encryptString(JSON.stringify(all)));
    return true;
  } catch (err) {
    console.error("[ssh] failed to persist target:", err);
    return false;
  }
}

// `list` only ever reports non-secret connection metadata (for rendering
// the "This PC ▾" picker's saved-targets list) -- never a password or
// passphrase. `get` is the one call that returns a target's full entry,
// including any saved secret, used right before the renderer fires a
// POST /remote/connect with it; the renderer never persists what `get`
// returns, only forwards it into that one request body.
ipcMain.handle("ssh:listTargets", () => {
  const all = loadSshTargets();
  return Object.entries(all).map(([id, t]) => ({
    id,
    label: (t && t.label) || `${(t && t.username) || ""}@${(t && t.host) || ""}`,
    host: (t && t.host) || "",
    port: (t && t.port) || 22,
    username: (t && t.username) || "",
    authMethod: (t && t.authMethod) || "key",
    identityPath: t && t.identityPath,
    hasSecret: Boolean(t && (t.password || t.passphrase)),
  }));
});

ipcMain.handle("ssh:getTarget", (_event, id) => {
  const entry = loadSshTargets()[id];
  return entry ? { id, ...entry } : null;
});

ipcMain.handle("ssh:setTarget", (_event, target) => {
  if (!target || typeof target !== "object" || !target.host || !target.username) {
    return { ok: false, error: "host and username are required" };
  }
  const all = loadSshTargets();
  const id = typeof target.id === "string" && target.id ? target.id : crypto.randomUUID();
  all[id] = {
    label: typeof target.label === "string" ? target.label : "",
    host: target.host,
    port: Number.isInteger(target.port) && target.port > 0 ? target.port : 22,
    username: target.username,
    authMethod: target.authMethod === "password" || target.authMethod === "agent" ? target.authMethod : "key",
    ...(target.identityPath ? { identityPath: target.identityPath } : {}),
    ...(target.password ? { password: target.password } : {}),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
  };
  const ok = saveSshTargets(all);
  return ok ? { ok: true, id } : { ok: false, error: "Couldn't reach the OS keychain to store this target securely." };
});

ipcMain.handle("ssh:deleteTarget", (_event, id) => {
  const all = loadSshTargets();
  delete all[id];
  saveSshTargets(all);
  return { ok: true };
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
