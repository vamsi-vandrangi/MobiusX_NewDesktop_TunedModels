import { randomUUID } from "node:crypto";
import { appendAuditEntry } from "@mobiusx/audit-log";
import { getSettings } from "@mobiusx/agent-settings";
import type { CreateTaskRequest, ProjectContext, TaskEvent, TaskSummary } from "@mobiusx/protocol";
import { applyEvent, createTask, getTask } from "./store.js";
import { broadcast } from "./wsHub.js";
import { resolveRunner, type ResolvedRunner } from "./runners/registry.js";
import { scanAndRedact } from "@mobiusx/secret-scan";

/** In-flight tasks only — cleared as soon as a task reaches a terminal state, so cancelTask() naturally reports "not running" for anything already finished (or unknown). Not persisted: a cancel request only makes sense against a task this process is actively running. */
const controllers = new Map<string, AbortController>();

export async function startTask(req: CreateTaskRequest): Promise<TaskSummary> {
  const id = randomUUID();
  const now = new Date().toISOString();

  // Multi-model support: pick which runner (and which specific model)
  // actually serves this task — a per-task override, the user's Settings
  // default, or an automatic choice, in that order. See registry.ts.
  const settings = await getSettings();
  const { runner, modelId, fallbackNote } = await resolveRunner(req.model, settings);

  // Phase 5: scan+redact any code context before it ever reaches a runner
  // (and, for real-model runners, before it leaves the machine at all).
  // This happens synchronously here, before task creation, so a redaction
  // notice is always the task's very first recorded step — never a race
  // against the runner's own first event.
  const { projectContext, redactedCount, redactedRules } = redactProjectContext(req.projectContext);

  const summary: TaskSummary = {
    id,
    mode: req.mode,
    prompt: req.prompt,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    runner: runner.name,
    model: modelId,
    modelNote: fallbackNote,
    projectPath: req.projectContext?.projectPath,
  };
  await createTask(id, summary);

  const emit = (event: TaskEvent) => {
    void applyEvent(id, event).then(() => broadcast(id, event));
  };

  if (redactedCount > 0) {
    emit({
      type: "step",
      step: {
        id: randomUUID(),
        label: `Redacted ${redactedCount} potential secret(s) from context before use (${redactedRules.join(", ")})`,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
    void appendAuditEntry({
      source: "cloud-agent-gateway",
      category: "secret-redaction",
      severity: "warning",
      summary: `Redacted ${redactedCount} potential secret(s) from task ${id}'s context before it was used`,
      detail: { taskId: id, rules: redactedRules },
    });
  }

  if (fallbackNote) {
    emit({
      type: "step",
      step: {
        id: randomUUID(),
        label: `Model note: ${fallbackNote}`,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
  }

  const controller = new AbortController();
  controllers.set(id, controller);

  // Fire-and-forget: the caller gets the TaskSummary immediately and follows
  // progress via GET /tasks/:id (polling) or the /tasks/:id/stream WebSocket.
  void runRunnerAndPersist(
    id,
    { mode: req.mode, prompt: req.prompt, projectContext, history: req.history },
    { runner, modelId },
    controller,
  );

  return summary;
}

/**
 * Requests cancellation of a running task. Returns false if the task isn't
 * currently running (already finished, or unknown id) — the route layer
 * turns that into a 409/404 rather than silently no-opping. Aborting the
 * shared AbortSignal is what actually stops work: each runner decides how
 * to react (an in-flight fetch call rejects immediately; demoRunner's timer
 * rejects on its next tick) and is responsible for emitting the resulting
 * "cancelled" status itself — this function only signals the intent.
 */
export function cancelTask(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** Redacts every relevantFiles[].snippet (and .content, when present — see below) in place (returning a new object — the input isn't mutated) and reports how much was redacted, so the runner this feeds never sees the original secret text. */
function redactProjectContext(ctx?: ProjectContext): {
  projectContext?: ProjectContext;
  redactedCount: number;
  redactedRules: string[];
} {
  if (!ctx?.relevantFiles?.length) return { projectContext: ctx, redactedCount: 0, redactedRules: [] };

  let redactedCount = 0;
  const ruleIds = new Set<string>();
  const relevantFiles = ctx.relevantFiles.map((file) => {
    const snippetResult = scanAndRedact(file.snippet);
    // Build-mode requests attach full file content (see ProjectContext.relevantFiles
    // in cloud.ts) — it needs the same redaction pass as the snippet, since it's the
    // same "about to leave the machine" boundary this function exists to enforce.
    const contentResult = file.content !== undefined ? scanAndRedact(file.content) : undefined;
    const matches = [...snippetResult.matches, ...(contentResult?.matches ?? [])];
    if (matches.length === 0) return file;
    redactedCount += matches.length;
    for (const m of matches) ruleIds.add(m.ruleId);
    return { ...file, snippet: snippetResult.text, ...(contentResult ? { content: contentResult.text } : {}) };
  });

  return { projectContext: { ...ctx, relevantFiles }, redactedCount, redactedRules: [...ruleIds] };
}

async function runRunnerAndPersist(
  id: string,
  req: CreateTaskRequest,
  resolved: Pick<ResolvedRunner, "runner" | "modelId">,
  controller: AbortController,
): Promise<void> {
  const emit = (event: TaskEvent) => {
    void applyEvent(id, event).then(() => broadcast(id, event));
  };
  try {
    await resolved.runner.run(
      {
        taskId: id,
        mode: req.mode,
        prompt: req.prompt,
        projectContext: req.projectContext,
        history: req.history,
        modelId: resolved.modelId,
        signal: controller.signal,
      },
      emit,
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      // A runner that doesn't catch its own abort (shouldn't happen with the runners shipped here,
      // but a future third-party runner might not) still resolves as "cancelled", never as "failed".
      emit({ type: "status", status: "cancelled" });
    } else {
      emit({ type: "error", message: (err as Error).message });
    }
    emit({ type: "done" });
  } finally {
    controllers.delete(id);
  }
}

export { getTask };
