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
      updatedAt: now,
    } as const;
    const resumedTaskId = randomUUID();
    await store.createTask(resumedTaskId, { id: resumedTaskId, mode: "build", prompt: "checkpoint test", status: "running", createdAt: now, updatedAt: now, runner: "ollama", model: "qwen" }, checkpoint);
    assert.equal((await store.getTask(resumedTaskId))?.generationCheckpoint?.taskId, resumedTaskId);
    const tasksFile = join(dataDir, "tasks.json");
    await writeFile(`${tasksFile}.${process.pid}.interrupted.tmp`, "[{ partial JSON", "utf8");
    const script = `import { recoverInterruptedTasks, getTask } from ${JSON.stringify(storeModule)}; await recoverInterruptedTasks(); const task = await getTask(${JSON.stringify(resumedTaskId)}); if (task?.status !== "failed" || task.generationCheckpoint?.completedStageIds[0] !== "scaffold") process.exit(2); console.log("recovered checkpoint");`;
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: resolve("."),
      env: { ...process.env, MOBIUSX_CLOUD_DATA_DIR: dataDir },
      timeout: 10_000,
    });
    assert.match(stdout, /recovered checkpoint/);
  } finally {
    if (oldDataDir === undefined) delete process.env.MOBIUSX_CLOUD_DATA_DIR;
    else process.env.MOBIUSX_CLOUD_DATA_DIR = oldDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
