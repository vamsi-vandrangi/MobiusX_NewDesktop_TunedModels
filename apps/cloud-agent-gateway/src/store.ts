import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { TaskDetail, TaskEvent, TaskStep, TaskSummary } from "@mobiusx/protocol";

/**
 * Deliberately NOT written into the project repo (unlike Phase 2's
 * .mobiusx-index, which is per-project and gitignored) — cloud tasks aren't
 * scoped to one project, so they live under the user's home directory, the
 * same way a real cloud service's database wouldn't be part of any one
 * repo's checkout. Override with MOBIUSX_CLOUD_DATA_DIR for tests.
 */
const DATA_DIR = process.env.MOBIUSX_CLOUD_DATA_DIR ?? join(homedir(), ".mobiusx", "cloud-agent-gateway");
const DATA_FILE = join(DATA_DIR, "tasks.json");

let cache: Map<string, TaskDetail> | null = null;

async function load(): Promise<Map<string, TaskDetail>> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const arr: TaskDetail[] = JSON.parse(raw);
    cache = new Map(arr.map((t) => [t.id, t]));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify([...cache.values()], null, 2), "utf8");
}

export async function createTask(id: string, summary: TaskSummary): Promise<TaskDetail> {
  const map = await load();
  const detail: TaskDetail = { ...summary, steps: [], output: "" };
  map.set(id, detail);
  await persist();
  return detail;
}

export async function getTask(id: string): Promise<TaskDetail | undefined> {
  const map = await load();
  return map.get(id);
}

export async function listTasks(): Promise<TaskSummary[]> {
  const map = await load();
  return [...map.values()]
    .map(({ steps: _steps, output: _output, error: _error, ...summary }) => summary)
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
  } else if (event.type === "status") {
    task.status = event.status;
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
