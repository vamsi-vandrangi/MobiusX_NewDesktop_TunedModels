import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { GenerationCheckpoint, TaskDetail, TaskEvent, TaskStep, TaskSummary, ThreadSummary } from "@mobiusx/protocol";

/**
 * Deliberately NOT written into the project repo (unlike Phase 2's
 * .mobiusx-index, which is per-project and gitignored) — cloud tasks aren't
 * scoped to one project, so they live under the user's home directory, the
 * same way a real cloud service's database wouldn't be part of any one
 * repo's checkout. Override with MOBIUSX_CLOUD_DATA_DIR for tests.
 */
const DATA_DIR = process.env.MOBIUSX_CLOUD_DATA_DIR ?? join(homedir(), ".mobiusx", "cloud-agent-gateway");
const DATA_FILE = join(DATA_DIR, "tasks.json");
/** Threads are a separate file (same DATA_DIR) rather than a field inside tasks.json -- a thread's own metadata (title, timestamps) updates far more often (every task touches it) than any single task's own record does, and keeping them apart means a thread rename/touch never rewrites the full task archive. */
const THREADS_FILE = join(DATA_DIR, "threads.json");
/** Matches the client-side default the "New Chat" nav item already uses (renderer.js) -- the one title value touchThread() is allowed to auto-replace from a task's prompt. Any other title means the user (or a prior auto-title) already set something meaningful, so it's left alone. */
const DEFAULT_THREAD_TITLE = "New Chat";

let cache: Map<string, TaskDetail> | null = null;
let threadsCache: Map<string, ThreadSummary> | null = null;
let taskPersistQueue: Promise<void> = Promise.resolve();

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function load(): Promise<Map<string, TaskDetail>> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const arr: TaskDetail[] = JSON.parse(raw);
    cache = new Map(arr.map((t) => [t.id, t]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`task checkpoint store is unreadable; preserving it for recovery: ${(error as Error).message}`);
    cache = new Map();
  }
  return cache;
}

function persist(): Promise<void> {
  if (!cache) return Promise.resolve();
  const write = async () => {
    await atomicWriteJson(DATA_FILE, [...cache!.values()]);
  };
  const pending = taskPersistQueue.then(write);
  taskPersistQueue = pending.catch(() => {});
  return pending;
}

export async function createTask(id: string, summary: TaskSummary, generationCheckpoint?: GenerationCheckpoint): Promise<TaskDetail> {
  const map = await load();
  const detail: TaskDetail = {
    ...summary,
    steps: [],
    output: "",
    ...(generationCheckpoint ? { generationCheckpoint: { ...generationCheckpoint, taskId: id, updatedAt: new Date().toISOString() } } : {}),
  };
  map.set(id, detail);
  await persist();
  return detail;
}

export async function getTask(id: string): Promise<TaskDetail | undefined> {
  const map = await load();
  return map.get(id);
}

export async function updateTaskModel(id: string, runner: string, model?: string): Promise<void> {
  const map = await load();
  const task = map.get(id);
  if (!task) return;
  task.runner = runner;
  task.model = model;
  task.updatedAt = new Date().toISOString();
  await persist();
}

export async function listTasks(): Promise<TaskSummary[]> {
  const map = await load();
  return [...map.values()]
    .map(({ steps: _steps, output: _output, error: _error, edits: _edits, review: _review, usage: _usage, modelDiagnostics: _modelDiagnostics, generationCheckpoint: _generationCheckpoint, ...summary }) => summary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Applies one event to a task's persisted state (the same event a WS subscriber receives). */
export async function applyEvent(id: string, event: TaskEvent): Promise<void> {
  const map = await load();
  const task = map.get(id);
  if (!task) return;
  task.updatedAt = new Date().toISOString();

  if (event.type === "step") {
    const idx = task.steps.findIndex((s) => s.id === event.step.id);
    if (idx === -1) task.steps.push(event.step);
    else task.steps[idx] = event.step;
  } else if (event.type === "output") {
    task.output += event.delta;
  } else if (event.type === "edits") {
    task.edits = event.edits;
  } else if (event.type === "review") {
    task.review = event.review;
  } else if (event.type === "status") {
    task.status = event.status;
  } else if (event.type === "usage") {
    task.usage = event.usage;
  } else if (event.type === "model_diagnostic") {
    task.modelDiagnostics ??= [];
    task.modelDiagnostics.push(event.diagnostic);
  } else if (event.type === "generation_checkpoint") {
    task.generationCheckpoint = event.checkpoint;
  } else if (event.type === "error") {
    task.error = event.message;
    task.status = "failed";
  }
  // "done" carries no state of its own — status transitions to "completed" via a separate status event.

  await persist();
}

export function newStep(label: string): TaskStep {
  return { id: randomUUID(), label, status: "pending" };
}

// --- Threads -----------------------------------------------------------
// Same lazy-load-then-persist-on-every-write pattern as the task store
// above, just against THREADS_FILE / ThreadSummary instead of DATA_FILE /
// TaskDetail. Kept as plain functions in this same module (not a second
// file) since the pattern -- and the DATA_DIR constant -- are identical;
// splitting it out would just add an import for no real separation.

async function loadThreads(): Promise<Map<string, ThreadSummary>> {
  if (threadsCache) return threadsCache;
  try {
    const raw = await readFile(THREADS_FILE, "utf8");
    const arr: ThreadSummary[] = JSON.parse(raw);
    threadsCache = new Map(arr.map((t) => [t.id, t]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`thread store is unreadable; preserving it for recovery: ${(error as Error).message}`);
    threadsCache = new Map();
  }
  return threadsCache;
}

async function persistThreads(): Promise<void> {
  if (!threadsCache) return;
  await atomicWriteJson(THREADS_FILE, [...threadsCache.values()]);
}

export async function saveGenerationCheckpoint(id: string, checkpoint: GenerationCheckpoint): Promise<void> {
  await applyEvent(id, { type: "generation_checkpoint", checkpoint });
}

/** Mark persisted in-flight tasks resumable after process restart without deleting their last stage checkpoint. */
export async function recoverInterruptedTasks(): Promise<number> {
  const map = await load();
  let recovered = 0;
  for (const task of map.values()) {
    if (task.status !== "queued" && task.status !== "running") continue;
    task.status = "failed";
    task.error = task.generationCheckpoint
      ? "Gateway restarted during generation. The last validated stage is preserved; resume this task to continue."
      : "Gateway restarted before a validated generation checkpoint was saved. Start a new Build task.";
    task.output += `\n\n${task.error}`;
    task.updatedAt = new Date().toISOString();
    recovered += 1;
  }
  if (recovered) await persist();
  return recovered;
}

export async function createThread(title?: string): Promise<ThreadSummary> {
  const map = await loadThreads();
  const now = new Date().toISOString();
  const thread: ThreadSummary = {
    id: randomUUID(),
    title: title?.trim() || DEFAULT_THREAD_TITLE,
    createdAt: now,
    updatedAt: now,
  };
  map.set(thread.id, thread);
  await persistThreads();
  return thread;
}

export async function getThread(id: string): Promise<ThreadSummary | undefined> {
  const map = await loadThreads();
  return map.get(id);
}

export async function listThreads(): Promise<ThreadSummary[]> {
  const map = await loadThreads();
  return [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function renameThread(id: string, title: string): Promise<ThreadSummary | undefined> {
  const map = await loadThreads();
  const thread = map.get(id);
  if (!thread) return undefined;
  thread.title = title.trim() || DEFAULT_THREAD_TITLE;
  thread.updatedAt = new Date().toISOString();
  await persistThreads();
  return thread;
}

export async function deleteThread(id: string): Promise<boolean> {
  const map = await loadThreads();
  const existed = map.delete(id);
  if (existed) await persistThreads();
  return existed;
}

/**
 * Called by taskEngine.startTask() right after a task is created with a
 * threadId. Bumps updatedAt, records the task as the thread's most recent,
 * auto-titles a still-default-titled thread from the task's prompt (first
 * ~60 chars, matching how most chat UIs title a new conversation from its
 * opening message), and backfills projectPath the first time a task on
 * this thread carries one. Silently no-ops if the thread doesn't exist
 * (e.g. a stale/deleted threadId) rather than throwing -- a task should
 * still be created even if its thread association can't be recorded.
 */
export async function touchThread(threadId: string, task: TaskSummary): Promise<void> {
  const map = await loadThreads();
  const thread = map.get(threadId);
  if (!thread) return;
  thread.updatedAt = new Date().toISOString();
  thread.lastTaskId = task.id;
  if (thread.title === DEFAULT_THREAD_TITLE && task.prompt) {
    const trimmed = task.prompt.trim().replace(/\s+/g, " ");
    thread.title = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed || DEFAULT_THREAD_TITLE;
  }
  if (!thread.projectPath && task.projectPath) {
    thread.projectPath = task.projectPath;
  }
  await persistThreads();
}

/** All tasks created on a given thread, oldest first -- what ThreadDetailResponse rehydrates a desktop panel from on thread selection. */
export async function listTasksByThread(threadId: string): Promise<TaskDetail[]> {
  const map = await load();
  return [...map.values()]
    .filter((t) => t.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
