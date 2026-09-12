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
  return `${banner}Proposed-changes summary for: "${input.prompt}"\n\nThis reference gateway does not modify files automatically — "build" mode only drafts a description of the change for human review, by design (see docs/ARCHITECTURE.md §8's approval step). A real model would draft the actual diff description here.${context}`;
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
