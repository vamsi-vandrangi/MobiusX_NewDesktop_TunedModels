import type { ModelOption, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { classifyPersona, PERSONAS } from "./personas.js";

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
      // Roadmap Phase 11 (source §26): edits computed once per mode so the
      // scripted review below can attach the SAME persona classifyPersona()
      // would assign for a real run — a demo user gets an honest preview of
      // which named persona (see runners/personas.ts) would review this
      // kind of task, not just a generic "approve" every time. "spec" is
      // now included here too (previously reviewed nowhere, real or demo —
      // see anthropicRunner.ts's doc comment for why that changed).
      let edits: ProposedEdit[] = [];
      if (input.mode === "build" || input.mode === "fix") edits = [demoEdit(input)];
      else if (input.mode === "database") edits = demoDatabaseEdits(input);
      else if (input.mode === "architecture") edits = demoArchitectureEdits(input);
      else if (input.mode === "testing") edits = demoTestingEdits(input);
      else if (input.mode === "spec") edits = [demoSpecEdit(input)];

      if (edits.length > 0) {
        emit({ type: "edits", edits });
        // Second-pass Reviewer agent (PRD §11/§46) — scripted here, same as everything else in this runner.
        const persona = classifyPersona(input.mode, edits);
        emit({
          type: "review",
          review: {
            verdict: "approve",
            summary: `[demo reviewer — no model configured] This is a scripted demo review (as the ${PERSONAS[persona].label}) that always approves the demo edit; configure a real model for an actual second-opinion code review.`,
            persona,
          },
        });
      }
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
  if (mode === "fix") return ["Reading verification failure", "Reviewing project context", "Drafting fix"];
  if (mode === "database") return ["Reading request", "Checking for an existing DB/ORM convention", "Drafting schema, migration, and model changes"];
  if (mode === "architecture") return ["Reading architecture evidence bundle", "Mapping real components, routes, and schema", "Drafting HLD.md and LLD.md with Mermaid diagrams"];
  if (mode === "testing") return ["Reading testing evidence bundle", "Matching existing test style", "Drafting test file(s)"];
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
  if (input.mode === "fix") {
    const failing = input.projectContext?.failingVerification ?? [];
    const failingSummary = failing.length > 0 ? failing.map((s) => s.label).join(", ") : "(no failing-step evidence attached)";
    return `${banner}Diagnose & Fix for: "${input.prompt}"\n\nThis reference gateway never writes to disk itself — "fix" mode (roadmap Phase 6, Autonomous Build/Test/Fix Loop) proposes full-file-content edits addressing a real verification failure the same way "build" mode proposes edits for a feature request: only desktop-agent ever writes them, and only once you review and click Apply. Failing step(s) this demo run was given: ${failingSummary}. Below is a clearly-labeled DEMO fix so you can exercise the verify → diagnose & fix → apply → re-verify loop without a real model configured. A real model would diagnose the actual failure output instead.${context}`;
  }
  if (input.mode === "database") {
    return `${banner}Database Engineering for: "${input.prompt}"\n\nThis reference gateway never writes to disk itself — "database" mode (roadmap Phase 8) proposes a schema, its forward migration, and ORM model changes as one coherent set, the same way "build" mode proposes code edits: only desktop-agent ever writes them, and only once you review and click Apply. Below is a clearly-labeled DEMO schema/migration/model set so you can exercise that flow, and GET /db/consistency, without a real model configured. A real model would generate an actual schema grounded in your request and this project's existing DB/ORM convention instead.${context}`;
  }
  if (input.mode === "architecture") {
    return `${banner}Architecture Generation for: "${input.prompt}"\n\nThis reference gateway never writes to disk itself — "architecture" mode (roadmap Phase 9) proposes docs/architecture/HLD.md and docs/architecture/LLD.md as one coherent set, the same way "build" mode proposes code edits: only desktop-agent ever writes them, and only once you review and click Apply. A real model is handed a pre-computed, evidence-cited bundle (GET /architecture-evidence: real components, schema/ORM relationships, HTTP routes, external integrations) and instructed to render it faithfully rather than invent generic boxes. Below is a clearly-labeled DEMO HLD/LLD pair so you can exercise that flow without a real model configured.${context}`;
  }
  if (input.mode === "testing") {
    return `${banner}Testing Engine for: "${input.prompt}"\n\nThis reference gateway never writes to disk itself — "testing" mode (roadmap Phase 10) proposes real test file(s) for the code shown to you, the same way "build" mode proposes code edits: only desktop-agent ever writes them, and only once you review and click Apply. A real model is handed a pre-computed evidence bundle (GET /testing-evidence: this project's real detected test framework(s) and an existing test file sample when one exists) and instructed to write tests only against real, visible code -- never an imagined API. Below is a clearly-labeled DEMO test file so you can exercise that flow without a real model configured.${context}`;
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
  if (input.mode === "fix") {
    return {
      path: "MOBIUSX_DEMO_FIX.md",
      action: "create",
      content: `# Demo fix (not a real AI-diagnosed repair)\n\nThis file was created by the cloud-agent-gateway's **demo runner**, not a real\nmodel. No ANTHROPIC_API_KEY is configured, so there is no real diagnosis\nbehind this change — it exists only to prove that MobiusX.ai WDC's\nverify -> diagnose & fix -> apply -> re-verify loop (roadmap Phase 6) works\nend-to-end:\n\n1. POST /verify reported a real failure.\n2. The gateway proposed this file (a "fix" task).\n3. You reviewed it and clicked Apply.\n4. The desktop agent wrote it to disk exactly here.\n\nOriginal prompt: "${input.prompt}"\n\nSafe to delete. Configure a real model (see apps/cloud-agent-gateway/README.md) to get an actual diagnosed fix instead of this placeholder.\n`,
    };
  }
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

/**
 * Same idea as demoEdit/demoSpecEdit above, but for "database" mode
 * (roadmap Phase 8, Database Engineering): a clearly-labeled placeholder
 * schema + matching forward migration, so GET /db/consistency (dbOps.ts)
 * and the whole propose -> review -> apply -> consistency-check flow is
 * exercisable without a model configured. Two files, like a real database
 * task would propose, so "Proposed changes -- 2 files" isn't misleading
 * even in demo mode.
 */
/**
 * Same idea as demoDatabaseEdits above, but for "architecture" mode
 * (roadmap Phase 9, Architecture Generation): a clearly-labeled placeholder
 * HLD/LLD pair with real Mermaid fences, so the Artifacts view's Mermaid
 * rendering (see renderer.js) and the whole propose -> review -> apply flow
 * is exercisable without a model configured. Two files, like a real
 * architecture task would propose, so "Proposed changes -- 2 files" is not
 * misleading even in demo mode.
 */
function demoArchitectureEdits(input: RunnerInput): { path: string; action: "create"; content: string }[] {
  return [
    {
      path: "docs/architecture/HLD.md",
      action: "create",
      content: `# High-Level Design (DEMO -- not a real architecture analysis)

Created by the cloud-agent-gateway's **demo runner**, not a real model. No
ANTHROPIC_API_KEY is configured, so nothing below reflects this project's
actual detected tech stack, routes, or integrations -- it exists only to
exercise MobiusX.ai WDC's Architecture Generation flow (roadmap Phase 9)
end-to-end, including Mermaid rendering in the Artifacts view.

Original prompt: "${input.prompt}"

## System Context

` + "```mermaid" + `
flowchart TD
    User([User]) --> System[This System -- DEMO PLACEHOLDER]
` + "```" + `

(A real model would draw one box per entry in this project's real detected
externalIntegrations here, or state plainly that none were detected.)

## Container

` + "```mermaid" + `
flowchart TD
    Frontend[Frontend -- DEMO PLACEHOLDER] -->|HTTP| Backend[Backend -- DEMO PLACEHOLDER]
    Backend --> DB[(Database -- DEMO PLACEHOLDER)]
` + "```" + `

Safe to delete. Configure a real model (see apps/cloud-agent-gateway/README.md) to get actual evidence-grounded diagrams instead of this placeholder.
`,
    },
    {
      path: "docs/architecture/LLD.md",
      action: "create",
      content: `# Low-Level Design (DEMO -- not a real architecture analysis)

Created by the cloud-agent-gateway's **demo runner**, not a real model.
Original prompt: "${input.prompt}"

## Component

` + "```mermaid" + `
flowchart TD
    Routes["/example -- DEMO PLACEHOLDER"]
` + "```" + `

## Sequence

` + "```mermaid" + `
sequenceDiagram
    participant U as User
    participant F as Frontend
    participant B as Backend
    U->>F: DEMO PLACEHOLDER request
    F->>B: DEMO PLACEHOLDER
` + "```" + `

## ER

(A real model would draw this strictly from this project's real detected
database schema/ORM relationships, or state plainly that none were found.
No demo ER diagram is included, to avoid implying a fake schema is real.)

## Deployment

Deployment/infrastructure evidence is not yet gathered by this tool, so no
Deployment diagram is included here even in demo mode.

Safe to delete. Configure a real model to get actual evidence-grounded diagrams instead of this placeholder.
`,
    },
  ];
}

function demoDatabaseEdits(input: RunnerInput): { path: string; action: "create"; content: string }[] {
  return [
    {
      path: "db/schema.sql",
      action: "create",
      content: `-- Demo schema (not a real AI-designed schema)
--
-- Created by the cloud-agent-gateway's DEMO runner, not a real model. No
-- ANTHROPIC_API_KEY is configured, so there is no real domain-model
-- reasoning behind this -- it exists only to exercise MobiusX.ai WDC's
-- Database Engineering flow (roadmap Phase 8) end-to-end:
--
-- 1. The gateway proposed this schema + db/migrations/001_demo.sql (a "database" task).
-- 2. You reviewed them and clicked Apply.
-- 3. GET /db/consistency (dbOps.ts) can now check them against any ORM models.
--
-- Original prompt: "${input.prompt}"
-- Safe to delete. Configure a real model to get an actual schema instead.

CREATE TABLE demo_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    },
    {
      path: "db/migrations/001_demo.sql",
      action: "create",
      content: `-- Demo forward migration (not real) -- see db/schema.sql for context.
-- Original prompt: "${input.prompt}"

CREATE TABLE demo_items (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    },
  ];
}

/**
 * Same idea as demoEdit/demoDatabaseEdits/demoArchitectureEdits above, but
 * for "testing" mode (roadmap Phase 10, Testing Engine): a single,
 * clearly-labeled placeholder test file, so the propose -> review -> apply
 * flow is exercisable without a model configured. This reference runner has
 * no live testing-evidence bundle to react to (that only exists once a real
 * desktop-agent project is open with a real model attached), so it always
 * proposes a plain pytest-flavored placeholder -- explicitly labeled either
 * way, same as every other demo edit in this file.
 */
function demoTestingEdits(input: RunnerInput): { path: string; action: "create"; content: string }[] {
  return [
    {
      path: "tests/test_demo_placeholder.py",
      action: "create",
      content: `# Demo test file (not a real AI-generated test)
#
# Created by the cloud-agent-gateway's DEMO runner, not a real model. No
# ANTHROPIC_API_KEY is configured, so there is no real analysis of your
# project's code behind this -- it exists only to exercise MobiusX.ai WDC's
# Testing Engine flow (roadmap Phase 10) end-to-end:
#
# 1. The gateway proposed this file (a "testing" task).
# 2. You reviewed it and clicked Apply.
# 3. POST /verify can now run it (if this project has pytest available).
#
# Original prompt: "${input.prompt}"
# Safe to delete. Configure a real model (see apps/cloud-agent-gateway/README.md)
# to get actual tests grounded in this project's real detected framework and
# real existing code instead of this placeholder.


def test_demo_placeholder():
    assert True, "This is a DEMO placeholder test -- configure a real model for actual generated tests."
`,
    },
  ];
}

function demoDevopsEdits(input: RunnerInput): { path: string; action: "create"; content: string }[] {
  return [
    {
      path: "Dockerfile",
      action: "create",
      content: `# Demo Dockerfile (not a real AI-generated infra file)
#
# Created by the cloud-agent-gateway's DEMO runner, not a real model. No
# ANTHROPIC_API_KEY is configured, so there is no real analysis of this
# project's actual detected services behind this -- it exists only to
# exercise MobiusX.ai WDC's DevOps/Infrastructure Generation flow (roadmap
# Phase 14) end-to-end:
#
# 1. The gateway proposed this file (a "devops" task).
# 2. You reviewed it and clicked Apply.
# 3. A real model would instead be grounded in GET /devops-evidence --
#    this project's real detected frontend/backend/database components,
#    any infra file it already has, and its own real build/test/lint
#    commands -- and would propose an actual Dockerfile, docker-compose.yml,
#    and CI pipeline for THIS project's real services, never this
#    placeholder.
#
# Original prompt: "${input.prompt}"
# Safe to delete. Configure a real model (see apps/cloud-agent-gateway/README.md)
# to get an actual, evidence-grounded infrastructure proposal instead.

FROM alpine:3.19
CMD ["echo", "DEMO placeholder image -- configure a real model for an actual generated Dockerfile"]
`,
    },
  ];
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
