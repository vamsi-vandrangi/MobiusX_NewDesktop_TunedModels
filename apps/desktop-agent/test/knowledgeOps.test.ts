import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the global knowledge-sources store at an isolated temp dir before
// importing anything that reads it — same pattern agent-settings' own test
// suite uses (see its own module doc comment) so this never touches a real
// ~/.mobiusx.
const settingsDir = await mkdtemp(join(tmpdir(), "mobiusx-knowledge-test-"));
process.env.MOBIUSX_SETTINGS_DIR = settingsDir;

const { addKnowledgeSource, buildKnowledgeIndex, listKnowledgeSources, removeKnowledgeSource, searchKnowledge } = await import("../src/knowledgeOps.js");

test("listKnowledgeSources returns [] when nothing has been added yet", async () => {
  assert.deepEqual(await listKnowledgeSources(), []);
});

test("searchKnowledge returns [] when no sources are configured, without throwing", async () => {
  const { hits } = await searchKnowledge("anything", 5);
  assert.deepEqual(hits, []);
});

test("addKnowledgeSource rejects a path that isn't a real directory", async () => {
  await assert.rejects(() => addKnowledgeSource("bad", join(tmpdir(), "definitely-does-not-exist-mobiusx")));
});

test("addKnowledgeSource + listKnowledgeSources round-trips a real folder", async () => {
  const docsDir = await mkdtemp(join(tmpdir(), "mobiusx-knowledge-docs-"));
  const source = await addKnowledgeSource("My Docs", docsDir);
  assert.equal(source.label, "My Docs");
  assert.equal(source.path, docsDir);
  const sources = await listKnowledgeSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.id, source.id);
});

test("buildKnowledgeIndex indexes markdown files and searchKnowledge finds the relevant one", async () => {
  const docsDir = await mkdtemp(join(tmpdir(), "mobiusx-knowledge-docs-"));
  await writeFile(join(docsDir, "auth.md"), "# Authentication\n\nThis project uses JWT bearer tokens for API authentication. Tokens expire after 24 hours.\n");
  await writeFile(join(docsDir, "deploy.md"), "# Deployment\n\nWe deploy via GitHub Actions to a Kubernetes cluster every Friday.\n");
  const source = await addKnowledgeSource("Docs", docsDir);

  const results = await buildKnowledgeIndex(source.id);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.filesIndexed, 2);
  assert.ok(results[0]!.chunksIndexed >= 2);

  const { hits } = await searchKnowledge("JWT authentication tokens", 5);
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.relPath, "auth.md");
  assert.equal(hits[0]!.sourceId, source.id);
});

test("buildKnowledgeIndex skips non-markdown/text files and ignores node_modules/.git", async () => {
  const docsDir = await mkdtemp(join(tmpdir(), "mobiusx-knowledge-docs-"));
  await writeFile(join(docsDir, "notes.md"), "# Real notes\n\nKeep this one.\n");
  await writeFile(join(docsDir, "image.png"), "not really a png");
  await mkdir(join(docsDir, "node_modules"));
  await writeFile(join(docsDir, "node_modules", "ignored.md"), "# Should not be indexed\n");
  const source = await addKnowledgeSource("Mixed", docsDir);

  const [result] = await buildKnowledgeIndex(source.id);
  assert.equal(result!.filesIndexed, 1);
});

test("removeKnowledgeSource deletes it from the list and its index no longer contributes to search", async () => {
  const docsDir = await mkdtemp(join(tmpdir(), "mobiusx-knowledge-docs-"));
  await writeFile(join(docsDir, "topic.md"), "# Unique Topic\n\nSomething very specific goes here.\n");
  const source = await addKnowledgeSource("Temp", docsDir);
  await buildKnowledgeIndex(source.id);

  await removeKnowledgeSource(source.id);
  const sources = await listKnowledgeSources();
  assert.ok(!sources.some((s) => s.id === source.id));

  // A no-threshold top-k search still returns other sources' chunks for
  // an unrelated query (same "always return the closest k, however weak"
  // design semantic-index's own queryIndex uses) -- what removal actually
  // guarantees is that NONE of the results come from the removed source.
  const { hits } = await searchKnowledge("Unique Topic", 5);
  assert.ok(!hits.some((h) => h.sourceId === source.id));
});

