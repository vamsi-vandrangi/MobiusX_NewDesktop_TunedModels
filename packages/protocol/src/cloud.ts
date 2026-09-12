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

export type AgentMode = "ask" | "plan" | "build";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ProjectContext {
  projectPath?: string;
  /** Optional relevant-code hints, e.g. top hits from a Phase 2 /debug/search — keeps the cloud call grounded in local context without shipping the whole repo. */
  relevantFiles?: { relPath: string; snippet: string }[];
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
}

export interface TaskStep {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "completed";
  startedAt?: string;
  completedAt?: string;
}

export interface TaskDetail extends TaskSummary {
  steps: TaskStep[];
  /** Accumulated output text so far (final answer / plan / build-proposal text). */
  output: string;
  error?: string;
}

export interface ListTasksResponse {
  tasks: TaskSummary[];
}

/** Streamed over the /tasks/:id/stream WebSocket, and also what GET /tasks/:id's `steps`/`output` are built from server-side. */
export type TaskEvent =
  | { type: "step"; step: TaskStep }
  | { type: "output"; delta: string }
  | { type: "status"; status: TaskStatus }
  | { type: "error"; message: string }
  | { type: "done" };
