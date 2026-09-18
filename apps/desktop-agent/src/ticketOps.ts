import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ArchitectureEvidence,
  KnowledgeSearchHit,
  ParsedTicket,
  TicketInvestigationReport,
  TicketRelevantFile,
  TicketRootCauseCategory,
  TraceEvidence,
} from "@mobiusx/protocol";
import { gatherArchitectureEvidence } from "./architectureContext.js";
import { getPreviewStatus } from "./previewOps.js";
import { searchSemanticIndex, buildSemanticIndex } from "./semanticOps.js";
import { searchKnowledge } from "./knowledgeOps.js";
import { extractRecentBackendTraceback, backendTracebackMentionsDb, findMatchingRoute, pathsMatch } from "./errorIntelligence.js";

/**
 * X-Debug & Fix (extends Phase 2/13's Debug view -- see @mobiusx/protocol's
 * debug.ts for the full scope note). A developer pastes a JIRA/Service
 * Desk ticket's raw text; this module extracts whatever structured
 * signal that text actually contains (a route, a status code, a pasted
 * traceback, a file path) and correlates it against this project's own
 * real evidence -- the exact same sources errorIntelligence.ts's
 * classifyStep already uses -- rather than sending the raw ticket text to
 * a model and hoping. A semantic-search pass and an Enterprise Knowledge
 * search always run too, regardless of what structured signal was found,
 * so even a vague ticket still returns real, ranked leads.
 *
 * This deliberately never talks to Jira/Service Desk itself. There is no
 * ticket-system credential, no API call out, no webhook -- the developer
 * copies the text in, same as they would into any other text box in this
 * app. Extending this to fetch a ticket live by ID would be a real,
 * separate feature (a new integration + credential UI), not this one.
 */

const TICKET_ID_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;
const TITLE_LABEL_RE = /^\s*(?:summary|title|subject)\s*:\s*(.+)$/im;
const ROUTE_WITH_VERB_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s'")]*)/i;
// A bare path or URL, used only when no explicit verb was found nearby --
// method is reported as "HANDLER" (the same honest "verb unknown" convention
// DetectedRoute already uses for a file-based route that can't be
// statically determined), never guessed as GET.
const BARE_PATH_RE = /(?:https?:\/\/[^\s/'")]+)?(\/[a-zA-Z0-9_\-/{}.]*[a-zA-Z0-9_\-/{}])/;
const KNOWN_HTTP_STATUSES = new Set([400, 401, 402, 403, 404, 405, 408, 409, 422, 429, 500, 501, 502, 503, 504]);
// Broad enough to catch how a developer actually phrases this in a ticket
// ("returns a 404", "getting a 500", "responds with 403") without matching
// an unrelated three-digit number that happens to share a line with
// neither an error word nor a response-shaped verb.
const STATUS_CONTEXT_RE = /error|status|code|fail|exception|http|respon|return|getting|gives?\b|seeing/i;
// A project-relative file path with a recognized source extension,
// optionally followed by ":line". Broader than errorIntelligence.ts's
// FRONTEND_HINT_RE (JS/TS-only) since a ticket can reference any backend
// language this platform generates code in.
const FILE_MENTION_RE = /\b([\w./-]+\.(?:[jt]sx?|py|java|go|rb|php|cs))(?::(\d+))?\b/;

function findStatusCode(text: string): number | null {
  for (const line of text.split("\n")) {
    const m = line.match(/\b(\d{3})\b/);
    if (m && KNOWN_HTTP_STATUSES.has(Number(m[1])) && STATUS_CONTEXT_RE.test(line)) {
      return Number(m[1]);
    }
  }
  return null;
}

function findMentionedRoute(text: string): { method: string; path: string } | null {
  const withVerb = text.match(ROUTE_WITH_VERB_RE);
  if (withVerb) return { method: withVerb[1].toUpperCase(), path: withVerb[2] };
  const bare = text.match(BARE_PATH_RE);
  if (bare && bare[1].length > 1) return { method: "HANDLER", path: bare[1] };
  return null;
}

function findMentionedFile(text: string, projectPath: string): { relPath: string; line?: number } | null {
  // Scan every match, not just the first -- a ticket's stack trace often
  // has the real source file several lines in, after framework noise.
  const re = new RegExp(FILE_MENTION_RE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const relPath = m[1];
    if (existsSync(join(projectPath, relPath))) {
      return { relPath, line: m[2] ? Number(m[2]) : undefined };
    }
  }
  return null;
}

function findTitle(rawText: string, ticketId: string | null): string | null {
  const labeled = rawText.match(TITLE_LABEL_RE);
  if (labeled) return labeled[1].trim().slice(0, 200);
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ticketId && trimmed === ticketId) continue;
    return trimmed.slice(0, 200);
  }
  return null;
}

/** Pure parser -- no I/O of its own beyond the one existsSync check for a mentioned file, so it's directly unit-testable with constructed ticket text. */
export function parseTicketText(rawText: string, projectPath: string): ParsedTicket {
  const idMatch = rawText.match(TICKET_ID_RE);
  const ticketId = idMatch ? idMatch[1] : null;
  return {
    ticketId,
    title: findTitle(rawText, ticketId),
    rawText,
    mentionedRoute: findMentionedRoute(rawText),
    mentionedStatusCode: findStatusCode(rawText),
    pastedTraceback: extractRecentBackendTraceback(rawText.split("\n")),
    mentionedFile: findMentionedFile(rawText, projectPath),
  };
}

interface Classification {
  category: TicketRootCauseCategory;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  evidence: TraceEvidence[];
  livePreviewCorroboration: boolean;
}

/** Pure classifier -- no I/O, takes already-gathered evidence so it's unit-testable without a real project or running preview. Mirrors errorIntelligence.ts#classifyStep's evidence-first discipline: every category is reached only through a specific, cited combination of real evidence, and "insufficient-evidence" is the honest default when the ticket text itself doesn't contain enough to say more. */
export function classifyTicket(ticket: ParsedTicket, evidence: ArchitectureEvidence, backendLog: string[]): Classification {
  const traceEvidence: TraceEvidence[] = [
    { layer: "ticket", label: ticket.title ?? ticket.ticketId ?? "Pasted ticket", detail: ticket.rawText.slice(0, 1500) },
  ];

  // 1. A traceback pasted directly in the ticket is the strongest signal
  // available -- attribute it exactly like errorIntelligence.ts attributes
  // a live-captured one.
  if (ticket.pastedTraceback) {
    traceEvidence.push({ layer: "backend", label: "Traceback pasted in the ticket", detail: ticket.pastedTraceback.join("\n") });
    const dbRelated = backendTracebackMentionsDb(ticket.pastedTraceback, evidence);
    if (dbRelated) {
      const tbLower = ticket.pastedTraceback.join("\n").toLowerCase();
      const entity = evidence.database.ormEntities.find((e) => tbLower.includes(e.name.toLowerCase()) || tbLower.includes(e.tableName.toLowerCase()));
      if (entity) {
        traceEvidence.push({
          layer: "database",
          label: entity.name,
          detail: `ORM entity referenced in the pasted traceback, mapped to table "${entity.tableName}".`,
          source: entity.source,
          line: entity.line,
        });
      }
      return {
        category: "backend-error-db-layer",
        confidence: "high",
        reasoning: `The ticket includes a traceback that references the database layer${entity ? ` (the "${entity.name}" model)` : ""}.`,
        evidence: traceEvidence,
        livePreviewCorroboration: false,
      };
    }
    return {
      category: "backend-error-logic",
      confidence: "high",
      reasoning: "The ticket includes a traceback, and it doesn't reference any database entity this project actually has -- pointing at application logic rather than the database layer.",
      evidence: traceEvidence,
      livePreviewCorroboration: false,
    };
  }

  // 2. A mentioned route -- correlate against this project's own real
  // detected routes, the same matching errorIntelligence.ts uses.
  if (ticket.mentionedRoute) {
    const { method, path } = ticket.mentionedRoute;
    const route = method === "HANDLER" ? evidence.routes.find((r) => pathsMatch(r.path, path)) ?? null : findMatchingRoute(evidence.routes, method, path);
    if (!route) {
      const known = evidence.routes.map((r) => `${r.method} ${r.path}`);
      traceEvidence.push({
        layer: "api",
        label: `${method === "HANDLER" ? "" : method + " "}${path}`,
        detail: `No backend route matches ${path} in this project.${known.length > 0 ? ` Closest known routes: ${known.slice(0, 5).join(", ")}.` : " No backend routes were detected in this project at all."}`,
      });
      return {
        category: "route-not-implemented",
        confidence: "high",
        reasoning: `The ticket references ${path}, but no backend route matching that path exists anywhere in this project's own code.`,
        evidence: traceEvidence,
        livePreviewCorroboration: false,
      };
    }
    traceEvidence.push({ layer: "api", label: `${route.method} ${route.path}`, detail: "Matched a real backend route in this project.", source: route.source, line: route.line });

    if (ticket.mentionedStatusCode && ticket.mentionedStatusCode >= 500) {
      const traceback = extractRecentBackendTraceback(backendLog);
      if (traceback) {
        traceEvidence.push({ layer: "backend", label: "Live backend process output", detail: traceback.join("\n") });
        const dbRelated = backendTracebackMentionsDb(traceback, evidence);
        if (dbRelated) {
          const tbLower = traceback.join("\n").toLowerCase();
          const entity = evidence.database.ormEntities.find((e) => tbLower.includes(e.name.toLowerCase()) || tbLower.includes(e.tableName.toLowerCase()));
          if (entity) traceEvidence.push({ layer: "database", label: entity.name, detail: `ORM entity referenced in the live traceback, mapped to table "${entity.tableName}".`, source: entity.source, line: entity.line });
          return {
            category: "backend-error-db-layer",
            confidence: "high",
            reasoning: `${route.method} ${route.path} (${route.source}:${route.line}) matches the ticket's ${ticket.mentionedStatusCode}, and the currently-running preview's own backend log shows a real traceback at this moment referencing the database layer${entity ? ` (the "${entity.name}" model)` : ""}.`,
            evidence: traceEvidence,
            livePreviewCorroboration: true,
          };
        }
        return {
          category: "backend-error-logic",
          confidence: "high",
          reasoning: `${route.method} ${route.path} (${route.source}:${route.line}) matches the ticket's ${ticket.mentionedStatusCode}, and the currently-running preview's own backend log shows a real traceback at this moment, not related to any known database entity.`,
          evidence: traceEvidence,
          livePreviewCorroboration: true,
        };
      }
      return {
        category: "backend-error-logic",
        confidence: "medium",
        reasoning: `The ticket says ${route.method} ${route.path} (${route.source}:${route.line}) returns a ${ticket.mentionedStatusCode}, but no live backend log is currently available (no preview running, or nothing matching in its recent output) to find a corroborating traceback.`,
        evidence: traceEvidence,
        livePreviewCorroboration: false,
      };
    }

    if (ticket.mentionedStatusCode && ticket.mentionedStatusCode >= 400) {
      return {
        category: "client-error",
        confidence: "medium",
        reasoning: `The ticket references ${route.method} ${route.path} (${route.source}:${route.line}) returning a ${ticket.mentionedStatusCode} -- a real, implemented route, which may or may not indicate a genuine bug (e.g. a correctly-rejected bad request).`,
        evidence: traceEvidence,
        livePreviewCorroboration: false,
      };
    }

    // Route matched but no explicit failure status -- a real lead, not a
    // diagnosis. Falls through to the honest default below rather than
    // guessing what's wrong with a route that, for all this evidence
    // shows, might be working correctly.
  }

  // 3. A mentioned file with nothing else -- surfaced as a lead, not a cause.
  if (ticket.mentionedFile) {
    traceEvidence.push({
      layer: "backend",
      label: `File mentioned in the ticket: ${ticket.mentionedFile.relPath}`,
      detail: "Confirmed to exist in this project, but the ticket didn't include an error, status code, or traceback to attribute a specific defect to.",
      source: ticket.mentionedFile.relPath,
      line: ticket.mentionedFile.line,
    });
  }

  // 4. Honest default: nothing in the ticket text gave this project's own
  // evidence enough to correlate against. Say exactly what's missing,
  // the same discipline errorIntelligence.ts's "unclassified" applies,
  // but named distinctly here since the gap is in the INPUT (a vague
  // ticket), not in evidence that was captured and still didn't fit.
  const missing: string[] = [];
  if (!ticket.mentionedRoute) missing.push("an affected endpoint or URL");
  if (!ticket.mentionedStatusCode) missing.push("an HTTP status code or explicit error message");
  if (!ticket.pastedTraceback) missing.push("a stack trace or traceback");
  if (!ticket.mentionedFile) missing.push("a specific file/line reference");
  return {
    category: "insufficient-evidence",
    confidence: "low",
    reasoning: `The pasted ticket text didn't contain enough structured signal (${missing.join(", ")}) for this project's own evidence to corroborate a specific root cause. See the relevant files and knowledge hits below for real leads, or add more detail to the ticket (the actual error text, the endpoint/URL, or a stack trace) and investigate again.`,
    evidence: traceEvidence,
    livePreviewCorroboration: false,
  };
}

/** Orchestrator -- gathers real evidence (architecture, semantic search, Enterprise Knowledge, and a live backend log when a preview happens to be running), then classifies. */
export async function investigateTicket(projectPath: string, ticketText: string): Promise<TicketInvestigationReport> {
  const ticket = parseTicketText(ticketText, projectPath);
  const searchQuery = `${ticket.title ?? ""} ${ticket.rawText}`.slice(0, 2000).trim() || ticketText.slice(0, 2000);

  const [evidence, semanticResult, knowledgeResult] = await Promise.all([
    gatherArchitectureEvidence(projectPath),
    (async () => {
      try {
        await buildSemanticIndex(projectPath); // idempotent incremental rebuild, same as /debug/search's own route
        return await searchSemanticIndex(projectPath, searchQuery, 6);
      } catch {
        return { hits: [] as TicketRelevantFile[] };
      }
    })(),
    searchKnowledge(searchQuery, 5).catch(() => ({ hits: [] as KnowledgeSearchHit[] })),
  ]);

  const backendLog = getPreviewStatus().backend?.log ?? [];
  const classification = classifyTicket(ticket, evidence, backendLog);

  return {
    ticket,
    generatedAt: new Date().toISOString(),
    category: classification.category,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
    evidence: classification.evidence,
    relevantFiles: semanticResult.hits.map((h) => ({ relPath: h.relPath, kind: h.kind, startLine: h.startLine, endLine: h.endLine, score: h.score, snippet: h.snippet })),
    knowledgeHits: knowledgeResult.hits,
    livePreviewCorroboration: classification.livePreviewCorroboration,
  };
}
