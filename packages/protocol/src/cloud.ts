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

import type { ArchitectureEvidence, TestingEvidence } from "./agent.js";

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
export type AgentMode = "ask" | "plan" | "build" | "spec" | "fix" | "database" | "architecture" | "testing";

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
 * Two providers are deliberately excluded from automatic selection
 * (registry.ts's AUTO_PRIORITY) and only ever run when explicitly chosen:
 * "ollama" (local-only, depends on a background process happening to be
 * running on the user's machine) and "deepseek" (a paid, metered API —
 * DeepSeek's own platform.deepseek.com, not free like openrouter/groq's
 * current lineups — so using it should always be an explicit choice, never
 * a silent fallback that starts charging the user's account).
 */
export type ModelProvider = "demo" | "anthropic" | "openrouter" | "groq" | "deepseek" | "ollama";

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
  /** See HistoryTurn's doc comment. Omit (or send []) for a fresh, contextless request. */
  history?: HistoryTurn[];
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
}

export interface TaskStep {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed";
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
 * A minimal, real multi-agent primitive (PRD §11/§46): after build-mode
 * edits are proposed, a second model call (a distinct "Code Reviewer
 * Agent" persona — see anthropicRunner.ts's reviewEdits) assesses them
 * BEFORE the user decides whether to Apply. Not a second opinion the user
 * has to go request — it's produced automatically alongside the edits,
 * the same way a human reviewer would look at a diff before it merges.
 * The demo runner's version is a clearly-labeled scripted stand-in, same
 * as its demo edits.
 *
 * Currently only the anthropic runner performs this second pass — the
 * newer free-model runners (openrouter/groq/ollama) propose edits without
 * one. This is a real, known scope cut, not a silent omission — see each
 * runner's module doc comment and apps/cloud-agent-gateway/README.md's
 * "Known gaps".
 */
export type ReviewVerdict = "approve" | "concerns";

export interface EditReview {
  verdict: ReviewVerdict;
  summary: string;
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
}

export interface ListTasksResponse {
  tasks: TaskSummary[];
}

/** Streamed over the /tasks/:id/stream WebSocket, and also what GET /tasks/:id's `steps`/`output`/`edits` are built from server-side. */
export type TaskEvent =
  | { type: "step"; step: TaskStep }
  | { type: "output"; delta: string }
  | { type: "edits"; edits: ProposedEdit[] }
  | { type: "review"; review: EditReview }
  | { type: "status"; status: TaskStatus }
  | { type: "error"; message: string }
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
