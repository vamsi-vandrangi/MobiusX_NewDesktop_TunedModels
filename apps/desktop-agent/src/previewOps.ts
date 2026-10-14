import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import type { PreviewServiceState, PreviewStartResponse, PreviewStatusResponse } from "@mobiusx/protocol";

const MAX_LOG_LINES = 300;
const DEFAULT_BACKEND_PORT = 8000;

// Oct 2026 addition, as part of making the live console drawer actually
// live: Python's own stdout is fully block-buffered whenever it isn't
// attached to a real terminal (which child_process.spawn's pipe never is),
// so any print()-based output a project's own route handlers emit (or a
// third-party library that logs via print rather than the logging module)
// can sit invisible in that process's internal buffer for a long time --
// not lost, just badly delayed, arriving all at once rather than live. This
// never affected uvicorn's OWN "Uvicorn running on..."/"Application startup
// complete." lines (those go through Python's logging module to stderr,
// which Python always leaves unbuffered), which is why previewOps.ts's own
// text-based readiness detection already worked correctly before this --
// but it's exactly the kind of thing that makes a generated FastAPI
// backend's own debug prints look like they "never streamed" even though
// the process is healthy. Harmless for the frontend's `npm run dev`
// (Node doesn't consult this variable at all), so it's set unconditionally
// for every spawned child rather than threaded through a kind-specific env.
const CHILD_ENV = { ...process.env, PYTHONUNBUFFERED: "1" };

// Deliberately conservative, in the same spirit as verify.ts's
// detectVerificationSteps: only ever a real script/file the project itself
// defines, never a command invented for it. A generic reference app can't
// know every project's layout, so this checks a short list of the most
// common locations rather than guessing arbitrarily.
const FRONTEND_CANDIDATE_DIRS = [".", "frontend", "client", "web", "app"];
const BACKEND_CANDIDATE_DIRS = [".", "backend", "server", "api"];
// Where main.py actually lives INSIDE a backend candidate dir. "." covers a
// flat backend/main.py; "app" and "src" cover the equally common src-layout
// where the real package (with its own __init__.py, relative imports, etc.)
// sits one level below the dir that holds requirements.txt/pyproject.toml --
// e.g. backend/requirements.txt next to backend/app/main.py. Checked in this
// order so a flat layout is never mistaken for a package layout.
const BACKEND_PACKAGE_SUBDIRS = [".", "app", "src"];

// Keep the hostname Next.js actually reported. `localhost` and
// `127.0.0.1` can reach different listeners on macOS (IPv6 vs IPv4);
// normalizing `localhost` to 127.0.0.1 can silently preview another
// project's stale server when both have claimed the same port.
const URL_RE = /(https?:\/\/(localhost|127\.0\.0\.1):(\d+))/;

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
  /** Absolute path to the backend's SQLite file, when one was found in its own config (see detectSqliteDatabasePath) -- always null for a frontend service. */
  databasePath: string | null;
  env?: Record<string, string>;
}

const services = new Map<"frontend" | "backend", RunningService>();

export function parsePreviewUrl(text: string): { url: string; port: number } | null {
  const match = text.match(URL_RE);
  return match ? { url: match[1], port: Number(match[3]) } : null;
}

// Exported for real fixture-based unit tests (test/previewOps.test.ts) --
// still only ever called internally from startPreview below.
export function detectFrontend(projectRoot: string): { cwd: string; command: string[] } | null {
  for (const rel of FRONTEND_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts && typeof pkg.scripts.dev === "string") {
        return { cwd: dir, command: [resolveSystemNpm(), "run", "dev"] };
      }
    } catch {
      // malformed package.json — skip rather than guess
    }
  }
  return null;
}

// Checked for a `sqlite:///` (or `sqlite:////` for an absolute path) URL --
// the files a generated FastAPI backend conventionally puts its DB wiring
// in, checked in this order. Deliberately a small, explicit list (same
// "never guess, only react to what's actually there" principle as
// detectFrontend/detectBackend above) rather than scanning every .py file
// in the project.
const DB_CONFIG_FILENAMES = ["database.py", "db.py", "config.py", "settings.py", "main.py"];
const SQLITE_URL_RE = /sqlite:\/\/\/(\/?[^"'\s]*)/;

/**
 * Orchestrator feature request (Oct 2026): "dynamically extract the local
 * SQLite database path" so the user can see exactly which .db file a
 * running backend is actually using, without having to go read main.py
 * themselves. Best-effort and read-only -- this never creates, moves, or
 * opens the database file, it only looks for the conventional SQLAlchemy
 * `sqlite:///relative/path.db` (or `sqlite:////absolute/path.db`) URL
 * string in one of a backend's own config-ish files and resolves it to a
 * real absolute path for display. Returns null rather than guessing when
 * nothing matches (e.g. a backend using Postgres, or one that builds its
 * URL from pieces this regex can't follow) -- an absent DB path is honest,
 * a wrong one is worse than useless.
 */
export function detectSqliteDatabasePath(packageDir: string): string | null {
  for (const filename of DB_CONFIG_FILENAMES) {
    const filePath = join(packageDir, filename);
    if (!existsSync(filePath)) continue;
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const match = content.match(SQLITE_URL_RE);
    if (!match) continue;
    const captured = match[1]; // e.g. "./app.db", "app.db", or "/abs/path.db" (leading slash = absolute, per SQLAlchemy's 3-vs-4-slash convention)
    if (!captured) continue;
    return captured.startsWith("/") ? captured : join(packageDir, captured);
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

/**
 * Resolves the python3 interpreter used to CREATE a brand-new `.venv`
 * (backendInstallSteps' `-m venv` step, reached only when `.venv` doesn't
 * exist yet). Bare "python3" would be resolved through CHILD_ENV's PATH --
 * Electron's own inherited PATH, which on macOS very often does NOT
 * include Homebrew's /usr/local/bin (Intel) or /opt/homebrew/bin (Apple
 * Silicon), for the same reason findVenvUvicorn's own doc comment already
 * documents for uvicorn resolution: GUI apps launched via Finder/
 * LaunchServices don't source the user's shell rc files, so they can see a
 * much shorter PATH than an interactive Terminal does. Confirmed live: on
 * a Mac with a perfectly good Homebrew python@3.14 installed and on the
 * user's own interactive PATH, a `.venv` created through this app's
 * restricted PATH still landed on /usr/bin/python3 -- a thin shim for
 * Apple's CommandLineTools-bundled Python (3.8.2 here). That interpreter's
 * `venv` module stamps the new venv with ITS OWN frozen, years-old
 * ensurepip bundle (pip 19.2.3, confirmed live) -- old enough that even
 * backendInstallSteps' "upgrade pip first" step can itself fail outright
 * (`EnvironmentError: [Errno 13] Permission denied: 'RECORD'`, confirmed
 * live -- a documented pip pitfall specific to this exact
 * ancient-pip-upgrading-itself combination) and get silently skipped by
 * runInstallSteps' pip-step tolerance (see isOptionalPipUpgradeStep), after
 * which the REAL `pip install -r requirements.txt` step fails too, because
 * the underlying interpreter was never actually fixed -- only its pip
 * upgrade was attempted and skipped.
 *
 * Rather than trying to repair an old interpreter's pip after the fact,
 * this looks for a genuinely better python3 to create the venv from in the
 * first place: it scans the well-known Homebrew bin directories directly
 * by absolute path (sidestepping PATH inheritance entirely, the same way
 * venvPythonBin always returns an absolute path rather than relying on
 * "python3" resolving correctly later) for the highest-numbered
 * `python3.N` it can find, preferring Apple Silicon's prefix first since a
 * newer Mac is more likely to be on that architecture. Falls back to bare
 * "python3" when no Homebrew interpreter is found, so a Mac with only
 * Apple's CommandLineTools Python is never worse off than before this fix.
 */
function resolveSystemPython3(): string {
  if (process.platform === "win32") return "python";
  if (process.platform !== "darwin") return "python3"; // Linux distro python3 isn't subject to this same GUI-PATH/stub trap.

  let best: { bin: string; version: number } | null = null;
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // Directory doesn't exist on this Mac -- not an error, just nothing to offer from here.
    }
    for (const name of entries) {
      const match = name.match(/^python3\.(\d+)$/);
      if (!match) continue;
      const bin = join(dir, name);
      if (!existsSync(bin)) continue; // Guards a dangling symlink from a since-uninstalled Homebrew formula.
      const version = Number(match[1]);
      if (!best || version > best.version) best = { bin, version };
    }
  }
  return best ? best.bin : "python3";
}

/**
 * Same wrong-interpreter-via-restricted-PATH bug as resolveSystemPython3
 * above, confirmed live against a real Start Preview run on this exact
 * Mac: the frontend's "npm run dev" (and any "npm install" install step)
 * spawned bare "npm" via Node's own PATH search over Electron's
 * GUI-inherited CHILD_ENV.PATH, which failed outright with
 * `[spawn error] spawn npm ENOENT` even though an interactive Terminal on
 * the same machine resolves "npm" fine -- the GUI-launched app's PATH
 * simply never had the directory npm actually lives in (Homebrew's
 * /opt/homebrew/bin or /usr/local/bin for an Apple-Silicon/Intel Node
 * install, or a version manager's own bin dir for nvm/volta) on it.
 *
 * Mirrors resolveSystemPython3's approach: resolve an absolute path by
 * scanning well-known install locations directly, rather than trusting
 * PATH inheritance. npm's own install methods are more varied than
 * python3's, so this checks, in order: Homebrew (Apple Silicon then
 * Intel prefix, same preference order as resolveSystemPython3), a
 * Node.org-installer-style /usr/local/bin, then the two most common
 * Node version managers (nvm, picking its highest installed version by
 * directory name; volta). Falls back to bare "npm" so a Mac using some
 * other install method is never worse off than before this fix.
 */
function resolveSystemNpm(): string {
  if (process.platform === "win32") return "npm";
  if (process.platform !== "darwin") return "npm"; // Linux distro npm isn't subject to this same GUI-PATH trap.

  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const bin = join(dir, "npm");
    if (existsSync(bin)) return bin;
  }

  const nvmVersionsDir = join(homedir(), ".nvm", "versions", "node");
  try {
    const versions = readdirSync(nvmVersionsDir).filter((name) => /^v\d+\.\d+\.\d+$/.test(name));
    versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest version string first
    for (const version of versions) {
      const bin = join(nvmVersionsDir, version, "bin", "npm");
      if (existsSync(bin)) return bin;
    }
  } catch {
    // nvm not installed -- not an error, just nothing to offer from here.
  }

  const voltaBin = join(homedir(), ".volta", "bin", "npm");
  if (existsSync(voltaBin)) return voltaBin;

  return "npm";
}

/** Absolute path to the venv's own python interpreter -- used to run `-m venv`/`-m pip` steps against exactly the interpreter this runner will later launch uvicorn from, never whatever "python"/"pip" happens to resolve on PATH. Always the `.venv` convention (not `venv`) -- this is the one this app creates itself when auto-installing, matching findVenvUvicorn's own preferred candidate. */
export function venvPythonBin(dir: string): string {
  return process.platform === "win32" ? join(dir, ".venv", "Scripts", "python.exe") : join(dir, ".venv", "bin", "python3");
}

export function backendPythonEnvironment(projectRoot: string, inheritedPath = process.env.PYTHONPATH ?? ""): Record<string, string> {
  return { PYTHONPATH: [projectRoot, inheritedPath].filter(Boolean).join(delimiter) };
}

/**
 * A generated backend may correctly refuse to start when its encryption key
 * is missing. When its source explicitly requires ENCRYPTION_KEY, provision a
 * random, project-specific development key outside the project tree and pass
 * it only to the preview process. Never put a fallback secret in generated
 * source or commit it alongside the app. Existing process/.env configuration
 * always takes precedence.
 */
export function backendPreviewEncryptionEnvironment(
  backendDir: string,
  env: NodeJS.ProcessEnv = process.env,
  secretRoot = join(homedir(), ".mobiusx", "preview-secrets"),
): Record<string, string> {
  if (env.ENCRYPTION_KEY) return { ENCRYPTION_KEY: env.ENCRYPTION_KEY };
  const envFile = join(backendDir, ".env");
  if (existsSync(envFile)) {
    const configured = readFileSync(envFile, "utf8").match(/^\s*ENCRYPTION_KEY\s*=\s*([^\r\n#]+)\s*$/m)?.[1]?.trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
    if (configured) return { ENCRYPTION_KEY: configured };
  }
  const pythonFiles = collectSourceFiles(backendDir, new Set([".py"]));
  if (!pythonFiles.some((file) => /\bENCRYPTION_KEY\b/.test(readFileSync(file, "utf8")))) return {};

  mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
  try { chmodSync(secretRoot, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
  const secretFile = join(secretRoot, `${createHash("sha256").update(backendDir).digest("hex")}.key`);
  let key: string;
  try {
    key = readFileSync(secretFile, "utf8").trim();
  } catch {
    key = `${randomBytes(32).toString("base64url")}=`;
    try { writeFileSync(secretFile, key, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch { key = readFileSync(secretFile, "utf8").trim(); }
  }
  try { chmodSync(secretFile, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  return key ? { ENCRYPTION_KEY: key } : {};
}

function collectSourceFiles(root: string, extensions: Set<string>, maxFiles = 2000): string[] {
  const files: string[] = [];
  const ignored = new Set([".git", ".next", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);
  const visit = (dir: string): void => {
    if (files.length >= maxFiles) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (ignored.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) visit(full);
        else if (stat.isFile() && extensions.has(entry.slice(entry.lastIndexOf(".")))) files.push(full);
      } catch { /* skip files that disappear during the scan */ }
    }
  };
  visit(root);
  return files;
}

/** Add Next.js's supported compatibility flag to legacy Link-with-anchor JSX. */
export function repairLegacyNextLinks(frontendDir: string): number {
  let repaired = 0;
  for (const file of collectSourceFiles(frontendDir, new Set([".tsx", ".jsx", ".ts", ".js"])) ) {
    const original = readFileSync(file, "utf8");
    const fixed = original.replace(/(<Link\b)([^>]*)(>\s*<a\b)/g, (match, open: string, attrs: string, child: string) => {
      if (/\blegacyBehavior\b/.test(attrs)) return match;
      repaired += 1;
      return `${open}${attrs} legacyBehavior${child}`;
    });
    if (fixed !== original) writeFileSync(file, fixed, "utf8");
  }
  return repaired;
}

// Exported for real fixture-based unit tests (test/previewOps.test.ts) --
// still only ever called internally from startPreview below.
export function detectBackend(
  projectRoot: string,
  port = DEFAULT_BACKEND_PORT,
): { cwd: string; command: string[]; port: number; databasePath: string | null; mainFile: string } | null {
  for (const rel of BACKEND_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    // Oct 2026 fix: this used to gate the whole dir on requirements.txt/
    // pyproject.toml existing BEFORE ever looking at main.py -- confirmed
    // live against a real generated backend (gardening-flow-test-01) that
    // has a completely genuine FastAPI app (main.py, database.py, models.py,
    // routers/) but no manifest file at all (dependencies were installed
    // ad hoc, never frozen to a requirements.txt). That project's backend
    // was silently never detected -- startPreview reported
    // `detected: {backend: false}` with no error, which is exactly what
    // made this look like a webview/sandbox display problem from the
    // outside: the backend genuinely never started, so the frontend's own
    // API calls had nothing to talk to.
    //
    // A manifest file was only ever a proxy signal for "a real backend is
    // here" -- main.py actually constructing `FastAPI(...)`, checked below,
    // is strictly stronger, more direct, on-disk evidence of the same
    // thing, so detection no longer requires the proxy when the direct
    // signal is available. requirements.txt/pyproject.toml now only affect
    // HOW to install (see backendInstallSteps' no-manifest fallback below),
    // never WHETHER a backend was found.
    for (const pkgRel of BACKEND_PACKAGE_SUBDIRS) {
      const mainPath = join(dir, pkgRel, "main.py");
      if (!existsSync(mainPath)) continue;
      let content: string;
      try {
        content = readFileSync(mainPath, "utf8");
      } catch {
        continue;
      }
      if (!/FastAPI\s*\(/.test(content)) continue;
      const match = content.match(/(\w+)\s*=\s*FastAPI\s*\(/);
      const appVar = match ? match[1] : "app";
      // Dotted module path relative to `dir` (uvicorn's --app-dir default),
      // e.g. "app.main:app" for backend/app/main.py run with cwd=backend/ --
      // required whenever main.py uses package-relative imports
      // (`from .database import ...`), which only resolve when main.py is
      // imported AS a package member, not run from its own directory.
      const modulePath = pkgRel === "." ? `main:${appVar}` : `${pkgRel.split(/[\\/]/).join(".")}.main:${appVar}`;
      // Oct 2026 fix: this used to resolve a standalone uvicorn BINARY path
      // via findVenvUvicorn, falling back to the bare string "uvicorn" (relying
      // on system PATH) whenever that binary didn't exist YET -- which is
      // exactly the case for every project whose backend hasn't been
      // installed into its venv before this very call, i.e. the normal
      // first-run path this auto-install feature exists to handle in the
      // first place. detectBackend runs once, up front, before
      // backendInstallSteps' install even happens -- so that fallback
      // permanently baked a command into the service's `command` array that
      // could never work, confirmed live (gardening-flow-test-01): every
      // dependency installed successfully, then the run phase failed outright
      // with `[spawn error] spawn uvicorn ENOENT` because "uvicorn" isn't on
      // this app's own PATH (it only ever exists inside the project's own
      // .venv). Invoking uvicorn as a module through the venv's own python
      // interpreter instead -- the exact same interpreter every install step
      // above already runs against via venvPythonBin -- works as soon as the
      // package lands in that interpreter's site-packages, with no
      // dependency on a separately-resolved binary existing at detection
      // time, whether the venv was freshly created by this app or already
      // existed with uvicorn pre-installed.
      const python = venvPythonBin(dir);
      // The package dir (where main.py actually lives) is where its sibling
      // database.py/config.py etc. would be too -- check there first, then
      // fall back to `dir` itself for a flat layout that keeps DB wiring one
      // level up from a src-layout main.py.
      const packageDir = pkgRel === "." ? dir : join(dir, pkgRel);
      const databasePath = detectSqliteDatabasePath(packageDir) ?? (packageDir !== dir ? detectSqliteDatabasePath(dir) : null);
      return {
        cwd: dir,
        command: [python, "-m", "uvicorn", modulePath, "--reload", "--port", String(port)],
        port,
        databasePath,
        mainFile: mainPath,
      };
    }
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
// Exported for real fixture-based unit tests (test/previewOps.test.ts) --
// still only ever called internally from startPreview below.
export function frontendInstallSteps(dir: string): string[][] {
  if (!existsSync(join(dir, "node_modules"))) return [[resolveSystemNpm(), "install"]];
  // Oct 2026 fix: node_modules existing is not proof it's actually usable.
  // Confirmed live against a real project (gardening-flow-test-01/frontend):
  // its node_modules held a genuine, complete `next` package (236MB, every
  // dependency present) but a completely EMPTY node_modules/.bin/ -- some
  // earlier `npm install` had clearly been interrupted after downloading
  // packages but before npm's binary-linking step ran. `npm run dev` (->
  // `next dev`) then failed outright with `sh: next: command not found`,
  // and the old "does node_modules exist at all" check skipped reinstalling
  // entirely because the (broken) directory was already there -- a false
  // "nothing to do" that left Start Preview permanently broken for this
  // project with no way to recover short of a manual `npm install` outside
  // this app.
  //
  // Checking for the SPECIFIC binary this project's own "dev" script
  // actually invokes (read from the same package.json detectFrontend
  // already validated parses and has a real `dev` script) is a strictly
  // more accurate on-disk signal than the directory's mere existence, and
  // running `npm install` again when it's missing is safe/idempotent --
  // npm reconciles what's already there and finishes the linking step it
  // never got to, it doesn't need a clean `node_modules` to start from.
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const devScript = pkg.scripts?.dev ?? "";
    const bin = devScript.trim().split(/\s+/)[0];
    if (bin && !existsSync(join(dir, "node_modules", ".bin", bin))) {
      return [[resolveSystemNpm(), "install"]];
    }
  } catch {
    // Malformed package.json -- detectFrontend already proved this exact
    // file parses fine before this was ever reachable, so this is
    // unreachable in practice. Fall through to "nothing to install" rather
    // than guessing at a reinstall this evidence doesn't actually support.
  }
  return [];
}

// Exported for real fixture-based unit tests (test/previewOps.test.ts) --
// still only ever called internally from startPreview below.
export function backendInstallSteps(dir: string): string[][] {
  const steps: string[][] = [];
  if (!existsSync(join(dir, ".venv"))) {
    // See resolveSystemPython3's own doc comment: this avoids stamping a
    // fresh venv from Apple's ancient CommandLineTools Python when a real
    // Homebrew interpreter is available but merely not on this app's own
    // (GUI-inherited, often-restricted) PATH.
    steps.push([resolveSystemPython3(), "-m", "venv", ".venv"]);
  }
  // findVenvUvicorn checks the venv as it exists RIGHT NOW, before any of
  // the steps above run -- so this is true both for a venv that doesn't
  // exist yet (the case above just queued its creation) and for one that
  // exists but was never `pip install`-ed into, which is exactly the state
  // right after this app scaffolds a new project's files.
  if (findVenvUvicorn(dir) === null) {
    const python = venvPythonBin(dir);
    // Oct 2026 fix: confirmed live (gardening-flow-test-01) that a venv's
    // OWN bootstrapped pip can be years out of date -- Python 3.8's stdlib
    // `venv` module ships whatever pip its own ensurepip bundle was frozen
    // at, which showed up here as pip 19.2.3. That's old enough to predate
    // mature PEP 517 build-isolation support: installing a modern package
    // (sqlalchemy's current release, in this case) failed outright with
    // `pip._vendor.pep517.wrappers.BackendUnavailable` while "Getting
    // requirements to build wheel" -- not a problem with the package or the
    // network, but with pip itself being too old to invoke the package's
    // declared build backend. Upgrading pip (and setuptools/wheel, the
    // other two build-time tools this same staleness can affect) before the
    // real install is the standard fix, and it's cheap/idempotent on a venv
    // that's already current -- so it runs unconditionally here rather than
    // trying to detect "is this pip old enough to be a problem" in advance.
    steps.push([python, "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);
    const hasRequirementsTxt = existsSync(join(dir, "requirements.txt"));
    if (hasRequirementsTxt) repairSingleLineRequirements(dir);
    const hasPyproject = existsSync(join(dir, "pyproject.toml"));
    if (hasRequirementsTxt) {
      steps.push([python, "-m", "pip", "install", "-r", "requirements.txt"]);
    } else if (hasPyproject) {
      // pyproject.toml, no requirements.txt -- install the project itself
      // in editable form rather than guessing at a requirements filename
      // that isn't there.
      steps.push([python, "-m", "pip", "install", "-e", "."]);
    } else {
      // Oct 2026 fix: neither manifest exists -- detectBackend no longer
      // requires one (see its own doc comment), so this branch is now real
      // and reachable, not dead code. `pip install -e .` here would fail
      // outright (no setup.py/pyproject.toml for pip to find), which is
      // exactly what silently left gardening-flow-test-01's .venv created
      // but empty -- no uvicorn, no fastapi, nothing, so every subsequent
      // Start Preview kept hitting `spawn uvicorn ENOENT`.
      // detectBackend only ever returns non-null after confirming a real
      // `FastAPI(...)` construction in main.py, and this app's own SQLite
      // detection (detectSqliteDatabasePath) only ever matches a genuine
      // `sqlalchemy.create_engine(...)`-style sqlite:/// URL -- so a fixed,
      // small baseline covering exactly what a FastAPI+SQLite backend
      // unconditionally needs is real evidence-driven behavior, not a
      // guess at arbitrary dependencies: it's the minimum set this
      // function could not have been reached without actually requiring.
      steps.push([python, "-m", "pip", "install", "fastapi", "uvicorn[standard]", "sqlalchemy", "pydantic"]);
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

/**
 * Repairs a common model-generated requirements.txt error where several
 * package names were separated by spaces on one line. pip's requirements
 * format requires one requirement per line, so e.g. "fastapi uvicorn" is
 * parsed as one invalid requirement. Split only lines made entirely of
 * straightforward package specifiers; leave options, URLs, markers,
 * continuations, and other complex pip syntax untouched.
 *
 * Removes Python standard-library modules accidentally listed as packages
 * (for example `sqlite3`) and returns the number of lines repaired so
 * Preview can report the recovery.
 */
export function repairSingleLineRequirements(dir: string): number {
  const path = join(dir, "requirements.txt");
  if (!existsSync(path)) return 0;
  const original = readFileSync(path, "utf8");
  let repairedLines = 0;
  const standardLibraryOnly = new Set(["sqlite3"]);
  const specifier = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9.*+!_-]+(?:,[<>=!~]+[A-Za-z0-9.*+!_-]+)*)?$/;
  const normalized = original.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-") || trimmed.includes("#")) return [line];
    const parts = trimmed.split(/\s+/);
    const packageName = (part: string) => part.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0]?.toLowerCase() ?? "";
    if (parts.length === 1 && standardLibraryOnly.has(packageName(parts[0]))) {
      repairedLines += 1;
      return [];
    }
    if (parts.length < 2 || !parts.every((part) => specifier.test(part))) return [line];
    const installableParts = parts.filter((part) => !standardLibraryOnly.has(packageName(part)));
    repairedLines += 1;
    return installableParts;
  }).join("\n");
  if (repairedLines > 0 && normalized !== original) writeFileSync(path, normalized.endsWith("\n") ? normalized : `${normalized}\n`, "utf8");
  return repairedLines;
}

/**
 * Repairs FastAPI route handlers that call async database/ORM methods with
 * `await` but were declared using synchronous `def`. FastAPI supports async
 * route functions directly, and changing only decorated route declarations
 * avoids changing ordinary helpers or nested functions. This fixes a common
 * generated-code SyntaxError before Uvicorn imports the module.
 */
export function repairFastApiAwaitRoutes(mainFile: string): number {
  if (!existsSync(mainFile)) return 0;
  const original = readFileSync(mainFile, "utf8");
  const lines = original.split(/\r?\n/);
  let repaired = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const defMatch = lines[index].match(/^(\s*)def\s+([A-Za-z_]\w*)\s*\(/);
    if (!defMatch) continue;
    const indent = defMatch[1].length;
    let decoratorIndex = index - 1;
    while (decoratorIndex >= 0 && /^\s*@/.test(lines[decoratorIndex])) decoratorIndex -= 1;
    const decorators = lines.slice(decoratorIndex + 1, index).join("\n");
    if (!/@(?:app|router)\.(?:get|post|put|patch|delete|options|head)\s*\(/i.test(decorators)) continue;
    let hasAwait = false;
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const line = lines[bodyIndex];
      if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      if (/\bawait\b/.test(line.replace(/#.*$/, ""))) {
        hasAwait = true;
        break;
      }
    }
    if (hasAwait) {
      lines[index] = `${defMatch[1]}async ${lines[index].slice(defMatch[1].length)}`;
      repaired += 1;
    }
  }
  if (repaired > 0) writeFileSync(mainFile, lines.join("\n"), "utf8");
  return repaired;
}

/** Probe a loopback port and return whether another local service owns it. */
function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * Recover from the common generated-app failure where an old/stale backend
 * still owns port 8000. Select another free dev port before spawning either
 * half, and pass its API origin to Next.js so the UI follows the backend we
 * actually started instead of quietly calling the stale listener.
 */
async function availableBackendPort(): Promise<number> {
  for (let port = DEFAULT_BACKEND_PORT; port <= DEFAULT_BACKEND_PORT + 20; port++) {
    if (await isLoopbackPortAvailable(port)) return port;
  }
  throw new Error("No free local backend port is available in 8000–8020. Stop an existing dev server and retry Preview.");
}

function frontendApiOriginOverride(frontendDir: string, port: number): Record<string, string> | undefined {
  let foundLocalOrigin = false;
  for (const filename of [".env.local", ".env.development.local", ".env.development", ".env"]) {
    const path = join(frontendDir, filename);
    if (!existsSync(path)) continue;
    try {
      const line = readFileSync(path, "utf8").split(/\r?\n/).find((entry) => /^\s*NEXT_PUBLIC_API_BASE_URL\s*=/i.test(entry));
      if (!line) continue;
      const configured = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
      const localOrigin = configured.match(/^https?:\/\/(localhost|127\.0\.0\.1):(\d+)(?:\/|$)/i);
      if (!localOrigin) return undefined; // Honor an explicit non-local API endpoint.
      if (Number(localOrigin[2]) === port) return undefined;
      foundLocalOrigin = true;
      break;
    } catch {
      return undefined;
    }
  }
  return port !== DEFAULT_BACKEND_PORT || foundLocalOrigin
    ? { NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${port}` }
    : undefined;
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
    databasePath: s.databasePath,
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
    env: { ...CHILD_ENV, ...state.env },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  state.child = child;
  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    appendLog(state, text);
    if (!state.port) {
      const discovered = parsePreviewUrl(text);
      if (discovered) {
        state.port = discovered.port;
        state.url = discovered.url;
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
 * Oct 2026 fix: confirmed live against a real project (gardening-flow-test-01)
 * that pip's own in-place self-upgrade (the "pip install --upgrade pip
 * setuptools wheel" step backendInstallSteps queues) can itself fail with
 * `ERROR: Could not install packages due to an EnvironmentError: [Errno 13]
 * Permission denied: 'RECORD'` -- a well-documented pip pitfall when pip
 * tries to uninstall-then-replace its own already-installed dist-info in
 * place, unrelated to this app's own file-permission handling. That step
 * exists purely as a best-effort compatibility improvement (so a stale
 * ensurepip-bootstrapped pip can handle a modern package's PEP 517 build
 * backend) -- it is not itself a requirement, and the venv's existing pip,
 * old or not, may well still be capable of installing the real dependencies
 * queued right after it. Treating its failure as fatal (the previous
 * behavior) meant a transient/environmental pip self-upgrade hiccup
 * permanently blocked Start Preview with no path to recovery short of
 * manually repairing the venv outside this app -- exactly what was
 * observed live. Matched by shape, not by position, since whether this step
 * lands at index 0 depends on whether `.venv` already existed.
 */
export function isOptionalPipUpgradeStep(stepCmd: string[]): boolean {
  return (
    stepCmd.includes("pip") &&
    stepCmd.includes("install") &&
    stepCmd.includes("--upgrade") &&
    stepCmd.includes("setuptools") &&
    stepCmd.includes("wheel")
  );
}

/**
 * Runs `steps[index..]` one at a time (cwd set to the service's directory,
 * same spawn options as the eventual dev-server run), each only starting
 * after the previous one exits 0 -- then calls `onAllDone`. Any step that
 * exits non-zero, or fails to spawn at all (e.g. no `python3` on PATH),
 * marks the service "failed" with the real install output already in its
 * log (surfaced to the user the same way a crashed dev server's log is —
 * see renderer.js's renderPreviewStatus) and never proceeds to the next
 * step or to starting the real server -- EXCEPT the best-effort pip
 * self-upgrade step (see isOptionalPipUpgradeStep's doc comment), whose
 * failure is logged and then skipped past rather than aborting the run.
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
    env: CHILD_ENV,
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
    } else if (code !== null && isOptionalPipUpgradeStep(stepCmd)) {
      appendLog(state, `[install step skipped] "${stepCmd.join(" ")}" failed (exit ${code}) -- continuing without the pip upgrade`);
      runInstallSteps(state, cwd, steps, index + 1, onAllDone);
    } else {
      state.status = "failed";
      state.exitCode = code;
      appendLog(state, `[install step failed] "${stepCmd.join(" ")}" exited with code ${code}`);
    }
  });
}

/** The pre-auto-install entry point — still used directly whenever there's nothing to install (the common case once a project's dependencies are already in place), so that path is byte-for-byte the same behavior this had before. */
function startService(
  kind: "frontend" | "backend",
  cwd: string,
  command: string[],
  knownPort: number | null,
  databasePath: string | null = null,
  env?: Record<string, string>,
): RunningService {
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
    databasePath,
    env,
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
  databasePath: string | null = null,
  env?: Record<string, string>,
): RunningService {
  if (installSteps.length === 0) return startService(kind, cwd, command, knownPort, databasePath, env);

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
    databasePath,
    env,
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
  if (!state.child) return;
  const pid = state.child.pid;
  if (process.platform !== "win32" && pid) {
    // Keep signaling the detached process group even if npm/uvicorn's
    // launcher process has already exited. Its framework child can outlive
    // that launcher and keep serving the previous project's app on the old
    // port; skipping exited/failed leaders here left exactly that stale
    // preview behind when switching projects.
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
  if (state.status === "exited" || state.status === "failed") return;
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
export async function startPreview(projectRoot: string): Promise<PreviewStartResponse> {
  stopPreview();

  const frontendCandidate = detectFrontend(projectRoot);
  const backendExists = detectBackend(projectRoot) !== null;
  const backendPort = backendExists ? await availableBackendPort() : DEFAULT_BACKEND_PORT;
  const backendCandidate = backendExists ? detectBackend(projectRoot, backendPort) : null;
  const frontendEnv = frontendCandidate && backendCandidate ? frontendApiOriginOverride(frontendCandidate.cwd, backendPort) : undefined;

  let frontendState: RunningService | null = null;
  let backendState: RunningService | null = null;

  if (frontendCandidate) {
    const repairedLinks = repairLegacyNextLinks(frontendCandidate.cwd);
    const installSteps = frontendInstallSteps(frontendCandidate.cwd);
    frontendState = startServiceWithInstall("frontend", frontendCandidate.cwd, installSteps, frontendCandidate.command, null, null, frontendEnv);
    if (repairedLinks > 0) appendLog(frontendState, `[auto-repair] Added Next.js legacyBehavior to ${repairedLinks} Link component(s) containing an anchor child.`);
    if (frontendEnv?.NEXT_PUBLIC_API_BASE_URL) {
      appendLog(frontendState, `[auto-repair] Backend API origin set to ${frontendEnv.NEXT_PUBLIC_API_BASE_URL} to match the selected free port.`);
    }
    // Redundant with the services.set(...) startServiceWithInstall/startService
    // now do internally (required there -- see their doc comments) -- kept
    // here too since it's harmless and keeps this map update visible at the
    // call site.
    services.set("frontend", frontendState);
  }
  if (backendCandidate) {
    const repairedAsyncRoutes = repairFastApiAwaitRoutes(backendCandidate.mainFile);
    const repairedRequirementLines = repairSingleLineRequirements(backendCandidate.cwd);
    const encryptionEnv = backendPreviewEncryptionEnvironment(backendCandidate.cwd);
    const installSteps = backendInstallSteps(backendCandidate.cwd);
    backendState = startServiceWithInstall(
      "backend",
      backendCandidate.cwd,
      installSteps,
      backendCandidate.command,
      backendCandidate.port,
      backendCandidate.databasePath,
      { ...backendPythonEnvironment(projectRoot), ...encryptionEnv },
    );
    appendLog(backendState, `[preview] Added project root to backend PYTHONPATH so package imports such as backend.models resolve from ${projectRoot}.`);
    if (backendPort !== DEFAULT_BACKEND_PORT) {
      appendLog(backendState, `[auto-repair] Port ${DEFAULT_BACKEND_PORT} was occupied; selected free backend port ${backendPort}.`);
    }
    if (repairedRequirementLines > 0) {
      appendLog(backendState, `[auto-repair] Normalized ${repairedRequirementLines} invalid requirements.txt line(s): split space-separated packages and removed standard-library modules such as sqlite3.`);
    }
    if (repairedAsyncRoutes > 0) {
      appendLog(backendState, `[auto-repair] Changed ${repairedAsyncRoutes} FastAPI route handler(s) from def to async def because their bodies use await.`);
    }
    if (encryptionEnv.ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY) {
      appendLog(backendState, `[auto-repair] Supplied the configured or MobiusX-managed development ENCRYPTION_KEY to the backend preview process.`);
    }
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
