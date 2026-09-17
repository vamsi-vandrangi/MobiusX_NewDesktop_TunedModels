import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectHooks, runHooksForEvent } from "../src/hooks.js";

test("loadProjectHooks returns no rules and no error when there is no project open", async () => {
  assert.deepEqual(await loadProjectHooks(null), { rules: [], path: null, error: null });
});

test("loadProjectHooks returns no rules and no error when .mobiusx/hooks.json doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  assert.deepEqual(await loadProjectHooks(dir), { rules: [], path: null, error: null });
});

test("loadProjectHooks loads valid rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "hooks.json"),
    JSON.stringify({ hooks: [{ id: "tests", event: "before-commit", command: "echo ok" }] }),
  );
  const result = await loadProjectHooks(dir);
  assert.equal(result.error, null);
  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0]!.id, "tests");
});

test("loadProjectHooks ignores the WHOLE file on a malformed entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "hooks.json"),
    JSON.stringify({ hooks: [{ id: "ok", event: "before-commit", command: "echo ok" }, { id: "bad", event: "not-a-real-event", command: "x" }] }),
  );
  const result = await loadProjectHooks(dir);
  assert.equal(result.rules.length, 0);
  assert.match(result.error ?? "", /event/);
});

test("loadProjectHooks reports an invalid pathPattern regex", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "hooks.json"),
    JSON.stringify({ hooks: [{ id: "bad", event: "after-api-change", command: "x", pathPattern: "(" }] }),
  );
  const result = await loadProjectHooks(dir);
  assert.equal(result.rules.length, 0);
  assert.match(result.error ?? "", /pathPattern/);
});

test("runHooksForEvent runs a real command and reports pass/fail honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "hooks.json"),
    JSON.stringify({
      hooks: [
        { id: "passing", event: "before-commit", command: "echo hello-from-hook" },
        { id: "failing", event: "before-commit", command: "exit 1" },
      ],
    }),
  );
  const results = await runHooksForEvent(dir, "before-commit");
  assert.equal(results.length, 2);
  assert.equal(results[0]!.status, "passed");
  assert.match(results[0]!.output, /hello-from-hook/);
  assert.equal(results[1]!.status, "failed");
});

test("runHooksForEvent's after-api-change rule only fires when a changed path matches pathPattern", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "hooks.json"),
    JSON.stringify({
      hooks: [{ id: "openapi", event: "after-api-change", command: "echo regenerated", pathPattern: "routes.*\\.ts$" }],
    }),
  );
  const noMatch = await runHooksForEvent(dir, "after-api-change", { changedPaths: ["src/unrelated.ts"] });
  assert.equal(noMatch.length, 0);
  const match = await runHooksForEvent(dir, "after-api-change", { changedPaths: ["src/routes.ts"] });
  assert.equal(match.length, 1);
  assert.equal(match[0]!.status, "passed");
});

test("runHooksForEvent with changedPaths omitted (manual test run) ignores pathPattern scoping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-hooks-test-"));
  await mkdir(join(dir, ".mobiusx"));
  await writeFile(
    join(dir, ".mobiusx", "hooks.json"),
    JSON.stringify({ hooks: [{ id: "scoped", event: "after-api-change", command: "echo x", pathPattern: "never-matches-anything" }] }),
  );
  const results = await runHooksForEvent(dir, "after-api-change");
  assert.equal(results.length, 1);
});
