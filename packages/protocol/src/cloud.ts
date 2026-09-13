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

/**
 * "spec" (PRD §8, Requirements Engineering) reuses the exact same
 * propose-edits/review/apply pipeline "build" uses — a generated spec is
 * just a markdown file under `.mobiusx/specs/` proposed as a `create`
 * ProposedEdit, so it goes through the same diff review and explicit
 * Apply step as any other AI-generated file (see taskEngine.ts,
 * anthropicRunner.ts's MODES_WITH_STRUCTURED_EDITS, and
 * apps/desktop-agent/src/fsOps.ts#applyEdits). It never touches existing
 * code — only ever proposes a brand-new spec file.
 */
export type AgentMode = "ask" | "plan" | "build" | "spec";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * Multi-model support: this gateway can route a task to more than one
 * model provider, not just Anthropic — including free-tier open-weight
 * models (Llama, Qwen2.5-Coder, DeepSeek), so the user can pick a model
 * the way Claude/Cursor's own UIs let you, either as a standing default
 * (AgentSettings.defaultModel in agent.ts) or per task (CreateTaskRequest.model
 * below). See apps/cloud-agent-gateway/src/runners/registry.ts#resolveRunner
 * for exactly how a requested selection is honored or — visibly, never
 * silently — substituted.
 *
 * "ollama" is local-only (no API key, talks to a local Ollama install) and
 * is deliberately never auto-selected — see registry.ts's AUTO_PRIORITY
 * comment for why. It only ever runs when explicitly chosen.
 */
export type ModelProvider = "demo" | "anthropic" | "openrouter" | "groq" | "ollama";

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

export interface ProjectContext {
  projectPath?: string;
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
