import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherDevopsEvidence } from "../src/devopsContext.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-devops-test-"));
}

test("gatherDevopsEvidence reports everything honestly empty for a project with no components, infra, or verification scripts", async () => {
  const dir = await tempProject();
  const evidence = await gatherDevopsEvidence(dir);
  assert.equal(evidence.projectPath, dir);
  assert.deepEqual(evidence.existingInfraFiles, []);
  assert.deepEqual(evidence.verificationSteps, []);
  assert.equal(evidence.projectContext.components.some((c) => c.category === "frontend" || c.category === "backend"), false);
});

test("gatherDevopsEvidence detects a root Node frontend and its own real npm scripts as verification steps", async () => {
  const dir = await tempProject();
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { next: "14.0.0" }, scripts: { build: "next build", test: "jest" } }),
  );
  const evidence = await gatherDevopsEvidence(dir);
  const frontend = evidence.projectContext.components.find((c) => c.category === "frontend");
  assert.ok(frontend, "expected a detected frontend component");
  assert.equal(frontend!.name, "Next.js");
  assert.equal(frontend!.location, ".");
  // detectVerificationSteps only recognizes typecheck/build/lint/test -- both defined scripts should surface.
  const labels = evidence.verificationSteps.map((s) => s.label);
  assert.ok(labels.some((l) => l.includes("npm run build")));
  assert.ok(labels.some((l) => l.includes("npm run test")));
  assert.ok(evidence.verificationSteps.every((s) => s.cwd === "."));
});

test("gatherDevopsEvidence finds an existing root Dockerfile/compose/CI file and returns their full content", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "Dockerfile"), "FROM node:20-slim\n");
  await writeFile(join(dir, "docker-compose.yml"), "services:\n  app:\n    build: .\n");
  await mkdir(join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(join(dir, ".github", "workflows", "ci.yml"), "name: CI\n");
  const evidence = await gatherDevopsEvidence(dir);
  const byPath = new Map(evidence.existingInfraFiles.map((f) => [f.relPath, f.content]));
  assert.equal(byPath.get("Dockerfile"), "FROM node:20-slim\n");
  assert.equal(byPath.get("docker-compose.yml"), "services:\n  app:\n    build: .\n");
  assert.equal(byPath.get(".github/workflows/ci.yml"), "name: CI\n");
});

test("gatherDevopsEvidence also checks a detected backend component's own subdirectory for its own Dockerfile", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "backend", "requirements.txt"), "fastapi==0.110.0\npytest==8.0.0\n");
  await writeFile(join(dir, "backend", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
  await writeFile(join(dir, "backend", "Dockerfile"), "FROM python:3.11-slim\n");
  const evidence = await gatherDevopsEvidence(dir);
  const backend = evidence.projectContext.components.find((c) => c.category === "backend");
  assert.ok(backend, "expected a detected FastAPI backend component");
  assert.equal(backend!.location, "backend");
  const byPath = new Map(evidence.existingInfraFiles.map((f) => [f.relPath, f.content]));
  assert.equal(byPath.get("backend/Dockerfile"), "FROM python:3.11-slim\n");
  // A real pytest step should also be reported, scoped to the backend/ cwd -- the CI pipeline this
  // evidence grounds must run this exact command in this exact directory, never the project root.
  const pytestStep = evidence.verificationSteps.find((s) => s.command.includes("pytest"));
  assert.ok(pytestStep, "expected a detected pytest verification step");
  assert.equal(pytestStep!.cwd, "backend");
});
