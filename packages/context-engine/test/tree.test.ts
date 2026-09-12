import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile, applyChange } from "../src/tree.js";

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-index-test-"));
  await mkdir(join(dir, "src", "services"), { recursive: true });
  await mkdir(join(dir, "src", "utils"), { recursive: true });
  await writeFile(join(dir, "README.md"), "# fixture\n");
  await writeFile(join(dir, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "src", "services", "order.ts"), "export function order() {}\n");
  await writeFile(join(dir, "src", "utils", "math.ts"), "export const add = (a:number,b:number)=>a+b;\n");
  return dir;
}

test("cold reconcile hashes every file and is deterministic", async () => {
  const dir = await makeFixture();
  try {
    const a = await reconcile(dir, null);
    const b = await reconcile(dir, null);
    assert.equal(a.stats.filesHashed, 4);
    assert.equal(a.stats.filesSkippedCached, 0);
    assert.equal(a.snapshot.rootHash, b.snapshot.rootHash, "hashing the same tree twice must be deterministic");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("warm reconcile with nothing changed skips all content hashing", async () => {
  const dir = await makeFixture();
  try {
    const cold = await reconcile(dir, null);
    const warm = await reconcile(dir, cold.snapshot);
    assert.equal(warm.stats.filesHashed, 0);
    assert.equal(warm.stats.filesSkippedCached, 4);
    assert.equal(warm.stats.unchanged, true);
    assert.equal(warm.snapshot.rootHash, cold.snapshot.rootHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing one file re-hashes only that file, but changes every ancestor's hash up to root", async () => {
  const dir = await makeFixture();
  try {
    const cold = await reconcile(dir, null);
    await writeFile(join(dir, "src", "services", "order.ts"), "export function order() { return 42; }\n");

    const after = await reconcile(dir, cold.snapshot);
    assert.equal(after.stats.filesHashed, 1);
    assert.deepEqual(after.stats.changedPaths, ["src/services/order.ts"]);
    assert.equal(after.stats.filesSkippedCached, 3);
    assert.notEqual(after.snapshot.rootHash, cold.snapshot.rootHash, "root hash must change when any content changes");

    // sibling file's hash must be byte-for-byte identical — it was never touched
    assert.equal(
      after.snapshot.nodes["src/utils/math.ts"].hash,
      cold.snapshot.nodes["src/utils/math.ts"].hash,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing a file is detected without a stale node lingering", async () => {
  const dir = await makeFixture();
  try {
    const cold = await reconcile(dir, null);
    await rm(join(dir, "src", "utils", "math.ts"));

    const after = await reconcile(dir, cold.snapshot);
    assert.deepEqual(after.stats.removedPaths, ["src/utils/math.ts"]);
    assert.equal(after.snapshot.nodes["src/utils/math.ts"], undefined);
    assert.notEqual(after.snapshot.rootHash, cold.snapshot.rootHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyChange touches exactly the ancestor chain depth, not the whole tree", async () => {
  const dir = await makeFixture();
  try {
    const { snapshot } = await reconcile(dir, null);
    const rootHashBefore = snapshot.rootHash;
    const untouchedSiblingHash = snapshot.nodes["src/utils/math.ts"].hash;

    await writeFile(join(dir, "src", "services", "order.ts"), "export function order() { return 7; }\n");
    const result = await applyChange(snapshot, dir, "src/services/order.ts", "change");

    // depth of src/services/order.ts is 3: "src/services" -> "src" -> "" (root)
    assert.deepEqual(result.ancestorsTouched, ["src/services", "src", ""]);
    assert.equal(result.rootHashBefore, rootHashBefore);
    assert.notEqual(result.rootHashAfter, rootHashBefore);
    assert.equal(snapshot.rootHash, result.rootHashAfter);

    // an unrelated sibling subtree must be provably untouched by the incremental update
    assert.equal(snapshot.nodes["src/utils/math.ts"].hash, untouchedSiblingHash);

    // and applyChange's view of the world must agree with a full reconcile from scratch
    const fresh = await reconcile(dir, null);
    assert.equal(snapshot.rootHash, fresh.snapshot.rootHash);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
