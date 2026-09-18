import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProposedEdit } from "@mobiusx/protocol";
import { createCheckpoint, deleteCheckpoint, listCheckpoints, readCheckpoint, restoreCheckpoint } from "../src/checkpoints.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-checkpoints-test-"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("createCheckpoint snapshots pre-edit content for a modify of an existing file", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "app.ts"), "console.log('before')\n");
  const edits: ProposedEdit[] = [{ path: "app.ts", action: "modify", content: "console.log('after')\n" }];

  const cp = await createCheckpoint(dir, edits);

  assert.equal(cp.entryCount, 1);
  assert.equal(cp.entries[0].path, "app.ts");
  assert.equal(cp.entries[0].action, "modify");
  assert.equal(cp.entries[0].hadPreviousContent, true);

  const stored = await readFile(join(dir, ".mobiusx", "checkpoints", cp.id, "files", "app.ts"), "utf8");
  assert.equal(stored, "console.log('before')\n");
});

test("createCheckpoint records a create with no prior content, and stores nothing under files/", async () => {
  const dir = await tempProject();
  const edits: ProposedEdit[] = [{ path: "new-file.ts", action: "create", content: "export const x = 1;\n" }];

  const cp = await createCheckpoint(dir, edits);

  assert.equal(cp.entries[0].action, "create");
  assert.equal(cp.entries[0].hadPreviousContent, false);
  assert.equal(await exists(join(dir, ".mobiusx", "checkpoints", cp.id, "files", "new-file.ts")), false);
});

test("createCheckpoint skips a path that escapes the project root, without throwing", async () => {
  const dir = await tempProject();
  const edits: ProposedEdit[] = [
    { path: "../outside.ts", action: "create", content: "bad\n" },
    { path: "ok.ts", action: "create", content: "fine\n" },
  ];

  const cp = await createCheckpoint(dir, edits);

  assert.equal(cp.entries.length, 1);
  assert.equal(cp.entries[0].path, "ok.ts");
});

test("listCheckpoints returns summaries newest-first and tolerates a project with none yet", async () => {
  const dir = await tempProject();
  assert.deepEqual(await listCheckpoints(dir), []);

  await writeFile(join(dir, "a.ts"), "a\n");
  const first = await createCheckpoint(dir, [{ path: "a.ts", action: "modify", content: "a2\n" }], "first");
  await new Promise((r) => setTimeout(r, 5));
  const second = await createCheckpoint(dir, [{ path: "b.ts", action: "create", content: "b\n" }], "second");

  const summaries = await listCheckpoints(dir);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].id, second.id);
  assert.equal(summaries[1].id, first.id);
});

test("restoreCheckpoint writes back pre-edit content for a modify and deletes a created file, and reports a pre-restore checkpoint id", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "app.ts"), "before\n");

  const cp = await createCheckpoint(dir, [
    { path: "app.ts", action: "modify", content: "after\n" },
    { path: "new.ts", action: "create", content: "created\n" },
  ]);
  // Simulate applyEdits actually having run.
  await writeFile(join(dir, "app.ts"), "after\n");
  await writeFile(join(dir, "new.ts"), "created\n");

  const { results, preRestoreCheckpointId } = await restoreCheckpoint(dir, cp.id);

  assert.equal(await readFile(join(dir, "app.ts"), "utf8"), "before\n");
  assert.equal(await exists(join(dir, "new.ts")), false);
  assert.deepEqual(
    results.map((r) => [r.path, r.status]).sort(),
    [
      ["app.ts", "restored"],
      ["new.ts", "deleted"],
    ].sort(),
  );
  assert.ok(preRestoreCheckpointId, "expected a pre-restore checkpoint to have been taken");

  const preRestore = await readCheckpoint(dir, preRestoreCheckpointId!);
  assert.ok(preRestore);
  // The pre-restore snapshot captured the CURRENT (post-apply) state before restoring overwrote it.
  const appEntry = preRestore!.entries.find((e) => e.path === "app.ts");
  assert.equal(appEntry?.action, "modify");
  assert.equal(appEntry?.hadPreviousContent, true);
  const preRestoreStored = await readFile(join(dir, ".mobiusx", "checkpoints", preRestoreCheckpointId!, "files", "app.ts"), "utf8");
  assert.equal(preRestoreStored, "after\n");
});

test("restoreCheckpoint's pre-restore snapshot captures a hand-edit made after the original apply, not the original checkpoint's own recorded action", async () => {
  const dir = await tempProject();
  // Original checkpoint covers a "create" (file did not exist yet).
  const cp = await createCheckpoint(dir, [{ path: "gen.ts", action: "create", content: "v1\n" }]);
  // The file now exists (as if applyEdits ran) AND was hand-edited afterwards.
  await writeFile(join(dir, "gen.ts"), "hand-edited-v2\n");

  const { preRestoreCheckpointId } = await restoreCheckpoint(dir, cp.id);
  assert.ok(preRestoreCheckpointId);

  const preRestore = await readCheckpoint(dir, preRestoreCheckpointId!);
  const entry = preRestore!.entries.find((e) => e.path === "gen.ts");
  // Even though the ORIGINAL checkpoint recorded this path as "create", the pre-restore
  // checkpoint must treat it as a "modify" of whatever is actually on disk right now.
  assert.equal(entry?.action, "modify");
  assert.equal(entry?.hadPreviousContent, true);
  const stored = await readFile(join(dir, ".mobiusx", "checkpoints", preRestoreCheckpointId!, "files", "gen.ts"), "utf8");
  assert.equal(stored, "hand-edited-v2\n");

  // And the restore itself still correctly deletes gen.ts (undoing the original "create").
  assert.equal(await exists(join(dir, "gen.ts")), false);
});

test("restoreCheckpoint reports a path already absent as skipped rather than erroring", async () => {
  const dir = await tempProject();
  const cp = await createCheckpoint(dir, [{ path: "never-written.ts", action: "create", content: "x\n" }]);
  const { results } = await restoreCheckpoint(dir, cp.id);
  assert.equal(results[0].status, "skipped");
  assert.match(results[0].reason ?? "", /already absent/);
});

test("restoreCheckpoint on an unknown id throws rather than silently doing nothing", async () => {
  const dir = await tempProject();
  await assert.rejects(() => restoreCheckpoint(dir, "does-not-exist"));
});

test("deleteCheckpoint removes the checkpoint directory and reports false for an unknown id", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "x.ts"), "x\n");
  const cp = await createCheckpoint(dir, [{ path: "x.ts", action: "modify", content: "x2\n" }]);

  assert.equal(await deleteCheckpoint(dir, cp.id), true);
  assert.equal(await exists(join(dir, ".mobiusx", "checkpoints", cp.id)), false);
  assert.equal(await deleteCheckpoint(dir, cp.id), false);
  assert.equal(await deleteCheckpoint(dir, "never-existed"), false);
});
