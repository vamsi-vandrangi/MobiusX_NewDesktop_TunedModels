import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the memory dir at an isolated temp dir BEFORE importing anything
// that reads it — same pattern as @mobiusx/agent-settings' own test suite
// (and the same reason: MEMORY_DIR, like SETTINGS_DIR, is read from
// MOBIUSX_MEMORY_DIR once at module load, not re-read per call, so this
// must be set before the first import and stays fixed for the whole file —
// tests below use distinct file names rather than separate directories).
const memoryDir = await mkdtemp(join(tmpdir(), "mobiusx-assistant-memory-test-"));
process.env.MOBIUSX_MEMORY_DIR = memoryDir;

const {
  appendMemoryFacts,
  buildAssistantMemoryContext,
  DEFAULT_MEMORY_TEMPLATES,
  deleteMemoryFile,
  getMemoryDir,
  listMemoryFiles,
  scaffoldDefaultMemory,
  writeMemoryFile,
} = await import("../src/index.js");

test("getMemoryDir reports the MOBIUSX_MEMORY_DIR override", async () => {
  assert.equal(getMemoryDir(), memoryDir);
});

test("writeMemoryFile writes a real file, listMemoryFiles reads it back", async () => {
  await writeMemoryFile("profile", "# Profile\n\nAI Architect.\n");
  const files = await listMemoryFiles();
  const profile = files.find((f) => f.name === "profile");
  assert.ok(profile);
  assert.match(profile!.content, /AI Architect/);
});

test("writeMemoryFile rejects an unsafe name", async () => {
  await assert.rejects(() => writeMemoryFile("../../etc/passwd", "x"));
  await assert.rejects(() => writeMemoryFile("has spaces", "x"));
});

test("deleteMemoryFile removes a file; listMemoryFiles no longer reports it", async () => {
  await writeMemoryFile("scratch", "# Scratch\n");
  await deleteMemoryFile("scratch");
  const files = await listMemoryFiles();
  assert.ok(!files.some((f) => f.name === "scratch"));
});

test("scaffoldDefaultMemory writes the default templates, never clobbers an existing customized file", async () => {
  // "profile" was already written by an earlier test above (shared dir, by
  // design — see the file-level comment) with real custom content, so this
  // doubles as the "never clobbers" assertion without needing a fresh dir.
  const before = await listMemoryFiles();
  const existingNames = new Set(before.map((f) => f.name));
  const written = await scaffoldDefaultMemory();
  const expectedNew = DEFAULT_MEMORY_TEMPLATES.filter((t) => !existingNames.has(t.name)).length;
  assert.equal(written.length, expectedNew);
  const profile = (await listMemoryFiles()).find((f) => f.name === "profile")!;
  assert.match(profile.content, /AI Architect/); // untouched by scaffolding
});

test("appendMemoryFacts creates a new file when none exists yet", async () => {
  const file = await appendMemoryFacts("topic-database", ["Uses SQLite for prototypes, Postgres in production"]);
  assert.match(file.content, /Uses SQLite for prototypes, Postgres in production/);
});

test("appendMemoryFacts appends to an existing file without discarding what's already there", async () => {
  await writeMemoryFile("preferences", "# Working Preferences\n\n- Likes concise commit messages\n");
  const file = await appendMemoryFacts("preferences", ["Prefers FastAPI over Flask for new backend services"]);
  assert.match(file.content, /Likes concise commit messages/);
  assert.match(file.content, /Prefers FastAPI over Flask for new backend services/);
});

test("appendMemoryFacts dedups a fact that's already present (case-insensitive, exact line)", async () => {
  await appendMemoryFacts("preferences", ["Prefers TypeScript for new services"]);
  const before = await listMemoryFiles();
  const file = await appendMemoryFacts("preferences", ["prefers typescript for new services"]); // same fact, different case
  const occurrences = (file.content.match(/typescript for new services/gi) ?? []).length;
  assert.equal(occurrences, 1);
  const after = await listMemoryFiles();
  assert.equal(before.length, after.length); // no new file created
});

test("buildAssistantMemoryContext returns undefined for an empty/heading-only file", async () => {
  await writeMemoryFile("empty-topic", "# Empty Topic\n\n");
  const combined = await buildAssistantMemoryContext();
  assert.ok(!combined?.includes("empty-topic"));
});

test("buildAssistantMemoryContext combines every non-empty file's content, labeled by filename", async () => {
  const combined = await buildAssistantMemoryContext();
  assert.ok(combined);
  assert.match(combined!, /memory\/profile\.md/);
  assert.match(combined!, /AI Architect/);
  assert.match(combined!, /memory\/preferences\.md/);
  assert.match(combined!, /Likes concise commit messages/);
});
