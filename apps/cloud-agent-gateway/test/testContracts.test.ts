import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deriveTestEnvironmentContract, deriveTestSpecification, estimateTestPromptBudget, mergeTestContribution, renderCustomerDashboardPlaywrightSlice, renderRegistrationPytestVerticalSlice, renderTestContractArtifacts, reuseValidatedTestSliceArtifacts, validateTestContribution, validateTestSpecification } from "../src/testContracts.js";
import type { TestApplicationTopology, TestTopologyFile } from "../src/testTopology.js";

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

test("registration pytest vertical slice binds fixtures and imports to discovered application topology", () => {
  const files: TestTopologyFile[] = [
    { path: "backend/__init__.py", content: "" },
    { path: "backend/main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n" },
    { path: "backend/database.py", content: "async def get_db():\n    yield None\n" },
    { path: "backend/models.py", content: [
      "from sqlalchemy import Column, Integer, String",
      "class User(Base):",
      "    __tablename__ = 'users'",
      "    id = Column(Integer, primary_key=True)",
      "    username = Column(String)",
      "    password_hash = Column(String)",
      "    role = Column(String)",
      "class Customer(Base):",
      "    __tablename__ = 'customers'",
      "    id = Column(Integer, primary_key=True)",
      "    owner_id = Column(Integer)",
      "    name = Column(String)",
      "    legal_name = Column(String)",
      "    business_email = Column(String)",
      "    reference = Column(String)",
      "    status = Column(String)",
      "class AuditEvent(Base):",
      "    __tablename__ = 'audit_events'",
      "    id = Column(Integer, primary_key=True)",
      "    user_id = Column(Integer)",
      "    customer_id = Column(Integer)",
      "    action = Column(String)",
      "    created_at = Column(String)",
    ].join("\n") },
    { path: "backend/schemas.py", content: [
      "class CustomerCreate(BaseModel):",
      "    name: str = Field(...)",
      "    legal_name: str = Field(...)",
      "    business_email: str = Field(...)",
      "    reference: str = Field(...)",
      "class CustomerResponse(BaseModel):",
      "    id: int",
      "    owner_id: int",
    ].join("\n") },
    { path: "backend/auth.py", content: "from passlib.context import CryptContext\ncrypt_context = CryptContext(schemes=['bcrypt'])\n" },
    { path: "frontend/ui-contract.v1.json", content: JSON.stringify({
      routes: [
        { id: "login", route: "/login/customer", loginRole: "customer", roles: ["public"], title: "Customer sign in", form: { operationId: "auth.login", fields: [{ name: "username", label: "Username" }, { name: "password", label: "Password" }] } },
        { id: "dashboard", route: "/customer", roles: ["customer"], title: "My customers", table: { entity: "Customer", columns: ["name", "status"] } },
      ],
    }) },
  ];
  const topology: TestApplicationTopology = {
    schemaVersion: "1.0",
    backend: {
      entrypoint: "backend.main:app", packageRoot: "backend",
      modules: ["backend", "backend.main", "backend.database", "backend.models", "backend.schemas", "backend.auth"],
      routes: [{ method: "POST", path: "/customers" }, { method: "POST", path: "/auth/login" }],
      databaseSessionModule: "backend.database", ormModels: [
        { module: "backend.models", className: "User", table: "users" },
        { module: "backend.models", className: "Customer", table: "customers" },
        { module: "backend.models", className: "AuditEvent", table: "audit_events" },
      ], migrationConfig: "backend/alembic.ini", requirementsFile: "backend/requirements.txt",
    },
    authentication: { module: "backend.auth", routeModule: "backend.routes.auth", routes: [{ method: "POST", path: "/auth/login" }], loginRequestContentType: "application/json", usernameField: "username", passwordField: "password" },
    frontend: { routes: ["/login/customer", "/customer"], labels: ["Username", "Password", "My customers"], fields: ["name", "status"], actions: ["Continue"] },
    test: { backendTestFiles: [], browserTestFiles: [], pythonTestDependencies: ["pytest>=8,<9", "httpx>=0.27,<1"] },
    sourceManifest: [],
  };
  const registration = { operationId: "customer.register", sha256: hash("register"), content: JSON.stringify({
    operationId: "customer.register", operationKind: "entity-create", architectureHash: "pac-hash",
    route: { method: "POST", path: "/customers" }, actor: { entity: "User", role: "customer" },
    input: { bodySchema: "CustomerCreate", fieldMappings: [
      ...["name", "legal_name", "business_email", "reference"].map((name) => ({ targetField: name, source: "body", sourceField: name })),
      { targetField: "owner_id", source: "actor", sourceField: "id" }, { targetField: "status", source: "state", value: "pending" },
    ] }, requestOnlyFields: [], output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 201 },
    audit: { entity: "AuditEvent", action: "created", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
  }) };
  const login = { operationId: "auth.login", sha256: hash("login"), content: JSON.stringify({
    operationId: "auth.login", operationKind: "authentication-login", architectureHash: "pac-hash",
    route: { method: "POST", path: "/auth/login" }, input: { requestSchema: "LoginRequest", usernameField: "username", passwordField: "password" },
    request: { fields: [{ name: "username", required: true }, { name: "password", required: true }] },
    principal: { entity: "User" }, response: { fields: [{ name: "access_token" }] },
  }) };
  const result = deriveTestEnvironmentContract(topology, files, registration, login, [...operations, registration, login]);
  assert.deepEqual(result.issues, []);
  assert.ok(result.contract);
  assert.equal(result.contract!.backend.entrypoint, "backend.main:app");
  assert.equal(result.contract!.backend.modelModules.Customer, "backend.models");
  const artifacts = renderRegistrationPytestVerticalSlice(result.contract!);
  const fixture = artifacts.find((item) => item.path.endsWith("conftest.py"))!.content;
  const integration = artifacts.find((item) => item.path.endsWith("test_customer_registration_vertical_slice.py"))!.content;
  assert.match(fixture, /from backend\.main import app/);
  assert.match(fixture, /from backend\.database import get_db/);
  assert.match(fixture, /def customer_identity\(identity_factory\)/);
  assert.match(fixture, /def manager_identity\(identity_factory\)/);
  assert.doesNotMatch(fixture + integration, /from app\.|pytest\.mark\.asyncio/);
  assert.match(integration, /select\(Customer\)/);
  assert.match(integration, /AuditEvent/);
  assert.match(integration, /test_customer_registration_persists_for_authenticated_owner/);
  assert.equal(artifacts.length, 3);

  const browser = renderCustomerDashboardPlaywrightSlice(result.contract!);
  const browserSource = browser.find((item) => item.path.endsWith(".spec.ts"))!.content;
  const provisioner = browser.find((item) => item.path.endsWith("provision_browser_identity.py"))!.content;
  assert.match(browserSource, /getByLabel\(contract\.frontend\.usernameLabel\)/);
  assert.match(browserSource, /page\.reload\(\)/);
  assert.match(browserSource, /otherCustomerRecord/);
  assert.match(provisioner, /password_hasher\.hash/);
  assert.match(provisioner, /MOBIUSX_PW_IDENTITIES_FILE/);
  assert.doesNotMatch(browserSource, /browser-[^`]*password/);
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

test("resume reuses a validated test slice instead of replacing it with a later proposal", () => {
  const content = "export const passingSlice = true;\n";
  const saved = [{ id: "vertical-slice", architectureHash: "a".repeat(64), topologyHash: "b".repeat(64), completedAt: new Date(0).toISOString(), artifacts: [{ path: "frontend/e2e/vertical-slice.spec.ts", action: "create" as const, content, sha256: hash(content) }], validation: { pytestCollected: 1, pytestPassed: 1, pytestFailed: 0, pytestSkipped: 0, playwrightCollected: 1, playwrightPassed: 1, playwrightFailed: 0, playwrightSkipped: 0 } }];
  const proposed = [{ path: "frontend/e2e/vertical-slice.spec.ts", action: "create" as const, content: "export const passingSlice = false;\n" }];
  assert.equal(reuseValidatedTestSliceArtifacts(proposed, saved, "a".repeat(64))[0].content, content);
  assert.equal(reuseValidatedTestSliceArtifacts(proposed, saved, "c".repeat(64))[0].content, proposed[0].content);
});
