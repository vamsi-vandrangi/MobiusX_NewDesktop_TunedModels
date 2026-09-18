import type { AgentMode, AgentPersona, EditReview, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { RunnerInput } from "./types.js";
import { stepId } from "./promptShared.js";

/**
 * Multi-Agent Orchestration (roadmap Phase 11, source §26/§27).
 *
 * Before this phase, every mode's second-pass Reviewer call (PRD §11/§46)
 * used the exact same generic "Code Reviewer Agent" system prompt,
 * regardless of whether it was reviewing a database migration, a
 * generated test file, or an architecture diagram doc. That's a real gap:
 * a Database edit's actual risks (schema<->ORM drift, a FK pointing at a
 * table name that doesn't exist -- see docs/phase-notes/
 * phase-10-testing-engine.md's live-found GreenThumbGarden bug) are not
 * the same risks a Testing edit has (placeholder assertions, an import
 * that doesn't match the target file's own convention -- ALSO a real bug
 * this session found live in Phase 10). This module is what formalizes
 * that into named personas with distinct review focus, per the roadmap's
 * own persona list (Architecture/Database/Backend/Frontend/API/Testing/
 * DevOps/Documentation/Debugger).
 *
 * Deliberately still ONE review call per task, not separate concurrent
 * agent processes -- the roadmap entry's own words are "real role
 * separation, not necessarily separate concurrent processes on day one."
 * What changes is WHICH identity and focus-area prompt that one call uses,
 * chosen by classifyPersona() below from the task's real mode (and, for
 * "build" mode -- which can touch any kind of file -- a lightweight
 * path-based heuristic over the actual proposed edits, not a guess made
 * before anything was proposed).
 */

export const PERSONAS: Record<AgentPersona, { label: string; focus: string[] }> = {
  architecture: {
    label: "Architecture Agent",
    focus: [
      "Does every component, route, integration, and relationship drawn in the diagrams trace back to something real -- never a generic \"Load Balancer\"/\"Cache\"/\"Auth Service\" box that isn't actually evidenced.",
      "Are the HLD and LLD internally consistent with each other and with the prose summary -- no diagram contradicting what the text says.",
      "Where evidence was genuinely absent (no external integrations, no routes, no schema), does the doc say so honestly instead of silently omitting the section or inventing content to fill it.",
    ],
  },
  database: {
    label: "Database Agent",
    focus: [
      "Does every table added or changed in the schema/migration have a matching entry in the ORM model file(s) -- never one layer updated and the other left stale.",
      "Do foreign key references actually point at a table name that exists elsewhere in this SAME edit set (a mismatched or auto-derived table name vs. a hardcoded FK string is a real, previously-observed bug class -- do not assume names match just because they look similar).",
      "Is a destructive operation (DROP TABLE, DROP COLUMN, TRUNCATE, a non-additive type change) called out explicitly as a risk, given this project has no migration rollback mechanism yet.",
    ],
  },
  backend: {
    label: "Backend Agent",
    focus: [
      "Does this file's imports match the SAME module's own existing import convention (bare sibling imports vs. package-qualified) rather than assuming a package layout the project doesn't have -- a real, previously-observed bug class.",
      "Basic error handling and input validation on anything touching external input (request bodies, file paths, query params).",
      "Obvious security issues: hardcoded secrets/credentials, unsafe string-built queries, unvalidated file paths.",
    ],
  },
  frontend: {
    label: "Frontend Agent",
    focus: [
      "Is user-provided input handled safely (no unescaped injection into rendered HTML, no trusting client-side validation alone).",
      "Does the change introduce an obviously broken UI state (an unhandled loading/error/empty case for data that can fail to load).",
      "Anything that would obviously break accessibility (a clickable element with no keyboard/label affordance) or cause an obvious unnecessary re-render loop.",
    ],
  },
  api: {
    label: "API Agent",
    focus: [
      "Does a new or changed HTTP route return a sensible status code and response shape for both its success and error paths (not just the happy path).",
      "If this backend is called from a separately-hosted frontend, is CORS actually configured for it -- don't assume it was just because the request mentioned a frontend.",
      "Is there an obvious missing authorization/ownership check on an endpoint that reads or writes data scoped to a specific user or resource.",
    ],
  },
  testing: {
    label: "Testing Agent",
    focus: [
      "Does every test assert something real about the code's behavior -- flag any test that only checks a function exists, returns non-null, or asserts a trivial truth (\"assert True\") with no real check.",
      "Do this test's imports match the file it's testing own import convention EXACTLY (e.g. a bare sibling import if the target file uses one) -- a package-qualified import that doesn't match how the app actually runs is a real, previously-observed bug that makes a generated test fail to even collect.",
      "Is the test actually placed where the project's test runner will find it (relative to the module under test, not assumed to be the project root).",
    ],
  },
  devops: {
    label: "DevOps Agent",
    focus: [
      "No secrets or credentials baked into an image, manifest, or CI config -- only ever referenced via a secrets mechanism.",
      "Resource limits/requests set on anything that could otherwise consume unbounded CPU/memory.",
      "No overly-broad permissions (a container running as root without needing to, a CI token with more scope than the job needs).",
    ],
  },
  auth: {
    label: "Auth Agent",
    focus: [
      "Are passwords/secrets ever compared with a non-constant-time equality check, or hashed with a fast general-purpose hash (MD5/SHA-1/plain SHA-256) instead of a real password-hashing function (bcrypt/argon2/scrypt/PBKDF2) -- flag either as a real risk, not a style nit.",
      "Is a JWT or session token actually verified (signature + expiry) on every protected route, not just decoded/parsed and trusted -- decoding without verifying is a real, previously-observed vulnerability class.",
      "Is an authorization check (does THIS user own/have a role permitting THIS resource) present and distinct from authentication (is this a valid logged-in user at all) -- flag any route that checks the latter but not the former on data scoped to a specific user or role.",
    ],
  },
  documentation: {
    label: "Documentation Agent",
    focus: [
      "Does every REQ-NNN requirement in the markdown spec have at least one matching acceptance criterion, and a matching entry in the JSON twin -- flag any id present in one but not the other.",
      "Does the spec stay within what the user actually asked for, rather than inventing requirements they never stated (those belong under Open Questions, not asserted as requirements).",
      "Is anything ambiguous in the original request left as a silent assumption instead of an explicit open question.",
    ],
  },
  debugger: {
    label: "Debugger Agent",
    focus: [
      "Does this fix address the root cause shown in the real failing verification output, not just suppress the symptom (e.g. wrapping a call in try/except instead of fixing why it throws).",
      "Is the change minimal -- flag anything that refactors, renames, or reformats code unrelated to the actual failure.",
      "Could this same fix plausibly reintroduce the failure under slightly different conditions (an edge case the fix doesn't actually cover).",
    ],
  },
};

/**
 * Maps a task's real mode (and, for "build" mode, a lightweight path-based
 * heuristic over its actual proposed edits) to the persona whose focus
 * areas above are most relevant. Direct 1:1 for every mode except "build",
 * which can touch backend, frontend, or API-route files in the same task
 * -- classified by majority vote across the proposed edits' paths, ties
 * broken toward "backend" (this project's most common real case so far:
 * FastAPI/Python backend files). This is a real but deliberately simple
 * heuristic -- path/extension matching, not static analysis of file
 * content -- consistent with "real role separation, not necessarily
 * separate concurrent processes" being this phase's stated bar, not a
 * promise of deep per-file understanding.
 *
 * "devops" is returned directly for "devops"-mode tasks (roadmap Phase 14,
 * source requirement §21) -- the first AgentMode to actually reach the
 * DevOps Agent persona defined above; every other mapping below predates
 * that phase and is unchanged.
 */
export function classifyPersona(mode: AgentMode, edits: ProposedEdit[]): AgentPersona {
  if (mode === "database") return "database";
  if (mode === "architecture") return "architecture";
  if (mode === "testing") return "testing";
  if (mode === "devops") return "devops";
  if (mode === "auth") return "auth";
  if (mode === "fix") return "debugger";
  if (mode === "spec") return "documentation";
  // "build" (and any future structured-edits mode not listed above):
  // classify by majority vote over the proposed edits' paths.
  return classifyBuildPersona(edits);
}

const API_PATH_RE = /(^|\/)(api|routes?|endpoints?)(\/|$)/i;
const API_FILENAME_RE = /routes?\.[jt]sx?$/i;
const FRONTEND_PATH_RE = /(^|\/)(frontend|client|components|pages|public|src\/app)(\/|$)/i;
const FRONTEND_EXT_RE = /\.(tsx|jsx|vue|svelte|css|scss)$/i;

function classifyEditPersona(path: string): "backend" | "frontend" | "api" {
  if (API_PATH_RE.test(path) || API_FILENAME_RE.test(path)) return "api";
  if (FRONTEND_PATH_RE.test(path) || FRONTEND_EXT_RE.test(path)) return "frontend";
  return "backend";
}

function classifyBuildPersona(edits: ProposedEdit[]): AgentPersona {
  if (edits.length === 0) return "backend"; // never actually reached (callers only invoke this with edits.length > 0), but a safe, honest default rather than throwing
  const counts: Record<"backend" | "frontend" | "api", number> = { backend: 0, frontend: 0, api: 0 };
  for (const e of edits) counts[classifyEditPersona(e.path)]++;
  // Tie-break order: backend, then api, then frontend -- backend is this
  // project's most common real case (see doc comment above); api ranks
  // above frontend on a tie because a route-pattern match is a more
  // specific/deliberate signal than a generic frontend path/extension.
  const order: ("backend" | "api" | "frontend")[] = ["backend", "api", "frontend"];
  let best: "backend" | "api" | "frontend" = "backend";
  for (const key of order) {
    if (counts[key] > counts[best]) best = key;
  }
  return best;
}

/** Builds the full second-pass reviewer system prompt for a given persona -- the shared critic core (unchanged from the original single generic reviewer) plus that persona's own named identity and focus checklist. */
export function personaReviewSystemPrompt(persona: AgentPersona): string {
  const p = PERSONAS[persona];
  return [
    `You are the ${p.label} — a second, independent pass over another agent's proposed file edits, run automatically before a human decides whether to apply them. This review is specifically about ${persona} concerns, in addition to general code-review judgment.`,
    "Assess, in order of priority: correctness risk, security concerns (hardcoded secrets, injection, unsafe input handling), whether the change actually addresses the stated request, and obvious code-quality issues.",
    `As the ${p.label}, pay particular attention to:`,
    ...p.focus.map((f) => `- ${f}`),
    'Respond with EXACTLY one JSON object and nothing else: {"verdict": "approve" | "concerns", "summary": "1-3 sentences explaining the verdict"}.',
    'Use "concerns" whenever you are not confident the change is correct and safe — do not default to "approve" out of politeness or to avoid conflict.',
  ].join("\n");
}

/** Lenient JSON extraction matching parseBuildResponse's style, but with a safe default: an unparseable review is reported as "concerns", never silently dropped or upgraded to "approve". Persona is attached by the caller (runPersonaReview below), not parsed from the model's own response -- the persona was already decided before the call was made. */
export function parseReview(text: string): Pick<EditReview, "verdict" | "summary"> {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : text).trim();
  try {
    const parsed = JSON.parse(jsonText) as { verdict?: unknown; summary?: unknown };
    if ((parsed.verdict === "approve" || parsed.verdict === "concerns") && typeof parsed.summary === "string") {
      return { verdict: parsed.verdict, summary: parsed.summary };
    }
  } catch {
    /* fall through to the safe default below */
  }
  return {
    verdict: "concerns",
    summary: "Reviewer response could not be parsed as a verdict — treating as unreviewed rather than silently approving.",
  };
}

/**
 * Shared second-pass-review orchestration: builds the persona-specific
 * prompt and user content, calls the given `callModel` (each runner
 * supplies its own thin closure around its provider's own non-streamed
 * chat call -- Anthropic Messages API, an OpenAI-compatible
 * /chat/completions, or Ollama's /api/chat), and emits the resulting
 * "step"/"review" TaskEvents. Centralizing this (rather than duplicating
 * the step-emission and error-handling in every runner, as the original
 * single-persona version did only in anthropicRunner.ts) is what let this
 * phase extend review to the OpenAI-compatible and Ollama runners without
 * copy-pasting the same try/catch shape three more times.
 *
 * Failure modes are handled conservatively, same as before this phase: a
 * review call that errors (network, non-2xx, cancellation aside) or whose
 * response doesn't parse as {verdict, summary} is reported as verdict
 * "concerns" with an honest explanation, never dropped or defaulted to
 * "approve". An AbortError is re-thrown so cancellation during review is
 * handled uniformly by the caller's own catch block.
 */
export async function runPersonaReview(
  mode: AgentMode,
  input: RunnerInput,
  edits: ProposedEdit[],
  emit: (event: TaskEvent) => void,
  callModel: (systemPrompt: string, userContent: string) => Promise<string>,
): Promise<void> {
  const persona = classifyPersona(mode, edits);
  const step = {
    id: stepId(),
    label: `Running second-pass review (${PERSONAS[persona].label})`,
    status: "in_progress" as const,
    startedAt: new Date().toISOString(),
  };
  emit({ type: "step", step });

  try {
    const userContent = [
      `Original request: "${input.prompt}"`,
      "",
      "Proposed edits:",
      ...edits.map((e) => `--- ${e.path} (${e.action}) ---\n${e.content}`),
    ].join("\n\n");

    const text = await callModel(personaReviewSystemPrompt(persona), userContent);
    emit({ type: "review", review: { ...parseReview(text), persona } });
    emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    emit({
      type: "review",
      review: {
        verdict: "concerns",
        summary: `Second-pass review could not be completed: ${(err as Error).message}`,
        persona,
      },
    });
    emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
  }
}
