import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, queryIndex } from "../src/query.js";
import { deobfuscatePath, loadOrCreateWorkspaceKey } from "../src/index.js";
import { readFile } from "node:fs/promises";

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-semantic-test-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "src", "orders.ts"),
    [
      "export class OrderService {",
      "  validate(order: Order): boolean {",
      "    return order.items.length > 0;",
      "  }",
      "",
      "  calculateTotal(order: Order): number {",
      "    return order.items.reduce((sum, item) => sum + item.price, 0);",
      "  }",
      "}",
      "",
      "export function formatCurrency(amount: number): string {",
      "  return `$${amount.toFixed(2)}`;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(dir, "src", "users.ts"),
    [
      "export class UserRepository {",
      "  findById(id: string): User | undefined {",
      "    return this.users.get(id);",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

test("buildIndex indexes supported files and queryIndex finds the most relevant chunk", async () => {
  const dir = await makeFixtureRepo();
  try {
    const buildStats = await buildIndex(dir);
    assert.equal(buildStats.filesChunked, 2);
    assert.ok(buildStats.chunksIndexed >= 3, `expected at least 3 chunks, got ${buildStats.chunksIndexed}`);

    const result = await queryIndex(dir, "calculate order total price", 3);
    assert.ok(result.hits.length > 0, "expected at least one hit");
    const top = result.hits[0]!;
    assert.equal(top.relPath, "src/orders.ts");
    assert.match(top.snippet, /calculateTotal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildIndex is incremental: unchanged files are not re-chunked on the second run", async () => {
  const dir = await makeFixtureRepo();
  try {
    await buildIndex(dir);
    const second = await buildIndex(dir);
    assert.equal(second.filesChunked, 0, "no files changed since the first build");
    assert.equal(second.chunksIndexed, 0);
    assert.ok(second.totalChunksInStore > 0, "the store should still report its existing chunks");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted vector store contains no raw source text or real paths", async () => {
  const dir = await makeFixtureRepo();
  try {
    await buildIndex(dir);
    const raw = await readFile(join(dir, ".mobiusx-index", "vectors.json"), "utf8");
    assert.doesNotMatch(raw, /calculateTotal/, "store must not contain identifier/source text");
    assert.doesNotMatch(raw, /orders\.ts/, "store must not contain the real file path");
    assert.doesNotMatch(raw, /users\.ts/, "store must not contain the real file path");

    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.records) && parsed.records.length > 0);
    for (const record of parsed.records) {
      assert.equal(typeof record.text, "undefined", "records must not carry chunk text");
      assert.equal(typeof record.symbolPath, "undefined", "records must not carry symbol names");
    }

    // Round-trip: the obfuscated paths in the store really do decode back to the real files.
    const key = await loadOrCreateWorkspaceKey(dir);
    const realPaths = new Set(parsed.records.map((r: { obfuscatedPath: string }) => deobfuscatePath(key, r.obfuscatedPath)));
    assert.deepEqual([...realPaths].sort(), ["src/orders.ts", "src/users.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removing a file from disk removes its chunks from the index on rebuild", async () => {
  const dir = await makeFixtureRepo();
  try {
    await buildIndex(dir);
    await rm(join(dir, "src", "users.ts"));
    const stats = await buildIndex(dir);
    assert.equal(stats.filesRemoved, 1);

    const result = await queryIndex(dir, "find user by id", 5);
    assert.ok(
      result.hits.every((h) => h.relPath !== "src/users.ts"),
      "deleted file's chunks must not surface in query results",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
