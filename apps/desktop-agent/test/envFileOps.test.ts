import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectReferencedEnvVars, generateEnvExample } from "../src/envFileOps.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-envfile-test-"));
}

test("detectReferencedEnvVars reports honestly empty for a project with no env-var reads", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "app.py"), "def add(a, b):\n    return a + b\n");
  const refs = await detectReferencedEnvVars(dir);
  assert.deepEqual(refs, []);
});

test("detectReferencedEnvVars detects real process.env and os.getenv reads across JS and Python files", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "frontend.js"), "const key = process.env.API_KEY;\nconst url = process.env['DATABASE_URL'];\n");
  await writeFile(join(dir, "backend", "settings.py"), "import os\nSECRET = os.getenv('JWT_SECRET')\nDB = os.environ.get('DATABASE_URL')\n");
  const refs = await detectReferencedEnvVars(dir);
  const names = refs.map((r) => r.name).sort();
  assert.deepEqual(names, ["API_KEY", "DATABASE_URL", "JWT_SECRET"]);
  const dbRef = refs.find((r) => r.name === "DATABASE_URL");
  // Exactly one location is recorded even though DATABASE_URL is read from two files --
  // readdir order isn't guaranteed, so assert it's ONE of the two real locations, not which.
  assert.ok(["frontend.js", "backend/settings.py"].includes(dbRef!.relPath));
});

test("generateEnvExample writes .env.example with placeholder lines for real detected vars when none exists yet", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "app.py"), "import os\nAPI_KEY = os.getenv('API_KEY')\n");
  const result = await generateEnvExample(dir);
  assert.equal(result.wroteFile, true);
  assert.deepEqual(result.addedKeys, ["API_KEY"]);
  const content = await readFile(join(dir, ".env.example"), "utf8");
  assert.match(content, /^API_KEY=.*app\.py/m);
});

test("generateEnvExample never touches an already-set key and only adds genuinely missing ones", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "app.py"), "import os\nAPI_KEY = os.getenv('API_KEY')\nDB = os.getenv('DATABASE_URL')\n");
  await writeFile(join(dir, ".env.example"), "API_KEY=already-here-do-not-touch\n");
  const result = await generateEnvExample(dir);
  assert.equal(result.wroteFile, true);
  assert.deepEqual(result.addedKeys, ["DATABASE_URL"]);
  const content = await readFile(join(dir, ".env.example"), "utf8");
  assert.match(content, /API_KEY=already-here-do-not-touch/); // untouched, exact original line preserved
  assert.match(content, /DATABASE_URL=/);
});

test("generateEnvExample reports wroteFile: false and touches nothing when .env.example already covers everything detected", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "app.py"), "import os\nAPI_KEY = os.getenv('API_KEY')\n");
  await writeFile(join(dir, ".env.example"), "API_KEY=set\n");
  const before = await readFile(join(dir, ".env.example"), "utf8");
  const result = await generateEnvExample(dir);
  assert.equal(result.wroteFile, false);
  assert.deepEqual(result.addedKeys, []);
  const after = await readFile(join(dir, ".env.example"), "utf8");
  assert.equal(after, before);
});
