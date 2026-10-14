import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { buildSnapshot, snapshotToNodes, resolveWithinProject, readProjectFile, applyEdits, validateEditBundle, validateLocalEdits } from "../src/fsOps.js";

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

test("validateEditBundle normalizes safe paths and rejects duplicate, absolute, and oversized bundles", () => {
  const normalized = validateEditBundle([{ path: ".\\src\\new.ts", action: "create", content: "export {};" }]);
  assert.equal(normalized.edits?.[0]?.path, "src/new.ts");
  assert.equal(validateEditBundle([
    { path: "src/a.ts", action: "create", content: "a" },
    { path: "src\\a.ts", action: "create", content: "b" },
  ]).edits, undefined);
  assert.equal(validateEditBundle([{ path: "/tmp/outside", action: "create", content: "x" }]).edits, undefined);
  assert.equal(validateEditBundle([{ path: "../outside", action: "create", content: "x" }]).edits, undefined);
  assert.equal(validateEditBundle([{ path: "empty.ts", action: "create", content: "  " }]).edits, undefined);
});

test("validateLocalEdits rejects the entire batch if any destination is invalid", async () => {
  const dir = await makeFixture();
  const result = await validateLocalEdits(dir, [
    { path: "src/new.ts", action: "create", content: "export {};" },
    { path: "src/a.ts", action: "create", content: "would overwrite" },
  ]);
  assert.equal(result.edits, undefined);
  assert.match(result.errors.join(" "), /already exists/);
  await assert.rejects(readFile(join(dir, "src", "new.ts"), "utf8"), { code: "ENOENT" });
});

test("validateLocalEdits rejects symlink parents that escape the project", async () => {
  const dir = await makeFixture();
  const outside = await mkdtemp(join(tmpdir(), "mobiusx-agent-outside-"));
  const { symlink } = await import("node:fs/promises");
  await symlink(outside, join(dir, "linked"));
  const result = await validateLocalEdits(dir, [{ path: "linked/new.ts", action: "create", content: "x" }]);
  assert.equal(result.edits, undefined);
  assert.match(result.errors.join(" "), /outside the open project/);
});

test("readProjectFile reads a real file by relative path", async () => {
  const dir = await makeFixture();
  const result = await readProjectFile(dir, "src/a.ts");
  assert.equal(result.content, "export const a = 1;\n");
  assert.equal(result.truncated, false);
});

test("applyEdits creates a genuinely new file", async () => {
  const dir = await makeFixture();
  const results = await applyEdits(dir, [{ path: "src/new.ts", action: "create", content: "export const n = 1;\n" }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "applied");
  const content = await readFile(join(dir, "src", "new.ts"), "utf8");
  assert.equal(content, "export const n = 1;\n");
});

test("applyEdits modifies an existing file", async () => {
  const dir = await makeFixture();
  const results = await applyEdits(dir, [{ path: "src/a.ts", action: "modify", content: "export const a = 2;\n" }]);
  assert.equal(results[0].status, "applied");
  const content = await readFile(join(dir, "src", "a.ts"), "utf8");
  assert.equal(content, "export const a = 2;\n");
});

test("applyEdits refuses to create a path that already exists", async () => {
  const dir = await makeFixture();
  await assert.rejects(applyEdits(dir, [{ path: "src/a.ts", action: "create", content: "export const a = 999;\n" }]), /already exists/);
  // original content untouched
  const content = await readFile(join(dir, "src", "a.ts"), "utf8");
  assert.equal(content, "export const a = 1;\n");
});

test("applyEdits refuses to modify a path that doesn't exist", async () => {
  const dir = await makeFixture();
  await assert.rejects(applyEdits(dir, [{ path: "src/missing.ts", action: "modify", content: "x" }]), /does not exist/);
});

test("applyEdits refuses a path that escapes the project root", async () => {
  const dir = await makeFixture();
  await assert.rejects(applyEdits(dir, [{ path: "../../etc/passwd", action: "create", content: "x" }]), /stay inside the project/);
});

test("applyEdits skips (does not rewrite) content that looks like it contains a secret", async () => {
  const dir = await makeFixture();
  await assert.rejects(applyEdits(dir, [
    { path: "src/config.ts", action: "create", content: 'export const key = "AKIAABCDEFGHIJKLMNOP";\n' },
  ]), /secret-shaped/);
});

test("applyEdits creates parent directories for a new nested path", async () => {
  const dir = await makeFixture();
  const results = await applyEdits(dir, [
    { path: "src/nested/deep/file.ts", action: "create", content: "export const x = 1;\n" },
  ]);
  assert.equal(results[0].status, "applied");
  const content = await readFile(join(dir, "src", "nested", "deep", "file.ts"), "utf8");
  assert.equal(content, "export const x = 1;\n");
});

test("applyEdits rejects the whole batch before writing when one proposed edit is invalid", async () => {
  const dir = await makeFixture();
  await assert.rejects(applyEdits(dir, [
    { path: "src/a.ts", action: "modify", content: "export const a = 2;\n" },
    { path: "src/a.ts", action: "create", content: "duplicate" },
    { path: "src/brand-new.ts", action: "create", content: "export const b = 1;\n" },
  ]), /duplicate destination/);
  assert.equal(await readFile(join(dir, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  await assert.rejects(readFile(join(dir, "src", "brand-new.ts"), "utf8"), { code: "ENOENT" });
});

test("applyEdits rolls back already promoted modifications when a later file promotion fails", async () => {
  const dir = await makeFixture();
  await assert.rejects(applyEdits(dir, [
    { path: "src/a.ts", action: "modify", content: "export const a = 2;\n" },
    { path: "src/new.ts", action: "create", content: "export const n = 1;\n" },
  ], {
    linkCreate: async () => { throw new Error("injected promotion failure"); },
  }), /all promoted files were rolled back/);
  assert.equal(await readFile(join(dir, "src", "a.ts"), "utf8"), "export const a = 1;\n");
  await assert.rejects(readFile(join(dir, "src", "new.ts"), "utf8"), { code: "ENOENT" });
});
