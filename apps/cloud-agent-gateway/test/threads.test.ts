import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same isolated-temp-dir setup as taskEngine.test.ts (and for the same
// reason: touchThread/createThread read/write THREADS_FILE under
// MOBIUSX_CLOUD_DATA_DIR, so this must be set before store.ts is imported).
const dataDir = await mkdtemp(join(tmpdir(), "mobiusx-cloud-threads-test-"));
process.env.MOBIUSX_CLOUD_DATA_DIR = dataDir;
const settingsDir = await mkdtemp(join(tmpdir(), "mobiusx-cloud-threads-settings-test-"));
process.env.MOBIUSX_SETTINGS_DIR = settingsDir;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GROQ_API_KEY;

const { createThread, getThread, listThreads, renameThread, deleteThread, listTasksByThread } = await import("../src/store.js");
const { startTask, getTask } = await import("../src/taskEngine.js");

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

test("createThread defaults to 'New Chat' when no title is given", async () => {
  const thread = await createThread();
  assert.equal(thread.title, "New Chat");
  assert.ok(thread.id);
  assert.equal(thread.createdAt, thread.updatedAt);
  assert.equal(thread.lastTaskId, undefined);
});

test("createThread honors an explicit title", async () => {
  const thread = await createThread("Payment retry investigation");
  assert.equal(thread.title, "Payment retry investigation");
});

test("getThread / listThreads reflect created threads, most recently updated first", async () => {
  const a = await createThread("first");
  await new Promise((r) => setTimeout(r, 5));
  const b = await createThread("second");

  assert.deepEqual(await getThread(a.id), a);

  const threads = await listThreads();
  const ids = threads.map((t) => t.id);
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
});

test("renameThread updates the title and bumps updatedAt", async () => {
  const thread = await createThread();
  const before = thread.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const renamed = await renameThread(thread.id, "  Retry jitter plan  ");
  assert.equal(renamed?.title, "Retry jitter plan");
  assert.ok(renamed!.updatedAt >= before);
});

test("renameThread on an unknown id returns undefined", async () => {
  assert.equal(await renameThread("no-such-thread", "x"), undefined);
});

test("deleteThread removes it from listThreads but leaves its tasks retrievable", async () => {
  const thread = await createThread();
  const summary = await startTask({ mode: "ask", prompt: "quick one", threadId: thread.id });
  await waitUntilDone(summary.id);

  assert.equal(await deleteThread(thread.id), true);
  assert.equal(await getThread(thread.id), undefined);
  assert.ok(!(await listThreads()).some((t) => t.id === thread.id));

  // The task itself is untouched -- deleting a thread is a soft/list-only
  // operation, documented at the DELETE /threads/:id route (routes.ts).
  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.threadId, thread.id);
});

test("deleteThread on an unknown id returns false", async () => {
  assert.equal(await deleteThread("no-such-thread"), false);
});

test("startTask with a threadId persists threadId on the task and touches the thread", async () => {
  const thread = await createThread();
  const summary = await startTask({ mode: "plan", prompt: "reduce payment timeout retries", threadId: thread.id });
  assert.equal(summary.threadId, thread.id);

  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.threadId, thread.id);

  const touched = await getThread(thread.id);
  assert.equal(touched?.lastTaskId, summary.id);
  // Still default-titled before this task, so touchThread should have auto-titled it from the prompt.
  assert.equal(touched?.title, "reduce payment timeout retries");
});

test("touchThread auto-titles only a still-default-titled thread, never overwriting a real title", async () => {
  const thread = await createThread("My renamed thread");
  const summary = await startTask({ mode: "ask", prompt: "this should not become the title", threadId: thread.id });
  await waitUntilDone(summary.id);

  const touched = await getThread(thread.id);
  assert.equal(touched?.title, "My renamed thread");
  assert.equal(touched?.lastTaskId, summary.id);
});

test("touchThread truncates a long first prompt to a bounded title", async () => {
  const thread = await createThread();
  const longPrompt = "x".repeat(200);
  const summary = await startTask({ mode: "ask", prompt: longPrompt, threadId: thread.id });
  await waitUntilDone(summary.id);

  const touched = await getThread(thread.id);
  assert.ok(touched!.title.length <= 61); // 60 chars + the trailing ellipsis character
  assert.ok(touched!.title.endsWith("…"));
});

test("startTask with an unknown threadId still creates the task (touchThread no-ops rather than throwing)", async () => {
  const summary = await startTask({ mode: "ask", prompt: "orphaned", threadId: "no-such-thread" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.threadId, "no-such-thread");
});

test("startTask without a threadId never associates the task with any thread", async () => {
  const summary = await startTask({ mode: "ask", prompt: "no thread here" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.threadId, undefined);
});

test("listTasksByThread returns only that thread's tasks, oldest first", async () => {
  const thread = await createThread();
  const other = await createThread();

  const t1 = await startTask({ mode: "ask", prompt: "one", threadId: thread.id });
  await waitUntilDone(t1.id);
  const t2 = await startTask({ mode: "ask", prompt: "two", threadId: thread.id });
  await waitUntilDone(t2.id);
  const inOther = await startTask({ mode: "ask", prompt: "unrelated", threadId: other.id });
  await waitUntilDone(inOther.id);

  const tasks = await listTasksByThread(thread.id);
  assert.deepEqual(tasks.map((t) => t.id), [t1.id, t2.id]);
});

test("listTasksByThread on a thread with no tasks returns an empty array", async () => {
  const thread = await createThread();
  assert.deepEqual(await listTasksByThread(thread.id), []);
});
