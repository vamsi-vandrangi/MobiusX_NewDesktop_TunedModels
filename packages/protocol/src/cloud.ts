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

export interface CreateTaskRequest {
  mode: AgentMode;
  prompt: string;
  projectContext?: ProjectContext;
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
  /** Which runner actually served this task — "demo" (always available) or a real model runner name. Never hidden from the caller. */
  runner: string;
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

export interface TaskDetail extends TaskSummary {
  steps: TaskStep[];
  /** Accumulated output text so far (final answer / plan / build-proposal text). */
  output: string;
  error?: string;
  /** Present once a build-mode task has finished proposing changes. Empty/absent for ask & plan modes, and for build-mode tasks that didn't produce parseable edits. */
  edits?: ProposedEdit[];
}

export interface ListTasksResponse {
  tasks: TaskSummary[];
}

/** Streamed over the /tasks/:id/stream WebSocket, and also what GET /tasks/:id's `steps`/`output`/`edits` are built from server-side. */
export type TaskEvent =
  | { type: "step"; step: TaskStep }
  | { type: "output"; delta: string }
  | { type: "edits"; edits: ProposedEdit[] }
  | { type: "status"; status: TaskStatus }
  | { type: "error"; message: string }
  | { type: "done" };
