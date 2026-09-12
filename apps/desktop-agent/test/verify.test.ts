import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerificationSteps, verifyProject } from "../src/verify.js";

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
