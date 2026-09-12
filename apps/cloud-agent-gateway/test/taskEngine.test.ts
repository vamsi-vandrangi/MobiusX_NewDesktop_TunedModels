import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at an isolated temp dir before importing anything that reads it.
const dataDir = await mkdtemp(join(tmpdir(), "mobiusx-cloud-test-"));
process.env.MOBIUSX_CLOUD_DATA_DIR = dataDir;

const { startTask, getTask, cancelTask } = await import("../src/taskEngine.js");
const { listTasks } = await import("../src/store.js");

function waitUntilDone(id: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const task = await getTask(id);
      if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("task did not complete in time"));
        return;
      }
      setTimeout(tick, 50);
    };
    void tick();
  });
}

test("startTask with no Anthropic env runs the demo runner end-to-end", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;

  const summary = await startTask({ mode: "plan", prompt: "reduce payment timeout retries" });
  assert.equal(summary.runner, "demo");
  assert.equal(summary.status, "queued");

  await waitUntilDone(summary.id);

  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.status, "completed");
  assert.ok(task!.steps.length >= 2);
  assert.ok(task!.steps.every((s) => s.status === "completed"));
  assert.match(task!.output, /demo runner/);
  assert.match(task!.output, /reduce payment timeout retries/);
});

test("listTasks reflects created tasks, most recent first", async () => {
  const first = await startTask({ mode: "ask", prompt: "first" });
  await waitUntilDone(first.id);
  const second = await startTask({ mode: "ask", prompt: "second" });
  await waitUntilDone(second.id);

  const tasks = await listTasks();
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id));
});

test("build mode never claims to modify files", async () => {
  const summary = await startTask({ mode: "build", prompt: "add retry jitter" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.match(task!.output, /does not modify files automatically/);
});

test("cancelTask aborts a running demo task and marks it cancelled, not failed", async () => {
  const summary = await startTask({ mode: "build", prompt: "long-running thing to cancel" });
  assert.equal(summary.status, "queued");

  // Cancel almost immediately — before the demo runner's first scripted step
  // (350-700ms) has a chance to finish — to prove the abort actually
  // interrupts in-flight work rather than the task just running to completion.
  const cancelled = cancelTask(summary.id);
  assert.equal(cancelled, true);

  await waitUntilDone(summary.id);

  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.status, "cancelled");
  assert.ok(!task!.output.includes("does not modify files automatically")); // never reached the completed output
});

test("cancelTask on an unknown or already-finished task returns false", async () => {
  assert.equal(cancelTask("no-such-task-id"), false);

  const summary = await startTask({ mode: "ask", prompt: "quick one" });
  await waitUntilDone(summary.id);
  assert.equal(cancelTask(summary.id), false); // already completed by the time we get here
});
