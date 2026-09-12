import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, snapshotToNodes, resolveWithinProject, readProjectFile } from "../src/fsOps.js";

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-agent-test-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(dir, "README.md"), "# fixture\n");
  return dir;
}

test("buildSnapshot + snapshotToNodes finds files and dirs", async () => {
  const dir = await makeFixture();
  const snapshot = await buildSnapshot(dir);
  const nodes = snapshotToNodes(snapshot);
  const paths = nodes.map((n) => n.path).sort();
  assert.deepEqual(paths, ["README.md", "src", "src/a.ts"]);
});

test("resolveWithinProject rejects path traversal", async () => {
  const dir = await makeFixture();
  assert.throws(() => resolveWithinProject(dir, "../../etc/passwd"));
});

test("readProjectFile reads a real file by relative path", async () => {
  const dir = await makeFixture();
  const result = await readProjectFile(dir, "src/a.ts");
  assert.equal(result.content, "export const a = 1;\n");
  assert.equal(result.truncated, false);
});
