/**
 * Phase 5 (local-reference slice): shared types for the desktop agent's
 * terminal "command guard" and the cloud gateway's secret scan/redaction,
 * plus the shared audit log both write to.
 *
 * IMPORTANT framing — read before wiring more enforcement on top of this:
 * this is a single-user, local, advisory layer, not enterprise policy
 * management. There is no multi-tenant auth, no centrally-pushed org
 * policy, and — for the terminal guard specifically — no hard sandboxing
 * of the user's own shell (see apps/desktop-agent/src/policy.ts's doc
 * comment for exactly why that's not achievable without breaking terminal
 * interactivity, and why it's honest to say so rather than imply this is
 * a real security boundary). See docs/ARCHITECTURE.md §8/§12 and the root
 * README for how this fits the bigger picture.
 */

export interface PolicyRule {
  id: string;
  description: string;
  /** Source string for a RegExp (not a RegExp instance — needs to survive JSON/file storage). */
  pattern: string;
}

export interface PolicyMatch {
  ruleId: string;
  description: string;
}

export interface EffectivePolicyResponse {
  builtIn: PolicyRule[];
  project: PolicyRule[];
  /** Absolute path to the project's .mobiusx/policy.json, or null if none is open/none exists. */
  projectPolicyPath: string | null;
  /** Set when a project policy file exists but couldn't be used (malformed JSON, bad regex, wrong shape) — the file is ignored entirely rather than partially applied, and this says why. */
  projectPolicyError: string | null;
}

export type AuditCategory = "terminal-command-guard" | "secret-redaction" | "applied-edits" | "verification" | "project-created" | "preview-started" | "browser-validation" | "hook-run" | "mcp-tool-call" | "knowledge-index" | "error-intelligence" | "checkpoint-created" | "checkpoint-restored" | "security-scan" | "ticket-investigation" | "git-commit" | "git-push";
export type AuditSeverity = "info" | "warning";

export interface AuditEntry {
  id: string;
  timestamp: string;
  source: "desktop-agent" | "cloud-agent-gateway";
  category: AuditCategory;
  severity: AuditSeverity;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface AuditLogResponse {
  entries: AuditEntry[];
}
