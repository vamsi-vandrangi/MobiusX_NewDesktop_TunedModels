import type { TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";

/**
 * Always available, no external dependency. Demonstrates the real task
 * lifecycle (steps, streamed output, status transitions, persistence,
 * resumability, cancellation) end-to-end — but the "reasoning" is scripted,
 * not a model call. Every output this runner produces says so explicitly;
 * it never pretends to be a real answer. See runnerSelector.ts for how a
 * real model runner (e.g. AnthropicRunner) takes over when the user
 * configures one.
 */
export const demoRunner: AgentRunner = {
  name: "demo",
  async run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void> {
    const steps = stepsFor(input.mode);
    emit({ type: "status", status: "running" });

    try {
      for (const label of steps) {
        const step = { id: cryptoId(), label, status: "in_progress" as const, startedAt: new Date().toISOString() };
        emit({ type: "step", step });
        await delay(350 + Math.random() * 350, input.signal);
        emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
      }

      emit({ type: "output", delta: renderOutput(input) });
      if (input.mode === "build") emit({ type: "edits", edits: [demoEdit(input)] });
      emit({ type: "status", status: "completed" });
      emit({ type: "done" });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        emit({ type: "status", status: "cancelled" });
        emit({ type: "done" });
        return;
      }
      throw err;
    }
  },
};

function stepsFor(mode: RunnerInput["mode"]): string[] {
  if (mode === "ask") return ["Reading request", "Composing response"];
  if (mode === "plan") return ["Reading request", "Reviewing project context", "Drafting plan"];
  return ["Reading request", "Reviewing project context", "Drafting proposed changes"];
}

function renderOutput(input: RunnerInput): string {
  const context = input.projectContext?.relevantFiles?.length
    ? `\n\nContext considered: ${input.projectContext.relevantFiles.map((f) => f.relPath).join(", ")}`
    : "";

  const banner =
    "[demo runner — no model configured. Set ANTHROPIC_API_KEY + ANTHROPIC_MODEL for MobiusX Cloud Gateway to use a real model. See apps/cloud-agent-gateway/README.md]\n\n";

  if (input.mode === "ask") {
    return `${banner}You asked: "${input.prompt}"\n\nThis is where a real model's answer would appear.${context}`;
  }
  if (input.mode === "plan") {
    return `${banner}Draft plan for: "${input.prompt}"\n\n1. Investigate the relevant code paths\n2. Identify the smallest change that addresses this\n3. Write/update tests\n4. Open a PR for human review\n\n(A real model would replace this with a plan grounded in your actual codebase.)${context}`;
  }
  return `${banner}Proposed-changes summary for: "${input.prompt}"\n\nThis reference gateway never writes to disk itself — "build" mode proposes full-file-content edits (below) that only desktop-agent ever writes to disk, and only once you review and click Apply (see docs/ARCHITECTURE.md §8's approval step). Below is a clearly-labeled DEMO edit so you can exercise that full propose → review → apply flow without a real model configured. A real model (see README) would propose an edit addressing your actual prompt instead.${context}`;
}

/**
 * A single, obviously-fake proposed edit so the propose -> review -> apply
 * pipeline (see ProposedEdit in @mobiusx/protocol and fsOps.ts#applyEdits)
 * is exercisable end-to-end with no model configured. Always creates the
 * same clearly-labeled file — never touches anything that could look like
 * a real change — and the desktop agent still applies its normal
 * create-must-not-exist check, so re-running this twice against the same
 * project correctly reports the second one as skipped, not silently
 * overwritten.
 */
function demoEdit(input: RunnerInput): { path: string; action: "create"; content: string } {
  return {
    path: "MOBIUSX_DEMO_EDIT.md",
    action: "create",
    content: `# Demo edit (not real AI-generated code)\n\nThis file was created by the cloud-agent-gateway's **demo runner**, not a real\nmodel. No ANTHROPIC_API_KEY is configured, so there is no real reasoning\nbehind this change — it exists only to prove that MobiusX.ai WDC's\npropose -> review -> apply pipeline works end-to-end:\n\n1. The gateway proposed this file (a "build" task).\n2. You reviewed it in the AI Assistant panel / Tasks view.\n3. You clicked Apply, and the desktop agent wrote it to disk exactly here.\n\nOriginal prompt: "${input.prompt}"\n\nSafe to delete. Configure a real model (see apps/cloud-agent-gateway/README.md) to get actual generated edits instead of this placeholder.\n`,
  };
}

/** Rejects with a named AbortError (matching the DOM/fetch convention) the moment `signal` aborts, so callers can `if (err.name === "AbortError")` regardless of whether the abort came from a timer or a fetch call. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): Error {
  const err = new Error("Task cancelled");
  err.name = "AbortError";
  return err;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
