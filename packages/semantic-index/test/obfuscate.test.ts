import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorkspaceKey, obfuscatePath, deobfuscatePath } from "../src/obfuscate.js";

test("round-trips ordinary and edge-case paths exactly", () => {
  const key = generateWorkspaceKey();
  const paths = [
    "src/services/orderService.ts",
    "README.md",
    ".gitignore",
    "packages/context-engine/test/tree.test.ts",
    "a/b/c/d/e.f.g.h.ts",
    "",
  ];
  for (const p of paths) {
    const obfuscated = obfuscatePath(key, p);
    assert.equal(deobfuscatePath(key, obfuscated), p, `round-trip failed for ${JSON.stringify(p)}`);
  }
});

test("obfuscated output contains none of the real segment names", () => {
  const key = generateWorkspaceKey();
  const real = "src/services/orderPaymentValidator.ts";
  const obfuscated = obfuscatePath(key, real);
  for (const segment of ["src", "services", "orderPaymentValidator", "ts"]) {
    assert.ok(!obfuscated.includes(segment), `leaked plaintext segment "${segment}" in ${obfuscated}`);
  }
  // directory depth and dot-count are the one thing this scheme (like Cursor's) does
  // not hide — document that as a property, not pretend otherwise.
  assert.equal(obfuscated.split("/").length, real.split("/").length);
});

test("the same segment always obfuscates the same way under one key (determinism)", () => {
  const key = generateWorkspaceKey();
  const a = obfuscatePath(key, "src/utils/math.ts");
  const b = obfuscatePath(key, "lib/utils/math.ts");
  const aSegs = a.split("/");
  const bSegs = b.split("/");
  assert.equal(aSegs[1], bSegs[1], "the shared 'utils' segment should obfuscate identically both times");
  assert.equal(aSegs[2], bSegs[2], "the shared 'math.ts' segment should obfuscate identically both times");
});

test("different workspace keys produce different ciphertext for the same path", () => {
  const keyA = generateWorkspaceKey();
  const keyB = generateWorkspaceKey();
  const path = "src/index.ts";
  assert.notEqual(obfuscatePath(keyA, path), obfuscatePath(keyB, path));
});

test("decrypting with the wrong key fails loudly rather than returning garbage silently", () => {
  const keyA = generateWorkspaceKey();
  const keyB = generateWorkspaceKey();
  const obfuscated = obfuscatePath(keyA, "src/index.ts");
  assert.throws(() => deobfuscatePath(keyB, obfuscated));
});
