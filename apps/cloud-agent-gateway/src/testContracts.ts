import { createHash } from "node:crypto";
import type { GenerationCheckpoint, ProposedEdit } from "@mobiusx/protocol";
import type { TestApplicationTopology, TestTopologyFile } from "./testTopology.js";

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

/** Preserve previously executed test-slice artifacts when a later test-stage
 * attempt resumes. A newer proposal cannot silently overwrite passing tests. */
export function reuseValidatedTestSliceArtifacts(
  generated: ProposedEdit[],
  slices: NonNullable<GenerationCheckpoint["testSubtasks"]>,
  architectureHash: string,
): ProposedEdit[] {
  const output = [...generated];
  for (const slice of slices.filter((item) => item.architectureHash === architectureHash)) {
    for (const artifact of slice.artifacts) {
      const index = output.findIndex((edit) => edit.path.toLowerCase() === artifact.path.toLowerCase());
      if (index >= 0 && output[index].content !== artifact.content) {
        output[index] = { path: artifact.path, action: artifact.action, content: artifact.content };
      } else if (index < 0) {
        output.push({ path: artifact.path, action: artifact.action, content: artifact.content });
      }
    }
  }
  return output;
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

export interface TestEnvironmentContract {
  schemaVersion: "1.0";
  architectureHash: string;
  topologyHash: string;
  operationHashes: Record<string, string>;
  backend: { entrypoint: string; databaseSessionModule: string; databaseUrlEnv: string; userModel: string; customerModel: string; auditModel: string; passwordHasher: string; modelModules: Record<string, string> };
  authentication: { module: string; method: string; path: string; usernameField: string; passwordField: string; tokenField: string; roleField: string; passwordHashField: string; allowedRoles: string[] };
  registration: { method: string; path: string; statusCode: number; requestSchema: string; requestFields: string[]; responseIdField: string; responseOwnerField: string; ownerField: string; statusField: string; initialState: string; auditAction: string; actorRole: string };
  frontend: { baseUrlEnv: string; identitiesFileEnv: string; loginRoute: string; dashboardRoute: string; usernameLabel: string; passwordLabel: string; submitLabel: string; dashboardHeading: string; recordField: string };
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

function sourceModuleForClass(files: TestTopologyFile[], className: string): { moduleName: string; body: string } | undefined {
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!/\.py$/i.test(path)) continue;
    const lines = file.content.split(/\r?\n/);
    const classIndex = lines.findIndex((line) => new RegExp(`^class\\s+${className}\\b[^\\n]*:`).test(line));
    if (classIndex < 0) continue;
    let end = classIndex + 1;
    while (end < lines.length && !/^(?:class|def|async\s+def|@)\b/.test(lines[end])) end++;
    const body = lines.slice(classIndex + 1, end).join("\n");
    return { moduleName: path.replace(/\.py$/i, "").replaceAll("/", ".").replace(/\.__init__$/, ""), body };
  }
  return undefined;
}

function pythonFields(body: string, orm = false): Set<string> {
  const pattern = orm
    ? /^\s{4}([A-Za-z_]\w*)\s*=\s*(?:Column|mapped_column)\s*\(/gm
    : /^\s{4}([A-Za-z_]\w*)\s*:/gm;
  return new Set([...body.matchAll(pattern)].map((match) => match[1]));
}

/** Bind a small executable registration test to actual modules, schemas and ORM fields. */
export function deriveTestEnvironmentContract(
  topology: TestApplicationTopology,
  files: TestTopologyFile[],
  registrationRecord: TestOperationMetadata,
  loginRecord: TestOperationMetadata,
  operations: TestOperationMetadata[],
): { contract?: TestEnvironmentContract; issues: string[] } {
  const issues: string[] = [];
  const registration = parseOperation(registrationRecord);
  const login = parseOperation(loginRecord);
  if (!registration || registration.operationKind !== "entity-create") issues.push("registration operation contract is missing or is not an entity-create operation");
  if (!login || login.operationKind !== "authentication-login") issues.push("login operation contract is missing or is not an authentication-login operation");
  const entrypoint = topology.backend.entrypoint;
  if (!entrypoint || !topology.backend.modules.includes(entrypoint.split(":")[0])) issues.push("FastAPI entrypoint is not present in discovered topology");
  if (!topology.backend.databaseSessionModule || !topology.backend.modules.includes(topology.backend.databaseSessionModule)) issues.push("database session module is not present in discovered topology");
  if (!registration || !login || !entrypoint || !topology.backend.databaseSessionModule) return { issues };

  const registerRoute = registration.route as { method?: string; path?: string } | undefined;
  const loginRoute = login.route as { method?: string; path?: string } | undefined;
  for (const [label, route] of [["registration", registerRoute], ["login", loginRoute]] as const) {
    if (!route?.method || !route.path || !topology.backend.routes.some((item) => item.method === route.method?.toUpperCase() && item.path === route.path)) issues.push(`${label} operation route is absent from discovered API topology`);
  }

  const entityName = String(registration.output?.entity ?? "");
  const auditEntityName = String(registration.audit?.entity ?? "");
  const principalName = String(login.principal?.entity ?? registration.actor?.entity ?? "");
  const entity = sourceModuleForClass(files, entityName);
  const auditEntity = sourceModuleForClass(files, auditEntityName);
  const principal = sourceModuleForClass(files, principalName);
  if (!entity) issues.push(`registration ORM entity ${entityName || "<missing>"} is absent from source files`);
  if (!auditEntity) issues.push(`audit ORM entity ${auditEntityName || "<missing>"} is absent from source files`);
  if (!principal) issues.push(`authentication principal ${principalName || "<missing>"} is absent from source files`);
  if (!entity || !auditEntity || !principal) return { issues };

  const input = registration.input as Record<string, any> | undefined;
  const output = registration.output as Record<string, any> | undefined;
  const authRequest = (login.request ?? {}) as Record<string, any>;
  const authInput = (login.input ?? {}) as Record<string, any>;
  const requestSchema = String(input?.bodySchema ?? "");
  const responseSchema = String(output?.responseSchema ?? "");
  const schema = sourceModuleForClass(files, requestSchema);
  const response = sourceModuleForClass(files, responseSchema);
  if (!schema) issues.push(`registration request schema ${requestSchema || "<missing>"} is absent from source files`);
  if (!response) issues.push(`registration response schema ${responseSchema || "<missing>"} is absent from source files`);
  const bodyMappings = (input?.fieldMappings ?? []).filter((item: any) => item?.source === "body");
  const requestFields = bodyMappings.map((item: any) => String(item.sourceField ?? item.targetField)).filter(Boolean);
  const schemaFieldSet = schema ? pythonFields(schema.body) : new Set<string>();
  const entityFieldSet = pythonFields(entity.body, true);
  const auditFieldSet = pythonFields(auditEntity.body, true);
  const principalFieldSet = pythonFields(principal.body, true);
  if (!requestFields.length) issues.push("registration operation has no request-body field mappings");
  for (const field of requestFields) {
    if (!schemaFieldSet.has(field)) issues.push(`registration request field ${field} is absent from ${requestSchema}`);
    if (!entityFieldSet.has(field)) issues.push(`registration ORM entity ${entityName} has no mapped field ${field}`);
  }

  const ownerMapping = (input?.fieldMappings ?? []).find((item: any) => item?.source === "actor");
  const statusMapping = (input?.fieldMappings ?? []).find((item: any) => item?.source === "state");
  const ownerField = String(ownerMapping?.targetField ?? "");
  const statusField = String(statusMapping?.targetField ?? "");
  const initialState = String(statusMapping?.value ?? "");
  const auditAction = String(registration.audit?.action ?? "");
  const responseFields = response ? pythonFields(response.body) : new Set<string>();
  const responseIdField = responseFields.has("id") ? "id" : "";
  const responseOwnerField = responseFields.has(ownerField) ? ownerField : "";
  if (!ownerField || !entityFieldSet.has(ownerField) || !responseOwnerField) issues.push("registration owner mapping is not represented by the ORM and response schema");
  if (!statusField || !entityFieldSet.has(statusField) || !initialState) issues.push("registration initial state mapping is not represented by the ORM entity");
  if (!auditAction || !auditFieldSet.has(String(registration.audit?.actionField ?? "action"))) issues.push("registration audit action is not represented by the audit ORM entity");
  if (!responseIdField) issues.push("registration response schema does not expose the generated id field");

  const authFields = Array.isArray(authRequest.fields) ? authRequest.fields : [];
  const usernameField = String(authInput.usernameField ?? "");
  const passwordField = String(authInput.passwordField ?? "");
  const tokenField = String(login.response?.fields?.find((field: any) => field.name === "access_token")?.name ?? "");
  const authModule = topology.authentication.module;
  const authSource = authModule ? files.find((file) => file.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\.py$/i, "").replaceAll("/", ".") === authModule)?.content ?? "" : "";
  const hasher = authSource.match(/^([A-Za-z_]\w*)\s*=\s*CryptContext\s*\(/m)?.[1] ?? "";
  const usernameHashField = [...principalFieldSet].find((field) => field === usernameField) ?? "";
  const passwordHashField = [...principalFieldSet].find((field) => /password.*hash|hashed.*password/i.test(field)) ?? "";
  const roleField = [...principalFieldSet].find((field) => field === "role") ?? "";
  if (!usernameField || !passwordField || !tokenField || !authFields.some((field: any) => field.name === usernameField) || !authFields.some((field: any) => field.name === passwordField)) issues.push("login operation request/response contract is incomplete");
  if (!authModule || !hasher || !usernameHashField || !passwordHashField || !roleField) issues.push("authentication principal password hashing bindings cannot be resolved from source");
  for (const field of ["user_id", "customer_id", "action"]) if (!auditFieldSet.has(field)) issues.push(`audit ORM entity ${auditEntityName} has no required mapped field ${field}`);

  let uiContract: Record<string, any> | undefined;
  const uiFile = files.find((file) => /(^|\/)ui-contract(?:\.v\d+)?\.json$/i.test(file.path.replaceAll("\\", "/")));
  if (uiFile) {
    try { uiContract = JSON.parse(uiFile.content) as Record<string, any>; }
    catch { issues.push("saved UI contract is not valid JSON"); }
  }
  const screens = Array.isArray(uiContract?.routes) ? uiContract!.routes as Array<Record<string, any>> : [];
  const actorRole = String(registration.actor?.role ?? "");
  const loginScreen = screens.find((screen) => screen.loginRole === actorRole && screen.form?.operationId === loginRecord.operationId);
  const dashboardScreen = screens.find((screen) => Array.isArray(screen.roles) && screen.roles.includes(actorRole) && screen.table?.entity === entityName);
  const usernameLabel = loginScreen?.form?.fields?.find((field: any) => field.name === usernameField)?.label;
  const passwordLabel = loginScreen?.form?.fields?.find((field: any) => field.name === passwordField)?.label;
  const dashboardRoute = String(dashboardScreen?.route ?? "");
  const loginPath = String(loginScreen?.route ?? "");
  const dashboardHeading = String(dashboardScreen?.title ?? "");
  const recordField = (dashboardScreen?.table?.columns ?? []).find((field: string) => requestFields.includes(field));
  const submitLabel = topology.frontend.actions.find((action) => action === "Continue") ?? "";
  if (!uiContract || !loginScreen || !dashboardScreen || !usernameLabel || !passwordLabel || !submitLabel || !recordField) issues.push("saved UI contract does not bind a customer login form and persisted-record dashboard");
  if (loginPath && !topology.frontend.routes.includes(loginPath)) issues.push(`customer login route ${loginPath} is absent from discovered frontend topology`);
  if (dashboardRoute && !topology.frontend.routes.includes(dashboardRoute)) issues.push(`customer dashboard route ${dashboardRoute} is absent from discovered frontend topology`);

  if (issues.length) return { issues: [...new Set(issues)] };
  const roleSet = new Set<string>();
  for (const record of operations) {
    const operation = parseOperation(record);
    for (const value of [operation?.actor?.role, operation?.actor?.customerRole, operation?.actor?.managerRole, operation?.actor?.privilegedRole]) if (typeof value === "string") roleSet.add(value);
  }
  const contract: TestEnvironmentContract = {
    schemaVersion: "1.0",
    architectureHash: registration.architectureHash,
    topologyHash: sha256(JSON.stringify(topology)),
    operationHashes: { [registrationRecord.operationId]: registrationRecord.sha256, [loginRecord.operationId]: loginRecord.sha256 },
    backend: {
      entrypoint,
      databaseSessionModule: topology.backend.databaseSessionModule,
      databaseUrlEnv: "DATABASE_URL",
      userModel: principalName,
      customerModel: entityName,
      auditModel: auditEntityName,
      passwordHasher: hasher,
      modelModules: { [principalName]: principal.moduleName, [entityName]: entity.moduleName, [auditEntityName]: auditEntity.moduleName },
    },
    authentication: {
      module: authModule!,
      method: String(loginRoute?.method).toUpperCase(),
      path: String(loginRoute?.path),
      usernameField,
      passwordField,
      tokenField,
      roleField,
      passwordHashField,
      allowedRoles: [...roleSet].sort(),
    },
    registration: {
      method: String(registerRoute?.method).toUpperCase(),
      path: String(registerRoute?.path),
      statusCode: Number(output?.statusCode ?? 201),
      requestSchema,
      requestFields,
      responseIdField,
      responseOwnerField,
      ownerField,
      statusField,
      initialState,
      auditAction,
      actorRole: String(registration.actor?.role ?? ""),
    },
    frontend: {
      baseUrlEnv: "E2E_BASE_URL",
      identitiesFileEnv: "MOBIUSX_PW_IDENTITIES_FILE",
      loginRoute: loginPath,
      dashboardRoute,
      usernameLabel: String(usernameLabel),
      passwordLabel: String(passwordLabel),
      submitLabel,
      dashboardHeading,
      recordField: String(recordField),
    },
  };
  return { contract, issues: [] };
}

/** Render topology-bound pytest fixtures and one real registration/persistence integration test. */
export function renderRegistrationPytestVerticalSlice(contract: TestEnvironmentContract): Array<{ path: string; action: "create"; content: string }> {
  const literal = JSON.stringify(JSON.stringify(contract));
  const [appModule, appSymbol = "app"] = contract.backend.entrypoint.split(":");
  const userModuleName = contract.backend.modelModules[contract.backend.userModel] ?? "";
  const customerModuleName = contract.backend.modelModules[contract.backend.customerModel] ?? "";
  const auditModuleName = contract.backend.modelModules[contract.backend.auditModel] ?? "";
  if (!userModuleName || !customerModuleName || !auditModuleName) throw new Error("test environment contract is missing resolved ORM module bindings");
  const databaseModule = contract.backend.databaseSessionModule;
  const authModule = contract.authentication.module;
  const schemaFields = contract.registration.requestFields;
  const payloadLines = schemaFields.map((field) => {
    const lower = field.toLowerCase();
    const expression = /email/.test(lower)
      ? `f"${field.replace(/"/g, "\\\"")}-{suffix}@example.test"`
      : /reference|code|number/.test(lower)
        ? `f"${field.replace(/"/g, "\\\"")}-{suffix}"`
        : `f"${field.replace(/"/g, "\\\"").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())} {suffix}"`;
    return `        ${JSON.stringify(field)}: ${expression},`;
  }).join("\n");
  const roles = contract.authentication.allowedRoles;
  const roleFixtures = roles.map((role) => {
    const fixtureName = `${role.replace(/[^A-Za-z0-9_]/g, "_")}_identity`;
    return `@pytest.fixture\ndef ${fixtureName}(identity_factory):\n    return identity_factory(${JSON.stringify(role)})`;
  }).join("\n\n");
  const conftest = [
    '"""Generated test fixtures bound to the validated TestEnvironmentContract."""',
    "import asyncio",
    "import json",
    "import os",
    "import uuid",
    "from pathlib import Path",
    "from typing import Any, Awaitable, Callable",
    "import pytest",
    "from fastapi.testclient import TestClient",
    "from sqlalchemy import delete, select",
    "from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine",
    "from sqlalchemy.pool import NullPool",
    `from ${appModule} import ${appSymbol}`,
    `from ${databaseModule} import get_db`,
    `from ${userModuleName} import ${contract.backend.userModel}`,
    `from ${customerModuleName} import ${contract.backend.customerModel}`,
    `from ${auditModuleName} import ${contract.backend.auditModel}`,
    `from ${authModule} import ${contract.backend.passwordHasher}`,
    "",
    `TEST_ENVIRONMENT = json.loads(${literal})`,
    "_URL_ENV = TEST_ENVIRONMENT['backend']['databaseUrlEnv']",
    "if not os.environ.get(_URL_ENV):",
    "    raise RuntimeError(f\"Set {_URL_ENV} to an isolated PostgreSQL test database before running generated tests\")",
    "",
    "@pytest.fixture(scope='session')",
    "def client():",
    "    with TestClient(app) as test_client:",
    "        yield test_client",
    "",
    "@pytest.fixture",
    "def database_operation():",
    "    def run(operation: Callable[[AsyncSession], Awaitable[Any]]) -> Any:",
    "        async def execute() -> Any:",
    "            engine = create_async_engine(os.environ[_URL_ENV], poolclass=NullPool)",
    "            factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)",
    "            try:",
    "                async with factory() as session:",
    "                    return await operation(session)",
    "            finally:",
    "                await engine.dispose()",
    "        return asyncio.run(execute())",
    "    return run",
    "",
    "@pytest.fixture",
    "def identity_factory(client, database_operation):",
    "    created_user_ids: list[int] = []",
    "    user_model = getattr(__import__(TEST_ENVIRONMENT['backend']['modelModules'][TEST_ENVIRONMENT['backend']['userModel']], fromlist=[TEST_ENVIRONMENT['backend']['userModel']]), TEST_ENVIRONMENT['backend']['userModel'])",
    "    password_hasher = getattr(__import__(TEST_ENVIRONMENT['authentication']['module'], fromlist=[TEST_ENVIRONMENT['backend']['passwordHasher']]), TEST_ENVIRONMENT['backend']['passwordHasher'])",
    "    auth = TEST_ENVIRONMENT['authentication']",
    "    def create(role: str) -> dict[str, Any]:",
    "        if role not in auth['allowedRoles']:",
    "            raise ValueError(f'Role is not defined by the approved operation contracts: {role}')",
    "        suffix = uuid.uuid4().hex",
    "        username = f\"test-{role}-{suffix}\"",
    "        password = f\"Test-{suffix}-Aa9!\"",
    "        user = user_model(**{",
    "            auth['usernameField']: username,",
    "            auth['passwordHashField']: password_hasher.hash(password),",
    "            auth['roleField']: role,",
    "        })",
    "        async def insert_user(session: AsyncSession) -> int:",
    "            session.add(user)",
    "            await session.flush()",
    "            user_id = int(user.id)",
    "            await session.commit()",
    "            return user_id",
    "        user_id = database_operation(insert_user)",
    "        created_user_ids.append(user_id)",
    "        response = client.post(auth['path'], json={auth['usernameField']: username, auth['passwordField']: password})",
    "        assert response.status_code == 200, f\"Provisioned identity could not authenticate: {response.status_code} {response.text}\"",
    "        token = response.json()[auth['tokenField']]",
    "        return {'id': user_id, 'username': username, 'password': password, 'token': token, 'headers': {'Authorization': f'Bearer {token}'}}",
    "    yield create",
    "    if created_user_ids:",
    "        async def cleanup(session: AsyncSession) -> None:",
    `            customer_model = getattr(__import__(TEST_ENVIRONMENT['backend']['modelModules'][TEST_ENVIRONMENT['backend']['customerModel']], fromlist=[TEST_ENVIRONMENT['backend']['customerModel']]), TEST_ENVIRONMENT['backend']['customerModel'])`,
    `            audit_model = getattr(__import__(TEST_ENVIRONMENT['backend']['modelModules'][TEST_ENVIRONMENT['backend']['auditModel']], fromlist=[TEST_ENVIRONMENT['backend']['auditModel']]), TEST_ENVIRONMENT['backend']['auditModel'])`,
    "            customer_ids = list((await session.scalars(select(customer_model.id).where(getattr(customer_model, TEST_ENVIRONMENT['registration']['ownerField']).in_(created_user_ids)))).all())",
    "            if customer_ids:",
    "                await session.execute(delete(audit_model).where(audit_model.customer_id.in_(customer_ids)))",
    "                await session.execute(delete(customer_model).where(customer_model.id.in_(customer_ids)))",
    "            await session.execute(delete(audit_model).where(audit_model.user_id.in_(created_user_ids)))",
    "            await session.execute(delete(user_model).where(user_model.id.in_(created_user_ids)))",
    "            await session.commit()",
    "        database_operation(cleanup)",
    "",
    roleFixtures,
    "",
  ].join("\n");
  const test = [
    '"""One generated customer registration integration test with independent SQL assertions."""',
    "import json",
    "import uuid",
    "from pathlib import Path",
    "from sqlalchemy import select",
    `from ${userModuleName} import ${contract.backend.userModel}`,
    `from ${customerModuleName} import ${contract.backend.customerModel}`,
    `from ${auditModuleName} import ${contract.backend.auditModel}`,
    "",
    "CONTRACT = json.loads(Path(__file__).with_name('test_environment.v1.json').read_text(encoding='utf-8'))",
    "",
    "def test_customer_registration_persists_for_authenticated_owner(client, customer_identity, database_operation):",
    "    registration = CONTRACT['registration']",
    "    suffix = uuid.uuid4().hex",
    "    payload = {",
    payloadLines,
    "    }",
    "    response = client.request(registration['method'], registration['path'], json=payload, headers=customer_identity['headers'])",
    "    assert response.status_code == registration['statusCode'], response.text",
    "    body = response.json()",
    "    customer_id = body[registration['responseIdField']]",
    "    assert body[registration['responseOwnerField']] == customer_identity['id']",
    "    async def inspect_persisted_state(session):",
    `        customer = await session.scalar(select(${contract.backend.customerModel}).where(${contract.backend.customerModel}.id == customer_id))`,
    "        assert customer is not None, 'registration response must correspond to a persisted row'",
    "        status_value = getattr(getattr(customer, registration['statusField']), 'value', getattr(customer, registration['statusField']))",
    "        events = list((await session.scalars(select(" + contract.backend.auditModel + ").where(" + contract.backend.auditModel + ".customer_id == customer_id).order_by(" + contract.backend.auditModel + ".created_at.asc(), " + contract.backend.auditModel + ".id.asc()))).all())",
    "        return {'owner_id': getattr(customer, registration['ownerField']), 'status': status_value, 'events': [(event.user_id, event.action) for event in events]}",
    "    persisted = database_operation(inspect_persisted_state)",
    "    assert persisted['owner_id'] == customer_identity['id']",
    "    assert persisted['status'] == registration['initialState']",
    "    assert (customer_identity['id'], registration['auditAction']) in persisted['events']",
    "",
  ].join("\n");
  return [
    { path: "backend/tests/test_environment.v1.json", action: "create", content: JSON.stringify(contract, null, 2) + "\n" },
    { path: "backend/tests/conftest.py", action: "create", content: conftest },
    { path: "backend/tests/test_customer_registration_vertical_slice.py", action: "create", content: test },
  ];
}

/** Render one browser ownership/reload test and disposable DB identity provisioner from verified bindings. */
export function renderCustomerDashboardPlaywrightSlice(contract: TestEnvironmentContract): Array<{ path: string; action: "create"; content: string }> {
  const literal = JSON.stringify(JSON.stringify(contract));
  const fixture = [
    '"""Seed short-lived browser identities and records in the isolated generated-app database."""',
    "import asyncio",
    "import json",
    "import os",
    "import uuid",
    "from pathlib import Path",
    "from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine",
    "from sqlalchemy.pool import NullPool",
    "",
    `TEST_ENVIRONMENT = json.loads(${literal})`,
    "",
    "def _sample_value(field: str, suffix: str) -> str:",
    "    lowered = field.lower()",
    "    if 'email' in lowered:",
    "        return f'{field}-{suffix}@example.test'",
    "    if any(token in lowered for token in ('reference', 'code', 'number')):",
    "        return f'{field}-{suffix}'",
    "    return f'{field.replace(\"_\", \" \").title()} {suffix}'",
    "",
    "async def _provision() -> dict:",
    "    import importlib",
    "    backend = TEST_ENVIRONMENT['backend']",
    "    auth = TEST_ENVIRONMENT['authentication']",
    "    registration = TEST_ENVIRONMENT['registration']",
    "    user_model = getattr(importlib.import_module(backend['modelModules'][backend['userModel']]), backend['userModel'])",
    "    customer_model = getattr(importlib.import_module(backend['modelModules'][backend['customerModel']]), backend['customerModel'])",
    "    password_hasher = getattr(importlib.import_module(auth['module']), backend['passwordHasher'])",
    "    engine = create_async_engine(os.environ[backend['databaseUrlEnv']], poolclass=NullPool)",
    "    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)",
    "    result = {}",
    "    try:",
    "        async with sessions() as session:",
    "            records = []",
    "            for label in ('customer', 'other'):",
    "                suffix = uuid.uuid4().hex",
    "                username = f\"browser-{label}-{suffix}\"",
    "                password = f\"Browser-{suffix}-Aa9!\"",
    "                owner = user_model(**{auth['usernameField']: username, auth['passwordHashField']: password_hasher.hash(password), auth['roleField']: registration['actorRole']})",
    "                session.add(owner)",
    "                await session.flush()",
    "                values = {field: _sample_value(field, suffix) for field in registration['requestFields']}",
    "                values[registration['ownerField']] = owner.id",
    "                values[registration['statusField']] = registration['initialState']",
    "                customer = customer_model(**values)",
    "                session.add(customer)",
    "                await session.flush()",
    "                if label == 'customer':",
    "                    result['customer'] = {'username': username, 'password': password, 'record': getattr(customer, TEST_ENVIRONMENT['frontend']['recordField'])}",
    "                else:",
    "                    result['otherCustomerRecord'] = getattr(customer, TEST_ENVIRONMENT['frontend']['recordField'])",
    "            await session.commit()",
    "    finally:",
    "        await engine.dispose()",
    "    return result",
    "",
    "def main() -> None:",
    "    output = os.environ.get(TEST_ENVIRONMENT['frontend']['identitiesFileEnv'])",
    "    if not output:",
    "        raise RuntimeError(f\"Set {TEST_ENVIRONMENT['frontend']['identitiesFileEnv']} to a temporary credentials-file path\")",
    "    path = Path(output)",
    "    path.parent.mkdir(parents=True, exist_ok=True)",
    "    path.write_text(json.dumps(asyncio.run(_provision())), encoding='utf-8')",
    "    path.chmod(0o600)",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "",
  ].join("\n");
  // The field used in the dashboard is bound into the fixture's JSON contract, not a guessed route or selector.
  const provisioner = fixture.replace("registration['frontendRecordField']", "TEST_ENVIRONMENT['frontend']['recordField']");
  const spec = [
    'import { expect, test } from "@playwright/test";',
    'import { readFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    "",
    `const contract = ${JSON.stringify(contract, null, 2)};`,
    "const identityPath = process.env[contract.frontend.identitiesFileEnv];",
    "if (!identityPath) throw new Error(`Set ${contract.frontend.identitiesFileEnv} to the provisioned temporary identity file`);",
    "const identities = JSON.parse(readFileSync(resolve(identityPath), 'utf8')) as { customer: { username: string; password: string; record: string }; otherCustomerRecord: string };",
    "",
    "test('customer sees only persisted owned records after reload', async ({ page }) => {",
    "  const pageErrors: string[] = [];",
    "  const failedRequests: string[] = [];",
    "  page.on('pageerror', (error) => pageErrors.push(error.message));",
    "  page.on('requestfailed', (request) => {",
    "    if (/^https?:/.test(request.url())) failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`);",
    "  });",
    "  await page.goto(contract.frontend.loginRoute);",
    "  await page.getByLabel(contract.frontend.usernameLabel).fill(identities.customer.username);",
    "  await page.getByLabel(contract.frontend.passwordLabel).fill(identities.customer.password);",
    "  await page.getByRole('button', { name: contract.frontend.submitLabel }).click();",
    "  await expect(page).toHaveURL(new RegExp(`${contract.frontend.dashboardRoute.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/?$`));",
    "  await expect(page.getByRole('heading', { name: contract.frontend.dashboardHeading })).toBeVisible();",
    "  await expect(page.getByRole('cell', { name: identities.customer.record, exact: true })).toBeVisible();",
    "  await expect(page.getByRole('cell', { name: identities.otherCustomerRecord, exact: true })).toHaveCount(0);",
    "  await page.reload();",
    "  await expect(page.getByRole('heading', { name: contract.frontend.dashboardHeading })).toBeVisible();",
    "  await expect(page.getByRole('cell', { name: identities.customer.record, exact: true })).toBeVisible();",
    "  await expect(page.getByRole('cell', { name: identities.otherCustomerRecord, exact: true })).toHaveCount(0);",
    "  expect(pageErrors).toEqual([]);",
    "  expect(failedRequests).toEqual([]);",
    "});",
    "",
  ].join("\n");
  const config = [
    'import { defineConfig } from "@playwright/test";',
    "",
    "export default defineConfig({",
    "  testDir: './e2e',",
    "  testMatch: '**/*.spec.ts',",
    "  fullyParallel: false,",
    "  workers: 1,",
    "  reporter: 'list',",
    "  use: {",
    `    baseURL: process.env.${contract.frontend.baseUrlEnv} ?? 'http://127.0.0.1:3000',`,
    "    browserName: 'chromium',",
    "    headless: true,",
    "    trace: 'retain-on-failure',",
    "    screenshot: 'only-on-failure',",
    "  },",
    "});",
    "",
  ].join("\n");
  return [
    { path: "backend/tests/provision_browser_identity.py", action: "create", content: provisioner },
    { path: "frontend/playwright.config.ts", action: "create", content: config },
    { path: "frontend/e2e/customer-dashboard-owner-isolation.spec.ts", action: "create", content: spec },
  ];
}
