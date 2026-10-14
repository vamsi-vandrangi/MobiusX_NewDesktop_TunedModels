/**
 * Desktop <-> Cloud Agent contract (Phase 3).
 *
 * IMPORTANT: this describes the contract implemented by
 * apps/cloud-agent-gateway, which is a LOCAL REFERENCE implementation, not
 * MobiusX's real production Cloud (the RAG/Enterprise-Knowledge/Artifacts
 * backend referenced elsewhere in this repo's docs). It exists to prove the
 * desktop<->cloud task lifecycle end-to-end and give the AI Assistant panel
 * something real to call. Swapping in the real backend later means pointing
 * the desktop at a different base URL that implements this same contract
 * (or adapting this contract to match the real backend's — whichever is
 * less churn once that integration is scoped) — see docs/ARCHITECTURE.md §12.
 */

import type { ArchitectureEvidence, AuthEvidence, DevopsEvidence, TestingEvidence } from "./agent.js";

/**
 * "spec" (PRD §8, Requirements Engineering) reuses the exact same
 * propose-edits/review/apply pipeline "build" uses — a generated spec is
 * just a markdown file under `.mobiusx/specs/` proposed as a `create`
 * ProposedEdit, so it goes through the same diff review and explicit
 * Apply step as any other AI-generated file (see taskEngine.ts,
 * anthropicRunner.ts's MODES_WITH_STRUCTURED_EDITS, and
 * apps/desktop-agent/src/fsOps.ts#applyEdits). It never touches existing
 * code — only ever proposes a brand-new spec file.
 *
 * "fix" (roadmap Phase 6, source requirement §16 — Autonomous Build/Test/Fix
 * Loop) also reuses the exact same propose-edits/review/apply pipeline as
 * "build": given real failure evidence from POST /verify (see
 * ProjectContext.failingVerification below), it proposes the minimal
 * ProposedEdit[] needed to address those specific failures — never a
 * broader refactor. It is deliberately NOT a new pipeline: the only
 * difference from "build" is what grounds the prompt (verification
 * failures instead of a user's free-form request) and that its edits, once
 * applied, are expected to be re-verified (see apps/desktop/src/renderer/renderer.js's
 * "Diagnose & Fix" flow) rather than treated as a one-shot task.
 */
/**
 * "database" (roadmap Phase 8, source requirement §8 — Database Engineering)
 * also reuses the same propose-edits/review/apply pipeline as "build": it
 * proposes a schema definition, a forward migration, and ORM model file(s)
 * as one coherent set (never just files inside a generic build request) --
 * see apps/cloud-agent-gateway/src/runners/promptShared.ts's "database"
 * branch for the exact convention. Distinct from "build" only in what its
 * prompt asks for and that its output is checked afterward by a real,
 * evidence-based Database Consistency Check (GET /db/consistency, see
 * apps/desktop-agent/src/dbOps.ts) rather than trusted on the model's word.
 */
/**
 * "architecture" (roadmap Phase 9, source requirement §7 -- Architecture
 * Generation) also reuses the same propose-edits/review/apply pipeline as
 * "build", proposing exactly two files -- docs/architecture/HLD.md and
 * docs/architecture/LLD.md -- containing Mermaid diagrams (system context,
 * container, component, sequence, ER, deployment) plus grounding prose.
 * The one real difference from every other mode: its prompt is NOT built
 * from the user's free-form request plus a snippet/full-content file list
 * the way build/fix/spec/database are. It is built from a dedicated,
 * pre-computed evidence bundle (GET /architecture-evidence, see
 * apps/desktop-agent/src/architectureContext.ts) -- real detected tech
 * stack, real schema/ORM relationships, real HTTP routes, real third-party
 * integrations, real CORS-derived frontend<->backend links. This exists
 * because a beta tester reported generated diagrams as "very basic level,"
 * and the direct cause of a basic diagram is a model that was never given
 * anything but a one-line request to draw from -- see
 * docs/phase-notes/phase-9-architecture-generation.md.
 */
/**
 * "testing" (roadmap Phase 10, source requirement §15 -- Testing Engine)
 * also reuses the same propose-edits/review/apply pipeline as "build": it
 * proposes one or more real, runnable test files for the code shown to it,
 * grounded in a dedicated evidence bundle (GET /testing-evidence, see
 * apps/desktop-agent/src/testingContext.ts) -- this project's REAL
 * detected test framework(s) (reusing Phase 7's own detection, never
 * re-guessed) and, when one exists, a real existing test file to match
 * style against. verify.ts (see roadmap Phase 6) now also actually RUNS a
 * detected Python test suite (previously root-package.json-only), so a
 * generated test is validated the same way a fix is, not just written and
 * forgotten. Build mode also gains a conditional instruction, gated on
 * this same evidence bundle, to propose a companion test file alongside
 * new backend/frontend source it creates -- never inventing a framework
 * this project doesn't already have.
 */
/**
 * "devops" (roadmap Phase 14, source requirement §21 -- DevOps/
 * Infrastructure Generation, builds on Phase 6) also reuses the same
 * propose-edits/review/apply pipeline as "build": it proposes a
 * Dockerfile per detected frontend/backend component, a root
 * docker-compose.yml wiring those (plus any detected database) together,
 * and a CI pipeline file (.github/workflows/ci.yml) -- all grounded in a
 * dedicated evidence bundle (GET /devops-evidence, see
 * apps/desktop-agent/src/devopsContext.ts) rather than invented
 * boilerplate: this project's real detected components/locations (Phase
 * 7), any infra artifacts it ALREADY has (shown in full so the model
 * proposes "modify", never a blind "create" over something reviewed and
 * working), and this project's own real build/test/lint commands (reused
 * verbatim from verify.ts's own detectors, so the generated CI pipeline
 * runs literally the same commands "Run Verification" already runs).
 * Second-pass-reviewed by the DevOps Agent persona (see
 * apps/cloud-agent-gateway/src/runners/personas.ts#PERSONAS.devops),
 * which this mode is the first to actually make reachable.
 */
export type AgentMode = "ask" | "plan" | "build" | "spec" | "fix" | "database" | "architecture" | "testing" | "devops" | "auth";

/**
 * Oct 2026 addition — a per-task toggle in the Assistant panel's header
 * ("☁ Cloud / 💻 Local / ⇄ Both" has a sibling row for this), independent
 * of AgentMode: it doesn't change WHICH task type runs (Build vs Testing vs
 * Auth, etc.), only the architectural register every mode answers in —
 * see systemPromptFor's archModeGuidanceBlock in
 * apps/cloud-agent-gateway/src/runners/promptShared.ts for the actual
 * guidance text each value injects. Optional and has no server-side
 * default: omitted entirely, the prompt is unchanged from before this
 * field existed (see archModeGuidanceBlock's own doc comment for exactly
 * which call sites never set this).
 *
 * "web" = lean/fast web-application patterns (modern frontend frameworks,
 * utility-first styling, light state management, the simplest database
 * that fits). "enterprise" = layered architecture, SOLID, secure
 * role/attribute-based data access, async/event-driven service
 * communication where relevant, explicit test-coverage callouts. "core" =
 * general-purpose software development and debugging across languages
 * supported by the selected model. "embedded" = hardware-aware development
 * and debugging for embedded, bare-metal, and RTOS targets.
 * None of these values changes what this app itself enforces or verifies;
 * they change the model's instructions only.
 */
export type AppArchitectureMode = "web" | "enterprise" | "core" | "embedded";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * Multi-model support: this gateway can route a task to more than one
 * model provider, not just Anthropic, so the user can pick a model the
 * way Claude/Cursor's own UIs let you, either as a standing default
 * (AgentSettings.defaultModel in agent.ts) or per task (CreateTaskRequest.model
 * below). See apps/cloud-agent-gateway/src/runners/registry.ts#resolveRunner
 * for exactly how a requested selection is honored or — visibly, never
 * silently — substituted. Free-tier lineups (openrouter, groq) change over
 * time as providers deprecate/add models — see each runner file's own doc
 * comment for the current, live-verified state rather than trusting this
 * comment to stay current.
 *
 * Providers that are paid, local-only, or not yet phase-tested are
 * deliberately excluded from automatic selection (registry.ts's
 * AUTO_PRIORITY) and only run when explicitly chosen. This includes:
 * "ollama" (local-only, depends on a background process happening to be
 * running on the user's machine), "deepseek" (a paid, metered API —
 * DeepSeek's own platform.deepseek.com, not free like openrouter/groq's
 * current lineups — so using it should always be an explicit choice, never
 * a silent fallback that starts charging the user's account), and
 * "cerebras" (ported Oct 2026 from the MobiusX web app's own X-Debug
 * fallback chain — see app/core/ai_config.py/settings.py in the CredenceX
 * repo — which runs Cerebras Cloud's OpenAI-compatible API,
 * https://api.cerebras.ai/v1. Starts on a $5 free-trial credit at a modest
 * 30K-tokens/minute rate limit, graduating to real metered billing once
 * that's used up or a paid Developer tier is purchased — see
 * cerebrasRunner.ts's own doc comment for the live-verified numbers this
 * was added with. Not "free like openrouter/groq" for the same reason
 * deepseek isn't: it can genuinely cost money, so it must be an explicit
 * choice); "xkiro" and "apinex" (third-party model routers whose free
 * coding models are newly provisioned here and must pass our own evaluation
 * before becoming automatic choices).
 */
export type ModelProvider = "demo" | "anthropic" | "openrouter" | "groq" | "deepseek" | "cerebras" | "xkiro" | "apinex" | "ollama";

export interface ModelSelection {
  provider: ModelProvider;
  /**
   * Provider-specific model identifier — e.g.
   * "qwen/qwen-2.5-coder-32b-instruct:free" for openrouter, "llama-3.3-70b-versatile"
   * for groq, "qwen2.5-coder" for ollama, or whatever ANTHROPIC_MODEL is set
   * to for anthropic. Always one of the ids GET /models reports for that
   * provider — the UI never invents its own.
   */
  model: string;
}

/**
 * One entry in GET /models — always the FULL catalog this gateway knows
 * about, INCLUDING providers/models that aren't currently usable (no key
 * set, Ollama not running, a model not yet pulled). `available` and
 * `unavailableReason` tell the truth about why, rather than hiding options
 * the user hasn't configured yet — the same "never hidden" principle
 * TaskSummary.runner already follows.
 */
export interface ModelOption extends ModelSelection {
  /** Human-readable label for a picker UI, e.g. "Llama 3.3 70B (free via OpenRouter)". */
  label: string;
  /** Whether this specific model is free to call on its provider's free tier. Never a guarantee about rate limits — free tiers throttle hard. */
  free: boolean;
  /** Whether this option can actually be used right now, given current env vars / reachability. */
  available: boolean;
  /** Present when `available` is false — e.g. "requires OPENROUTER_API_KEY" or "Ollama not reachable at http://127.0.0.1:11434". Always a concrete, actionable reason, never a generic "unavailable". */
  unavailableReason?: string;
}

export interface ListModelsResponse {
  models: ModelOption[];
}

/** Read-only result of probing Ollama from the gateway process itself. A
 * reachable Ollama service and a working Laya decision endpoint are tracked
 * separately because local generation can work while Laya falls back. */
export interface OllamaDiagnosticsResponse {
  endpoint: string;
  endpointSource: "settings/environment" | "default" | "discovered";
  reachable: boolean;
  httpStatus?: number;
  version?: string;
  installedModels: string[];
  selectedLocalModelAvailable?: boolean;
  layaInstalled: boolean;
  layaUsable: boolean | null;
  detail: string;
  runtime: "host" | "container" | "unknown";
}

/**
 * One failed/timed-out step from a real POST /verify run (see
 * VerificationStep in agent.ts), carried into a "fix"-mode task's context
 * so the model is grounded in actual evidence — never asked to guess what
 * broke. Deliberately a narrower shape than VerificationStep itself (no
 * id/exitCode/durationMs/truncated) since those fields exist for the
 * verify UI, not for prompting; `output` here is whatever the caller
 * chooses to include (renderer.js passes verify.ts's own already-capped
 * output through as-is).
 */
export interface FailingVerificationStep {
  /** e.g. "Build (npm run build)" — same as VerificationStep.label. */
  label: string;
  /** The exact command that was run, e.g. "npm run build". */
  command: string;
  /** Captured stdout+stderr from the failing run — the actual error text a fix must address. */
  output: string;
}

export interface ProjectContext {
  projectPath?: string;
  /**
   * Present only for a "fix"-mode task (see AgentMode's doc comment above)
   * — the real, failing VerificationStep(s) (mapped down to
   * FailingVerificationStep) this task exists to address. Absent for every
   * other mode. promptShared.ts's systemPromptFor includes this verbatim
   * in the fix-mode prompt so the model is diagnosing actual captured
   * output, not a paraphrase of it.
   */
  failingVerification?: FailingVerificationStep[];
  /**
   * Optional relevant-code hints, e.g. top hits from a Phase 2 /debug/search
   * — keeps the cloud call grounded in local context without shipping the
   * whole repo. `snippet` is always a short excerpt for display/prompting.
   * `content`, when present, is the FULL current file content — the desktop
   * only attaches this for build-mode requests (see renderer.js
   * findRelevantFiles) and it is what gates whether the model is allowed to
   * propose a "modify" edit for that path (see taskEngine's edit-safety
   * check): a file the model was never shown in full can't be silently
   * overwritten.
   */
  relevantFiles?: { relPath: string; snippet: string; content?: string }[];
  /**
   * Total chunks currently in the project's semantic search index (see
   * apps/desktop-agent/src/semanticOps.ts's searchSemanticIndex / the
   * @mobiusx/semantic-index package) -- a signal for a different question
   * than relevantFiles answers: not "what's relevant to this prompt" but
   * "does this project have ANY indexed content at all". 0 means the
   * project is genuinely empty or effectively so; undefined means this
   * wasn't measured (an older client, or no project open at all).
   * promptShared.ts's relevantFilesContext uses this to tell a build-mode
   * model plainly when relevantFiles is empty BECAUSE the project is empty,
   * as opposed to empty because nothing matched a search over a non-empty
   * project -- confirmed live (Sept 2026, qwen/qwen3.8-27b) that leaving
   * this ambiguous can make a careful model refuse to propose any files at
   * all for a brand-new project rather than guess which case it's in.
   */
  indexedChunkCount?: number;
  /**
   * Present only for an "architecture"-mode task (see AgentMode's doc
   * comment above) -- the real, pre-computed evidence bundle
   * (GET /architecture-evidence) that mode's prompt is grounded in.
   * Absent for every other mode.
   */
  architectureEvidence?: ArchitectureEvidence;
  /**
   * Present for a "testing"-mode task, and optionally attached to a
   * "build"-mode task too (see AgentMode's doc comment above) -- the real,
   * pre-computed evidence bundle (GET /testing-evidence) grounding what
   * test framework(s) and existing test style either mode's prompt should
   * follow. Absent for every other mode.
   */
  testingEvidence?: TestingEvidence;
  /**
   * Present only for a "devops"-mode task (see AgentMode's doc comment
   * above) -- the real, pre-computed evidence bundle (GET
   * /devops-evidence) that mode's prompt is grounded in. Absent for every
   * other mode.
   */
  devopsEvidence?: DevopsEvidence;
  /**
   * Present only for an "auth"-mode task (see AgentMode's doc comment
   * above) -- the real, pre-computed evidence bundle (GET /auth-evidence)
   * that mode's prompt is grounded in. Absent for every other mode.
   */
  authEvidence?: AuthEvidence;
  /**
   * Project Memory/Steering (roadmap Phase 16, source requirement §24/§25).
   * The combined markdown content of every file under this project's
   * `.mobiusx/steering/` directory (see SteeringFile in agent.ts), fetched
   * by the desktop client for EVERY mode with a project open (not just
   * build) -- steering is meant to be consulted automatically, the same
   * way a real engineer reads a project's CONTRIBUTING.md/architecture
   * notes before touching code regardless of what task they're doing.
   * Absent when the project has no steering files at all.
   */
  steeringContext?: string;
  /**
   * Assistant Memory (Oct 2026 addition — see MemoryFile's doc comment in
   * agent.ts for the full feature background). Same client-side-fetched,
   * prepended-to-every-mode pattern as steeringContext directly above
   * (see assistantMemoryBlock() in promptShared.ts): the desktop client
   * calls GET /memory on the LOCAL desktop-agent and joins the non-empty
   * files into this string before every task-creation call, regardless
   * of mode or whether a project is even open — memory is global, unlike
   * steering. Absent when ~/.mobiusx/memory/ has no non-empty files yet.
   */
  assistantMemoryContext?: string;
  /**
   * Enterprise Knowledge / Global Intelligence local substitute (roadmap
   * Phase 17, source requirement §29/§30 -- see KnowledgeSearchHit in
   * agent.ts for what a hit actually is). Real snippets retrieved from the
   * user's own configured knowledge sources (~/.mobiusx/knowledge-sources.json),
   * relevant to this specific prompt -- the desktop client runs a real
   * GET /knowledge/search against the current prompt text before creating
   * a build/spec/architecture-mode task, the same way relevantFiles is
   * populated from a real semantic search. Absent when no knowledge
   * sources are configured, or none scored a match.
   */
  knowledgeContext?: { sourceLabel: string; relPath: string; snippet: string }[];
}

/**
 * One prior turn from the same AI Assistant panel session, carried along on
 * a follow-up request so it can be understood without the user repeating
 * themselves — e.g. "show me the output" after "generate code for X" only
 * means anything if the model is re-shown what "X" was. This gateway is
 * otherwise fully stateless between tasks (each is an independent HTTP
 * POST with its own fresh runner call), so without this field a runner has
 * no way to know what was said earlier in the same panel — the exact gap
 * behind "history isn't maintained." Populated client-side
 * (apps/desktop/src/renderer.js, from what that panel already rendered) and
 * capped both there and in routes.ts — a bounded recent-context window, not
 * a full transcript archive or server-side session store.
 */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface CreateTaskRequest {
  mode: AgentMode;
  prompt: string;
  projectContext?: ProjectContext;
  /**
   * Optional per-task model override — takes precedence over
   * AgentSettings.defaultModel, which in turn takes precedence over the
   * gateway's own automatic choice. Omit entirely to use whatever the user
   * has set as their default (or the automatic choice, if they haven't).
   */
  model?: ModelSelection;
  /** True only when the client selected Cloud Auto. Enables retrying a failed
   * provider against the next configured automatic provider. */
  autoCloud?: boolean;
  /** See AppArchitectureMode's doc comment. Omit entirely for prompts unaffected by this toggle (the default, before this field existed). */
  archMode?: AppArchitectureMode;
  /** See HistoryTurn's doc comment. Omit (or send []) for a fresh, contextless request. */
  history?: HistoryTurn[];
  /**
   * Which conversation thread this task belongs to (see ThreadSummary
   * below). Optional so older clients / one-off tasks that don't use
   * threads keep working unchanged -- a task created without one simply
   * has no thread association and won't show up under any ThreadDetailResponse.
   * When present, the gateway touches (and, for a still-default-titled
   * thread, auto-titles) the referenced thread -- see store.ts#touchThread.
   */
  threadId?: string;
}

export interface CreateTaskResponse {
  task: TaskSummary;
}

export interface TaskSummary {
  id: string;
  mode: AgentMode;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** Which runner actually served this task — "demo" (always available) or a real model provider's runner name. Never hidden from the caller. */
  runner: string;
  /** The specific model id actually used, when `runner` isn't "demo" — e.g. "qwen/qwen-2.5-coder-32b-instruct:free". Absent for the demo runner, which has no real model behind it. */
  model?: string;
  /**
   * Set only when the requested model (per-task, or the user's default)
   * could not actually be honored — e.g. no API key configured for the
   * requested provider, or Ollama unreachable — explaining exactly what
   * was requested, why it fell back, and what actually ran instead. Absent
   * when the requested (or default, or no-preference-at-all) selection was
   * used as-is. See registry.ts#resolveRunner.
   */
  modelNote?: string;
  /**
   * The project this task's context (if any) was grounded in — copied from
   * CreateTaskRequest.projectContext.projectPath at creation, so the Tasks
   * view can tell whether a build-mode task's ProposedEdit[] apply against
   * whichever project is currently open in the desktop agent (see
   * renderer.js's buildEditsCard) rather than assuming they always match.
   */
  projectPath?: string;
  /** See CreateTaskRequest.threadId. Absent for tasks created without a thread. */
  threadId?: string;
}

export interface TaskStep {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
}

/**
 * A single file-level change proposed by a build-mode task. Always a FULL
 * replacement file body, never a unified diff/patch — the model returns the
 * complete new content for each changed file, and any diff shown to the
 * user is computed client-side purely for review (see renderer.js). This
 * keeps "apply" a plain write instead of a patch-application step that can
 * fail to line up against the file on disk.
 *
 * "modify" is only honored by the desktop agent if the target path already
 * exists; "create" is only honored if it does not — see
 * apps/desktop-agent/src/fsOps.ts#applyEdits. Nothing is ever applied
 * automatically: this type only ever appears as a *proposal* pending
 * explicit user approval (see ApplyEditsRequest in agent.ts).
 */
export interface ProposedEdit {
  /** Project-relative path (never absolute — same convention as FsNode/FsReadResponse). */
  path: string;
  action: "modify" | "create";
  content: string;
}

/**
 * Versioned, model-neutral representation of a generated build response.
 * Providers may use different wire formats (for example MobiusX's marker
 * convention or Ollama's JSON schema mode), but runners normalize them to
 * this envelope before emitting ProposedEdit events.
 */
export const BUILD_RESPONSE_CONTRACT_VERSION = 1 as const;

export interface BuildResponseEnvelope {
  /** A concise user-facing summary; never a claim that checks passed. */
  summary?: string;
  /** Complete replacement file contents, normalized and validated by the gateway. */
  edits: ProposedEdit[];
}

/** Normalized parser result shared by every structured-edit runner. */
export interface ParsedBuildResponse extends BuildResponseEnvelope {
  contractVersion: typeof BUILD_RESPONSE_CONTRACT_VERSION;
  /** Whether a provider-specific structured response boundary was present. */
  hadMarker: boolean;
  /** Number of model-proposed entries rejected by common validation. */
  droppedCount: number;
  /** The response advertised structured output but could not be parsed. */
  parseFailed: boolean;
  /** Paths of rejected modify operations; never includes source contents. */
  rejectedEditPaths?: string[];
}



/**
 * A minimal, real multi-agent primitive (PRD §11/§46): after edits are
 * proposed, a second model call assesses them BEFORE the user decides
 * whether to Apply. Not a second opinion the user has to go request — it's
 * produced automatically alongside the edits, the same way a human
 * reviewer would look at a diff before it merges. The demo runner's
 * version is a clearly-labeled scripted stand-in, same as its demo edits.
 *
 * Roadmap Phase 11 (Multi-Agent Orchestration, source §26/§27) formalized
 * what was originally a single generic "Code Reviewer Agent" persona into
 * named personas with distinct review focus (see AgentPersona below and
 * apps/cloud-agent-gateway/src/runners/personas.ts) — a Database edit is
 * now reviewed by a persona that specifically looks for schema<->ORM
 * drift and destructive-op risk, a Testing edit by one that checks for
 * placeholder assertions and import-convention mismatches, and so on. Real
 * role separation in WHAT gets checked and HOW the reviewer is framed, not
 * (yet) separate concurrent agent processes — one review call per task,
 * same as before this phase, just with a persona-appropriate prompt.
 *
 * Phase 11 also extended this second pass beyond Anthropic to the
 * OpenAI-compatible (openrouter/groq) and Ollama runners (see each
 * runner's own reviewEdits/runPersonaReview call site) — previously a
 * real, documented scope cut ("Known gaps").
 */
export type ReviewVerdict = "approve" | "concerns";

/**
 * Named agent personas (roadmap Phase 11, source §26): formalizes the
 * second-pass Reviewer into distinct identities rather than one generic
 * critic. See apps/cloud-agent-gateway/src/runners/personas.ts for each
 * persona's review focus and PERSONA_MODE_MAP for how an AgentMode task
 * (plus, for "build" mode, a lightweight path-based heuristic over the
 * proposed edits) is classified into one of these. "devops" is reachable
 * since roadmap Phase 14 (DevOps/Infrastructure Generation) shipped its
 * own "devops" AgentMode -- see classifyPersona in personas.ts for the
 * direct 1:1 mapping, and AgentMode's own doc comment for what that mode
 * actually generates.
 */
export type AgentPersona = "architecture" | "database" | "backend" | "frontend" | "api" | "testing" | "devops" | "documentation" | "debugger" | "auth";

export interface EditReview {
  verdict: ReviewVerdict;
  summary: string;
  /** Which named persona produced this review (see AgentPersona above). Optional so an older client/runner response without this field still parses — absence means "unknown persona", never assumed to be any particular one. */
  persona?: AgentPersona;
}

export interface TaskDetail extends TaskSummary {
  steps: TaskStep[];
  /** Accumulated output text so far (final answer / plan / build-proposal text). */
  output: string;
  error?: string;
  /** Present once a build-mode task has finished proposing changes. Empty/absent for ask & plan modes, and for build-mode tasks that didn't produce parseable edits. */
  edits?: ProposedEdit[];
  /** Present once a build-mode task's edits have been through the second-pass Reviewer agent (see EditReview above). Never present without `edits` also being present. */
  review?: EditReview;
  /** Real token usage for this task's model call, when the provider reported it (see TokenUsage above). Absent for the demo runner and for providers/responses that didn't include usage data. */
  usage?: TokenUsage;
  /** Per-request local/cloud model execution diagnostics; sensitive prompts and response bodies are never stored here. */
  modelDiagnostics?: ModelExecutionDiagnostic[];
  /** Durable, per-stage generated draft checkpoint. Files remain proposals until explicit Desktop Agent apply. */
  generationCheckpoint?: GenerationCheckpoint;
}

export interface GenerationCheckpoint {
  version: 1;
  taskId: string;
  requirementsHash: string;
  provider: string;
  modelId: string;
  projectPath?: string;
  completedStageIds: string[];
  stages: Array<{
    id: string;
    completedAt: string;
    artifactPaths: string[];
    /** Full checksummed stage delta. Optional for checkpoints written before P0.2 stage snapshots. */
    artifacts?: Array<{ path: string; action: ProposedEdit["action"]; content: string; sha256: string }>;
    validation: "passed";
  }>;
  artifacts: Array<{ path: string; action: ProposedEdit["action"]; content: string; sha256: string }>;
  /** Explicit ownership/lineage for the active materialized files. Failed
   * attemptedStages are forensic proposals and are never part of this list. */
  artifactOwnership?: {
    schemaVersion: "1.0";
    active: Array<{
      artifactId: string;
      stageId: string;
      path: string;
      sha256: string;
      version: number;
      provenance: "model" | "deterministic" | "repair" | "checkpoint";
      replacesArtifactId?: string;
      replacementAuthorization?: string;
    }>;
    superseded: Array<{
      artifactId: string;
      stageId: string;
      path: string;
      sha256: string;
      version: number;
      provenance: "model" | "deterministic" | "repair" | "checkpoint";
      replacesArtifactId?: string;
      replacementAuthorization?: string;
    }>;
  };
  /** Failed-stage outputs kept for inspection/recovery; never treated as validated promotion artifacts. */
  attemptedStages?: Array<{
    id: string;
    attemptedAt: string;
    validation: "failed";
    issues: string[];
    repairOutcomes: string[];
    /** Content-addressed repair proposals retained across task resumes. */
    repairFingerprints?: Array<{
      fingerprint: string;
      diagnosticHash: string;
      targetPath: string;
      relevantCodeHash: string;
      proposedPatchHash: string;
      outcome: "applied" | "duplicate" | "no-progress";
    }>;
    artifacts: Array<{ path: string; action: ProposedEdit["action"]; content: string; sha256: string }>;
  }>;
  baseFiles: Array<{ path: string; sha256: string }>;
  pendingStageIds: string[];
  pendingDependencies: string[];
  repairHistory: Array<{ stageId: string; attempts: number; outcomes: string[] }>;
  /** Independently validated database-stage outputs. These remain resumable even when the database stage has not passed as a whole. */
  databaseSubtasks?: Array<{
    id: string;
    completedAt: string;
    architectureHash: string;
    artifacts: Array<{ path: string; action: ProposedEdit["action"]; content: string; sha256: string }>;
  }>;
  /** Independently validated backend implementation outputs, resumable without repeating completed modules. */
  backendSubtasks?: Array<{
    id: string;
    completedAt: string;
    architectureHash: string;
    artifacts: Array<{ path: string; action: ProposedEdit["action"]; content: string; sha256: string }>;
  }>;
  /** PAC-validated business operation contracts used by deterministic route scaffolds. */
  businessOperations?: Array<{
    operationId: string;
    architectureHash: string;
    content: string;
    sha256: string;
    createdAt: string;
  }>;
  /** Immutable superseded business-operation versions retained during safe contract upgrades. */
  businessOperationHistory?: Array<{
    operationId: string;
    architectureHash: string;
    content: string;
    sha256: string;
    createdAt: string;
    supersededBySha256: string;
    supersededAt: string;
    reason: string;
  }>;
  /** AI-authored UI intent validated against the PAC and operation contracts; source files are rendered from this resumable spec. */
  uiContracts?: Array<{
    architectureHash: string;
    content: string;
    sha256: string;
    modelId: string;
    createdAt: string;
    /** Compact model-authored choice merged into a deterministic UI contract skeleton. */
    modelRequestId?: string;
    modelResponse?: string;
    contribution?: string;
    contributionSha256?: string;
    /** Privacy-safe provider request provenance; message text is never checkpointed here. */
    requestMetadata?: {
      requestId: string;
      provider: string;
      endpoint: string;
      modelId: string;
      promptSha256: string;
      promptCharacters: number;
      promptBytes?: number;
      estimatedPromptTokens?: number;
      expectedOutputTokens?: number;
      structuredOutputOverheadTokens?: number;
      safetyMarginTokens?: number;
      contextTokens?: number;
      estimatedTotalTokens?: number;
      serializedRequestSha256?: string;
      serializedRequestBytes?: number;
      serializedRequestRedacted?: ModelExecutionDiagnostic["serializedRequestRedacted"];
      startedAt?: string;
      endedAt?: string;
      durationMs?: number;
      timeToHeadersMs?: number;
      timeToFirstTokenMs?: number;
      promptTokens?: number;
      generatedTokens?: number;
      cancelled?: boolean;
      deadlineExceeded?: boolean;
      responseSha256?: string;
      responseCharacters?: number;
    };
  }>;
  /** Versioned, PAC/operation-derived test inventory plus separately attributed model contributions. */
  testSpecifications?: Array<{
    architectureHash: string;
    content: string;
    sha256: string;
    modelId: string;
    createdAt: string;
    modelRequestId?: string;
    modelResponse?: string;
    contribution?: string;
    contributionSha256?: string;
    requestMetadata?: {
      requestId: string;
      provider: string;
      endpoint: string;
      modelId: string;
      promptSha256: string;
      promptCharacters: number;
      promptBytes?: number;
      estimatedPromptTokens?: number;
      expectedOutputTokens?: number;
      structuredOutputOverheadTokens?: number;
      safetyMarginTokens?: number;
      contextTokens?: number;
      estimatedTotalTokens?: number;
      serializedRequestSha256?: string;
      serializedRequestBytes?: number;
      startedAt?: string;
      endedAt?: string;
      durationMs?: number;
      timeToHeadersMs?: number;
      timeToFirstTokenMs?: number;
      promptTokens?: number;
      generatedTokens?: number;
      cancelled?: boolean;
      deadlineExceeded?: boolean;
      responseSha256?: string;
      responseCharacters?: number;
    };
  }>;
  /** Independently executed, resumable test slices. These do not mark the
   * overall tests stage complete; they preserve verified work for incremental
   * test generation and reruns. */
  testSubtasks?: Array<{
    id: string;
    architectureHash: string;
    topologyHash: string;
    completedAt: string;
    artifacts: Array<{ path: string; action: ProposedEdit["action"]; content: string; sha256: string }>;
    validation: {
      pytestCollected: number;
      pytestPassed: number;
      pytestFailed: number;
      pytestSkipped: number;
      playwrightCollected: number;
      playwrightPassed: number;
      playwrightFailed: number;
      playwrightSkipped: number;
    };
    modelContributionRequestId?: string;
  }>;
  /** Immutable, versioned project architecture approved before staged code generation. Optional only for checkpoints created before P0.5. */
  projectArchitecture?: ProjectArchitectureContract;
  updatedAt: string;
}

export interface ProjectArchitectureContract {
  schemaVersion: "1.0" | "1.1";
  contractHash: string;
  stack: { backend: string; orm: string; migrations: string; database: string; frontend: string; e2e: string };
  modules: Array<{ path: string; provides: string[]; dependsOn: string[] }>;
  /** Versioned domain boundary added only through an approved architecture change. */
  reviewScope?: {
    entity: "ReviewScope";
    userField: "review_scope_id";
    customerField: "review_scope_id";
    customerAssignment: "inherit-authenticated-customer";
    managerAccess: "same-scope-only";
    defaultProvisioning: "default-scope";
  };
}

export interface ListTasksResponse {
  tasks: TaskSummary[];
}

/**
 * A conversation thread -- what the desktop "New Chat" / thread-list UI
 * actually operates on. Mirrors store.ts's existing tasks.json persistence
 * pattern exactly (see createThread/getThread/listThreads/touchThread in
 * that file), persisted separately as threads.json. A thread is deliberately
 * thin: it does not itself hold messages or edits -- every real task
 * (TaskDetail, with its own `output`/`edits`/`review`/`usage`) still lives
 * in the existing tasks store, tagged with `threadId`. A thread is just the
 * grouping + display metadata (title, timestamps, which task was most
 * recent) a desktop panel instance needs to show a thread list and to
 * rehydrate one on selection (see ThreadDetailResponse below).
 */
export interface ThreadSummary {
  id: string;
  /**
   * Starts as "New Chat" (desktop-side default, same string the "New Chat"
   * nav item already uses) and is auto-set from the first task's prompt
   * (first ~60 chars) the first time touchThread() sees a task land on a
   * still-default-titled thread -- see store.ts#touchThread. A user-driven
   * rename (RenameThreadRequest) overrides this and is never auto-replaced
   * again.
   */
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The most recent task's id, if any task has been created on this thread yet. Used so a thread list can show "last activity" without a second round-trip. */
  lastTaskId?: string;
  /** The project this thread's tasks are grounded in, when any task on it carried a projectContext -- same semantics as TaskSummary.projectPath, copied from the first task that had one. */
  projectPath?: string;
}

/** Body is optional -- an empty/omitted body creates a thread with the default "New Chat" title, which is what lazy client-side thread creation (first message sent) actually sends. */
export interface CreateThreadRequest {
  title?: string;
}

export interface CreateThreadResponse {
  thread: ThreadSummary;
}

export interface ListThreadsResponse {
  threads: ThreadSummary[];
}

/** GET /threads/:id -- the thread plus its full task history, in creation order, for a desktop panel to rehydrate `historyTurns` and the feed when the user reopens an existing thread. */
export interface ThreadDetailResponse {
  thread: ThreadSummary;
  tasks: TaskDetail[];
}

export interface RenameThreadRequest {
  title: string;
}

/** Streamed over the /tasks/:id/stream WebSocket, and also what GET /tasks/:id's `steps`/`output`/`edits` are built from server-side. */
/**
 * Real token consumption for one task's model call, read back from the
 * provider's own response (never estimated/guessed) -- feature request:
 * "alert the token limits (50%, 75%, 90% consumed) to the user while
 * working". `contextWindow` is a best-effort lookup by model id (see
 * apps/cloud-agent-gateway/src/runners/contextWindows.ts) -- absent when
 * the model isn't in that table, so the UI can honestly show token counts
 * without a made-up percentage rather than compute one against the wrong
 * limit. Absent entirely for the demo runner (no real provider call, so no
 * real usage to report) and for any provider response that didn't include
 * usage data.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow?: number;
}

export type ModelFailureCategory =
  | "connection_refused"
  | "connection_reset"
  | "dns_or_network"
  | "provider_timeout"
  | "stream_idle_timeout"
  | "local_queue_full"
  | "stream_interrupted"
  | "process_terminated"
  | "context_or_resource_exhaustion"
  | "context_budget_exceeded"
  | "provider_http_error"
  | "unknown_network_error";

export interface ModelExecutionDiagnostic {
  requestId: string;
  /** Parent Build/chat task id used to correlate gateway, adapter, and provider logs. */
  taskId?: string;
  attempt?: number;
  provider: string;
  endpoint: string;
  modelId: string;
  phase: "queue" | "connect" | "connected" | "headers" | "stream" | "complete";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  queueWaitMs?: number;
  queuePosition?: number;
  activeRequests?: number;
  maxConcurrency?: number;
  serializedRequestBytes?: number;
  serializedRequestSha256?: string;
  /** Actual Ollama request shape with message text replaced by byte counts and hashes. */
  serializedRequestRedacted?: {
    model: string;
    keepAlive?: string;
    stream: boolean;
    format?: unknown;
    options?: Record<string, string | number | boolean>;
    messages: Array<{ role: string; contentBytes: number; contentSha256: string }>;
  };
  /** Present only when restricted Ollama request capture was explicitly enabled. */
  serializedRequestCapturePath?: string;
  serializedRequestCaptureError?: string;
  /** Present only when restricted raw-response capture was explicitly enabled. */
  responseCapturePath?: string;
  responseCaptureError?: string;
  queueStartedAt?: string;
  transportStartedAt?: string;
  connectedAt?: string;
  headersAt?: string;
  firstTokenAt?: string;
  streamEndedAt?: string;
  streamIdleTimeoutMs?: number;
  maxObservedStreamIdleMs?: number;
  streamIdleTimedOut?: boolean;
  timeToHeadersMs?: number;
  timeToConnectMs?: number;
  responseHeaderWaitMs?: number;
  timeToFirstTokenMs?: number;
  promptChars?: number;
  estimatedPromptTokens?: number;
  promptTokens?: number;
  generatedTokens?: number;
  /** Approximate generated-token count from streamed text when the request ended before Ollama's final usage record. */
  estimatedGeneratedTokens?: number;
  contextLength?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** Time beyond the configured deadline before the request was observed as terminal. */
  deadlineOverrunMs?: number;
  ollamaLoadDurationMs?: number;
  promptEvaluationDurationMs?: number;
  generationDurationMs?: number;
  providerTotalDurationMs?: number;
  /** CPU/memory sample for the active local Ollama inference process, if the host exposes ps. */
  ollamaProcessCpuPercent?: number;
  ollamaCpuSeconds?: number;
  resourceSampleDurationMs?: number;
  ollamaProcessRssBytes?: number;
  /** macOS system-wide free-memory percentage when `memory_pressure` is available. */
  hostMemoryFreePercent?: number;
  hostMemoryFreePercentAtStart?: number;
  /** GPU memory allocated by Ollama; zero indicates CPU-only execution. */
  ollamaVramBytes?: number;
  /** Gateway-side scheduling/CPU metrics help distinguish a slow model from a stalled event loop. */
  eventLoopDelayMaxMs?: number;
  gatewayCpuUserMs?: number;
  gatewayCpuSystemMs?: number;
  processMemoryBytes?: number;
  responseBytes: number;
  streaming: boolean;
  httpStatus?: number;
  errorCategory?: ModelFailureCategory;
  errorMessage?: string;
  errorCause?: string;
  cancelled: boolean;
  deadlineExceeded: boolean;
  retryHistory: string[];
}

export type TaskEvent =
  | { type: "step"; step: TaskStep }
  | { type: "output"; delta: string }
  | { type: "edits"; edits: ProposedEdit[]; contractVersion?: typeof BUILD_RESPONSE_CONTRACT_VERSION }
  | { type: "review"; review: EditReview }
  | { type: "status"; status: TaskStatus }
  | { type: "usage"; usage: TokenUsage }
  | { type: "model_diagnostic"; diagnostic: ModelExecutionDiagnostic }
  | { type: "generation_checkpoint"; checkpoint: GenerationCheckpoint }
  | { type: "error"; message: string }
  | { type: "provider_failure"; message: string }
  | { type: "done" };

/**
 * Voice input for the AI Assistant's prompt box (an "add-on" input method,
 * not a replacement for typing) — see apps/cloud-agent-gateway/src/voice.ts
 * for the actual transcription call (Groq's hosted Whisper endpoint, reusing
 * GROQ_API_KEY rather than a dedicated new provider/key). Electron doesn't
 * ship Chrome's built-in SpeechRecognition web service, so this is a real
 * server round-trip: the renderer records with MediaRecorder, base64-encodes
 * the blob, and POSTs it here rather than relying on the browser's Web
 * Speech API (unreliable/non-functional in Electron — see renderer.js's
 * voice-input block for the full reasoning).
 */
export interface TranscribeRequest {
  /** Base64-encoded audio data (no "data:" URL prefix). */
  audio: string;
  /** MediaRecorder's mimeType for the captured clip, e.g. "audio/webm". */
  mimeType: string;
}

export interface TranscribeResponse {
  text: string;
}

/** GET /transcribe/status — lets the renderer show/enable the mic button only when it will actually work, same honest-availability pattern as ModelOption.available. */
export interface TranscribeAvailabilityResponse {
  available: boolean;
  /** Present when unavailable, e.g. "requires GROQ_API_KEY". */
  reason?: string;
}
