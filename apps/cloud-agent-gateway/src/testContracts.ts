import { createHash } from "node:crypto";
import type { TestApplicationTopology } from "./testTopology.js";

export type TestLayer = "api" | "database" | "browser";
export type TestExpectation = { status?: number; persistedState?: string; auditAction?: string; rejected?: boolean };

export interface TestCaseSpec {
  id: string;
  layer: TestLayer;
  operationId?: string;
  preconditions: string[];
  testData: string[];
  role?: string;
  action: string;
  expected: TestExpectation;
  negative?: TestExpectation;
  cleanup: string[];
  origin: "contract" | "model";
}

export interface TestSpecification {
  schemaVersion: "1.0";
  architectureHash: string;
  operationHashes: Record<string, string>;
  cases: TestCaseSpec[];
  createdAt: string;
}

export interface TestOperationMetadata {
  operationId: string;
  sha256: string;
  content: string;
}

export interface TestPromptBudget {
  promptBytes: number;
  promptSha256: string;
  estimatedPromptTokens: number;
  expectedOutputTokens: number;
  structuredOutputOverheadTokens: number;
  safetyMarginTokens: number;
  contextTokens: number;
  estimatedTotalTokens: number;
  fits: boolean;
}

/** Conservative pre-dispatch budget; matches the Ollama adapter's char/token heuristic. */
export function estimateTestPromptBudget(
  prompt: string,
  contextTokens: number,
  expectedOutputTokens = 4_096,
  systemInstructionTokens = 1_024,
): TestPromptBudget {
  const structuredOutputOverheadTokens = 256;
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const estimatedPromptTokens = Math.ceil(prompt.length / 3.2) + 256;
  const safetyMarginTokens = Math.ceil(contextTokens * 0.12);
  const estimatedTotalTokens = estimatedPromptTokens + expectedOutputTokens + systemInstructionTokens
    + structuredOutputOverheadTokens + safetyMarginTokens;
  return {
    promptBytes,
    promptSha256: sha256(prompt),
    estimatedPromptTokens,
    expectedOutputTokens,
    structuredOutputOverheadTokens,
    safetyMarginTokens,
    contextTokens,
    estimatedTotalTokens,
    fits: estimatedTotalTokens <= contextTokens,
  };
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

function parseOperation(record: TestOperationMetadata): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(record.content);
    return parsed && typeof parsed === "object" && parsed.operationId === record.operationId ? parsed : undefined;
  } catch { return undefined; }
}

function caseSpec(id: string, layer: TestLayer, operationId: string | undefined, role: string | undefined, action: string, expected: TestExpectation, negative?: TestExpectation): TestCaseSpec {
  return { id, layer, ...(operationId ? { operationId } : {}), preconditions: [], testData: [], ...(role ? { role } : {}), action, expected, ...(negative ? { negative } : {}), cleanup: ["delete created test records"], origin: "contract" };
}

/** Build mandatory coverage only from operations present in the approved contracts. */
export function deriveTestSpecification(architectureHash: string, operations: TestOperationMetadata[], createdAt = new Date().toISOString()): TestSpecification {
  const parsed = operations.map((operation) => ({ record: operation, spec: parseOperation(operation) })).filter((item): item is { record: TestOperationMetadata; spec: Record<string, any> } => Boolean(item.spec));
  const cases: TestCaseSpec[] = [];
  const add = (test: TestCaseSpec) => { if (!cases.some((item) => item.id === test.id)) cases.push(test); };

  for (const { record, spec } of parsed) {
    const id = record.operationId;
    const actor = spec.actor as Record<string, unknown> | undefined;
    const roles = [spec.permissions, spec.roles].flatMap((value) => Array.isArray(value) ? value : []).filter((value): value is string => typeof value === "string");
    for (const value of [actor?.role, actor?.customerRole, actor?.managerRole, actor?.privilegedRole]) if (typeof value === "string" && !roles.includes(value)) roles.push(value);
    const role = roles[0];
    if (spec.failures?.unauthenticated === 401 && spec.operationKind !== "authentication-login") {
      add(caseSpec(`${id}.unauthenticated`, "api", id, undefined, "call the protected operation without an authentication token", { status: 401 }, { status: 401, rejected: true }));
    }
    if (spec.audit?.action) add(caseSpec(`${id}.audit-persistence`, "database", id, role, "verify the operation audit row is committed with the business change", { status: spec.output?.statusCode ?? 200, auditAction: String(spec.audit.action) }));
    if (spec.transaction?.atomic === true) add(caseSpec(`${id}.atomic-rollback`, "database", id, role, "inject a controlled failure and verify the operation leaves no partial mutation", { status: 500, persistedState: "unchanged", auditAction: "absent" }, { status: 500, rejected: true }));
    if (spec.concurrency?.strategy) add(caseSpec(`${id}.concurrent-decisions`, "database", id, role, "race incompatible decisions and verify exactly one transition commits", { persistedState: "one-winner", auditAction: "one-decision" }));
    if (spec.operationKind === "authentication-login") {
      add(caseSpec(`${id}.valid`, "api", id, undefined, "authenticate with a valid credential pair", { status: 200 }));
      add(caseSpec(`${id}.invalid-credentials`, "api", id, undefined, "authenticate with invalid credentials", { status: 401 }, { status: 401, rejected: true }));
    } else if (spec.operationKind === "entity-create") {
      add(caseSpec(`${id}.create`, "api", id, role, "create one entity using the declared request schema", { status: 201 }));
      add(caseSpec(`${id}.required-fields`, "api", id, role, "omit one required request field", { status: 422 }, { status: 422, rejected: true }));
      add(caseSpec(`${id}.duplicate`, "database", id, role, "repeat the same unique request", { status: 409 }, { status: 409, rejected: true }));
    } else if (spec.transition && typeof spec.transition === "object") {
      const transition = spec.transition as { from?: string; to?: string; auditAction?: string };
      const nextState = String(transition.to ?? "updated");
      const action = String(transition.auditAction ?? nextState);
      add(caseSpec(`${id}.authorized`, "api", id, role, `perform the declared ${String(transition.from ?? "current")} to ${nextState} transition`, { status: spec.output?.statusCode ?? 200, persistedState: nextState, auditAction: action }));
      add(caseSpec(`${id}.unauthorized`, "api", id, role, "attempt the decision without the required permission", { status: 403 }, { status: 403, rejected: true }));
      add(caseSpec(`${id}.invalid-transition`, "api", id, role, "repeat a completed decision", { status: 409 }, { status: 409, rejected: true }));
      if (roles.includes("manager")) add(caseSpec(`browser.${id}`, "browser", id, role, `complete the ${nextState} action and verify persisted state and history`, { status: spec.output?.statusCode ?? 200, persistedState: nextState, auditAction: action }));
    } else if (["entity-collection-read", "entity-record-read", "entity-history-read"].includes(spec.operationKind)) {
      add(caseSpec(`${id}.authorized`, "api", id, role, "read a resource permitted by the operation policy", { status: 200 }));
      const authorization = spec.authorization as Record<string, unknown> | undefined;
      const actor = spec.actor as Record<string, unknown> | undefined;
      if (authorization?.ownerField || authorization?.customer || actor?.access === "owner-or-role") add(caseSpec(`${id}.ownership`, "api", id, typeof actor?.customerRole === "string" ? actor.customerRole : typeof actor?.role === "string" ? actor.role : undefined, "read a resource owned by a different principal", { status: 404 }, { status: 404, rejected: true }));
    }
  }
  // Browser coverage refers to existing operations; it never invents endpoints.
  const login = parsed.find(({ spec }) => spec.operationKind === "authentication-login")?.record.operationId;
  const create = parsed.find(({ spec }) => spec.operationKind === "entity-create")?.record.operationId;
  const submit = parsed.find(({ spec }) => Boolean(spec.transition))?.record.operationId;
  if (login) add(caseSpec("browser.auth-session", "browser", login, undefined, "authenticate, reload a protected page, and end the session", { status: 200 }));
  if (login) add(caseSpec("browser.session-expiration", "browser", login, undefined, "expire the configured session and verify protected navigation returns to authentication", { status: 401 }));
  if (create) add(caseSpec("browser.entity-create", "browser", create, undefined, "create an entity through the rendered application form", { status: 201 }));
  if (submit) add(caseSpec("browser.persisted-reload", "browser", submit, undefined, "reload and verify server-backed entity state", { status: 200 }));
  return { schemaVersion: "1.0", architectureHash, operationHashes: Object.fromEntries(parsed.map(({ record }) => [record.operationId, record.sha256])), cases, createdAt };
}

export function validateTestSpecification(spec: TestSpecification, architectureHash: string, operations: TestOperationMetadata[], roles: string[] = []): string[] {
  const issues: string[] = [];
  if (spec.schemaVersion !== "1.0") issues.push("unsupported test specification schemaVersion");
  if (spec.architectureHash !== architectureHash) issues.push("test specification belongs to a different approved architecture");
  const known = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const [operationId, hash] of Object.entries(spec.operationHashes)) {
    const operation = known.get(operationId);
    if (!operation) issues.push(`test specification references unknown operation ${operationId}`);
    else if (operation.sha256 !== hash) issues.push(`test specification operation checksum changed: ${operationId}`);
  }
  const ids = new Set<string>();
  for (const test of spec.cases) {
    if (!test.id.trim() || ids.has(test.id)) issues.push(`test case identifier is empty or duplicated: ${test.id}`);
    ids.add(test.id);
    if (!test.action.trim()) issues.push(`test case ${test.id} has no action`);
    if (!Array.isArray(test.preconditions) || !Array.isArray(test.testData) || !Array.isArray(test.cleanup)) issues.push(`test case ${test.id} has invalid structured requirements`);
    if (test.operationId && !known.has(test.operationId)) issues.push(`test case ${test.id} references unknown operation ${test.operationId}`);
    if (test.role && roles.length && !roles.includes(test.role)) issues.push(`test case ${test.id} references unknown role ${test.role}`);
    if (!["api", "database", "browser"].includes(test.layer)) issues.push(`test case ${test.id} has unknown layer`);
    if (test.origin !== "contract" && test.origin !== "model") issues.push(`test case ${test.id} has unknown provenance`);
  }
  return [...new Set(issues)];
}

export interface TestContribution { cases: Array<{ id: string; operationId: string; action: string; expectedStatus: number; role?: string }> }

/** Parse compact model output and accept only additive cases grounded in existing operations. */
export function validateTestContribution(value: unknown, base: TestSpecification, operations: TestOperationMetadata[], roles: string[]): { contribution?: TestContribution; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { issues: ["model contribution must be a JSON object"] };
  const cases = (value as { cases?: unknown }).cases;
  if (!Array.isArray(cases) || cases.length === 0 || cases.length > 4) return { issues: ["model contribution must contain one to four bounded cases"] };
  const knownOps = new Set(operations.map((operation) => operation.operationId));
  const existingIds = new Set(base.cases.map((test) => test.id));
  const result: TestContribution["cases"] = [];
  for (const [index, raw] of cases.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { issues.push(`model case ${index} must be an object`); continue; }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9.-]{2,80}$/.test(item.id) || existingIds.has(item.id) || result.some((test) => test.id === item.id)) issues.push(`model case ${index} has an invalid or duplicate test id`);
    if (typeof item.operationId !== "string" || !knownOps.has(item.operationId)) issues.push(`model case ${index} references an unknown operation`);
    if (typeof item.action !== "string" || item.action.trim().length < 30 || item.action.length > 240) issues.push(`model case ${index} action must be a concrete 30–240 character test action with an observable assertion`);
    if (typeof item.expectedStatus !== "number" || !Number.isInteger(item.expectedStatus) || item.expectedStatus < 200 || item.expectedStatus > 599) issues.push(`model case ${index} has an invalid expected status`);
    if (item.role !== undefined && (typeof item.role !== "string" || !roles.includes(item.role))) issues.push(`model case ${index} references an unknown role`);
    if (typeof item.id === "string" && typeof item.operationId === "string" && typeof item.action === "string" && typeof item.expectedStatus === "number" && item.expectedStatus >= 200 && item.expectedStatus <= 599) {
      result.push({ id: item.id, operationId: item.operationId, action: item.action, expectedStatus: item.expectedStatus, ...(typeof item.role === "string" ? { role: item.role } : {}) });
    }
  }
  if (issues.length) return { issues: [...new Set(issues)] };
  return { contribution: { cases: result }, issues: [] };
}

export function mergeTestContribution(base: TestSpecification, contribution: TestContribution): TestSpecification {
  return { ...base, cases: [...base.cases, ...contribution.cases.map((test) => ({
    id: test.id, layer: "api" as const, operationId: test.operationId, preconditions: [], testData: [], ...(test.role ? { role: test.role } : {}),
    action: test.action, expected: { status: test.expectedStatus }, cleanup: ["delete created test records"], origin: "model" as const,
  }))] };
}

export function testSpecificationSha256(spec: TestSpecification): string { return sha256(JSON.stringify(spec)); }

/** Deterministically render the validated test inventory and an executable OpenAPI contract smoke test. */
export function renderTestContractArtifacts(specification: TestSpecification, operations: TestOperationMetadata[], topology: TestApplicationTopology): Array<{ path: string; action: "create" | "modify"; content: string }> {
  if (!topology.backend.entrypoint) throw new Error("cannot render FastAPI OpenAPI test without a discovered application entrypoint");
  const [appModule, appSymbol = "app"] = topology.backend.entrypoint.split(":");
  const parsed = operations.map((record) => ({ operationId: record.operationId, spec: parseOperation(record) }));
  const endpoints = parsed.flatMap(({ operationId, spec }) => spec?.route?.method && spec.route.path
    ? [{ operationId, method: String(spec.route.method).toLowerCase(), path: String(spec.route.path), request: spec.request, input: spec.input, response: spec.response, output: spec.output }]
    : []);
  const manifest = JSON.stringify({ schemaVersion: specification.schemaVersion, architectureHash: specification.architectureHash, operationHashes: specification.operationHashes, cases: specification.cases }, null, 2) + "\n";
  const expected = JSON.stringify(JSON.stringify(endpoints));
  const python = [
    '"""Deterministic checks that generated FastAPI routes remain aligned with approved operations."""',
    "import json",
    "from pathlib import Path",
    `from ${appModule} import ${appSymbol}`,
    "",
    "EXPECTED_OPERATIONS = json.loads(" + expected + ")",
    "",
    "def test_registered_routes_match_approved_operation_contracts():",
    "    schema = app.openapi()",
    "    paths = schema.get('paths', {})",
    "    for operation in EXPECTED_OPERATIONS:",
    "        path = operation['path']",
    "        method = operation['method']",
    "        assert path in paths, f\"{operation['operationId']} route {path} is not registered\"",
    "        assert method in paths[path], f\"{operation['operationId']} method {method.upper()} is not registered\"",
    "        endpoint = paths[path][method]",
    "        request = operation.get('request') or {}",
    "        input_schema = operation.get('input') or {}",
    "        schema_name = request.get('schema') or request.get('requestSchema') or input_schema.get('requestSchema') or input_schema.get('bodySchema')",
    "        if schema_name:",
    "            body = endpoint.get('requestBody', {}).get('content', {})",
    "            assert body, f\"{operation['operationId']} is missing its request body\"",
    "            expected_type = request.get('contentType')",
    "            if expected_type:",
    "                assert expected_type in body, f\"{operation['operationId']} request content type differs from {expected_type}\"",
    "            referenced = [media.get('schema', {}).get('$ref', '').rsplit('/', 1)[-1] for media in body.values()]",
    "            assert schema_name in referenced, f\"{operation['operationId']} request schema differs from {schema_name}\"",
    "        response_schema = (operation.get('response') or {}).get('schema') or (operation.get('output') or {}).get('responseSchema')",
    "        if response_schema:",
    "            responses = endpoint.get('responses', {})",
    "            success = next((value for key, value in responses.items() if key.isdigit() and 200 <= int(key) < 300), None)",
    "            assert success, f\"{operation['operationId']} has no successful response\"",
    "            content = success.get('content', {})",
    "            if content:",
    "                referenced = [media.get('schema', {}).get('$ref', '').rsplit('/', 1)[-1] for media in content.values()]",
    "                assert response_schema in referenced, f\"{operation['operationId']} response schema differs from {response_schema}\"",
    "",
    "def test_test_inventory_references_only_approved_operations():",
    "    inventory = json.loads(Path(__file__).with_name('test_contract_manifest.json').read_text(encoding='utf-8'))",
    "    allowed = set(inventory['operationHashes'])",
    "    assert inventory['cases'], 'test inventory must not be empty'",
    "    assert all(case.get('operationId') is None or case['operationId'] in allowed for case in inventory['cases'])",
  ].join("\n") + "\n";
  return [
    { path: "backend/tests/test_contract_manifest.json", action: "create", content: manifest },
    { path: "backend/tests/test_openapi_contract.py", action: "create", content: python },
  ];
}

export function testContributionPrompt(spec: TestSpecification, operations: TestOperationMetadata[]): string {
  const summaries = operations.map((record) => {
    const operation = parseOperation(record);
    const actor = operation?.actor as Record<string, unknown> | undefined;
    return { id: record.operationId, method: operation?.route?.method, path: operation?.route?.path, role: actor?.role ?? actor?.customerRole ?? actor?.managerRole, transition: operation?.transition, request: operation?.request ?? operation?.input, failures: operation?.failures };
  });
  return [
    "Add exactly one compact application-specific automated test case to this approved test contract, using the domain operation summaries below.",
    "Return only one JSON object shaped exactly as {\"cases\":[{\"id\":\"<new-lowercase-id>\",\"operationId\":\"<exact-supplied-operation-id>\",\"action\":\"<30-240 character concrete action plus observable assertion>\",\"expectedStatus\":200,\"role\":\"<optional exact supplied role>\"}]}. Replace every placeholder with a valid value; do not return angle-bracket placeholders.",
    "The cases array must have exactly one item. id must be a new lowercase identifier using letters, digits, dots, or hyphens. operationId must exactly match a supplied ID. action must be a concrete 30–240 character test action that states an observable assertion. expectedStatus must be an integer HTTP status. role, if included, must exactly match a supplied role.",
    "Do not add routes, fields, states, code, markdown, or explanation.",
    `Existing test IDs: ${spec.cases.map((item) => item.id).join(",")}`,
    `Approved operation IDs: ${operations.map((item) => item.operationId).join(",")}`,
    `Approved operation summaries: ${JSON.stringify(summaries)}`,
  ].join("\n");
}

export function testImplementationPrompt(
  userRequirements: string,
  specification: TestSpecification,
  operations: TestOperationMetadata[],
  uiContract?: string,
  topologySummary?: string,
): string {
  const operationSummaries = operations.map((item) => {
    const spec = parseOperation(item);
    return spec ? {
      operationId: item.operationId,
      route: spec.route,
      roles: [spec.actor?.role, spec.actor?.customerRole, spec.actor?.managerRole, spec.actor?.privilegedRole].filter(Boolean),
      requestFields: spec.request?.fields?.map((field: { name: string; required: boolean; type: string }) => ({ name: field.name, required: field.required, type: field.type })) ?? spec.input?.fieldMappings?.map((field: { source?: string; sourceField?: string; targetField?: string }) => field.source === "body" ? field.sourceField ?? field.targetField : undefined).filter(Boolean),
      outputStatus: spec.output?.statusCode,
      failureStatuses: Object.values(spec.failures ?? {}).filter((value) => typeof value === "number"),
      transition: spec.transition,
    } : { operationId: item.operationId };
  });
  const cases = specification.cases.map(({ id, layer, operationId, role, action, expected, negative, origin }) => ({ id, layer, operationId, role, action, expected, negative, origin }));
  let uiSummary: unknown;
  try {
    const ui = uiContract ? JSON.parse(uiContract) as { routes?: Array<Record<string, any>> } : undefined;
    uiSummary = ui?.routes?.map((route) => ({ id: route.id, route: route.route, roles: route.roles, title: route.title, dataOperation: route.dataOperation, form: route.form && { operationId: route.form.operationId, fields: route.form.fields?.map((field: { name: string; label: string; type: string; required: boolean }) => ({ name: field.name, label: field.label, type: field.type, required: field.required })) }, actions: route.actions?.map((action: { label: string; operationId: string }) => ({ label: action.label, operationId: action.operationId })), navigation: route.navigation?.map((item: { label: string; route: string }) => item) }));
  } catch { uiSummary = "invalid UI contract JSON"; }
  return [
    "Generate only executable automated test files for this existing application. Do not edit application source, scaffold, dependencies, database schema, or business logic.",
    "Use pytest for backend API/database tests and Playwright Chromium (@playwright/test) for browser E2E. No Cypress, skipped tests, mocks for business persistence, TODOs, or placeholders.",
    "Ground all paths, methods, roles, request/response fields and UI interactions in the supplied contracts. If a required scenario cannot be exercised with the existing application, report that gap instead of inventing an endpoint.",
    "Include environment-driven base URLs and credentials, randomized synthetic data, cleanup, and assertions on actual API responses and persisted state where test database access is configured.",
    "Approved user requirements:", userRequirements.slice(0, 5_000),
    "Validated operation contracts:", JSON.stringify(operationSummaries),
    "Validated mandatory and model-contributed test cases:", JSON.stringify(cases),
    ...(uiSummary ? ["Validated UI route summary:", JSON.stringify(uiSummary)] : []),
    ...(topologySummary ? ["Discovered application topology (authoritative paths/routes/selectors; do not infer a conventional layout):", topologySummary] : []),
    "Return complete file contents in structured file-edit format. Restrict edits to backend/tests/**, frontend/e2e/**, pytest/playwright configuration, and test commands in README.md.",
  ].join("\n");
}
