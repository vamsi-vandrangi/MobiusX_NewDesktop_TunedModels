import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherAuthEvidence, hasWiredAuthImplementation } from "../src/authContext.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-auth-test-"));
}

test("gatherAuthEvidence reports everything honestly empty for a project with no auth dependency, backend, or auth-shaped file", async () => {
  const dir = await tempProject();
  const evidence = await gatherAuthEvidence(dir);
  assert.equal(evidence.projectPath, dir);
  assert.deepEqual(evidence.authComponents, []);
  assert.deepEqual(evidence.backendComponents, []);
  assert.deepEqual(evidence.existingAuthFiles, []);
});

test("gatherAuthEvidence detects a declared JS auth dependency and a real backend component", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "backend", "package.json"), JSON.stringify({ dependencies: { express: "4.18.0", jsonwebtoken: "9.0.0" } }));
  const evidence = await gatherAuthEvidence(dir);
  const auth = evidence.authComponents.find((c) => c.name.includes("JWT"));
  assert.ok(auth, "expected a detected JWT auth component");
  assert.equal(auth!.location, "backend");
  const backend = evidence.backendComponents.find((c) => c.location === "backend");
  assert.ok(backend, "expected a detected backend component");
});

test("gatherAuthEvidence finds an existing auth-shaped file by filename convention and returns its full content", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend", "middleware"), { recursive: true });
  await writeFile(join(dir, "backend", "middleware", "auth.py"), "def require_auth():\n    pass\n");
  const evidence = await gatherAuthEvidence(dir);
  const byPath = new Map(evidence.existingAuthFiles.map((f) => [f.relPath, f.content]));
  assert.equal(byPath.get("backend/middleware/auth.py"), "def require_auth():\n    pass\n");
});

test("gatherAuthEvidence does not mistake an unrelated file for an auth-shaped one", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "backend", "pricing.py"), "def calculate_total():\n    pass\n");
  const evidence = await gatherAuthEvidence(dir);
  assert.deepEqual(evidence.existingAuthFiles, []);
});

test("hasWiredAuthImplementation is false when an auth-shaped file exists but contains no real token-verification call", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  // Auth-shaped path, but only imports a library -- never actually verifies a token.
  await writeFile(join(dir, "backend", "auth.py"), "import jwt\n\n# TODO: implement real verification\n");
  const wired = await hasWiredAuthImplementation(dir);
  assert.equal(wired, false);
});

test("hasWiredAuthImplementation is true when an auth-shaped file contains a real token-verification call", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(
    join(dir, "backend", "auth.py"),
    "import jwt\n\ndef verify(token):\n    return jwt.decode(token, SECRET, algorithms=['HS256'])\n",
  );
  const wired = await hasWiredAuthImplementation(dir);
  assert.equal(wired, true);
});
