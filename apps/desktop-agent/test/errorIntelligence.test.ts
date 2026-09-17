import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchitectureEvidence, BrowserValidationStep, DatabaseOrmEntity, DetectedRoute } from "@mobiusx/protocol";
import { classifyStep, extractRecentBackendTraceback, runErrorIntelligence } from "../src/errorIntelligence.js";
import { getPreviewStatus } from "../src/previewOps.js";

function makeStep(overrides: Partial<BrowserValidationStep> = {}): BrowserValidationStep {
  return {
    id: "step-1",
    label: "Open http://localhost:3000/products",
    command: "Navigate to http://localhost:3000/products",
    status: "failed",
    url: "http://localhost:3000/products",
    consoleErrors: [],
    networkErrors: [],
    output: "No console errors, page errors, or failed network requests observed.",
    durationMs: 100,
    ...overrides,
  };
}

function makeEvidence(overrides: { routes?: DetectedRoute[]; ormEntities?: DatabaseOrmEntity[]; projectPath?: string } = {}): ArchitectureEvidence {
  const projectPath = overrides.projectPath ?? "/tmp/does-not-matter";
  return {
    projectPath,
    generatedAt: new Date().toISOString(),
    projectContext: { projectPath, generatedAt: new Date().toISOString(), components: [], unknownCategories: [] },
    database: {
      projectPath,
      generatedAt: new Date().toISOString(),
      ormDetected: overrides.ormEntities && overrides.ormEntities.length > 0 ? "SQLModel/SQLAlchemy (Python)" : null,
      schemaTables: [],
      ormEntities: overrides.ormEntities ?? [],
      mismatches: [],
      relationships: [],
      overall: "unknown",
    },
    routes: overrides.routes ?? [],
    externalIntegrations: [],
    frontendBackendLinks: [],
  };
}

test("classifyStep returns null for a passed step with no captured errors", () => {
  const step = makeStep({ status: "passed" });
  assert.equal(classifyStep(step, makeEvidence(), []), null);
});

test("classifyStep: a connection-level network failure classifies as backend-unreachable", () => {
  const step = makeStep({
    networkErrors: ["FAILED GET http://localhost:8000/products (net::ERR_CONNECTION_REFUSED)"],
    output: "Failed network requests:\nFAILED GET http://localhost:8000/products (net::ERR_CONNECTION_REFUSED)",
  });
  const trace = classifyStep(step, makeEvidence(), []);
  assert.ok(trace);
  assert.equal(trace!.category, "backend-unreachable");
  assert.ok(trace!.evidence.some((e) => e.layer === "api"));
  assert.match(trace!.reasoning, /could not complete a request/);
});

test("classifyStep: a 404 on a path with no matching route classifies as route-not-implemented", () => {
  const step = makeStep({
    networkErrors: ["404 GET http://localhost:3000/api/products/featured"],
    output: "Failed network requests:\n404 GET http://localhost:3000/api/products/featured",
  });
  const evidence = makeEvidence({ routes: [{ method: "GET", path: "/products", source: "backend/main.py", line: 10 }] });
  const trace = classifyStep(step, evidence, []);
  assert.ok(trace);
  assert.equal(trace!.category, "route-not-implemented");
  assert.equal(trace!.confidence, "high");
  const apiEvidence = trace!.evidence.find((e) => e.layer === "api");
  assert.match(apiEvidence!.detail, /No backend route matches/);
  assert.match(apiEvidence!.detail, /GET \/products/); // cites the closest known route
});

test("classifyStep: a 500 on a matched route with a DB-referencing traceback classifies as backend-error-db-layer", () => {
  const step = makeStep({
    networkErrors: ["500 GET http://localhost:3000/products"],
    output: "Failed network requests:\n500 GET http://localhost:3000/products",
  });
  const evidence = makeEvidence({
    routes: [{ method: "GET", path: "/products", source: "backend/main.py", line: 12 }],
    ormEntities: [{ name: "Product", tableName: "product", source: "backend/models.py", line: 5 }],
  });
  const backendLog = [
    "INFO: Started server",
    "Traceback (most recent call last):",
    '  File "backend/main.py", line 14, in list_products',
    "    return session.query(Product).all()",
    "sqlalchemy.exc.OperationalError: no such table: product",
  ];
  const trace = classifyStep(step, evidence, backendLog);
  assert.ok(trace);
  assert.equal(trace!.category, "backend-error-db-layer");
  assert.equal(trace!.confidence, "high");
  assert.ok(trace!.evidence.some((e) => e.layer === "database" && e.label === "Product"));
  assert.match(trace!.reasoning, /"Product" model/);
});

test("classifyStep: a 500 on a matched route with a non-DB traceback classifies as backend-error-logic", () => {
  const step = makeStep({
    networkErrors: ["500 GET http://localhost:3000/products"],
    output: "Failed network requests:\n500 GET http://localhost:3000/products",
  });
  const evidence = makeEvidence({ routes: [{ method: "GET", path: "/products", source: "backend/main.py", line: 12 }] });
  const backendLog = [
    "Traceback (most recent call last):",
    '  File "backend/main.py", line 14, in list_products',
    "    return 1 / 0",
    "ZeroDivisionError: division by zero",
  ];
  const trace = classifyStep(step, evidence, backendLog);
  assert.ok(trace);
  assert.equal(trace!.category, "backend-error-logic");
  assert.equal(trace!.confidence, "high");
});

test("classifyStep: a 500 on a matched route with no traceback in the log is backend-error-logic at medium confidence", () => {
  const step = makeStep({
    networkErrors: ["500 GET http://localhost:3000/products"],
    output: "Failed network requests:\n500 GET http://localhost:3000/products",
  });
  const evidence = makeEvidence({ routes: [{ method: "GET", path: "/products", source: "backend/main.py", line: 12 }] });
  const trace = classifyStep(step, evidence, ["INFO: 127.0.0.1 - GET /products 500"]);
  assert.ok(trace);
  assert.equal(trace!.category, "backend-error-logic");
  assert.equal(trace!.confidence, "medium");
});

test("classifyStep: a 404 on a MATCHED route classifies as client-error, not route-not-implemented", () => {
  const step = makeStep({
    networkErrors: ["404 GET http://localhost:3000/products/999"],
    output: "Failed network requests:\n404 GET http://localhost:3000/products/999",
  });
  const evidence = makeEvidence({ routes: [{ method: "GET", path: "/products/{id}", source: "backend/main.py", line: 20 }] });
  const trace = classifyStep(step, evidence, []);
  assert.ok(trace);
  assert.equal(trace!.category, "client-error");
  assert.ok(trace!.evidence.some((e) => e.source === "backend/main.py" && e.line === 20));
});

test("classifyStep: a frontend console error citing a real project file resolves a high-confidence frontend-runtime-error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobiusx-errorintel-test-"));
  await writeFile(join(dir, "products.jsx"), "// fixture");
  const step = makeStep({
    consoleErrors: ["[error] TypeError: Cannot read properties of undefined (reading 'map') at ProductList (webpack-internal:///./products.jsx:12:5)"],
    output: "Console errors/warnings:\n[error] TypeError: Cannot read properties of undefined (reading 'map') at ProductList (webpack-internal:///./products.jsx:12:5)",
  });
  const trace = classifyStep(step, makeEvidence({ projectPath: dir }), []);
  assert.ok(trace);
  assert.equal(trace!.category, "frontend-runtime-error");
  assert.equal(trace!.confidence, "high");
  const fe = trace!.evidence.find((e) => e.layer === "frontend");
  assert.equal(fe!.source, "products.jsx");
  assert.equal(fe!.line, 12);
});

test("classifyStep: a frontend console error with no resolvable file hint is medium confidence", () => {
  const step = makeStep({
    consoleErrors: ["[error] Something went wrong"],
    output: "Console errors/warnings:\n[error] Something went wrong",
  });
  const trace = classifyStep(step, makeEvidence(), []);
  assert.ok(trace);
  assert.equal(trace!.category, "frontend-runtime-error");
  assert.equal(trace!.confidence, "medium");
});

test("classifyStep: a failed step with no console/network evidence at all is honestly unclassified, not force-fit", () => {
  const step = makeStep({ status: "timed_out", output: "Navigation error: Navigation timed out after 20000ms" });
  const trace = classifyStep(step, makeEvidence(), []);
  assert.ok(trace);
  assert.equal(trace!.category, "unclassified");
  assert.equal(trace!.confidence, "low");
});

test("extractRecentBackendTraceback finds the freshest traceback and returns null when there is none", () => {
  assert.equal(extractRecentBackendTraceback(["INFO: ready", "INFO: 200 GET /products"]), null);
  const log = ["INFO: ready", "Traceback (most recent call last):", "  File \"a.py\", line 1", "ValueError: x"];
  const block = extractRecentBackendTraceback(log);
  assert.ok(block);
  assert.equal(block![0], "Traceback (most recent call last):");
});

test("runErrorIntelligence reports no-preview-running honestly when nothing has been started", async () => {
  assert.equal(getPreviewStatus().frontend, null); // sanity: fresh test-runner process, nothing started
  const result = await runErrorIntelligence("/tmp/does-not-matter");
  assert.equal(result.overall, "no-preview-running");
  assert.equal(result.traces.length, 0);
  assert.match(result.previewUnavailableReason ?? "", /Start Preview/);
});
