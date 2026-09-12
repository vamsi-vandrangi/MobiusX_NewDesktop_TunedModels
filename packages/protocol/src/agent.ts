/**
 * Desktop <-> Local Agent contract (HTTP + WebSocket).
 *
 * The Local Agent Service (apps/desktop-agent) runs on 127.0.0.1 only and is
 * paired with the Electron shell via a per-launch bearer token (see
 * AgentHandshake). Nothing here is exposed to the network.
 */

import type { PolicyMatch } from "./governance.js";
import type { ProposedEdit } from "./cloud.js";

export interface AgentHandshake {
  /** Port the agent is listening on (loopback only). */
  port: number;
  /** Bearer token the shell must send as `Authorization: Bearer <token>`. */
  token: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  activeProject: string | null;
}

export interface OpenProjectRequest {
  path: string;
}

export interface OpenProjectResponse {
  path: string;
  isGitRepo: boolean;
  fileCount: number;
}

export interface FsNode {
  name: string;
  path: string; // relative to project root
  type: "file" | "dir";
  size?: number;
}

export interface FsTreeResponse {
  root: string;
  nodes: FsNode[];
}

export interface FsReadResponse {
  path: string;
  content: string;
  truncated: boolean;
}

export interface GitStatusEntry {
  path: string;
  index: string; // porcelain v1 staged status code
  worktree: string; // porcelain v1 unstaged status code
}

export interface GitStatusResponse {
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitLogResponse {
  entries: GitLogEntry[];
}

export interface GitDiffRequest {
  path: string;
  staged?: boolean;
}

export interface GitDiffResponse {
  path: string;
  diff: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/**
 * Body of POST /fs/apply-edits — the ONLY path by which generated code ever
 * reaches disk, and only ever in response to the user clicking "Apply" on a
 * reviewed set of ProposedEdit entries (see cloud.ts). The desktop agent
 * re-validates every edit itself (path-traversal guard, modify-must-exist /
 * create-must-not-exist, a flag-only secret scan) rather than trusting that
 * the caller already did — see apps/desktop-agent/src/fsOps.ts#applyEdits.
 */
export interface ApplyEditsRequest {
  edits: ProposedEdit[];
}

export interface AppliedEditResult {
  path: string;
  action: "modify" | "create";
  status: "applied" | "skipped";
  /** Present when status is "skipped" — e.g. "file already exists" for a create, "file not found" for a modify, "path escapes project root", or "possible secret-shaped content — review manually". */
  reason?: string;
}

export interface ApplyEditsResponse {
  results: AppliedEditResult[];
}

/**
 * Messages sent from the renderer, over the /terminal WebSocket, to the
 * agent. A real PTY session (see apps/desktop-agent/src/terminalWs.ts) is
 * raw byte pass-through, not request/response commands: "input" carries
 * exactly what the user typed (including control characters — Ctrl+C,
 * arrow keys, etc. arrive as their usual escape sequences), and "resize"
 * keeps the PTY's own notion of terminal size in sync with the panel so
 * full-screen programs (vim, htop, a REPL) render correctly.
 */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Messages sent from the agent back to the renderer over /terminal. */
export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal?: number }
  | { type: "error"; message: string }
  /** A submitted command line matched a Phase 5 command-guard rule (see apps/desktop-agent/src/policy.ts) — sent alongside a best-effort interrupt, not a block; the command may already be running. */
  | { type: "policy"; matches: PolicyMatch[] };
