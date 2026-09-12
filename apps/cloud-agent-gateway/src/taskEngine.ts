import { randomUUID } from "node:crypto";
import type { CreateTaskRequest, TaskEvent, TaskSummary } from "@mobiusx/protocol";
import { applyEvent, createTask, getTask } from "./store.js";
import { broadcast } from "./wsHub.js";
import { selectRunner } from "./runners/runnerSelector.js";

export async function startTask(req: CreateTaskRequest): Promise<TaskSummary> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const runner = selectRunner();

  const summary: TaskSummary = {
    id,
    mode: req.mode,
    prompt: req.prompt,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    runner: runner.name,
  };
  await createTask(id, summary);

  // Fire-and-forget: the caller gets the TaskSummary immediately and follows
  // progress via GET /tasks/:id (polling) or the /tasks/:id/stream WebSocket.
  void runRunnerAndPersist(id, req, runner);

  return summary;
}

async function runRunnerAndPersist(
  id: string,
  req: CreateTaskRequest,
  runner: ReturnType<typeof selectRunner>,
): Promise<void> {
  const emit = (event: TaskEvent) => {
    void applyEvent(id, event).then(() => broadcast(id, event));
  };
  try {
    await runner.run({ taskId: id, mode: req.mode, prompt: req.prompt, projectContext: req.projectContext }, emit);
  } catch (err) {
    emit({ type: "error", message: (err as Error).message });
    emit({ type: "done" });
  }
}

export { getTask };
