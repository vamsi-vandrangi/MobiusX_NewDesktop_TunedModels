/**
 * Desktop <-> Local Agent contract (HTTP + WebSocket).
 *
 * The Local Agent Service (apps/desktop-agent) runs on 127.0.0.1 only and is
 * paired with the Electron shell via a per-launch bearer token (see
 * AgentHandshake). Nothing here is exposed to the network.
 */

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
  | { type: "error"; message: string };
