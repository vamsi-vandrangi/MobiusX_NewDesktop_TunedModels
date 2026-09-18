import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchitectureEvidence, DatabaseOrmEntity, DetectedRoute } from "@mobiusx/protocol";
import { classifyTicket, parseTicketText } from "../src/ticketOps.js";

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

// ---- parseTicketText ----

test("parseTicketText extracts a JIRA-style ticket ID and title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const text = "GTG-482\nSummary: Checkout page returns 500 for guest users\n\nSteps to reproduce:\n1. Add item to cart\n2. Checkout as guest";
  const ticket = parseTicketText(text, dir);
  assert.equal(ticket.ticketId, "GTG-482");
  assert.equal(ticket.title, "Checkout page returns 500 for guest users");
});

test("parseTicketText falls back to the first non-ID line when no Summary/Title label is present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const ticket = parseTicketText("PROJ-1\nPayments are failing intermittently since this morning.", dir);
  assert.equal(ticket.title, "Payments are failing intermittently since this morning.");
});

test("parseTicketText extracts a method+path route mention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const ticket = parseTicketText("Calling GET /api/products/featured returns an error.", dir);
  assert.deepEqual(ticket.mentionedRoute, { method: "GET", path: "/api/products/featured" });
});

test("parseTicketText extracts a bare path with unknown verb as method HANDLER", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const ticket = parseTicketText("Customers report https://app.example.com/checkout is broken.", dir);
  assert.deepEqual(ticket.mentionedRoute, { method: "HANDLER", path: "/checkout" });
});

test("parseTicketText only extracts a status code with corroborating context, not any 3-digit number", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const withContext = parseTicketText("The API returns a 500 error on submit.", dir);
  assert.equal(withContext.mentionedStatusCode, 500);
  const noContext = parseTicketText("Ticket reported by employee 404 in the Chicago office.", dir);
  assert.equal(noContext.mentionedStatusCode, null);
});

test("parseTicketText extracts a pasted Python traceback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const text = [
    "Here's the error from the logs:",
    "Traceback (most recent call last):",
    '  File "main.py", line 42, in checkout',
    "    total = calculate_total(cart)",
    "KeyError: 'price'",
  ].join("\n");
  const ticket = parseTicketText(text, dir);
  assert.ok(ticket.pastedTraceback);
  assert.match(ticket.pastedTraceback!.join("\n"), /KeyError: 'price'/);
});

test("parseTicketText only cites a mentioned file that actually exists on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  await writeFile(join(dir, "main.py"), "# real file\n");
  const real = parseTicketText("The bug is in main.py near the checkout handler.", dir);
  assert.deepEqual(real.mentionedFile, { relPath: "main.py", line: undefined });
  const fake = parseTicketText("The bug is in nonexistent_file.py somewhere.", dir);
  assert.equal(fake.mentionedFile, null);
});

// ---- classifyTicket ----

test("classifyTicket: a pasted traceback referencing a known ORM entity classifies as backend-error-db-layer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const text = [
    "GTG-9",
    "Traceback (most recent call last):",
    '  File "main.py", line 12, in get_product',
    "    product = session.query(Product).first()",
    "sqlalchemy.exc.OperationalError: no such table: products",
  ].join("\n");
  const ticket = parseTicketText(text, dir);
  const evidence = makeEvidence({ ormEntities: [{ name: "Product", tableName: "products", source: "backend/models.py", line: 5 }] });
  const result = classifyTicket(ticket, evidence, []);
  assert.equal(result.category, "backend-error-db-layer");
  assert.equal(result.confidence, "high");
  assert.ok(result.evidence.some((e) => e.layer === "database" && e.label === "Product"));
});

test("classifyTicket: a pasted traceback with no DB reference classifies as backend-error-logic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ticketops-"));
  const text = ["Traceback (most recent call last):", '  File "utils.py", line 3, in add', "    return a + b", "TypeError: unsupported operand type(s)"].join("\n");
  const ticket = parseTicketText(text, dir);
  const result = classifyTicket(ticket, makeEvidence(), []);
  assert.equal(result.category, "backend-error-logic");
  assert.equal(result.confidence, "high");
});

test("classifyTicket: a mentioned route with no matching backend route classifies as route-not-implemented", () => {
  const ticket = parseTicketText("Hitting GET /equipment returns a 404 for every user.", "/tmp/does-not-matter");
  const evidence = makeEvidence({ routes: [{ method: "GET", path: "/products", source: "backend/main.py", line: 10 }] });
  const result = classifyTicket(ticket, evidence, []);
  assert.equal(result.category, "route-not-implemented");
  assert.match(result.reasoning, /\/equipment/);
});

test("classifyTicket: a matched route with a 5xx status and no live backend log is medium-confidence backend-error-logic", () => {
  const ticket = parseTicketText("POST /checkout is returning a 500 error for all guest users.", "/tmp/does-not-matter");
  const evidence = makeEvidence({ routes: [{ method: "POST", path: "/checkout", source: "backend/main.py", line: 20 }] });
  const result = classifyTicket(ticket, evidence, []);
  assert.equal(result.category, "backend-error-logic");
  assert.equal(result.confidence, "medium");
  assert.equal(result.livePreviewCorroboration, false);
});

test("classifyTicket: a matched route with a 5xx status corroborated by a live backend log is high-confidence and flags livePreviewCorroboration", () => {
  const ticket = parseTicketText("POST /checkout is returning a 500 error for all guest users.", "/tmp/does-not-matter");
  const evidence = makeEvidence({ routes: [{ method: "POST", path: "/checkout", source: "backend/main.py", line: 20 }] });
  const backendLog = ["Traceback (most recent call last):", '  File "main.py", line 21, in checkout', "    raise ValueError('missing address')", "ValueError: missing address"];
  const result = classifyTicket(ticket, evidence, backendLog);
  assert.equal(result.category, "backend-error-logic");
  assert.equal(result.confidence, "high");
  assert.equal(result.livePreviewCorroboration, true);
});

test("classifyTicket: a matched route with a 4xx status classifies as client-error", () => {
  const ticket = parseTicketText("GET /orders/42 returns a 404 when the order was deleted.", "/tmp/does-not-matter");
  const evidence = makeEvidence({ routes: [{ method: "GET", path: "/orders/{id}", source: "backend/main.py", line: 8 }] });
  const result = classifyTicket(ticket, evidence, []);
  assert.equal(result.category, "client-error");
});

test("classifyTicket: a vague ticket with no structured signal honestly reports insufficient-evidence and names what's missing", () => {
  const ticket = parseTicketText("Customers are complaining that checkout feels broken lately.", "/tmp/does-not-matter");
  const result = classifyTicket(ticket, makeEvidence(), []);
  assert.equal(result.category, "insufficient-evidence");
  assert.equal(result.confidence, "low");
  assert.match(result.reasoning, /endpoint or URL/);
  assert.match(result.reasoning, /stack trace or traceback/);
});
