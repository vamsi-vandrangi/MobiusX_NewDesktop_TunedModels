/**
 * Desktop <-> Local Agent contract (HTTP + WebSocket).
 *
 * The Local Agent Service (apps/desktop-agent) runs on 127.0.0.1 only and is
 * paired with the Electron shell via a per-launch bearer token (see
 * AgentHandshake). Nothing here is exposed to the network.
 */

import type { PolicyMatch } from "./governance.js";
import type { ModelSelection, ProposedEdit } from "./cloud.js";

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
 * GET/PUT /settings — desktop-agent-wide, single-user configuration (PRD
 * §34-35, "Approval Engine" / configurable autonomy levels), also shared
 * (read-only) with apps/cloud-agent-gateway for `defaultModel` — see
 * packages/agent-settings, the small shared package both apps use to read
 * and write the same `~/.mobiusx/settings.json` file so a single Settings
 * screen change is visible to both processes without needing IPC between
 * them. Kept deliberately small: a handful of real, working controls
 * rather than a menu of settings that don't do anything yet.
 */
export interface AgentSettings {
  /**
   * Terminal command-guard autonomy level. "off" (default) is today's
   * reactive-only behavior — a flagged command still runs, interrupted
   * only best-effort after the fact (see policy.ts). "guarded" holds a
   * flagged line's terminating keystroke and requires an explicit
   * Approve/Reject (see the new TerminalClientMessage variants below)
   * before it ever reaches the shell — see terminalWs.ts for exactly
   * what "hold" means and its limits. Read once per terminal
   * connection: changing this takes effect on the NEXT terminal
   * connection, not retroactively on one already open.
   */
  terminalApprovalMode: "off" | "guarded";
  /**
   * Standing default model for AI Assistant tasks (multi-model support —
   * Llama/Qwen2.5-Coder/DeepSeek via OpenRouter or Groq, or a local Ollama
   * install, alongside Anthropic). Absent means "let the gateway choose
   * automatically" (see apps/cloud-agent-gateway/src/runners/registry.ts).
   * A per-task selection in the AI Assistant panel overrides this for that
   * one task without changing the standing default. Set via PUT /settings
   * on the desktop agent — the cloud gateway only ever reads this file, it
   * never writes to it.
   */
  defaultModel?: ModelSelection;
}

/**
 * Body/response of POST /verify — "Verification Engine" (PRD §22): runs
 * the OPEN PROJECT's own verification scripts (from its package.json —
 * never commands the AI invents) and reports real pass/fail evidence, not
 * a claim. This is deliberately narrow for v1: root package.json `scripts`
 * only (a known limitation for monorepos — see
 * apps/desktop-agent/src/verify.ts#detectVerificationSteps), run via
 * `npm run <script>`, each with a bounded timeout and bounded captured
 * output. No request body is needed — it always verifies whichever
 * project is currently open (see projectState in desktop-agent).
 */
export interface VerificationStep {
  id: string;
  /** Human label, e.g. "Build (npm run build)". */
  label: string;
  /** The exact command that was run. */
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  /** Combined stdout+stderr, bounded — see `truncated`. */
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface VerifyResponse {
  projectPath: string;
  /** "no-verification-available" means no known script (build/test/typecheck/lint) was found in package.json — not a failure, just nothing to run. */
  overall: "passed" | "failed" | "no-verification-available";
  steps: VerificationStep[];
}

/**
 * Messages sent from the renderer, over the /terminal WebSocket, to the
 * agent. A real PTY session (see apps/desktop-agent/src/terminalWs.ts) is
 * raw byte pass-through, not request/response commands: "input" carries
 * exactly what the user typed (including control characters — Ctrl+C,
 * arrow keys, etc. arrive as their usual escape sequences), and "resize"
 * keeps the PTY's own notion of terminal size in sync with the panel so
 * full-screen programs (vim, htop, a REPL) render correctly.
 *
 * "approve"/"reject" only mean anything while AgentSettings.terminalApprovalMode
 * is "guarded" AND the server has a held command awaiting a decision (a
 * "policy" message arrived with requiresApproval: true) — see
 * terminalWs.ts. Sent with no other payload since there is at most one
 * pending decision per connection.
 */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "approve" }
  | { type: "reject" };

/** Messages sent from the agent back to the renderer over /terminal. */
export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal?: number }
  | { type: "error"; message: string }
  /**
   * A submitted command line matched a Phase 5 command-guard rule (see
   * apps/desktop-agent/src/policy.ts). When `requiresApproval` is absent
   * or false (the "off" autonomy level, or guard-matches that aren't
   * gated), this is purely informational — sent alongside a best-effort
   * interrupt, the command may already be running. When `requiresApproval`
   * is true (the "guarded" autonomy level), the command's terminating
   * keystroke has been HELD, not yet sent to the shell — the renderer
   * must send back "approve" or "reject" for it to be resolved.
   */
  | { type: "policy"; matches: PolicyMatch[]; requiresApproval?: boolean };
