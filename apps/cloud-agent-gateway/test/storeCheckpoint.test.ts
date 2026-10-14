import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const storeModule = fileURLToPath(new URL("../src/store.ts", import.meta.url));

test("a restart ignores an interrupted temp write and retains the last atomic stage checkpoint", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "mobiusx-store-recovery-"));
  const oldDataDir = process.env.MOBIUSX_CLOUD_DATA_DIR;
  process.env.MOBIUSX_CLOUD_DATA_DIR = dataDir;
  try {
    const store = await import("../src/store.js");
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const content = "from fastapi import FastAPI\napp = FastAPI()\n";
    const checkpoint = {
      version: 1,
      taskId,
      requirementsHash: createHash("sha256").update("checkpoint test").digest("hex"),
      provider: "ollama",
      modelId: "qwen",
      completedStageIds: ["scaffold"],
      stages: [{ id: "scaffold", completedAt: now, artifactPaths: ["backend/main.py"], validation: "passed" }],
      artifacts: [{ path: "backend/main.py", action: "create", content, sha256: createHash("sha256").update(content).digest("hex") }],
      baseFiles: [],
      pendingStageIds: ["database"],
      pendingDependencies: ["isolated PostgreSQL startup", "migration execution"],
      repairHistory: [],
      testSpecifications: [],
      testSubtasks: [{
        id: "registration-browser-slice",
        architectureHash: "a".repeat(64),
        topologyHash: "b".repeat(64),
        completedAt: now,
        artifacts: [{ path: "backend/tests/test_registration.py", action: "create", content: "def test_registration(): pass\n", sha256: createHash("sha256").update("def test_registration(): pass\n").digest("hex") }],
        validation: { pytestCollected: 1, pytestPassed: 1, pytestFailed: 0, pytestSkipped: 0, playwrightCollected: 1, playwrightPassed: 1, playwrightFailed: 0, playwrightSkipped: 0 },
        modelContributionRequestId: "previously-accepted-contribution",
      }],
      updatedAt: now,
    } as const;
    const resumedTaskId = randomUUID();
    await store.createTask(resumedTaskId, { id: resumedTaskId, mode: "build", prompt: "checkpoint test", status: "running", createdAt: now, updatedAt: now, runner: "ollama", model: "qwen" }, checkpoint);
    assert.equal((await store.getTask(resumedTaskId))?.generationCheckpoint?.taskId, resumedTaskId);
    const tasksFile = join(dataDir, "tasks.json");
    await writeFile(`${tasksFile}.${process.pid}.interrupted.tmp`, "[{ partial JSON", "utf8");
    const script = `import { recoverInterruptedTasks, getTask } from ${JSON.stringify(storeModule)}; await recoverInterruptedTasks(); const task = await getTask(${JSON.stringify(resumedTaskId)}); const slice = task?.generationCheckpoint?.testSubtasks?.[0]; if (task?.status !== "failed" || task.generationCheckpoint?.completedStageIds[0] !== "scaffold" || slice?.id !== "registration-browser-slice" || slice.modelContributionRequestId !== "previously-accepted-contribution" || slice.validation.playwrightPassed !== 1) process.exit(2); console.log("recovered stage and test-slice checkpoint");`;
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve("."),
      env: { ...process.env, MOBIUSX_CLOUD_DATA_DIR: dataDir },
      // The full gateway suite can keep the event loop busy for several
      // minutes; allow a separate Node startup to complete on loaded hosts.
      // The child still has a hard bound and its recovery assertions remain
      // unchanged.
      timeout: 30_000,
    });
    assert.match(stdout, /recovered stage and test-slice checkpoint/);
  } finally {
    if (oldDataDir === undefined) delete process.env.MOBIUSX_CLOUD_DATA_DIR;
    else process.env.MOBIUSX_CLOUD_DATA_DIR = oldDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
