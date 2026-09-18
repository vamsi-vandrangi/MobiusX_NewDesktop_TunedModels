import type { RootCauseCategory, TraceEvidence, KnowledgeSearchHit } from "./agent.js";

/**
 * Intelligent Debugger (Phase 2) contract.
 *
 * Scope, honestly: this is *static* code intelligence — semantic-ish code
 * search (chunker + local hashing embeddings from @mobiusx/semantic-index)
 * correlated with git history for the files that turn up. It does not read
 * live logs, traces, or metrics from a running system — that needs real
 * observability integration and MobiusX Cloud (Phase 3). Treat results here
 * as "code + history worth looking at," not an automated root-cause verdict.
 */

export interface DebugIndexResponse {
  provider: string;
  filesConsidered: number;
  filesChunked: number;
  filesRemoved: number;
  chunksIndexed: number;
  totalChunksInStore: number;
  durationMs: number;
}

export interface DebugSearchHit {
  relPath: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface DebugSearchResponse {
  hits: DebugSearchHit[];
  provider: string;
  durationMs: number;
  storeSize: number;
  indexedJustNow: boolean;
}

export interface DebugHistoryEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface DebugHistoryResponse {
  path: string;
  entries: DebugHistoryEntry[];
}

// ============================================================
// X-Debug & Fix: paste a JIRA/Service Desk ticket, get it investigated
// against THIS project's own real evidence, then generate a fix.
//
// Scope, honestly: this does NOT call out to Jira/Service Desk -- the
// developer copies the ticket's text in (title, description, comments,
// any pasted error/stack trace). There is no live ticket-system
// integration, no distributed tracing across other services, and no
// enterprise dependency graph -- see docs/phase-notes for the fuller
// scope discussion. What this DOES do: reuse the exact same real
// evidence sources Phase 13's classifyStep already correlates (detected
// routes, ORM entities, the running preview's own backend log when one
// happens to be running) plus a semantic-search pass over the ticket's
// own text against this project's code and the user's configured
// Enterprise Knowledge docs, so a diagnosis is grounded in this specific
// project, not generic advice.
// ============================================================

/**
 * Structured signals extracted from a developer's pasted ticket text.
 * Every field is either null/empty (nothing found) or something that was
 * actually matched in the raw text -- `mentionedFile`, in particular, is
 * only ever populated when the extracted path was confirmed to exist on
 * this project's own disk, the same "never cite an unverified path"
 * discipline errorIntelligence.ts's resolveFrontendHint already applies.
 */
export interface ParsedTicket {
  ticketId: string | null;
  title: string | null;
  rawText: string;
  /** An HTTP method + path mentioned in the ticket text (a "GET /api/foo" line, a curl command, or a pasted URL). `method` is "HANDLER" when a path was found but no verb was stated -- same honest convention DetectedRoute uses for a file-based route whose verb can't be determined statically. */
  mentionedRoute: { method: string; path: string } | null;
  /** A well-known HTTP status code mentioned near an error/status/fail-shaped word in the same line -- conservative on purpose, to avoid matching an unrelated three-digit number (a line number, a port, a ticket number). */
  mentionedStatusCode: number | null;
  /** A Python traceback or JS stack trace pasted directly in the ticket text, if the reporter included one -- same recognized shapes as errorIntelligence.ts's extractRecentBackendTraceback, reused directly against the ticket's own text. */
  pastedTraceback: string[] | null;
  /** A project-relative file path mentioned in the ticket text AND confirmed to exist on disk right now. */
  mentionedFile: { relPath: string; line?: number } | null;
}

/** A real semantic-search hit (see @mobiusx/semantic-index) for the ticket's own text against this project's code -- always attempted regardless of classification outcome, so even an "insufficient-evidence" result still gives the developer real leads. */
export interface TicketRelevantFile {
  relPath: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

/**
 * RootCauseCategory (from Phase 13) plus one ticket-specific honest
 * outcome: a pasted ticket, unlike a live Browser Validation failure,
 * often just doesn't contain enough structured signal (no error text, no
 * endpoint, no file) for this project's own static evidence to
 * corroborate anything -- "insufficient-evidence" reports that plainly,
 * together with exactly what's missing, rather than force-fitting into
 * one of Phase 13's categories or guessing.
 */
export type TicketRootCauseCategory = RootCauseCategory | "insufficient-evidence";

/** Request body of POST /debug/ticket-investigate. */
export interface TicketInvestigateRequest {
  ticketText: string;
}

/** Body of POST /debug/ticket-investigate. One investigation per pasted ticket -- see ParsedTicket/TraceEvidence's doc comments for what's real vs. honestly absent here. */
export interface TicketInvestigationReport {
  ticket: ParsedTicket;
  generatedAt: string;
  category: TicketRootCauseCategory;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  evidence: TraceEvidence[];
  relevantFiles: TicketRelevantFile[];
  knowledgeHits: KnowledgeSearchHit[];
  /** True only when a live preview happened to be running and its current backend log was actually used as corroborating evidence -- never true when nothing live was checked. */
  livePreviewCorroboration: boolean;
}
