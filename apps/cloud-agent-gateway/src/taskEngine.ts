import { randomUUID } from "node:crypto";
import { appendAuditEntry } from "@mobiusx/audit-log";
import { getSettings } from "@mobiusx/agent-settings";
import type { CreateTaskRequest, GenerationCheckpoint, ProjectContext, TaskEvent, TaskSummary } from "@mobiusx/protocol";
import { applyEvent, createTask, getTask, listTasksByThread, touchThread, updateTaskModel } from "./store.js";
import { broadcast } from "./wsHub.js";
import { autoRunnerCandidates, resolveRunner, type ResolvedRunner } from "./runners/registry.js";
import { routeWithLaya } from "./runners/layaRouter.js";
import { scanAndRedact } from "@mobiusx/secret-scan";
import { createBuildPipelineRunner } from "./buildPipeline.js";

/** In-flight tasks only — cleared as soon as a task reaches a terminal state, so cancelTask() naturally reports "not running" for anything already finished (or unknown). Not persisted: a cancel request only makes sense against a task this process is actively running. */
const controllers = new Map<string, AbortController>();

/**
 * Explicit Build selections go straight to the selected coding provider by
 * default. Set MOBIUSX_BYPASS_LAYA_FOR_EXPLICIT_BUILD=false to temporarily
 * restore the optional Laya classification hop for diagnostics/experiments.
 * Auto Cloud and every non-Build mode keep their existing routing behavior.
 */
export function shouldBypassLayaForExplicitBuild(req: Pick<CreateTaskRequest, "mode" | "model" | "autoCloud">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MOBIUSX_BYPASS_LAYA_FOR_EXPLICIT_BUILD?.trim().toLowerCase() === "false") return false;
  return req.mode === "build" && !req.autoCloud && req.model !== undefined;
}

export async function startTask(req: CreateTaskRequest, resumeCheckpoint?: GenerationCheckpoint): Promise<TaskSummary> {
  const id = randomUUID();
  const now = new Date().toISOString();

  // Remove secrets from project snippets before even the local System 1
  // router sees them. Laya only classifies the task; it never generates an
  // answer or receives any hosted call.
  const { projectContext, redactedCount, redactedRules } = redactProjectContext(req.projectContext);

  // Explicit Build selections bypass the Laya hop by default, so a classifier
  // failure or latency cannot delay the coding model the user selected.
  // Laya remains available for every other mode and optional via the feature
  // flag; Auto Cloud still uses its tier to select a provider candidate.
  const settings = await getSettings();
  const layaBypassed = shouldBypassLayaForExplicitBuild(req);
  const route = layaBypassed ? undefined : await routeWithLaya({ mode: req.mode, prompt: req.prompt, archMode: req.archMode, projectContext });
  const automaticCandidates = req.autoCloud ? await autoRunnerCandidates(route?.tier) : [];
  const resolved = req.autoCloud
    ? automaticCandidates[0] ?? await resolveRunner(undefined, { ...settings, defaultModel: undefined, modelRouting: undefined }, req.mode)
    : await resolveRunner(req.model, settings, req.mode);
  const { runner, modelId } = resolved;
  if (resumeCheckpoint && (resumeCheckpoint.provider !== runner.name || resumeCheckpoint.modelId !== modelId)) {
    throw new Error("Cannot resume because the selected provider or model is no longer available; the checkpoint was preserved.");
  }
  const fallbackNote = [resolved.fallbackNote, route?.note].filter(Boolean).join(" ") || undefined;

  // Desktop UI resets chats when a project changes, but enforce the same
  // boundary here so alternate clients or a race during project switching
  // cannot replay another project's prompts/code into this model request.
  const priorThreadTasks = req.threadId ? await listTasksByThread(req.threadId) : [];
  const activeProjectPath = req.projectContext?.projectPath ?? null;
  const historyCrossesProjectBoundary = priorThreadTasks.some((task) => (task.projectPath ?? null) !== activeProjectPath);
  const safeHistory = historyCrossesProjectBoundary ? [] : req.history;
  const safeThreadId = historyCrossesProjectBoundary ? undefined : req.threadId;

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
    threadId: safeThreadId,
  };
  // A resumed task must durably inherit its last validated checkpoint before
  // its first model request starts. Otherwise a process restart during the
  // first resumed stage would strand the new task without a resume point.
  await createTask(id, summary, resumeCheckpoint);

  // Associate this task with its thread (auto-titling, "last activity",
  // and projectPath backfill all happen inside touchThread -- see store.ts).
  // Fire-and-forget like the other emit() calls below: a thread-association
  // hiccup shouldn't block the task itself from starting.
  if (safeThreadId) {
    void touchThread(safeThreadId, summary);
  }

  const initialEvents: TaskEvent[] = [];

  if (redactedCount > 0) {
    initialEvents.push({
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
    initialEvents.push({
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

  if (route) {
    initialEvents.push({
      type: "step",
      step: {
        id: randomUUID(),
        label: `Model routing: ${route.note}`,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
  }

  if (layaBypassed) {
    initialEvents.push({
      type: "step",
      step: {
        id: randomUUID(),
        label: `Laya bypassed for explicit Build selection; routing directly to ${runner.name}${modelId ? `/${modelId}` : ""}`,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
  }

  if (historyCrossesProjectBoundary) {
    initialEvents.push({
      type: "step",
      step: {
        id: randomUUID(),
        label: "Started with fresh conversation context because earlier messages belong to another project",
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
    { mode: req.mode, prompt: req.prompt, projectContext, archMode: req.archMode, history: safeHistory },
    { runner, modelId },
    controller,
    initialEvents,
    req.autoCloud ? automaticCandidates : undefined,
    resumeCheckpoint,
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
  initialEvents: TaskEvent[] = [],
  automaticCandidates?: ResolvedRunner[],
  resumeCheckpoint?: GenerationCheckpoint,
): Promise<void> {
  let eventQueue: Promise<void> = Promise.resolve();
  let outputBuffer = "";
  let outputTimer: ReturnType<typeof setTimeout> | undefined;

  const enqueue = (event: TaskEvent) => {
    eventQueue = eventQueue.then(async () => {
      await applyEvent(id, event);
      broadcast(id, event);
    }).catch((err) => {
      process.stderr.write(`[task ${id}] failed to persist ${event.type} event: ${(err as Error).message}\n`);
    });
  };
  const flushOutput = () => {
    if (outputTimer) {
      clearTimeout(outputTimer);
      outputTimer = undefined;
    }
    if (!outputBuffer) return;
    const delta = outputBuffer;
    outputBuffer = "";
    enqueue({ type: "output", delta });
  };
  const emit = (event: TaskEvent) => {
    if (event.type === "status" && ["completed", "failed", "cancelled"].includes(event.status)) {
      // Make cancellation state agree with the terminal status as soon as
      // the runner reports it. Persistence is queued asynchronously below,
      // so waiting until runRunnerAndPersist's finally block left a small
      // window where a visibly completed task could still be cancelled.
      controllers.delete(id);
    }
    if (event.type === "output") {
      outputBuffer += event.delta;
      if (!outputTimer) outputTimer = setTimeout(flushOutput, 40);
      return;
    }
    flushOutput();
    enqueue(event);
  };
  for (const event of initialEvents) enqueue(event);
  try {
    const candidates = automaticCandidates?.length ? automaticCandidates : [resolved];
    let lastFailure = "";
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      let recoverableFailure: string | undefined;
      let attemptProducedEdits = false;
      let provisionalOutput = "";
      let activeStep: Extract<TaskEvent, { type: "step" }>["step"] | undefined;
      const autoAttemptStep = automaticCandidates
        ? { id: randomUUID(), label: `Auto Cloud attempt ${index + 1}/${candidates.length}: ${candidate.runner.name}${candidate.modelId ? `/${candidate.modelId}` : ""} — response is provisional until this model completes successfully`, status: "in_progress" as const, startedAt: new Date().toISOString() }
        : undefined;
      if (autoAttemptStep) emit({ type: "step", step: autoAttemptStep });
      const selectedRunner = req.mode === "build" ? createBuildPipelineRunner(candidate.runner) : candidate.runner;
      await selectedRunner.run(
        {
          taskId: id,
          mode: req.mode,
          prompt: req.prompt,
          projectContext: req.projectContext,
          archMode: req.archMode,
          history: req.history,
          modelId: candidate.modelId,
          autoCloud: Boolean(automaticCandidates),
          resumeCheckpoint,
          signal: controller.signal,
        },
        (event) => {
          if (event.type === "step") activeStep = event.step;
          if (event.type === "edits") attemptProducedEdits = true;
          if (automaticCandidates && event.type === "output") {
            // A model can stream a plan and then fail to return usable edits.
            // Keep that text provisional so Auto Cloud does not leave a
            // failed provider's description in the conversation as though
            // it were the completed application response.
            provisionalOutput += event.delta;
            return;
          }
          if (automaticCandidates && event.type === "provider_failure") {
            recoverableFailure = event.message;
            provisionalOutput = "";
            return;
          }
          // Any provider error before the task produced edits is eligible
          // for Auto Cloud failover. Model-specific request validation can
          // surface as an ordinary HTTP 400/404 as well as a quota error;
          // restricting retries to rate/billing text made those failures
          // terminate the chain even when another configured provider could
          // complete the build. Once edits exist, keep the existing
          // no-duplicate-output guard and let the user review that attempt.
          if (automaticCandidates && !attemptProducedEdits && event.type === "error") {
            recoverableFailure = event.message;
            provisionalOutput = "";
            return;
          }
          if (recoverableFailure && event.type === "done") return;
          if (recoverableFailure && event.type === "status" && ["failed", "completed"].includes(event.status)) return;
          if (automaticCandidates && provisionalOutput && (event.type === "edits" || (event.type === "status" && event.status === "completed"))) {
            emit({ type: "output", delta: provisionalOutput });
            provisionalOutput = "";
          }
          emit(event);
        },
      );
      if (!recoverableFailure || controller.signal.aborted) {
        if (autoAttemptStep && !controller.signal.aborted) {
          const completedAt = new Date().toISOString();
          emit({ type: "step", step: { ...autoAttemptStep, status: "completed", completedAt } });
        }
        break;
      }
      if (autoAttemptStep) {
        emit({ type: "step", step: { ...autoAttemptStep, status: "failed", completedAt: new Date().toISOString() } });
      }
      lastFailure = recoverableFailure;
      if (activeStep?.status === "in_progress") {
        const failedAt = new Date().toISOString();
        emit({ type: "step", step: { ...activeStep, status: "failed", completedAt: failedAt } });
      }
      flushOutput();
      await eventQueue;
      const next = candidates[index + 1];
      if (!next) {
        emit({ type: "error", message: `Auto Cloud exhausted its configured providers. Last failure: ${lastFailure}` });
        emit({ type: "done" });
        break;
      }
      const from = `${candidate.runner.name}${candidate.modelId ? `/${candidate.modelId}` : ""}`;
      const to = `${next.runner.name}${next.modelId ? `/${next.modelId}` : ""}`;
      const now = new Date().toISOString();
      emit({ type: "step", step: { id: randomUUID(), label: `Auto Cloud: ${from} could not complete the task; switching to ${to}`, status: "completed", startedAt: now, completedAt: now } });
      emit({ type: "output", delta: `\n\n[Auto Cloud] ${from} failed (${lastFailure}). Retrying with ${to}.\n\n` });
      await updateTaskModel(id, next.runner.name, next.modelId);
    }
    flushOutput();
    await eventQueue;
  } catch (err) {
    flushOutput();
    await eventQueue;
    if ((err as Error).name === "AbortError") {
      // A runner that doesn't catch its own abort (shouldn't happen with the runners shipped here,
      // but a future third-party runner might not) still resolves as "cancelled", never as "failed".
      emit({ type: "status", status: "cancelled" });
    } else {
      emit({ type: "error", message: (err as Error).message });
    }
    emit({ type: "done" });
    flushOutput();
    await eventQueue;
  } finally {
    flushOutput();
    await eventQueue;
    controllers.delete(id);
  }
}

export { getTask };
