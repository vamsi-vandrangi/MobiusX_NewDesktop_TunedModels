import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GenerationCheckpoint, ProposedEdit } from "@mobiusx/protocol";
import { activeCheckpointArtifacts, buildArtifactOwnershipManifest, normalizeArtifactPath, validateStageArtifactOwnership, validateTestSubtaskCheckpoint } from "../src/artifactOwnership.js";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const artifact = (path: string, content: string): GenerationCheckpoint["artifacts"][number] => ({ path, action: "create", content, sha256: sha(content) });
const checkpoint = (artifacts: GenerationCheckpoint["artifacts"], stages: GenerationCheckpoint["stages"], attemptedStages: NonNullable<GenerationCheckpoint["attemptedStages"]> = []): GenerationCheckpoint => ({
  version: 1, taskId: "task", requirementsHash: "hash", provider: "ollama", modelId: "model", completedStageIds: stages.map((stage) => stage.id), stages, artifacts,
  baseFiles: [], pendingStageIds: [], pendingDependencies: [], repairHistory: [], attemptedStages,
});

test("canonical artifact paths reject traversal, absolute, drive, and alias paths", () => {
  assert.equal(normalizeArtifactPath("backend/models.py"), "backend/models.py");
  for (const path of ["../escape", "backend/../escape", "/tmp/file", "C:\\temp\\file", "backend//main.py", "./backend/main.py", ""]) {
    assert.equal(normalizeArtifactPath(path), undefined, path);
  }
});

test("test stage cannot replace deployment compose and duplicate same-stage targets are rejected", () => {
  const before: ProposedEdit[] = [{ path: "docker-compose.yml", action: "create", content: "active compose" }];
  const after: ProposedEdit[] = [{ path: "docker-compose.yml", action: "create", content: "failed test proposal" }];
  assert.deepEqual(validateStageArtifactOwnership("tests", before, after), ["tests stage is not authorized to replace docker-compose.yml; current owner content is preserved"]);
  assert.ok(validateStageArtifactOwnership("tests", [], [after[0], after[0]]).some((issue) => issue.includes("same target path more than once")));
});

test("authorized database replacement records ownership lineage and keeps the active version", () => {
  const first = artifact("docker-compose.yml", "scaffold deployment");
  const second = artifact("docker-compose.yml", "database-wired deployment");
  const cp = checkpoint([second], [
    { id: "scaffold", completedAt: "t1", artifactPaths: [first.path], artifacts: [first], validation: "passed" },
    { id: "database", completedAt: "t2", artifactPaths: [second.path], artifacts: [second], validation: "passed" },
  ]);
  const manifest = buildArtifactOwnershipManifest(cp);
  assert.equal(manifest.active[0].stageId, "database");
  assert.equal(manifest.active[0].sha256, second.sha256);
  assert.equal(manifest.active[0].replacesArtifactId, `scaffold:${first.path}:${first.sha256.slice(0, 12)}`);
  assert.equal(manifest.superseded[0].sha256, first.sha256);
  assert.equal(manifest.active[0].version, 2);
});

test("failed-stage forensic artifacts cannot shadow the active materialization", () => {
  const active = artifact("docker-compose.yml", "validated database-stage compose");
  const attempted = artifact("docker-compose.yml", "unvalidated test-stage compose");
  const cp = checkpoint([active], [{ id: "database", completedAt: "t1", artifactPaths: [active.path], artifacts: [active], validation: "passed" }], [
    { id: "tests", attemptedAt: "t2", validation: "failed", issues: ["invalid test artifact"], repairOutcomes: [], artifacts: [attempted] },
  ]);
  assert.deepEqual(activeCheckpointArtifacts(cp).map((item) => item.sha256), [active.sha256]);
  assert.equal(buildArtifactOwnershipManifest(cp).active[0].sha256, active.sha256);
  assert.equal(cp.attemptedStages?.[0].artifacts[0].sha256, attempted.sha256, "forensic proposal stays preserved separately");
});

test("aggregate content conflicting with successful stage owner is rejected", () => {
  const stage = artifact("backend/main.py", "stage content");
  const aggregate = artifact("backend/main.py", "different aggregate content");
  const cp = checkpoint([aggregate], [{ id: "backend", completedAt: "t1", artifactPaths: [stage.path], artifacts: [stage], validation: "passed" }]);
  assert.throws(() => buildArtifactOwnershipManifest(cp), /conflicts with its last validated stage owner/);
});

test("validated test slices persist independently without asserting full test-stage completion", () => {
  const cp = checkpoint([], [], []);
  cp.projectArchitecture = { schemaVersion: "1.0", contractHash: "a".repeat(64), stack: { backend: "fastapi", orm: "sqlalchemy", migrations: "alembic", database: "postgresql", frontend: "react", e2e: "playwright" }, modules: [] };
  const file = artifact("backend/tests/test_vertical_slice.py", "def test_real_case():\n    assert 1 == 1\n");
  cp.testSubtasks = [{
    id: "customer-registration-browser-vertical-slice",
    architectureHash: cp.projectArchitecture.contractHash,
    topologyHash: "b".repeat(64),
    completedAt: "2026-10-14T00:00:00.000Z",
    artifacts: [file],
    validation: { pytestCollected: 1, pytestPassed: 1, pytestFailed: 0, pytestSkipped: 0, playwrightCollected: 1, playwrightPassed: 1, playwrightFailed: 0, playwrightSkipped: 0 },
    modelContributionRequestId: "reused-request",
  }];
  assert.deepEqual(validateTestSubtaskCheckpoint(cp), []);
  assert.deepEqual(cp.completedStageIds, [], "a passing slice does not mark the complete tests stage as passed");
  const corrupted = structuredClone(cp);
  corrupted.testSubtasks![0].artifacts[0].content += "# changed\n";
  assert.ok(validateTestSubtaskCheckpoint(corrupted).some((issue) => issue.includes("checksum mismatch")));
  const unsafe = structuredClone(cp);
  unsafe.testSubtasks![0].artifacts[0].path = "docker-compose.yml";
  assert.ok(validateTestSubtaskCheckpoint(unsafe).some((issue) => issue.includes("unauthorized")));
});
