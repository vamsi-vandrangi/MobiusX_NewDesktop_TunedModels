import type { ModelOption, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";

/**
 * Always available, no external dependency. Demonstrates the real task
 * lifecycle (steps, streamed output, status transitions, persistence,
 * resumability, cancellation) end-to-end — but the "reasoning" is scripted,
 * not a model call. Every output this runner produces says so explicitly;
 * it never pretends to be a real answer. See registry.ts for how a real
 * model runner (anthropic, openrouter, groq, ollama) takes over when the
 * user configures one.
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
      if (input.mode === "build") {
        emit({ type: "edits", edits: [demoEdit(input)] });
        // Second-pass Reviewer agent (PRD §11/§46) — scripted here, same as everything else in this runner.
        emit({
          type: "review",
          review: {
            verdict: "approve",
            summary:
              "[demo reviewer — no model configured] This is a scripted demo review that always approves the demo edit; configure a real model for an actual second-opinion code review.",
          },
        });
      }
      if (input.mode === "spec") emit({ type: "edits", edits: [demoSpecEdit(input)] });
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

  async listModels(): Promise<ModelOption[]> {
    return [
      {
        provider: "demo",
        model: "demo",
        label: "Demo (no model — deterministic, always available)",
        free: true,
        available: true,
      },
    ];
  },
};

function stepsFor(mode: RunnerInput["mode"]): string[] {
  if (mode === "ask") return ["Reading request", "Composing response"];
  if (mode === "plan") return ["Reading request", "Reviewing project context", "Drafting plan"];
  if (mode === "spec") return ["Reading request", "Identifying requirements", "Drafting specification"];
  return ["Reading request", "Reviewing project context", "Drafting proposed changes"];
}

function renderOutput(input: RunnerInput): string {
  const context = input.projectContext?.relevantFiles?.length
    ? `\n\nContext considered: ${input.projectContext.relevantFiles.map((f) => f.relPath).join(", ")}`
    : "";

  const banner =
    "[demo runner — no model configured. Pick a model in Settings, or set ANTHROPIC_API_KEY+ANTHROPIC_MODEL / OPENROUTER_API_KEY / GROQ_API_KEY / a running Ollama for MobiusX Cloud Gateway to use a real model. See apps/cloud-agent-gateway/README.md]\n\n";

  if (input.mode === "ask") {
    return `${banner}You asked: "${input.prompt}"\n\nThis is where a real model's answer would appear.${context}`;
  }
  if (input.mode === "plan") {
    return `${banner}Draft plan for: "${input.prompt}"\n\n1. Investigate the relevant code paths\n2. Identify the smallest change that addresses this\n3. Write/update tests\n4. Open a PR for human review\n\n(A real model would replace this with a plan grounded in your actual codebase.)${context}`;
  }
  if (input.mode === "spec") {
    return `${banner}Requirements specification for: "${input.prompt}"\n\nThis reference gateway never writes to disk itself — "spec" mode proposes a single new markdown spec file (below, under .mobiusx/specs/) the same way "build" mode proposes code edits: only desktop-agent ever writes it, and only once you review and click Apply. Below is a clearly-labeled DEMO spec so you can exercise that flow without a real model configured. A real model would produce an actual requirements breakdown of your prompt (functional/non-functional requirements, constraints, risks, Given/When/Then acceptance criteria) instead.${context}`;
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

/**
 * Same idea as demoEdit above, but for "spec" mode (PRD §8, Requirements
 * Engineering): a clearly-labeled placeholder spec, following the exact
 * section structure a real model is instructed to produce (see
 * promptShared.ts's systemPromptFor "spec" branch), so the whole
 * ask -> spec -> review -> apply flow is exercisable without a model.
 */
function demoSpecEdit(input: RunnerInput): { path: string; action: "create"; content: string } {
  return {
    path: ".mobiusx/specs/demo-spec.md",
    action: "create",
    content: `# Demo specification (not a real requirements analysis)

This spec was generated by the cloud-agent-gateway's **demo runner**, not a
real model. No ANTHROPIC_API_KEY is configured, so nothing below reflects
actual analysis of your request — it exists only to demonstrate the shape
a real spec would take, and to prove the propose -> review -> apply
pipeline works end-to-end for Requirements Engineering mode.

Original prompt: "${input.prompt}"

## Overview

A one-paragraph summary of the requested capability would go here.

## Functional Requirements

1. (placeholder) The system shall do X in response to Y.
2. (placeholder) The system shall do Z under condition W.

## Non-Functional Requirements

1. (placeholder) Performance, availability, or scalability targets.
2. (placeholder) Security or compliance constraints.

## Constraints & Assumptions

- (placeholder) Any constraint or assumption a real analysis would surface.

## Risks

- (placeholder) A risk a real analysis would flag.

## Acceptance Criteria

\`\`\`gherkin
Given (placeholder precondition)
When (placeholder action)
Then (placeholder expected outcome)
\`\`\`

Safe to delete. Configure a real model (see apps/cloud-agent-gateway/README.md) to get an actual requirements breakdown instead of this placeholder.
`,
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
