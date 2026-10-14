import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProposedEdit } from "@mobiusx/protocol";

// Point settings and memory at isolated temp dirs before importing anything
// that reads them -- same pattern as taskEngine.test.ts.
const settingsDir = await mkdtemp(join(tmpdir(), "mobiusx-memoryExtraction-settings-"));
process.env.MOBIUSX_SETTINGS_DIR = settingsDir;
const memoryDir = await mkdtemp(join(tmpdir(), "mobiusx-memoryExtraction-memory-"));
process.env.MOBIUSX_MEMORY_DIR = memoryDir;

const { updateSettings } = await import("@mobiusx/agent-settings");
const { listMemoryFiles } = await import("@mobiusx/assistant-memory");
const { maybeExtractAssistantMemory } = await import("../src/runners/memoryExtraction.js");

function baseInput(overrides: Record<string, unknown> = {}) {
  return { taskId: "t1", mode: "build", prompt: "build a thing", modelId: "test-model", ...overrides } as Parameters<typeof maybeExtractAssistantMemory>[0];
}

const edit: ProposedEdit = { path: "src/index.ts", action: "create", content: "console.log('hi')" };

test("memoryMode off (default): callModel is never invoked, nothing is written", async () => {
  await updateSettings({ memoryMode: "off" });
  let called = false;
  await maybeExtractAssistantMemory(baseInput(), "some output", [edit], async () => {
    called = true;
    return "[preferences] test";
  });
  assert.equal(called, false);
});

test("memoryMode auto: a NONE response writes nothing", async () => {
  await updateSettings({ memoryMode: "auto" });
  await maybeExtractAssistantMemory(baseInput(), "some output", [edit], async () => "NONE");
  const files = await listMemoryFiles();
  assert.deepEqual(files, []);
});

test("staged builds defer memory extraction until the final stage", async () => {
  await updateSettings({ memoryMode: "auto" });
  let calls = 0;
  await maybeExtractAssistantMemory(baseInput({ stagedBuild: { index: 2, total: 6, id: "database", final: false } }), "stage response", [edit], async () => {
    calls += 1;
    return "NONE";
  });
  assert.equal(calls, 0);
  await maybeExtractAssistantMemory(baseInput({ stagedBuild: { index: 6, total: 6, id: "tests", final: true } }), "final response", [edit], async () => {
    calls += 1;
    return "NONE";
  });
  assert.equal(calls, 1);
});

test("memoryMode auto: valid lines are appended to the right files", async () => {
  await updateSettings({ memoryMode: "auto" });
  await maybeExtractAssistantMemory(
    baseInput(),
    "some output",
    [edit],
    async () => "[preferences] Prefers FastAPI over Flask for new backend services\n[topic-database] Uses SQLite for prototypes, Postgres in production\n[profile] AI Architect",
  );
  const files = await listMemoryFiles();
  const preferences = files.find((f) => f.name === "preferences");
  const topicDb = files.find((f) => f.name === "topic-database");
  const profile = files.find((f) => f.name === "profile");
  assert.ok(preferences);
  assert.match(preferences!.content, /Prefers FastAPI over Flask/);
  assert.ok(topicDb);
  assert.match(topicDb!.content, /Uses SQLite for prototypes, Postgres in production/);
  assert.ok(profile);
  assert.match(profile!.content, /AI Architect/);
});

test("memoryMode auto: lines without a valid [target] prefix are ignored, not guessed at", async () => {
  // @mobiusx/assistant-memory reads MOBIUSX_MEMORY_DIR once at module load
  // (same convention as @mobiusx/agent-settings' SETTINGS_DIR -- see both
  // modules' doc comments), so this asserts against the one shared
  // memoryDir for the whole file rather than attempting a fresh isolated
  // directory mid-test: before/after file counts must be identical.
  await updateSettings({ memoryMode: "auto" });
  const before = await listMemoryFiles();
  await maybeExtractAssistantMemory(baseInput(), "some output", [edit], async () => "Just a plain sentence with no bracket prefix");
  const after = await listMemoryFiles();
  assert.deepEqual(before, after);
});

test("memoryMode auto: nothing to extract from (empty output, no edits) skips the callModel call entirely", async () => {
  await updateSettings({ memoryMode: "auto" });
  let called = false;
  await maybeExtractAssistantMemory(baseInput(), "", [], async () => {
    called = true;
    return "NONE";
  });
  assert.equal(called, false);
});

test("memoryMode auto: a callModel failure never throws (best-effort, same contract as runPersonaReview)", async () => {
  await updateSettings({ memoryMode: "auto" });
  await assert.doesNotReject(
    maybeExtractAssistantMemory(baseInput(), "some output", [edit], async () => {
      throw new Error("network error");
    }),
  );
});
