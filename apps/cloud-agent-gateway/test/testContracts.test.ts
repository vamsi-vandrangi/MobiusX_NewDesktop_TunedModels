import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deriveTestSpecification, estimateTestPromptBudget, mergeTestContribution, renderTestContractArtifacts, validateTestContribution, validateTestSpecification } from "../src/testContracts.js";
import type { TestApplicationTopology } from "../src/testTopology.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const operations = [
  { operationId: "auth.login", sha256: hash("login"), content: JSON.stringify({ operationId: "auth.login", operationKind: "authentication-login", route: { method: "POST", path: "/auth/login" } }) },
  { operationId: "customer.register", sha256: hash("register"), content: JSON.stringify({ operationId: "customer.register", operationKind: "entity-create", route: { method: "POST", path: "/customers" }, actor: { role: "customer" } }) },
  { operationId: "customer.submit", sha256: hash("submit"), content: JSON.stringify({ operationId: "customer.submit", route: { method: "POST", path: "/customers/{customer_id}/submit" }, actor: { role: "customer" }, transition: { from: "pending", to: "pending", auditAction: "submitted" } }) },
  { operationId: "manager.approve", sha256: hash("approve"), content: JSON.stringify({ operationId: "manager.approve", route: { method: "POST", path: "/customers/{customer_id}/approve" }, actor: { role: "manager" }, transition: { from: "pending", to: "approved", auditAction: "approved" }, concurrency: { strategy: "row-lock" } }) },
  { operationId: "customer.audit.read", sha256: hash("audit"), content: JSON.stringify({ operationId: "customer.audit.read", operationKind: "entity-history-read", route: { method: "GET", path: "/customers/{customer_id}/audit" } }) },
];

test("test inventory derives cases only from approved operations and has unique stable identifiers", () => {
  const spec = deriveTestSpecification("pac-hash", operations, "2026-10-13T00:00:00.000Z");
  assert.equal(spec.schemaVersion, "1.0");
  assert.ok(spec.cases.some((item) => item.id === "customer.register.required-fields"));
  assert.ok(spec.cases.some((item) => item.id === "customer.submit.unauthorized"));
  assert.ok(spec.cases.some((item) => item.id === "manager.approve.invalid-transition"));
  assert.ok(spec.cases.some((item) => item.id === "browser.auth-session"));
  assert.deepEqual(validateTestSpecification(spec, "pac-hash", operations, ["customer", "manager"]), []);
  assert.equal(new Set(spec.cases.map((item) => item.id)).size, spec.cases.length);
});

test("test contract rejects unknown operations, roles, PAC lineage, and operation hash drift", () => {
  const spec = deriveTestSpecification("pac-hash", operations);
  spec.cases[0].operationId = "customer.deleteAll";
  spec.cases[1].role = "root";
  spec.operationHashes["auth.login"] = hash("stale");
  const issues = validateTestSpecification(spec, "other-pac", operations, ["customer", "manager"]);
  assert.ok(issues.some((issue) => issue.includes("different approved architecture")));
  assert.ok(issues.some((issue) => issue.includes("unknown operation")));
  assert.ok(issues.some((issue) => issue.includes("unknown role")));
  assert.ok(issues.some((issue) => issue.includes("checksum changed")));
});

test("model test contribution is bounded, additive, and constrained to approved operations and roles", () => {
  const base = deriveTestSpecification("pac-hash", operations);
  const result = validateTestContribution({ cases: [{ id: "customer.register.unicode-name", operationId: "customer.register", action: "register a customer with a Unicode legal name", expectedStatus: 201, role: "customer" }] }, base, operations, ["customer", "manager"]);
  assert.deepEqual(result.issues, []);
  assert.ok(result.contribution);
  const merged = mergeTestContribution(base, result.contribution!);
  assert.equal(merged.cases.at(-1)?.origin, "model");
  assert.equal(merged.cases.at(-1)?.id, "customer.register.unicode-name");

  const invalid = validateTestContribution({ cases: [{ id: "customer.register.bad", operationId: "customer.purge", action: "try a made-up endpoint", expectedStatus: 200, role: "admin" }] }, base, operations, ["customer", "manager"]);
  assert.ok(invalid.issues.some((issue) => issue.includes("unknown operation")));
  assert.ok(invalid.issues.some((issue) => issue.includes("unknown role")));
});

test("model contribution rejects empty, malformed, duplicate, and oversized output", () => {
  const base = deriveTestSpecification("pac-hash", operations);
  assert.ok(validateTestContribution({}, base, operations, ["customer"]).issues.length);
  assert.ok(validateTestContribution({ cases: [] }, base, operations, ["customer"]).issues.length);
  assert.ok(validateTestContribution({ cases: [{ id: "customer.register.short", operationId: "customer.register", action: "check it", expectedStatus: 201 }] }, base, operations, ["customer"]).issues.some((issue) => issue.includes("observable assertion")));
  assert.ok(validateTestContribution({ cases: Array.from({ length: 5 }, (_, index) => ({ id: `customer.register.case-${index}`, operationId: "customer.register", action: "test case with sufficient details", expectedStatus: 200 })) }, base, operations, ["customer"]).issues.some((issue) => issue.includes("one to four")));
});

test("test contribution prompt budget includes instructions, structured output, response reserve, and margin", () => {
  const prompt = "Generate one case from approved operation metadata.";
  const fit = estimateTestPromptBudget(prompt, 12_288);
  assert.equal(fit.promptBytes, Buffer.byteLength(prompt, "utf8"));
  assert.equal(fit.promptSha256, hash(prompt));
  assert.equal(fit.expectedOutputTokens, 4_096);
  assert.ok(fit.estimatedTotalTokens > fit.estimatedPromptTokens + fit.expectedOutputTokens);
  assert.equal(fit.fits, true);
  const tooLarge = estimateTestPromptBudget("x".repeat(100_000), 12_288);
  assert.equal(tooLarge.fits, false);
  assert.ok(tooLarge.estimatedTotalTokens > tooLarge.contextTokens);
});

test("deterministic test renderer emits executable OpenAPI route checks and a checksummed-contract manifest", () => {
  const spec = deriveTestSpecification("pac-hash", operations);
  const topology = { backend: { entrypoint: "service.api:app" } } as TestApplicationTopology;
  const artifacts = renderTestContractArtifacts(spec, operations, topology);
  assert.deepEqual(artifacts.map((item) => item.path), ["backend/tests/test_contract_manifest.json", "backend/tests/test_openapi_contract.py"]);
  const python = artifacts.find((item) => item.path.endsWith(".py"))!.content;
  assert.match(python, /def test_registered_routes_match_approved_operation_contracts/);
  assert.match(python, /from service\.api import app/);
  assert.doesNotMatch(python, /from backend\.main import app/);
  assert.match(python, /\/auth\/login/);
  assert.match(python, /schema\.get\('paths'/);
  assert.match(python, /expected_type in body/);
  assert.match(python, /test_test_inventory_references_only_approved_operations/);
  assert.doesNotMatch(python, /TODO|test\.skip|assert True/);
  assert.doesNotThrow(() => execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: python, stdio: ["pipe", "ignore", "pipe"] }));
  const manifest = JSON.parse(artifacts.find((item) => item.path.endsWith(".json"))!.content) as { cases: Array<{ operationId?: string }> };
  assert.ok(manifest.cases.length > 0);
  assert.ok(manifest.cases.every((item) => !item.operationId || operations.some((operation) => operation.operationId === item.operationId)));
});
