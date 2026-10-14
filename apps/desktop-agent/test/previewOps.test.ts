import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  detectFrontend,
  detectBackend,
  detectSqliteDatabasePath,
  backendPreviewEncryptionEnvironment,
  backendInstallSteps,
  backendPythonEnvironment,
  repairSingleLineRequirements,
  repairFastApiAwaitRoutes,
  repairLegacyNextLinks,
  frontendInstallSteps,
  isOptionalPipUpgradeStep,
  parsePreviewUrl,
} from "../src/previewOps.js";

test("preview provisions a persistent project encryption key only when backend code references it", async () => {
  const root = await mkdtemp(join(tmpdir(), "mobiusx-preview-key-"));
  const backend = join(root, "backend");
  const secrets = join(root, "private-secrets");
  await mkdir(backend, { recursive: true });
  await writeFile(join(backend, "main.py"), 'raise RuntimeError("ENCRYPTION_KEY not set in environment")\n');
  const first = backendPreviewEncryptionEnvironment(backend, {}, secrets);
  const second = backendPreviewEncryptionEnvironment(backend, {}, secrets);
  assert.ok(first.ENCRYPTION_KEY && first.ENCRYPTION_KEY.length >= 40);
  assert.equal(second.ENCRYPTION_KEY, first.ENCRYPTION_KEY, "key must remain stable for persisted local encrypted data");
  assert.deepEqual(backendPreviewEncryptionEnvironment(backend, { ENCRYPTION_KEY: "configured-key" }, secrets), { ENCRYPTION_KEY: "configured-key" });
});

test("preview repairs Next.js Link components that directly wrap anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "mobiusx-next-link-"));
  const app = join(root, "app");
  await mkdir(app, { recursive: true });
  const page = join(app, "page.tsx");
  await writeFile(page, 'return <Link href="/employees"><a className="nav">Employees</a></Link>;\n');
  assert.equal(repairLegacyNextLinks(root), 1);
  const fixed = await readFile(page, "utf8");
  assert.match(fixed, /<Link href="\/employees" legacyBehavior><a className="nav">/);
  assert.equal(repairLegacyNextLinks(root), 0, "repair should be idempotent");
});

test("parsePreviewUrl preserves localhost so IPv6 and IPv4 projects sharing a port cannot be confused", () => {
  assert.deepEqual(parsePreviewUrl("▲ Next.js\n  - Local:        http://localhost:3000\n"), { url: "http://localhost:3000", port: 3000 });
  assert.deepEqual(parsePreviewUrl("Local: http://127.0.0.1:3001/"), { url: "http://127.0.0.1:3001", port: 3001 });
  assert.equal(parsePreviewUrl("ready on 0.0.0.0:3000"), null);
});

test("backendPythonEnvironment prepends the project root and preserves inherited imports", () => {
  const env = backendPythonEnvironment("/workspace/EmpPayroll", "/opt/shared/python");
  assert.equal(env.PYTHONPATH, ["/workspace/EmpPayroll", "/opt/shared/python"].join(delimiter));
});

test("repairSingleLineRequirements splits a generated whitespace-separated package list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-requirements-repair-"));
  const requirements = join(dir, "requirements.txt");
  await writeFile(requirements, "fastapi uvicorn sqlalchemy pydantic passlib[bcrypt] python-jose[pycryptodome] psycopg2-binary\nsqlite3\n");

  assert.equal(repairSingleLineRequirements(dir), 2);
  assert.equal(
    await readFile(requirements, "utf8"),
    "fastapi\nuvicorn\nsqlalchemy\npydantic\npasslib[bcrypt]\npython-jose[pycryptodome]\npsycopg2-binary\n",
  );
  assert.equal(repairSingleLineRequirements(dir), 0, "the repair should be idempotent");
});

test("repairSingleLineRequirements leaves complex pip syntax unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-requirements-complex-"));
  const requirements = join(dir, "requirements.txt");
  const original = "--index-url https://pypi.org/simple\npackage @ https://example.com/package.whl\nfoo; python_version >= '3.12'\n";
  await writeFile(requirements, original);
  assert.equal(repairSingleLineRequirements(dir), 0);
  assert.equal(await readFile(requirements, "utf8"), original);
});

test("repairSingleLineRequirements removes stdlib sqlite3 even when it shares a package list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-requirements-stdlib-"));
  const requirements = join(dir, "requirements.txt");
  await writeFile(requirements, "fastapi uvicorn sqlite3==3.14.0\n");
  assert.equal(repairSingleLineRequirements(dir), 1);
  assert.equal(await readFile(requirements, "utf8"), "fastapi\nuvicorn\n");
});

test("repairFastApiAwaitRoutes makes only decorated routes with await asynchronous", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-async-routes-"));
  const mainFile = join(dir, "main.py");
  const original = [
    "from fastapi import FastAPI",
    "app = FastAPI()",
    "@app.post('/token')",
    "def login():",
    "    user = await fetch_user()",
    "    return user",
    "",
    "def ordinary_helper():",
    "    return 'no await'",
    "",
  ].join("\n");
  await writeFile(mainFile, original);
  assert.equal(repairFastApiAwaitRoutes(mainFile), 1);
  const repaired = await readFile(mainFile, "utf8");
  assert.match(repaired, /@app\.post\('\/token'\)\nasync def login\(\):/);
  assert.match(repaired, /async def login\(\):\n    user = await fetch_user\(\)/);
  assert.match(repaired, /def ordinary_helper\(\):/);
  assert.equal(repairFastApiAwaitRoutes(mainFile), 0, "the repair should be idempotent");
});

/**
 * Reproduces the exact on-disk shape of the real "gardening-business-site"
 * project (apps/desktop's Live Preview bake-off, see repo history) that
 * failed to be detected: frontend/package.json with a "dev" script, and a
 * src-layout FastAPI backend -- backend/requirements.txt at the root
 * detectBackend scans, but the actual FastAPI app one level deeper at
 * backend/app/main.py (a real Python package, importing its sibling
 * modules via `from .database import ...`). Before this fix, detectBackend
 * only ever looked for backend/main.py directly and returned null here --
 * silently skipping the whole backend half of the preview with no error,
 * which is what made the app look like it "couldn't talk to" a server that
 * was never started in the first place.
 */
async function makeGardeningSiteFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-"));

  const frontendDir = join(dir, "frontend");
  await mkdir(frontendDir, { recursive: true });
  await writeFile(
    join(frontendDir, "package.json"),
    JSON.stringify({ name: "greenacre-frontend", scripts: { dev: "next dev", build: "next build" } }),
  );

  const backendDir = join(dir, "backend");
  const appDir = join(backendDir, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(backendDir, "requirements.txt"), "fastapi\nuvicorn[standard]\nsqlalchemy\n");
  await writeFile(join(appDir, "__init__.py"), "");
  await writeFile(
    join(appDir, "main.py"),
    ["from fastapi import FastAPI", "from .database import engine", "", "app = FastAPI()", ""].join("\n"),
  );

  return dir;
}

test("detectFrontend finds a frontend/package.json with a dev script", async () => {
  const dir = await makeGardeningSiteFixture();
  const found = detectFrontend(dir);
  assert.ok(found, "expected detectFrontend to find the frontend/ dir");
  assert.equal(found!.cwd, join(dir, "frontend"));
  assert.ok(found!.command[0].endsWith("/npm"), `expected an absolute npm executable, got ${found!.command[0]}`);
  assert.deepEqual(found!.command.slice(1), ["run", "dev"]);
});

test("detectBackend finds a src-layout FastAPI app (backend/app/main.py) and builds a dotted module path", async () => {
  const dir = await makeGardeningSiteFixture();
  const found = detectBackend(dir);
  assert.ok(found, "expected detectBackend to find the backend/app/main.py FastAPI app");
  // cwd is the directory holding requirements.txt (backend/), NOT backend/app --
  // this is what makes `from .database import ...` resolvable, and what the
  // auto-install/venv logic (backendInstallSteps/findVenvUvicorn) expects.
  assert.equal(found!.cwd, join(dir, "backend"));
  // Oct 2026 fix: uvicorn is now invoked as a module through the venv's own
  // python interpreter (`python3 -m uvicorn ...`), never a separately
  // resolved uvicorn binary path -- see detectBackend's own doc comment for
  // why resolving a standalone binary at detection time (before any install
  // has run) was itself a real bug.
  assert.ok(found!.command[0].endsWith("python3") || found!.command[0].endsWith("python.exe"), "command[0] must be the venv's own python interpreter");
  assert.equal(found!.command[1], "-m");
  assert.equal(found!.command[2], "uvicorn");
  assert.equal(found!.command[3], "app.main:app");
  assert.deepEqual(found!.command.slice(4), ["--reload", "--port", "8000"]);
});

/**
 * Oct 2026 regression test -- reproduces the FOURTH real failure hit live on
 * gardening-flow-test-01, right after the three install-side fixes above let
 * the backend's dependencies actually install successfully for the first
 * time: the run command itself failed with `[spawn error] spawn uvicorn
 * ENOENT`. The old detectBackend resolved a standalone uvicorn binary path
 * via findVenvUvicorn at DETECTION time -- before backendInstallSteps' own
 * install has run -- so on a project whose .venv doesn't have uvicorn yet
 * (the exact case this whole auto-install feature exists for), that lookup
 * came up empty and fell back to the bare string "uvicorn", relying on
 * system PATH. That fallback command got baked into the service and never
 * recomputed, so even after install genuinely succeeded, the run phase tried
 * to spawn a plain "uvicorn" that was never going to be on this app's own
 * PATH. This fixture deliberately has NO .venv at all (fresh-project state)
 * to prove the fix no longer depends on a binary already existing on disk.
 */
test("detectBackend's run command uses the venv's own python even when .venv doesn't exist yet (no uvicorn binary to find)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-no-venv-yet-"));
  const backendDir = join(dir, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(join(backendDir, "main.py"), ["from fastapi import FastAPI", "", "app = FastAPI()", ""].join("\n"));
  // No requirements.txt, no .venv -- genuinely nothing installed anywhere yet.

  const found = detectBackend(dir);
  assert.ok(found, "expected detectBackend to find this backend even with no .venv on disk yet");
  assert.ok(
    found!.command[0].endsWith("python3") || found!.command[0].endsWith("python.exe"),
    "must never fall back to the bare string 'uvicorn' just because no venv/binary exists yet",
  );
  assert.notEqual(found!.command[0], "uvicorn", "the old bug: command[0] must not literally be the unqualified 'uvicorn' string");
  assert.equal(found!.command[1], "-m");
  assert.equal(found!.command[2], "uvicorn");
});

test("detectBackend still finds a flat backend/main.py layout (no regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-flat-"));
  const backendDir = join(dir, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(join(backendDir, "requirements.txt"), "fastapi\nuvicorn\n");
  await writeFile(join(backendDir, "main.py"), ["from fastapi import FastAPI", "", "app = FastAPI()", ""].join("\n"));

  const found = detectBackend(dir);
  assert.ok(found, "expected detectBackend to still find a flat backend/main.py");
  assert.equal(found!.cwd, backendDir);
  assert.equal(found!.command[3], "main:app");
});

test("detectBackend returns null when there's no FastAPI app anywhere", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-none-"));
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "backend", "requirements.txt"), "flask\n");
  assert.equal(detectBackend(dir), null);
});

// Orchestrator feature request (Oct 2026): "dynamically extract the local
// SQLite database path", so the preview panel can show the user exactly
// which .db file a running backend is using.
test("detectBackend extracts a SQLite path from a sibling database.py", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-sqlite-"));
  const backendDir = join(dir, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(join(backendDir, "requirements.txt"), "fastapi\nuvicorn\nsqlalchemy\n");
  await writeFile(join(backendDir, "main.py"), ["from fastapi import FastAPI", "", "app = FastAPI()", ""].join("\n"));
  await writeFile(
    join(backendDir, "database.py"),
    ['SQLALCHEMY_DATABASE_URL = "sqlite:///./gardening.db"', "", "# engine = create_engine(SQLALCHEMY_DATABASE_URL)", ""].join("\n"),
  );

  const found = detectBackend(dir);
  assert.ok(found, "expected detectBackend to find the flat backend/main.py");
  assert.equal(found!.databasePath, join(backendDir, "./gardening.db"));
});

test("detectBackend reports a null databasePath when the backend isn't using SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-postgres-"));
  const backendDir = join(dir, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(join(backendDir, "requirements.txt"), "fastapi\nuvicorn\npsycopg2\n");
  await writeFile(join(backendDir, "main.py"), ["from fastapi import FastAPI", "", "app = FastAPI()", ""].join("\n"));
  await writeFile(join(backendDir, "database.py"), 'DATABASE_URL = "postgresql://user:pass@localhost/db"\n');

  const found = detectBackend(dir);
  assert.ok(found);
  assert.equal(found!.databasePath, null);
});

test("detectSqliteDatabasePath resolves an absolute (4-slash) sqlite URL as-is, not joined with the package dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-abs-sqlite-"));
  await writeFile(join(dir, "config.py"), 'DATABASE_URL = "sqlite:////var/data/app.db"\n');
  assert.equal(detectSqliteDatabasePath(dir), "/var/data/app.db");
});

test("detectSqliteDatabasePath returns null when no config file mentions sqlite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-no-sqlite-"));
  await writeFile(join(dir, "main.py"), "app = None\n");
  assert.equal(detectSqliteDatabasePath(dir), null);
});

/**
 * Oct 2026 regression test -- reproduces the EXACT on-disk shape of the
 * real "gardening-flow-test-01" project (a live test project found during
 * this session's investigation, under Test Projects/ on the connected
 * machine): a completely genuine FastAPI backend (main.py constructing a
 * real `FastAPI(...)` app, database.py with a real `sqlite:///./garden.db`
 * SQLAlchemy URL, models.py, routers/) that simply has no requirements.txt
 * or pyproject.toml anywhere -- dependencies were installed ad hoc, never
 * frozen to a manifest file. Before this fix, detectBackend's `hasReqs`
 * gate ran BEFORE ever looking at main.py, so this real backend was never
 * detected at all: startPreview silently reported `detected: {backend:
 * false}`, the backend never started, and from the outside (a blank/broken
 * live preview, since the Next.js frontend's own API calls had nothing to
 * talk to) this looked exactly like a webview/sandbox display problem
 * rather than the detection gap it actually was.
 */
test("detectBackend finds a real FastAPI backend with no requirements.txt/pyproject.toml at all", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-no-manifest-"));
  const backendDir = join(dir, "backend");
  await mkdir(backendDir, { recursive: true });
  await writeFile(
    join(backendDir, "main.py"),
    [
      "from fastapi import FastAPI",
      "from fastapi.middleware.cors import CORSMiddleware",
      "",
      "from routers import products",
      "",
      'app = FastAPI(title="Gardening Business API")',
      "app.include_router(products.router)",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(backendDir, "database.py"),
    [
      "import os",
      "from sqlalchemy import create_engine",
      "",
      'SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./garden.db")',
      "engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={\"check_same_thread\": False})",
      "",
    ].join("\n"),
  );
  // Deliberately no requirements.txt, no pyproject.toml anywhere.

  const found = detectBackend(dir);
  assert.ok(found, "expected detectBackend to find a real FastAPI app even with no manifest file");
  assert.equal(found!.cwd, backendDir);
  assert.equal(found!.command[3], "main:app");
  assert.equal(found!.databasePath, join(backendDir, "./garden.db"));
});

test("backendInstallSteps falls back to a fixed baseline pip install when neither requirements.txt nor pyproject.toml exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-install-fallback-"));
  // No requirements.txt, no pyproject.toml, no .venv yet -- the exact state
  // detectBackend above now successfully detects a backend in.
  const steps = backendInstallSteps(dir);
  // The pip/setuptools/wheel upgrade step (see its own doc comment) now
  // precedes the real dependency install in every branch, so this excludes
  // it explicitly rather than matching it by accident via a loose "install"
  // substring check.
  const pipInstallStep = steps.find(
    (s) => s.includes("install") && !s.includes("venv") && !s.includes("--upgrade"),
  );
  assert.ok(pipInstallStep, "expected a pip install step in the fallback plan");
  for (const pkg of ["fastapi", "uvicorn[standard]", "sqlalchemy"]) {
    assert.ok(pipInstallStep!.includes(pkg), `expected fallback install to include ${pkg}`);
  }
  // Must never be the old "pip install -e ." editable-install branch --
  // there's no setup.py/pyproject.toml here for pip to find, so that would
  // fail outright (this is exactly what left gardening-flow-test-01's
  // .venv created but empty).
  assert.ok(!pipInstallStep!.includes("-e"), "fallback must not attempt an editable install with no manifest present");
});

/**
 * Oct 2026 regression test -- reproduces the SECOND real failure hit live
 * on the same gardening-flow-test-01 project, right after the no-manifest
 * detection fix above let the backend be detected and installed for the
 * first time: pip 19.2.3 (the venv's own ancient bootstrapped version)
 * failed the real fastapi/uvicorn/sqlalchemy/pydantic install with
 * `pip._vendor.pep517.wrappers.BackendUnavailable` while building
 * sqlalchemy's wheel -- an out-of-date pip predating mature PEP 517
 * support, not a problem with the package itself.
 */
test("backendInstallSteps upgrades pip/setuptools/wheel before the real dependency install", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-pip-upgrade-"));
  const steps = backendInstallSteps(dir);
  const upgradeIndex = steps.findIndex((s) => s.includes("--upgrade") && s.includes("pip"));
  assert.ok(upgradeIndex !== -1, "expected a pip/setuptools/wheel upgrade step");
  assert.ok(steps[upgradeIndex].includes("setuptools"), "upgrade step should also cover setuptools");
  assert.ok(steps[upgradeIndex].includes("wheel"), "upgrade step should also cover wheel");
  const realInstallIndex = steps.findIndex((s) => s.includes("fastapi"));
  assert.ok(realInstallIndex !== -1, "expected the real dependency install step too");
  assert.ok(upgradeIndex < realInstallIndex, "pip must be upgraded BEFORE the real install, not after");
});

/**
 * Oct 2026 regression test -- reproduces the THIRD real failure hit live on
 * the same gardening-flow-test-01 project, right after the pip-upgrade fix
 * above let the upgrade step actually run for the first time: pip's own
 * in-place self-upgrade failed with `ERROR: Could not install packages due
 * to an EnvironmentError: [Errno 13] Permission denied: 'RECORD'` -- a
 * well-documented pip self-upgrade pitfall, unrelated to whether the venv's
 * existing pip can still install the real dependencies queued right after
 * it. isOptionalPipUpgradeStep is what runInstallSteps' exit handler uses
 * to recognize this exact step so its failure can be logged and skipped
 * past instead of aborting the whole install (see its own doc comment and
 * runInstallSteps' exit handler for the other half of this fix).
 */
test("isOptionalPipUpgradeStep matches the real pip/setuptools/wheel upgrade step backendInstallSteps queues", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-pip-upgrade-optional-"));
  const steps = backendInstallSteps(dir);
  const upgradeStep = steps.find((s) => s.includes("--upgrade") && s.includes("pip"));
  assert.ok(upgradeStep, "expected a pip/setuptools/wheel upgrade step to check against");
  assert.ok(isOptionalPipUpgradeStep(upgradeStep!), "the real upgrade step backendInstallSteps produces must be recognized as optional");
});

test("isOptionalPipUpgradeStep does not match the real (required) dependency install steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-pip-upgrade-optional-negative-"));
  const steps = backendInstallSteps(dir);
  const requiredSteps = steps.filter((s) => !(s.includes("--upgrade") && s.includes("pip")));
  assert.ok(requiredSteps.length > 0, "expected at least one required (non-upgrade) install step to check against");
  for (const step of requiredSteps) {
    assert.ok(!isOptionalPipUpgradeStep(step), `required step must not be misclassified as the optional pip upgrade: ${step.join(" ")}`);
  }
});

/**
 * Oct 2026 regression test -- reproduces the EXACT broken state found live
 * when actually running Start Preview against gardening-flow-test-01's
 * frontend: a genuinely complete `next` package under node_modules (every
 * file a real `npm install` would produce) but a completely EMPTY
 * node_modules/.bin/ -- an interrupted earlier install that got through
 * downloading packages but never linked their binaries. `npm run dev`
 * failed with `sh: next: command not found`, and the old
 * "does node_modules exist" check wrongly treated this as "nothing to
 * install".
 */
test("frontendInstallSteps re-installs when node_modules exists but the dev script's own binary is missing from .bin/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-broken-bin-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "gardening-frontend", scripts: { dev: "next dev", build: "next build" } }),
  );
  const nodeModules = join(dir, "node_modules");
  await mkdir(join(nodeModules, "next"), { recursive: true });
  await writeFile(join(nodeModules, "next", "package.json"), JSON.stringify({ name: "next", version: "13.5.2" }));
  await mkdir(join(nodeModules, ".bin"), { recursive: true }); // present, but empty -- the broken state

  const steps = frontendInstallSteps(dir);
  assert.equal(steps.length, 1, "expected a reinstall to be queued despite node_modules already existing");
  assert.ok(steps[0][0].endsWith("/npm"), `expected an absolute npm executable, got ${steps[0][0]}`);
  assert.deepEqual(steps[0].slice(1), ["install"]);
});

test("frontendInstallSteps finds nothing to do when the dev script's binary is genuinely present in .bin/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-preview-test-good-bin-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "gardening-frontend", scripts: { dev: "next dev" } }));
  const nodeModules = join(dir, "node_modules");
  await mkdir(join(nodeModules, ".bin"), { recursive: true });
  await writeFile(join(nodeModules, ".bin", "next"), "#!/usr/bin/env node\n"); // a real, complete install

  assert.deepEqual(frontendInstallSteps(dir), []);
});
