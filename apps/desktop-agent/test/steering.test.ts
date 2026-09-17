import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSteeringContext, DEFAULT_STEERING_TEMPLATES, deleteSteeringFile, listSteeringFiles, scaffoldDefaultSteering, writeSteeringFile } from "../src/steering.js";

test("listSteeringFiles returns [] when .mobiusx/steering doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  assert.deepEqual(await listSteeringFiles(dir), []);
});

test("writeSteeringFile writes a real file, listSteeringFiles reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  await writeSteeringFile(dir, "architecture", "# Architecture\n\nLayered.\n");
  const files = await listSteeringFiles(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.name, "architecture");
  assert.match(files[0]!.content, /Layered/);
});

test("writeSteeringFile rejects an unsafe name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  await assert.rejects(() => writeSteeringFile(dir, "../../etc/passwd", "x"));
  await assert.rejects(() => writeSteeringFile(dir, "has spaces", "x"));
});

test("deleteSteeringFile removes a file; listSteeringFiles no longer reports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  await writeSteeringFile(dir, "security", "# Security\n");
  await deleteSteeringFile(dir, "security");
  assert.deepEqual(await listSteeringFiles(dir), []);
});

test("scaffoldDefaultSteering writes all four templates, never clobbers an existing customized file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  await writeSteeringFile(dir, "security", "# Security\n\nMy real custom content.\n");
  const written = await scaffoldDefaultSteering(dir);
  assert.equal(written.length, DEFAULT_STEERING_TEMPLATES.length - 1); // security already existed, skipped
  const files = await listSteeringFiles(dir);
  assert.equal(files.length, DEFAULT_STEERING_TEMPLATES.length);
  const security = files.find((f) => f.name === "security")!;
  assert.match(security.content, /My real custom content/);
});

test("buildSteeringContext returns undefined when there are no steering files, or only empty ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  assert.equal(await buildSteeringContext(dir), undefined);
  await writeSteeringFile(dir, "empty", "   \n\n  ");
  assert.equal(await buildSteeringContext(dir), undefined);
});

test("buildSteeringContext combines every non-empty file's content, labeled by filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-steering-test-"));
  await writeSteeringFile(dir, "architecture", "Layered architecture.");
  await writeSteeringFile(dir, "security", "Never log secrets.");
  const combined = await buildSteeringContext(dir);
  assert.ok(combined);
  assert.match(combined!, /architecture\.md/);
  assert.match(combined!, /Layered architecture/);
  assert.match(combined!, /security\.md/);
  assert.match(combined!, /Never log secrets/);
});
