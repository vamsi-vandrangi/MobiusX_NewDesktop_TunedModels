import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewServiceState, PreviewStartResponse, PreviewStatusResponse } from "@mobiusx/protocol";

const MAX_LOG_LINES = 300;
const DEFAULT_BACKEND_PORT = 8000;

// Deliberately conservative, in the same spirit as verify.ts's
// detectVerificationSteps: only ever a real script/file the project itself
// defines, never a command invented for it. A generic reference app can't
// know every project's layout, so this checks a short list of the most
// common locations rather than guessing arbitrarily.
const FRONTEND_CANDIDATE_DIRS = [".", "frontend", "client", "web", "app"];
const BACKEND_CANDIDATE_DIRS = [".", "backend", "server", "api"];

const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1):(\d+))/;

interface RunningService {
  kind: "frontend" | "backend";
  cwd: string;
  command: string;
  status: PreviewServiceState["status"];
  port: number | null;
  url: string | null;
  log: string[];
  exitCode: number | null;
  startedAt: string;
  child: ChildProcess | null;
}

const services = new Map<"frontend" | "backend", RunningService>();

function detectFrontend(projectRoot: string): { cwd: string; command: string[] } | null {
  for (const rel of FRONTEND_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts && typeof pkg.scripts.dev === "string") {
        return { cwd: dir, command: ["npm", "run", "dev"] };
      }
    } catch {
      // malformed package.json — skip rather than guess
    }
  }
  return null;
}

/**
 * Looks for a per-project virtualenv's own uvicorn binary before falling
 * back to a bare "uvicorn" that relies on it being globally on PATH.
 * This matters because Electron's own process PATH (especially on macOS,
 * where GUI apps don't inherit the user's shell rc files) very often does
 * NOT include a venv someone activated by hand in a terminal -- so a
 * backend that installs fine via `pip install -r requirements.txt` inside
 * `.venv` still fails to launch here with `spawn uvicorn ENOENT`, even
 * though uvicorn is right there on disk. Confirmed live. Checks the
 * `.venv` convention (what this app's own setup instructions tell users
 * to create) and the common `venv` alternative, in that order.
 */
function findVenvUvicorn(dir: string): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(dir, ".venv", "Scripts", "uvicorn.exe"), join(dir, "venv", "Scripts", "uvicorn.exe")]
      : [join(dir, ".venv", "bin", "uvicorn"), join(dir, "venv", "bin", "uvicorn")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Absolute path to the venv's own python interpreter -- used to run `-m venv`/`-m pip` steps against exactly the interpreter this runner will later launch uvicorn from, never whatever "python"/"pip" happens to resolve on PATH. Always the `.venv` convention (not `venv`) -- this is the one this app creates itself when auto-installing, matching findVenvUvicorn's own preferred candidate. */
function venvPythonBin(dir: string): string {
  return process.platform === "win32" ? join(dir, ".venv", "Scripts", "python.exe") : join(dir, ".venv", "bin", "python3");
}

function detectBackend(projectRoot: string): { cwd: string; command: string[]; port: number } | null {
  for (const rel of BACKEND_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    const mainPath = join(dir, "main.py");
    if (!existsSync(mainPath)) continue;
    const hasReqs = existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"));
    if (!hasReqs) continue;
    let content: string;
    try {
      content = readFileSync(mainPath, "utf8");
    } catch {
      continue;
    }
    if (!/FastAPI\s*\(/.test(content)) continue;
    const match = content.match(/(\w+)\s*=\s*FastAPI\s*\(/);
    const appVar = match ? match[1] : "app";
    const uvicornBin = findVenvUvicorn(dir) ?? "uvicorn";
    return {
      cwd: dir,
      command: [uvicornBin, `main:${appVar}`, "--reload", "--port", String(DEFAULT_BACKEND_PORT)],
      port: DEFAULT_BACKEND_PORT,
    };
  }
  return null;
}

/**
 * Auto-install support (Sept 2026, explicit user request after hitting this
 * twice in one session -- a generated backend needing `pip install -r
 * requirements.txt` first, then a generated frontend needing `npm install`
 * first, each requiring the user to go find a terminal before Start Preview
 * would do anything). These compute the install command(s) a project needs
 * BEFORE any dev server can run, given only real on-disk evidence (no
 * node_modules dir; no .venv; findVenvUvicorn coming up empty) -- same
 * "never guess, only react to what's actually there" principle as
 * detectFrontend/detectBackend above. An empty array means "nothing to
 * install", which is the common case on a second Start Preview once a
 * project's dependencies are already in place -- startServiceWithInstall
 * treats that identically to the old always-just-start behavior.
 */
function frontendInstallSteps(dir: string): string[][] {
  if (existsSync(join(dir, "node_modules"))) return [];
  return [["npm", "install"]];
}

function backendInstallSteps(dir: string): string[][] {
  const steps: string[][] = [];
  if (!existsSync(join(dir, ".venv"))) {
    steps.push([process.platform === "win32" ? "python" : "python3", "-m", "venv", ".venv"]);
  }
  // findVenvUvicorn checks the venv as it exists RIGHT NOW, before any of
  // the steps above run -- so this is true both for a venv that doesn't
  // exist yet (the case above just queued its creation) and for one that
  // exists but was never `pip install`-ed into, which is exactly the state
  // right after this app scaffolds a new project's files.
  if (findVenvUvicorn(dir) === null) {
    const python = venvPythonBin(dir);
    if (existsSync(join(dir, "requirements.txt"))) {
      steps.push([python, "-m", "pip", "install", "-r", "requirements.txt"]);
    } else {
      // pyproject.toml-only project (detectBackend's `hasReqs` check
      // already guarantees one of the two exists) -- install the project
      // itself in editable form rather than guessing at a requirements
      // filename that isn't there.
      steps.push([python, "-m", "pip", "install", "-e", "."]);
    }
    // Defensive safety net, not a duplicate: a generated requirements.txt
    // has been observed missing/corrupting its own uvicorn line before
    // (see repairOverEscapedContent's doc comment on the gateway side) --
    // this makes sure the interpreter this runner is about to hand to
    // findVenvUvicorn's caller actually has it, at negligible cost when
    // it's already satisfied.
    steps.push([python, "-m", "pip", "install", "uvicorn[standard]"]);
  }
  return steps;
}

function appendLog(state: RunningService, chunk: string): void {
  const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;
  state.log.push(...lines);
  if (state.log.length > MAX_LOG_LINES) state.log = state.log.slice(-MAX_LOG_LINES);
}

function toPublic(s: RunningService): PreviewServiceState {
  return {
    kind: s.kind,
    cwd: s.cwd,
    command: s.command,
    status: s.status,
    port: s.port,
    url: s.url,
    log: s.log,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
  };
}

/**
 * Spawns the real dev-server command (`npm run dev` / `uvicorn ...`) for an
 * already-created `state` and wires up its output/exit/error handling --
 * the exact behavior startService had before auto-install existed, just
 * factored out so startServiceWithInstall can reuse it as the final step
 * of an install chain instead of duplicating this logic.
 */
function spawnRunPhase(state: RunningService, cwd: string, command: string[], knownPort: number | null): void {
  // The service may have been stopped (stopPreview) while a prior install
  // step was still running -- don't resurrect it by starting the real
  // server after the user already asked to stop.
  if (services.get(state.kind) !== state) return;

  state.status = "starting";
  const [cmd, ...args] = command;
  // detached:true (POSIX) so stopPreview can kill the whole process group —
  // same reasoning as verify.ts's killTree: `npm run dev` spawns a real dev
  // server as a grandchild, and killing just the npm process leaves that
  // grandchild (and the port it's holding) running.
  const child = spawn(cmd, args, {
    cwd,
    env: process.env,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  state.child = child;
  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    appendLog(state, text);
    if (!state.port) {
      const m = text.match(URL_RE);
      if (m) {
        state.port = Number(m[2]);
        state.url = `http://127.0.0.1:${state.port}`;
      }
    }
    // Deliberately does NOT treat "state.port !== null" as a readiness signal
    // on its own: for the backend, port is pre-seeded from DEFAULT_BACKEND_PORT
    // at state creation (see below), so that condition used to be trivially
    // true from the very first stdout/stderr chunk -- including a chunk that
    // was actually an ImportError traceback. That made the UI report a
    // backend "running" when it had in fact crashed on startup. Confirmed
    // live: a generated main.py with a bad relative import printed its
    // traceback, and this still flipped to "running" on that first chunk.
    // Readiness must come from the process's own text saying so (or, for the
    // frontend, discovering its port for the first time via URL_RE above --
    // that only happens once real output arrives, so it's a genuine signal).
    const justDiscoveredPort = knownPort === null && state.port !== null;
    if (state.status === "starting" && (justDiscoveredPort || /ready|compiled|started server|application startup complete/i.test(text))) {
      state.status = "running";
    }
  };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  child.on("exit", (code) => {
    // A service that was deliberately stopped is already removed from the
    // `services` map by stopPreview before this fires — don't let a
    // process's own async exit event resurrect stale state for it.
    if (services.get(state.kind) !== state) return;
    state.status = code === 0 ? "exited" : "failed";
    state.exitCode = code;
  });
  child.on("error", (err) => {
    if (services.get(state.kind) !== state) return;
    state.status = "failed";
    appendLog(state, `[spawn error] ${err.message}`);
  });
}

/**
 * Runs `steps[index..]` one at a time (cwd set to the service's directory,
 * same spawn options as the eventual dev-server run), each only starting
 * after the previous one exits 0 -- then calls `onAllDone`. Any step that
 * exits non-zero, or fails to spawn at all (e.g. no `python3` on PATH),
 * marks the service "failed" with the real install output already in its
 * log (surfaced to the user the same way a crashed dev server's log is —
 * see renderer.js's renderPreviewStatus) and never proceeds to the next
 * step or to starting the real server.
 */
function runInstallSteps(state: RunningService, cwd: string, steps: string[][], index: number, onAllDone: () => void): void {
  if (services.get(state.kind) !== state) return; // stopped mid-install
  if (index >= steps.length) {
    onAllDone();
    return;
  }
  const stepCmd = steps[index];
  appendLog(state, `$ ${stepCmd.join(" ")}`);
  const [cmd, ...args] = stepCmd;
  const child = spawn(cmd, args, {
    cwd,
    env: process.env,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  state.child = child;
  child.stdout?.on("data", (c: Buffer) => appendLog(state, c.toString("utf8")));
  child.stderr?.on("data", (c: Buffer) => appendLog(state, c.toString("utf8")));
  child.on("error", (err) => {
    if (services.get(state.kind) !== state) return;
    state.status = "failed";
    appendLog(state, `[install error] ${err.message}`);
  });
  child.on("exit", (code) => {
    if (services.get(state.kind) !== state) return;
    if (code === 0) {
      runInstallSteps(state, cwd, steps, index + 1, onAllDone);
    } else {
      state.status = "failed";
      state.exitCode = code;
      appendLog(state, `[install step failed] "${stepCmd.join(" ")}" exited with code ${code}`);
    }
  });
}

/** The pre-auto-install entry point — still used directly whenever there's nothing to install (the common case once a project's dependencies are already in place), so that path is byte-for-byte the same behavior this had before. */
function startService(kind: "frontend" | "backend", cwd: string, command: string[], knownPort: number | null): RunningService {
  const state: RunningService = {
    kind,
    cwd,
    command: command.join(" "),
    status: "starting",
    port: knownPort,
    url: knownPort ? `http://127.0.0.1:${knownPort}` : null,
    log: [],
    exitCode: null,
    startedAt: new Date().toISOString(),
    child: null,
  };
  // Must happen before spawnRunPhase -- see its staleness-guard doc comment.
  services.set(kind, state);
  spawnRunPhase(state, cwd, command, knownPort);
  return state;
}

/**
 * Like startService, but runs `installSteps` first (if any) before ever
 * spawning `command` -- the service reports status "installing" the whole
 * time, with each install command's real output streaming into the same
 * log the dev server itself will use once it starts. Falls through to the
 * exact old startService behavior when `installSteps` is empty.
 */
function startServiceWithInstall(
  kind: "frontend" | "backend",
  cwd: string,
  installSteps: string[][],
  command: string[],
  knownPort: number | null,
): RunningService {
  if (installSteps.length === 0) return startService(kind, cwd, command, knownPort);

  const state: RunningService = {
    kind,
    cwd,
    command: command.join(" "),
    status: "installing",
    port: knownPort,
    url: knownPort ? `http://127.0.0.1:${knownPort}` : null,
    log: [],
    exitCode: null,
    startedAt: new Date().toISOString(),
    child: null,
  };
  // Must happen before runInstallSteps -- its first line is a staleness
  // guard (`services.get(state.kind) !== state`) that otherwise always
  // reads "stopped mid-install" on this very first call, since nothing
  // has registered this state in `services` yet. Confirmed live: without
  // this, every install silently no-op'd and the UI sat on "installing"
  // forever with an empty log.
  services.set(kind, state);
  runInstallSteps(state, cwd, installSteps, 0, () => spawnRunPhase(state, cwd, command, knownPort));
  return state;
}

/** Kills one running service's whole process tree (see startService's doc comment on why) -- works the same whether `state.child` is currently an install step or the real dev server, since both are spawned the same way. */
function killService(state: RunningService): void {
  if (!state.child || state.status === "exited" || state.status === "failed") return;
  const pid = state.child.pid;
  if (process.platform !== "win32" && pid) {
    try {
      process.kill(-pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3000);
      return;
    } catch {
      // process group already gone — fall through
    }
  }
  try {
    state.child.kill();
  } catch {
    /* already dead */
  }
}

/**
 * Detects and starts a real dev server for each half of the open project it
 * can find real evidence for (a package.json with a "dev" script for the
 * frontend; a FastAPI app with its own requirements for the backend) and
 * reports honestly which of the two it actually found — never both by
 * assumption. Stops any previously-running preview for a different project
 * first; this reference implementation previews one project at a time.
 *
 * Each half also gets its dependencies installed automatically first if
 * they're missing (see frontendInstallSteps/backendInstallSteps) -- returns
 * immediately either way (installs run in the background; poll
 * /preview/status same as always to watch "installing" -> "starting" ->
 * "running").
 */
export function startPreview(projectRoot: string): PreviewStartResponse {
  stopPreview();

  const frontendCandidate = detectFrontend(projectRoot);
  const backendCandidate = detectBackend(projectRoot);

  let frontendState: RunningService | null = null;
  let backendState: RunningService | null = null;

  if (frontendCandidate) {
    const installSteps = frontendInstallSteps(frontendCandidate.cwd);
    frontendState = startServiceWithInstall("frontend", frontendCandidate.cwd, installSteps, frontendCandidate.command, null);
    // Redundant with the services.set(...) startServiceWithInstall/startService
    // now do internally (required there -- see their doc comments) -- kept
    // here too since it's harmless and keeps this map update visible at the
    // call site.
    services.set("frontend", frontendState);
  }
  if (backendCandidate) {
    const installSteps = backendInstallSteps(backendCandidate.cwd);
    backendState = startServiceWithInstall(
      "backend",
      backendCandidate.cwd,
      installSteps,
      backendCandidate.command,
      backendCandidate.port,
    );
    services.set("backend", backendState);
  }

  return {
    frontend: frontendState ? toPublic(frontendState) : null,
    backend: backendState ? toPublic(backendState) : null,
    detected: { frontend: frontendCandidate !== null, backend: backendCandidate !== null },
  };
}

export function getPreviewStatus(): PreviewStatusResponse {
  const frontend = services.get("frontend");
  const backend = services.get("backend");
  return {
    frontend: frontend ? toPublic(frontend) : null,
    backend: backend ? toPublic(backend) : null,
  };
}

export function stopPreview(): void {
  for (const [, state] of services) killService(state);
  services.clear();
}
