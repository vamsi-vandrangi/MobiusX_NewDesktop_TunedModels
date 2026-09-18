import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ArchitectureEvidence,
  BrowserValidationStep,
  DetectedRoute,
  ErrorIntelligenceReport,
  ErrorTrace,
  RootCauseCategory,
  TraceEvidence,
} from "@mobiusx/protocol";
import { runBrowserValidation } from "./browserOps.js";
import { gatherArchitectureEvidence } from "./architectureContext.js";
import { getPreviewStatus } from "./previewOps.js";

/**
 * Error Intelligence + Debugger v2 (roadmap Phase 13, source requirement
 * §19/§20). See ErrorIntelligenceReport's doc comment in @mobiusx/protocol
 * for the overall design: this correlates Phase 12's real browser-layer
 * evidence (runBrowserValidation) against Phase 9's real routes/database
 * evidence (gatherArchitectureEvidence) and Phase 6-era previewOps.ts's
 * already-captured backend process log, rather than injecting new
 * runtime tracing into the user's project -- this app has no mechanism
 * to instrument an arbitrary generated FastAPI/Express/Next.js backend
 * (previewOps.ts only spawns those as opaque child processes), so
 * "tracing" here means real, deterministic evidence correlation, not
 * distributed request tracing.
 *
 * One trace per failing BrowserValidationStep. When a step has BOTH a
 * network-level error and a console error, the network-level evidence
 * wins (it's more specific and closer to the real cause) -- the console
 * error isn't discarded from evidence gathering, it's just not what this
 * step's single ErrorTrace is built around. Documented here rather than
 * silently dropped.
 */

const NETWORK_STATUS_RE = /^(\d{3})\s+(\S+)\s+(\S+)$/;
const NETWORK_FAILED_RE = /^FAILED\s+(\S+)\s+(\S+)\s+\((.+)\)$/;
// A relative frontend source hint sometimes present in a real browser
// console/stack-trace message, e.g.
// "at ProductList (webpack-internal:///./pages/products.js:45:10)". Only
// ever cited as evidence when the extracted path is confirmed to exist on
// disk (see resolveFrontendHint) -- never presented as evidence from
// unverified text.
const FRONTEND_HINT_RE = /\.\/([\w./-]+\.(?:jsx?|tsx?))(?::(\d+))?/;

function isParamSegment(seg: string): boolean {
  return seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}")) || (seg.startsWith("[") && seg.endsWith("]"));
}

/** A real backend route's path (possibly with FastAPI `{id}`/Express `:id`/Next `[id]` param segments) matched against a real observed request path -- never a fuzzy/substring match. */
export function pathsMatch(routePath: string, requestPath: string): boolean {
  const a = routePath.split("/").filter(Boolean);
  const b = requestPath.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => isParamSegment(seg) || seg === b[i]);
}

export function findMatchingRoute(routes: DetectedRoute[], method: string, requestPath: string): DetectedRoute | null {
  const exact = routes.find((r) => r.method === method && pathsMatch(r.path, requestPath));
  if (exact) return exact;
  // A route registered as "HANDLER" (Next.js Pages Router -- method
  // genuinely unknowable statically, see architectureContext.ts) can
  // legitimately serve any method.
  return routes.find((r) => r.method === "HANDLER" && pathsMatch(r.path, requestPath)) ?? null;
}

function resolveFrontendHint(projectPath: string, text: string): { relPath: string; line?: number } | null {
  const m = text.match(FRONTEND_HINT_RE);
  if (!m) return null;
  const relPath = m[1];
  if (!existsSync(join(projectPath, relPath))) return null; // never cite a path that isn't actually there
  return { relPath, line: m[2] ? Number(m[2]) : undefined };
}

/** A recent Python traceback or Node stack trace in the backend's own captured process log (previewOps.ts's rolling, capped `log`), closest to the end (freshest) -- real evidence a browser-observed 5xx can be attributed to, without needing new instrumentation. */
export function extractRecentBackendTraceback(log: string[]): string[] | null {
  for (let i = log.length - 1; i >= 0; i--) {
    if (/^Traceback \(most recent call last\):$/.test(log[i]) || /^\s*at\s+\S+.*\(.*:\d+:\d+\)$/.test(log[i])) {
      const block: string[] = [];
      for (let j = i; j < log.length && block.length < 20; j++) block.push(log[j]);
      return block;
    }
  }
  return null;
}

export function backendTracebackMentionsDb(tracebackLines: string[], evidence: ArchitectureEvidence): boolean {
  const text = tracebackLines.join("\n").toLowerCase();
  if (/sqlalchemy|sqlmodel|psycopg|sqlite3|pymongo|mongoose|prisma\.|\.query\(|session\.(add|commit|query)/.test(text)) return true;
  return evidence.database.ormEntities.some((e) => text.includes(e.name.toLowerCase()) || text.includes(e.tableName.toLowerCase()));
}

function getBackendStatusHint(): TraceEvidence | null {
  const status = getPreviewStatus();
  if (!status.backend) return null;
  const b = status.backend;
  return {
    layer: "backend",
    label: `Backend process (${b.kind})`,
    detail: `status: ${b.status}${b.exitCode !== null ? `, exitCode: ${b.exitCode}` : ""}. Command: ${b.command}`,
  };
}

function build(step: BrowserValidationStep, category: RootCauseCategory, confidence: ErrorTrace["confidence"], evidence: TraceEvidence[], reasoning: string): ErrorTrace {
  return { id: randomUUID(), stepLabel: step.label, url: step.url, category, confidence, evidence, reasoning };
}

/**
 * Pure classifier -- no I/O of its own, takes already-gathered evidence
 * bundles so it can be unit-tested without Playwright or a real running
 * preview. Returns null only when the step genuinely has nothing to
 * classify (passed, no console/network errors).
 */
export function classifyStep(step: BrowserValidationStep, evidence: ArchitectureEvidence, backendLog: string[]): ErrorTrace | null {
  if (step.status === "passed" && step.consoleErrors.length === 0 && step.networkErrors.length === 0) return null;

  const traceEvidence: TraceEvidence[] = [{ layer: "browser", label: step.label, detail: step.output }];

  // 1. Connection-level network failures (backend unreachable) take
  // priority -- if the backend can't even be reached, anything else
  // observed on the same page is very likely a downstream symptom.
  const failedNet = step.networkErrors.map((e) => e.match(NETWORK_FAILED_RE)).find((m): m is RegExpMatchArray => m !== null);
  if (failedNet) {
    const [full, method, url, errorText] = failedNet;
    traceEvidence.push({ layer: "api", label: `${method} ${url}`, detail: full });
    const backend = getBackendStatusHint();
    if (backend) traceEvidence.push(backend);
    return build(
      step,
      "backend-unreachable",
      backend ? "high" : "medium",
      traceEvidence,
      `The browser could not complete a request to ${url} at all (${errorText}), not just receive an error response from it.` +
        (backend ? ` ${backend.detail}` : " The backend preview's own process status could not be checked."),
    );
  }

  // 2. HTTP-status network errors -- correlate against real detected routes.
  const statusNet = step.networkErrors.map((e) => e.match(NETWORK_STATUS_RE)).find((m): m is RegExpMatchArray => m !== null);
  if (statusNet) {
    const [, statusStr, method, url] = statusNet;
    const statusCode = Number(statusStr);
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      /* not a full URL — use as-is */
    }
    const route = findMatchingRoute(evidence.routes, method, pathname);
    if (!route) {
      const knownForMethod = evidence.routes.filter((r) => r.method === method || r.method === "HANDLER").map((r) => `${r.method} ${r.path}`);
      traceEvidence.push({
        layer: "api",
        label: `${method} ${pathname}`,
        detail: `No backend route matches ${method} ${pathname}.${
          knownForMethod.length > 0 ? ` Closest known routes: ${knownForMethod.slice(0, 5).join(", ")}.` : " No backend routes were detected in this project at all."
        }`,
      });
      return build(
        step,
        "route-not-implemented",
        "high",
        traceEvidence,
        `The frontend requested ${method} ${pathname} and got a ${statusCode} response, but no backend route matching that method and path was found anywhere in this project's own code.`,
      );
    }
    traceEvidence.push({
      layer: "api",
      label: `${route.method} ${route.path}`,
      detail: `Matched backend route (returned ${statusCode}).`,
      source: route.source,
      line: route.line,
    });

    if (statusCode >= 500) {
      const traceback = extractRecentBackendTraceback(backendLog);
      if (traceback) {
        const dbRelated = backendTracebackMentionsDb(traceback, evidence);
        traceEvidence.push({ layer: "backend", label: "Backend process output at time of error", detail: traceback.join("\n") });
        if (dbRelated) {
          const tbLower = traceback.join("\n").toLowerCase();
          const entity = evidence.database.ormEntities.find((e) => tbLower.includes(e.name.toLowerCase()) || tbLower.includes(e.tableName.toLowerCase()));
          if (entity) traceEvidence.push({ layer: "database", label: entity.name, detail: `ORM entity referenced in the traceback, mapped to table "${entity.tableName}".`, source: entity.source, line: entity.line });
          return build(
            step,
            "backend-error-db-layer",
            "high",
            traceEvidence,
            `${route.method} ${route.path} (${route.source}:${route.line}) returned ${statusCode}. The backend process's own captured output shows a real traceback at that time referencing the database layer${entity ? ` (the "${entity.name}" model)` : ""}.`,
          );
        }
        return build(
          step,
          "backend-error-logic",
          "high",
          traceEvidence,
          `${route.method} ${route.path} (${route.source}:${route.line}) returned ${statusCode}. The backend process's own captured output shows a real traceback at that time, not related to any known database entity.`,
        );
      }
      return build(
        step,
        "backend-error-logic",
        "medium",
        traceEvidence,
        `${route.method} ${route.path} (${route.source}:${route.line}) returned ${statusCode}, but no matching traceback was found in the backend's recent captured output to attribute a specific cause.`,
      );
    }

    return build(
      step,
      "client-error",
      "medium",
      traceEvidence,
      `${route.method} ${route.path} (${route.source}:${route.line}) returned ${statusCode} — a real, implemented route responding with a client-error status, which may or may not indicate a bug (e.g. a legitimate 404/401).`,
    );
  }

  // 3. No network-level evidence -- a pure frontend runtime error.
  if (step.consoleErrors.length > 0 || /Uncaught page error:/.test(step.output)) {
    const hint = resolveFrontendHint(evidence.projectPath, `${step.output}\n${step.consoleErrors.join("\n")}`);
    if (hint) {
      traceEvidence.push({
        layer: "frontend",
        label: "Frontend source referenced in the error",
        detail: step.consoleErrors.join("\n") || step.output,
        source: hint.relPath,
        line: hint.line,
      });
      return build(
        step,
        "frontend-runtime-error",
        "high",
        traceEvidence,
        `A frontend console/page error was captured while loading ${step.url}, and the error text cites ${hint.relPath}${hint.line ? `:${hint.line}` : ""}, a real file in this project.`,
      );
    }
    traceEvidence.push({ layer: "frontend", label: "Frontend console/page error", detail: step.consoleErrors.join("\n") || step.output });
    return build(
      step,
      "frontend-runtime-error",
      "medium",
      traceEvidence,
      `A frontend console/page error was captured while loading ${step.url}, but the error text didn't cite a specific project file to point to.`,
    );
  }

  return build(step, "unclassified", "low", traceEvidence, `${step.label} failed (status: ${step.status}), but the captured evidence didn't match any of this classifier's known patterns.`);
}

/** Orchestrator -- gathers real evidence, then classifies every failing step. */
export async function runErrorIntelligence(projectPath: string): Promise<ErrorIntelligenceReport> {
  const [browserResult, evidence] = await Promise.all([runBrowserValidation(projectPath), gatherArchitectureEvidence(projectPath)]);

  if (browserResult.overall === "no-preview-running") {
    return {
      projectPath,
      generatedAt: new Date().toISOString(),
      previewUrl: null,
      overall: "no-preview-running",
      previewUnavailableReason: browserResult.previewUnavailableReason,
      traces: [],
    };
  }

  const backendLog = getPreviewStatus().backend?.log ?? [];
  const traces = browserResult.steps.map((step) => classifyStep(step, evidence, backendLog)).filter((t): t is ErrorTrace => t !== null);

  return {
    projectPath,
    generatedAt: new Date().toISOString(),
    previewUrl: browserResult.previewUrl,
    overall: traces.length > 0 ? "errors-found" : "no-errors-observed",
    traces,
  };
}
