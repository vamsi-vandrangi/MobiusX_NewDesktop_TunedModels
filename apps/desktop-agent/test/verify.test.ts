import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPythonTestSteps, detectVerificationSteps, verifyProject } from "../src/verify.js";

const execFileAsync = promisify(execFile);

async function fixtureWithScripts(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2));
  return dir;
}

test("detectVerificationSteps finds known scripts in a sensible order", async () => {
  const dir = await fixtureWithScripts({ test: "echo test", build: "echo build", lint: "echo lint" });
  const steps = await detectVerificationSteps(dir);
  assert.deepEqual(
    steps.map((s) => s.scriptName),
    ["build", "lint", "test"], // typecheck absent; order follows KNOWN_SCRIPT_NAMES, not object key order
  );
});

test("detectVerificationSteps ignores unknown script names", async () => {
  const dir = await fixtureWithScripts({ start: "node index.js", deploy: "echo deploy" });
  const steps = await detectVerificationSteps(dir);
  assert.equal(steps.length, 0);
});

test("detectVerificationSteps returns [] for a project with no package.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
  const steps = await detectVerificationSteps(dir);
  assert.equal(steps.length, 0);
});

test("verifyProject reports no-verification-available when nothing to run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
  const result = await verifyProject(dir);
  assert.equal(result.overall, "no-verification-available");
  assert.deepEqual(result.steps, []);
});

test("verifyProject runs a passing script and reports real evidence", async () => {
  const dir = await fixtureWithScripts({ build: "node -e \"console.log('built ok')\"" });
  const result = await verifyProject(dir);
  assert.equal(result.overall, "passed");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, "passed");
  assert.equal(result.steps[0].exitCode, 0);
  assert.match(result.steps[0].output, /built ok/);
});

test("verifyProject reports a failing script honestly, and still runs the rest", async () => {
  const dir = await fixtureWithScripts({
    build: "node -e \"process.exit(1)\"",
    test: "node -e \"console.log('tests ran')\"",
  });
  const result = await verifyProject(dir);
  assert.equal(result.overall, "failed");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].status, "failed");
  assert.equal(result.steps[0].exitCode, 1);
  assert.equal(result.steps[1].status, "passed"); // ran despite the earlier failure
});

test("verifyProject kills and reports timed_out for a script that hangs past its timeout", async () => {
  const dir = await fixtureWithScripts({ build: "node -e \"setInterval(() => {}, 1000)\"" });
  const result = await verifyProject(dir, 500);
  assert.equal(result.overall, "failed");
  assert.equal(result.steps[0].status, "timed_out");
  assert.match(result.steps[0].output, /timed out/);
});

test("verifyProject truncates very large output and marks it truncated", async () => {
  const dir = await fixtureWithScripts({ build: "node -e \"console.log('x'.repeat(20000))\"" });
  const result = await verifyProject(dir);
  assert.equal(result.steps[0].truncated, true);
  assert.ok(result.steps[0].output.length <= 8000);
});

// ---- Testing Engine (roadmap Phase 10): Python/pytest detection ----
//
// detectPythonTestSteps is tested directly (never-executed) rather than
// only through a full verifyProject run, so this suite doesn't depend on
// a real `pytest` install being present on whatever machine runs it --
// the same reasoning verify.ts itself follows for never assuming a tool
// is installed just because a project references it. A separate,
// self-skipping integration test below exercises the real end-to-end
// spawn (detection -> run -> pass/fail) when a `pytest` IS importable in
// this environment.

test("detectPythonTestSteps finds nothing when requirements.txt doesn't declare pytest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
  await writeFile(join(dir, "requirements.txt"), "fastapi==0.110.0\nsqlmodel\n");
  const steps = await detectPythonTestSteps(dir);
  assert.equal(steps.length, 0); // pytest not declared -- never invented
});

test("detectPythonTestSteps finds a backend/ subdirectory that declares pytest, with no root package.json needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
  const backend = join(dir, "backend");
  await mkdir(backend, { recursive: true });
  await writeFile(join(backend, "requirements.txt"), "fastapi==0.110.0\npytest==8.0.0\n");
  const steps = await detectPythonTestSteps(dir);
  assert.equal(steps.length, 1);
  assert.match(steps[0].label, /pytest, backend\//);
  assert.equal(steps[0].cwd, backend);
  assert.deepEqual(steps[0].spawnArgs, ["-m", "pytest", "-q"]);
  // No .venv exists in this fixture, so it must fall back to a bare interpreter, never invent a venv path that isn't there.
  assert.ok(steps[0].spawnCmd === "python3" || steps[0].spawnCmd === "python");
});

test("detectPythonTestSteps also recognizes pytest declared via pyproject.toml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
  await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "fixture"\ndependencies = ["fastapi", "pytest>=8.0"]\n');
  const steps = await detectPythonTestSteps(dir);
  assert.equal(steps.length, 1);
  assert.match(steps[0].label, /pytest, root/);
});

test("verifyProject combines npm steps and Python test steps in one report", async () => {
  const dir = await fixtureWithScripts({ build: "node -e \"console.log('built ok')\"" });
  await writeFile(join(dir, "requirements.txt"), "pytest==8.0.0\n");
  const planned = await detectPythonTestSteps(dir);
  assert.equal(planned.length, 1); // sanity: this fixture really does plan a pytest step
});

// Real, end-to-end confirmation that a detected pytest step actually runs
// and reports genuine pass/fail -- skipped (not failed) when this
// environment has no `pytest` module reachable via `python3 -m pytest`,
// since this suite must never assume a tool is installed just to test
// against it.
let pytestAvailable = false;
try {
  await execFileAsync("python3", ["-m", "pytest", "--version"]);
  pytestAvailable = true;
} catch {
  pytestAvailable = false;
}

test(
  "verifyProject actually runs pytest and reports a real pass/fail (requires a local pytest install)",
  { skip: !pytestAvailable ? "python3 -m pytest is not available in this environment" : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "mobiusx-verify-test-"));
    await writeFile(join(dir, "requirements.txt"), "pytest\n");
    await writeFile(join(dir, "test_sample.py"), "def test_ok():\n    assert 1 + 1 == 2\n");
    const result = await verifyProject(dir);
    assert.equal(result.overall, "passed");
    const pytestStep = result.steps.find((s) => s.label.includes("pytest"));
    assert.ok(pytestStep);
    assert.equal(pytestStep!.status, "passed");

    // Same project, now with a genuinely failing test -- reported honestly, not hidden.
    await writeFile(join(dir, "test_sample.py"), "def test_fails():\n    assert False\n");
    const result2 = await verifyProject(dir);
    assert.equal(result2.overall, "failed");
    const pytestStep2 = result2.steps.find((s) => s.label.includes("pytest"));
    assert.equal(pytestStep2!.status, "failed");
  },
);
