import type { ProjectArchitectureContract } from "@mobiusx/protocol";
import { createHash } from "node:crypto";

export interface BusinessOperationCheckpointRecord { operationId: string; architectureHash: string; content: string; sha256: string; createdAt: string }
export interface SupersededBusinessOperationRecord extends BusinessOperationCheckpointRecord { supersededBySha256: string; supersededAt: string; reason: string }

/** Safely migrate the legacy auth.login checkpoint while retaining its exact historical bytes. */
export function upgradeAuthenticationLoginCheckpoint(
  saved: BusinessOperationCheckpointRecord,
  architecture: ProjectArchitectureContract,
  modelSource: string,
  schemaSource: string,
  authSource: string,
  targetModule: string,
  upgradedAt = new Date().toISOString(),
): { current: BusinessOperationCheckpointRecord; history?: SupersededBusinessOperationRecord; upgraded: boolean } {
  if (saved.operationId !== "auth.login" || saved.architectureHash !== architecture.contractHash || createHash("sha256").update(saved.content).digest("hex") !== saved.sha256) throw new Error("saved auth.login operation has a PAC mismatch or checksum error");
  const prior = JSON.parse(saved.content) as { schemaVersion?: string };
  if (prior.schemaVersion === "2.0") return { current: saved, upgraded: false };
  if (prior.schemaVersion !== "1.0") throw new Error(`unsupported saved auth.login contract version ${String(prior.schemaVersion)}`);
  const operation = createAuthenticationLoginOperationSpec(architecture, modelSource, schemaSource, targetModule, authSource);
  const content = JSON.stringify(operation);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    current: { operationId: "auth.login", architectureHash: architecture.contractHash, content, sha256, createdAt: upgradedAt },
    history: { ...saved, supersededBySha256: sha256, supersededAt: upgradedAt, reason: "Reconstructed missing request/response contract metadata from the validated generated FastAPI schemas." },
    upgraded: true,
  };
}

export interface AuthenticationLoginOperationSpec {
  schemaVersion: "2.0";
  operationKind: "authentication-login";
  operationId: "auth.login";
  architectureHash: string;
  targetModule: string;
  route: { method: "POST"; path: string; functionName: string };
  input: { requestSchema: string; usernameField: string; passwordField: string };
  request: { contentType: "application/json"; fields: Array<{ name: string; type: string; required: boolean; constraints?: Record<string, number> }> };
  principal: { entity: string; subjectField: string };
  dependencies: { authenticator: string; tokenIssuer: string; responseSchema: string; tokenTypeField: string };
  response: { contentType: "application/json"; schema: string; fields: Array<{ name: string; type: string; required: boolean }> };
  session: { scheme: "bearer"; tokenField: string; tokenTypeField: string; expiration: { claim: "exp"; defaultSeconds: number }; logout: "client-token-removal" };
  failures: { invalidCredentials: 401; validation: 422 };
}

function pydanticFields(className: string, source: string): AuthenticationLoginOperationSpec["request"]["fields"] {
  const body = source.match(new RegExp(`class\\s+${className}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\nclass\\s|$)`))?.[1] ?? "";
  return [...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*:\s*([\w.\[\], |]+)(?:\s*=\s*(.*))?$/gm)].map((match) => {
    const [, name, annotation, defaultValue = ""] = match;
    const constraints: Record<string, number> = {};
    for (const [key, outputKey] of [["min_length", "minLength"], ["max_length", "maxLength"], ["ge", "minimum"], ["le", "maximum"]] as const) {
      const value = defaultValue.match(new RegExp(`${key}\\s*=\\s*(\\d+)`))?.[1];
      if (value) constraints[outputKey] = Number(value);
    }
    const type = /\bstr\b/.test(annotation) ? "string" : /\bint\b/.test(annotation) ? "integer" : /\bfloat\b/.test(annotation) ? "number" : /\bbool\b/.test(annotation) ? "boolean" : "unknown";
    return { name, type, required: !defaultValue || /Field\s*\(\s*\.\.\./.test(defaultValue), ...(Object.keys(constraints).length ? { constraints } : {}) };
  });
}

/** Resolve the login operation from the approved conventional FastAPI
 * request/response interfaces and actual generated User model fields. */
export function createAuthenticationLoginOperationSpec(
  architecture: ProjectArchitectureContract,
  modelSource: string,
  schemaSource: string,
  targetModule = architecture.modules.find((module) => module.path === "backend/routes/auth.py")?.path ?? "backend/routes/auth.py",
  authSource = "",
): AuthenticationLoginOperationSpec {
  const requestFields = pydanticFields("LoginRequest", schemaSource);
  const responseFields = pydanticFields("TokenResponse", schemaSource);
  const userBody = modelSource.match(/class\s+User\b[^\n]*\n([\s\S]*?)(?=\nclass\s|$)/)?.[1] ?? "";
  const userFields = [...userBody.matchAll(/^\s*([A-Za-z_]\w*)\s*(?::|=)/gm)].map((match) => match[1]);
  const usernameField = ["username", "email"].find((field) => requestFields.some((item) => item.name === field) && userFields.includes(field));
  const passwordField = ["password"].find((field) => requestFields.some((item) => item.name === field));
  const subjectField = [usernameField, "id"].find((field) => field && userFields.includes(field));
  const tokenTypeField = ["token_type"].find((field) => responseFields.some((item) => item.name === field));
  const responseSchema = "TokenResponse";
  const expiry = authSource.match(/timedelta\(minutes\s*=\s*(\d+)\)/)?.[1];
  return {
    schemaVersion: "2.0", operationKind: "authentication-login", operationId: "auth.login",
    architectureHash: architecture.contractHash, targetModule,
    route: { method: "POST", path: "/auth/login", functionName: "login" },
    input: { requestSchema: "LoginRequest", usernameField: usernameField ?? "username", passwordField: passwordField ?? "password" },
    request: { contentType: "application/json", fields: requestFields },
    principal: { entity: "User", subjectField: subjectField ?? "username" },
    dependencies: { authenticator: "authenticate_user", tokenIssuer: "create_access_token", responseSchema, tokenTypeField: tokenTypeField ?? "token_type" },
    response: { contentType: "application/json", schema: responseSchema, fields: responseFields.map(({ name, type, required }) => ({ name, type, required })) },
    session: { scheme: "bearer", tokenField: "access_token", tokenTypeField: tokenTypeField ?? "token_type", expiration: { claim: "exp", defaultSeconds: expiry ? Number(expiry) * 60 : 900 }, logout: "client-token-removal" },
    failures: { invalidCredentials: 401, validation: 422 },
  };
}

/** Compare a saved auth operation's complete request/response contract to app.openapi(). */
export function validateAuthenticationLoginOpenApi(value: unknown, openApi: unknown): string[] {
  const spec = value as AuthenticationLoginOperationSpec;
  const document = openApi as {
    paths?: Record<string, Record<string, {
      requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    }>>;
    components?: { schemas?: Record<string, { properties?: Record<string, { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }>; required?: string[] }> };
  };
  const operation = document.paths?.[spec.route.path]?.[spec.route.method.toLowerCase()];
  if (!operation) return [`OpenAPI is missing ${spec.route.method} ${spec.route.path}`];
  const issues: string[] = [];
  const refName = (ref?: string) => ref?.split("/").at(-1);
  const requestMedia = operation.requestBody?.content?.[spec.request?.contentType];
  if (!requestMedia) issues.push(`OpenAPI login request content type must be ${spec.request?.contentType ?? "declared"}`);
  const requestName = refName(requestMedia?.schema?.$ref);
  if (requestName !== spec.input.requestSchema) issues.push(`OpenAPI login request schema must reference ${spec.input.requestSchema}`);
  const requestSchema = requestName ? document.components?.schemas?.[requestName] : undefined;
  for (const field of spec.request?.fields ?? []) {
    const property = requestSchema?.properties?.[field.name];
    if (!property) issues.push(`OpenAPI login request is missing field ${field.name}`);
    else {
      if (property.type !== field.type) issues.push(`OpenAPI login field ${field.name} type does not match ${field.type}`);
      if (field.required !== (requestSchema?.required ?? []).includes(field.name)) issues.push(`OpenAPI login field ${field.name} required status does not match`);
      for (const [constraint, expected] of Object.entries(field.constraints ?? {})) if (property[constraint as keyof typeof property] !== expected) issues.push(`OpenAPI login field ${field.name} constraint ${constraint} does not match`);
    }
  }
  const responseMedia = operation.responses?.["200"]?.content?.[spec.response?.contentType];
  if (!responseMedia) issues.push(`OpenAPI login response content type must be ${spec.response?.contentType ?? "declared"}`);
  const responseName = refName(responseMedia?.schema?.$ref);
  if (responseName !== spec.response?.schema) issues.push(`OpenAPI login response schema must reference ${spec.response?.schema}`);
  const responseSchema = responseName ? document.components?.schemas?.[responseName] : undefined;
  for (const field of spec.response?.fields ?? []) {
    const property = responseSchema?.properties?.[field.name];
    if (!property) issues.push(`OpenAPI login response is missing field ${field.name}`);
    else if (property.type !== field.type) issues.push(`OpenAPI login response field ${field.name} type does not match ${field.type}`);
    else if (field.required !== (responseSchema?.required ?? []).includes(field.name)) issues.push(`OpenAPI login response field ${field.name} required status does not match`);
  }
  for (const statusCode of ["401", "422"]) if (!operation.responses?.[statusCode]) issues.push(`OpenAPI login operation is missing HTTP ${statusCode} response`);
  return [...new Set(issues)];
}

/** Validate the small, reusable login operation against existing PAC modules
 * and generated interfaces. Roles remain persisted domain data, never route
 * constants or client-supplied input. */
export function validateAuthenticationLoginOperationSpec(
  value: unknown,
  architecture: ProjectArchitectureContract,
  authSource: string,
  modelSource: string,
  schemaSource: string,
): string[] {
  const issues: string[] = [];
  const spec = value as Partial<AuthenticationLoginOperationSpec>;
  const safeIdentifier = /^[A-Za-z_]\w*$/;
  if (spec.schemaVersion !== "2.0" || spec.operationKind !== "authentication-login" || spec.operationId !== "auth.login") issues.push("unsupported authentication operation contract");
  if (spec.architectureHash !== architecture.contractHash) issues.push("authentication operation PAC hash mismatch");
  const target = architecture.modules.find((module) => module.path === spec.targetModule && module.path.startsWith("backend/routes/"));
  if (!target || !target.provides.includes("router")) issues.push("authentication operation target is not a PAC route module exporting router");
  if (spec.route?.method !== "POST" || !/^\/[A-Za-z0-9_{}\-/]+$/.test(spec.route.path ?? "") || !safeIdentifier.test(spec.route.functionName ?? "")) issues.push("authentication login route is invalid");
  if (!safeIdentifier.test(spec.input?.requestSchema ?? "") || !safeIdentifier.test(spec.input?.usernameField ?? "") || !safeIdentifier.test(spec.input?.passwordField ?? "")) issues.push("authentication request fields are invalid");
  if (!safeIdentifier.test(spec.principal?.entity ?? "") || !safeIdentifier.test(spec.principal?.subjectField ?? "")) issues.push("authentication principal contract is invalid");
  if (!safeIdentifier.test(spec.dependencies?.authenticator ?? "") || !safeIdentifier.test(spec.dependencies?.tokenIssuer ?? "") || !safeIdentifier.test(spec.dependencies?.responseSchema ?? "") || !safeIdentifier.test(spec.dependencies?.tokenTypeField ?? "")) issues.push("authentication helper/schema references are invalid");
  if (spec.failures?.invalidCredentials !== 401) issues.push("invalid credentials must return HTTP 401");
  if (spec.failures?.validation !== 422 || spec.request?.contentType !== "application/json" || spec.response?.contentType !== "application/json") issues.push("authentication request/response content types or validation failure contract is invalid");
  if (spec.response?.schema !== spec.dependencies?.responseSchema || spec.session?.scheme !== "bearer" || spec.session?.tokenField !== "access_token" || !Number.isInteger(spec.session?.expiration?.defaultSeconds)) issues.push("authentication response/session contract is incomplete");
  if (!spec.request?.fields?.some((field) => field.name === spec.input?.usernameField) || !spec.request?.fields?.some((field) => field.name === spec.input?.passwordField) || !spec.response?.fields?.some((field) => field.name === spec.session?.tokenField) || !spec.response?.fields?.some((field) => field.name === spec.session?.tokenTypeField)) issues.push("authentication credential or token fields are not present in their declared schemas");
  const classBody = (name: string, source: string) => source.match(new RegExp(`class\\s+${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\nclass\\s|$)`))?.[1] ?? "";
  const actualRequestFields = pydanticFields(spec.input?.requestSchema ?? "", schemaSource);
  const actualResponseFields = pydanticFields(spec.dependencies?.responseSchema ?? "", schemaSource);
  if (!spec.request?.fields?.length || spec.request.fields.some((field) => field.type === "unknown")) issues.push("login request schema must declare supported typed fields");
  if (JSON.stringify(spec.request?.fields) !== JSON.stringify(actualRequestFields)) issues.push("authentication request metadata does not match the generated Pydantic request schema");
  if (JSON.stringify(spec.response?.fields) !== JSON.stringify(actualResponseFields.map(({ name, type, required }) => ({ name, type, required })))) issues.push("authentication response metadata does not match the generated Pydantic response schema");
  if (!new RegExp(`^\\s*${spec.input?.usernameField}\\s*:`, "m").test(classBody(spec.input?.requestSchema ?? "", schemaSource))) issues.push("login schema does not declare the approved username field");
  if (!new RegExp(`^\\s*${spec.input?.passwordField}\\s*:`, "m").test(classBody(spec.input?.requestSchema ?? "", schemaSource))) issues.push("login schema does not declare the approved password field");
  if (!new RegExp(`^\\s*${spec.dependencies?.tokenTypeField}\\s*:`, "m").test(classBody(spec.dependencies?.responseSchema ?? "", schemaSource))) issues.push("token response schema does not declare the approved token type field");
  if (!new RegExp(`class\\s+${spec.principal?.entity}\\b`).test(modelSource) || !new RegExp(`^\\s*${spec.principal?.subjectField}\\s*[:=]`, "m").test(classBody(spec.principal?.entity ?? "", modelSource))) issues.push("authentication principal subject is not a declared ORM field");
  if (!new RegExp(`async\\s+def\\s+${spec.dependencies?.authenticator}\\s*\\(`).test(authSource)) issues.push("authentication verifier is not an async function in the PAC auth module");
  if (!new RegExp(`async\\s+def\\s+${spec.dependencies?.tokenIssuer}\\s*\\(`).test(authSource)) issues.push("token issuer must be an async function in the PAC auth module");
  return [...new Set(issues)];
}

/** Render the stable FastAPI login boundary from a validated operation. */
export function renderAuthenticationLoginOperation(spec: AuthenticationLoginOperationSpec): string {
  const call = (name: string, args: string, isAsync: boolean) => `${isAsync ? "await " : ""}${name}(${args})`;
  return [
    "from fastapi import APIRouter, Depends, HTTPException, status",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from backend.database import get_db",
    `from backend.schemas import ${spec.input.requestSchema}, ${spec.dependencies.responseSchema}`,
    `from backend.auth import ${spec.dependencies.authenticator}, ${spec.dependencies.tokenIssuer}`,
    "",
    "router = APIRouter()",
    "",
    `@router.post(${JSON.stringify(spec.route.path)}, response_model=${spec.dependencies.responseSchema}, responses={401: {"description": "Invalid credentials"}})`,
    `async def ${spec.route.functionName}(payload: ${spec.input.requestSchema}, db: AsyncSession = Depends(get_db)):` ,
    `    principal = ${call(spec.dependencies.authenticator, `payload.${spec.input.usernameField}, payload.${spec.input.passwordField}, db`, true)}`,
    "    if principal is None or principal is False:",
    "        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=\"Invalid credentials\", headers={\"WWW-Authenticate\": \"Bearer\"})",
    `    token = ${call(spec.dependencies.tokenIssuer, `{\"sub\": str(principal.${spec.principal.subjectField})}`, true)}`,
    `    return ${spec.dependencies.responseSchema}(access_token=token, ${spec.dependencies.tokenTypeField}=\"bearer\")`,
    "",
  ].join("\n");
}

export interface BusinessOperationSpec {
  schemaVersion: "1.0";
  operationId: string;
  architectureHash: string;
  targetModule: string;
  route: { method: "POST"; path: string; functionName: string };
  actor: { entity: string; role: string; permission: string };
  managerScope?: { userField: "review_scope_id"; subjectField: "review_scope_id" };
  input: { pathParams: Array<{ name: string; entity: string; field: string; type: "integer" }> };
  output: { entity: string; responseSchema: string; statusCode: number };
  preconditions: Array<
    | { kind: "owner_is_actor"; entity: string; field: string }
    | { kind: "state_is"; entity: string; field: string; value: string }
    | { kind: "audit_absent"; entity: string; subjectField: string; actionField: string; action: string }
    | { kind: "audit_exists"; entity: string; subjectField: string; actionField: string; action: string }
  >;
  mutation: { entity: string; field: string; value: string };
  audit: { entity: string; action: string; actorField: string; subjectField: string; actionField: string };
  transition: { entity: string; field: string; from: string; to: string; auditAction: string };
  transaction: { driver: "sqlalchemy-async"; scope: "single-request"; atomic: true; rollbackOnError: true };
  concurrency?: { strategy: "row-lock" };
  idempotency: { strategy: "reject-duplicate-audit"; auditAction: string };
  failures: { notFound: 404; forbidden: 403; invalidTransition: 409; rollbackOnError: true };
}

export interface ComplementaryDecisionOverrides {
  operationId: string;
  permission: string;
  routePath: string;
  functionName: string;
  toState: string;
  auditAction: string;
}

/** Derive a sibling terminal decision from a validated transition contract. */
export function deriveComplementaryDecisionOperation(
  source: BusinessOperationSpec,
  overrides: ComplementaryDecisionOverrides,
): BusinessOperationSpec {
  const preconditions = source.preconditions.map((condition) => condition.kind === "audit_absent"
    ? { ...condition, action: overrides.auditAction }
    : { ...condition });
  return {
    ...source,
    operationId: overrides.operationId,
    route: { ...source.route, path: overrides.routePath, functionName: overrides.functionName },
    actor: { ...source.actor, permission: overrides.permission },
    preconditions,
    mutation: { ...source.mutation, value: overrides.toState },
    audit: { ...source.audit, action: overrides.auditAction },
    transition: { ...source.transition, to: overrides.toState, auditAction: overrides.auditAction },
    idempotency: { ...source.idempotency, auditAction: overrides.auditAction },
  };
}

export interface EntityCreateOperationSpec {
  schemaVersion: "1.0";
  operationKind: "entity-create";
  operationId: string;
  architectureHash: string;
  targetModule: string;
  route: { method: "POST"; path: string; functionName: string };
  actor: { entity: "User"; role: string; permission: string };
  input: { bodySchema: string; fieldMappings: Array<{ targetField: string; source: "body" | "actor" | "state" | "credential"; sourceField?: string; value?: string }> };
  requestOnlyFields?: string[];
  credentialHashing?: { requestField: string; targetField: string; hasher: "crypt_context.hash" };
  duplicateFields?: string[];
  scopeAssignment?: "inherit-authenticated-customer";
  output: { entity: string; responseSchema: string; statusCode: 201 };
  audit: { entity: string; action: string; actorField: string; subjectField: string; actionField: string };
  transaction: { driver: "sqlalchemy-async"; scope: "single-request"; atomic: true; rollbackOnError: true };
  failures: { duplicate: 409; rollbackOnError: true };
}

export type BusinessOperationContract = BusinessOperationSpec | EntityCreateOperationSpec;

/** Read operations declare their query and authorization policy as data so the
 * same renderer can support audit timelines and other owner-scoped histories. */
export interface EntityHistoryReadOperationSpec {
  schemaVersion: "3.0";
  operationKind: "entity-history-read";
  operationId: string;
  architectureHash: string;
  targetModule: string;
  route: { method: "GET"; path: string; functionName: string };
  actor: { entity: "User"; access: "owner-or-role"; ownerEntity: string; ownerField: string; privilegedRole: string };
  managerAuthorization: { mode: "global" } | { mode: "review-scope"; userField: "review_scope_id"; subjectField: "review_scope_id" };
  subject: { entity: string; idField: string };
  output: { entity: string; subjectField: string; responseSchema: string; statusCode: 200; orderBy: string[] };
  transaction: { driver: "sqlalchemy-async"; scope: "single-request"; readOnly: true };
  failures: { notFound: 404; forbidden: 403 };
}

/** A collection read contract names the manager policy explicitly: global
 * access is valid when the immutable PAC has no review-scope relationship. */
export interface EntityCollectionReadOperationSpec {
  schemaVersion: "1.0";
  operationKind: "entity-collection-read";
  operationId: "customer.listOwn" | "manager.listReviewQueue";
  architectureHash: string;
  targetModule: string;
  route: { method: "GET"; path: "/customers"; functionName: string };
  actor: { entity: "User"; customerRole: "customer"; managerRole: "manager" };
  authorization: {
    customer: { entity: "Customer"; ownerField: "owner_id"; actorField: "id" };
    manager: { mode: "global" | "review-scope"; userScopeField?: "review_scope_id"; customerScopeField?: "review_scope_id"; requiresSubmittedAudit: boolean };
  };
  query: { statusField: "status"; pageSizeDefault: number; pageSizeMaximum: number; orderBy: ["created_at", "id"] };
  output: { entity: "Customer"; responseSchema: string; statusCode: 200 };
  transaction: { driver: "sqlalchemy-async"; scope: "single-request"; readOnly: true };
  failures: { unauthenticated: 401; forbidden: 403 };
}

export interface EntityRecordReadOperationSpec {
  schemaVersion: "1.0";
  operationKind: "entity-record-read";
  operationId: "customer.getOwn" | "manager.getReviewable";
  architectureHash: string;
  targetModule: string;
  route: { method: "GET"; path: "/customers/{customer_id}"; functionName: string };
  actor: { entity: "User"; customerRole: "customer"; managerRole: "manager" };
  authorization: { ownerField: "owner_id"; ownerActorField: "id"; manager: { mode: "global" } | { mode: "review-scope"; userScopeField: "review_scope_id"; customerScopeField: "review_scope_id" } };
  output: { entity: "Customer"; responseSchema: string; statusCode: 200; unauthorized: 404 };
  transaction: { driver: "sqlalchemy-async"; scope: "single-request"; readOnly: true };
}

export interface BusinessDomainCatalog {
  entities: Record<string, { fields: string[]; states?: string[] }>;
  roles: string[];
  permissions: string[];
  responseSchemas: string[];
  requestSchemas: Record<string, string[]>;
  responseSchemaFields?: Record<string, string[]>;
  entityProperties?: Record<string, Record<string, EntityPropertyContract>>;
  requestProperties?: Record<string, Record<string, SchemaPropertyContract>>;
  enumMembers?: Record<string, Record<string, string>>;
}

export interface EntityPropertyContract {
  type: string;
  required: boolean;
  optional: boolean;
  primaryKey: boolean;
  serverGenerated: boolean;
  unique: boolean;
  foreignKey?: string;
  enumName?: string;
}

export interface SchemaPropertyContract { type: string; required: boolean; optional: boolean }

function classSourceBody(source: string, name: string): string {
  const match = source.match(new RegExp(`^class\\s+${name}\\s*\\([^\\n]+\\)\\s*:\\s*$`, "m"));
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const next = source.slice(start).search(/^class\s+\w+\s*\(/m);
  return next < 0 ? source.slice(start) : source.slice(start, start + next);
}

function pythonTypeName(value: string): string {
  const type = value.replace(/\s/g, "");
  if (/^(?:str|String|Text|EmailStr)(?:\[.*\])?$/.test(type)) return "string";
  if (/^(?:int|Integer|BigInteger|SmallInteger)$/.test(type)) return "integer";
  if (/^(?:float|Float|Numeric|Decimal)$/.test(type)) return "number";
  if (/^(?:bool|Boolean)$/.test(type)) return "boolean";
  if (/^(?:datetime|DateTime|date|Date)$/.test(type)) return "datetime";
  if (/^(?:Enum|.*Status)$/.test(type)) return "enum";
  return type.toLowerCase();
}

function classFields(source: string, name: string): Record<string, SchemaPropertyContract> {
  const result: Record<string, SchemaPropertyContract> = {};
  const body = classSourceBody(source, name);
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s{4}([A-Za-z_]\w*)\s*:\s*([^=]+?)(?:\s*=\s*(.*))?\s*$/);
    if (!match) continue;
    const [, field, rawType, defaultValue] = match;
    const requiredMarker = /^\s*(?:Field\s*\(\s*\.\.\.|\.\.\.)/.test(defaultValue ?? "");
    const optional = /(?:\bOptional\[|\|\s*None\b|None\s*\|)/.test(rawType) || (defaultValue !== undefined && !requiredMarker);
    const type = pythonTypeName(rawType.replace(/\bOptional\[([^\]]+)\]/, "$1").replace(/\|\s*None|None\s*\|/g, ""));
    result[field] = { type, required: !optional, optional };
  }
  return result;
}

function parseEntityProperties(modelSource: string, name: string): Record<string, EntityPropertyContract> {
  const properties: Record<string, EntityPropertyContract> = {};
  const body = classSourceBody(modelSource, name);
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s{4}([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*(?:Column|mapped_column)\((.*)\)\s*$/);
    if (!match) continue;
    const [, field, annotation = "", args] = match;
    const primaryKey = /\bprimary_key\s*=\s*True/.test(args);
    const nullable = /\bnullable\s*=\s*False/.test(args) || primaryKey;
    const hasDefault = /\b(?:default|server_default|server_onupdate)\s*=/.test(args);
    const foreignKey = args.match(/ForeignKey\(\s*["']([^"']+)["']\s*\)/)?.[1];
    const enumName = args.match(/^\s*Enum\(\s*([A-Za-z_]\w*)/)?.[1];
    const firstArg = args.split(",")[0]?.trim() ?? "";
    const type = pythonTypeName(annotation.replace(/^Mapped\[|\]$/g, "") || firstArg.split("(")[0] || "unknown");
    properties[field] = {
      type, required: nullable && !primaryKey && !hasDefault, optional: !nullable || hasDefault || primaryKey,
      primaryKey, serverGenerated: primaryKey || hasDefault || field === "id",
      unique: /\bunique\s*=\s*True/.test(args) || new RegExp(`UniqueConstraint\\([^)]*\\b${field}\\b`).test(body),
      ...(foreignKey ? { foreignKey } : {}),
      ...(enumName ? { enumName } : {}),
    };
  }
  return properties;
}

/** Derive writable fields from ORM/schema declarations. Relationships, keys,
 * defaults, ownership and lifecycle state stay server controlled. */
export function deriveEntityCreateFieldContract(input: {
  modelSource: string; schemaSource: string; entity: string; bodySchema: string; responseSchema?: string; actorEntity?: string; actorFields?: string[];
}): { mappings: EntityCreateOperationSpec["input"]["fieldMappings"]; requestOnlyFields: string[]; credentialHashing?: EntityCreateOperationSpec["credentialHashing"]; duplicateFields: string[]; requiredOrmFields: string[]; responseSchemas: Record<string, string[]>; issues: string[] } {
  const modelBody = classSourceBody(input.modelSource, input.entity);
  if (!modelBody) return { mappings: [], requestOnlyFields: [], duplicateFields: [], requiredOrmFields: [], responseSchemas: {}, issues: [`ORM entity ${input.entity} was not found`] };
  const entityProperties = parseEntityProperties(input.modelSource, input.entity);
  const requestProperties = classFields(input.schemaSource, input.bodySchema);
  if (!Object.keys(requestProperties).length) return { mappings: [], requestOnlyFields: [], duplicateFields: [], requiredOrmFields: [], responseSchemas: {}, issues: [`request schema ${input.bodySchema} was not found or has no typed fields`] };
  const mappings: EntityCreateOperationSpec["input"]["fieldMappings"] = [];
  const requestOnlyFields: string[] = [];
  const issues: string[] = [];
  let credentialHashing: EntityCreateOperationSpec["credentialHashing"];
  for (const [field, property] of Object.entries(requestProperties)) {
    if (field === "password" && entityProperties.password_hash) {
      credentialHashing = { requestField: field, targetField: "password_hash", hasher: "crypt_context.hash" };
      mappings.push({ targetField: "password_hash", source: "credential", sourceField: field });
      continue;
    }
    const target = entityProperties[field];
    if (!target) {
      if (!property.required) { requestOnlyFields.push(field); continue; }
      issues.push(`required request field ${input.bodySchema}.${field} has no ORM mapping or declared request-only behavior`);
      continue;
    }
    if (target.primaryKey || target.serverGenerated || /(?:^|_)(?:owner|created_by|user)_id$/i.test(field) || /^(?:status|state|role)$/i.test(field)) {
      issues.push(`request field ${input.bodySchema}.${field} must not supply a server-managed ORM field`);
      continue;
    }
    if (property.type !== target.type && !(property.type === "enum" && target.type === "enum")) {
      issues.push(`type mismatch for ${input.bodySchema}.${field} (${property.type}) -> ${input.entity}.${field} (${target.type})`);
      continue;
    }
    mappings.push({ targetField: field, source: "body", sourceField: field });
  }
  const userBody = classSourceBody(input.modelSource, input.actorEntity ?? "User");
  const userTable = userBody.match(/^\s{4}__tablename__\s*=\s*["']([^"']+)["']/m)?.[1];
  const actorFields = classSourceBody(input.modelSource, input.actorEntity ?? "User");
  const primaryActorKey = actorFields.match(/^\s{4}([A-Za-z_]\w*)\s*=\s*(?:Column|mapped_column)\([^\n]*primary_key\s*=\s*True/m)?.[1]
    ?? Object.entries(classFields(input.modelSource, input.actorEntity ?? "User"))[0]?.[0]
    ?? "id";
  for (const [field, property] of Object.entries(entityProperties)) {
    if (!property.required || mappings.some((mapping) => mapping.targetField === field)) continue;
    if (field === `${(input.actorEntity ?? "User").toLowerCase()}_id` || (property.foreignKey && userTable && property.foreignKey === `${userTable}.${primaryActorKey}`)) {
      mappings.push({ targetField: field, source: "actor", sourceField: primaryActorKey });
    } else if (input.actorFields?.includes(field)) {
      mappings.push({ targetField: field, source: "actor", sourceField: field });
    }
  }
  const requiredOrmFields = Object.entries(entityProperties).filter(([, property]) => property.required).map(([field]) => field);
  for (const field of requiredOrmFields) {
    if (!mappings.some((mapping) => mapping.targetField === field)) issues.push(`required ORM field ${input.entity}.${field} has no request, actor, or server-default mapping`);
  }
  const duplicateFields = Object.entries(entityProperties).filter(([, property]) => property.unique).map(([field]) => field);
  const responseSchemas: Record<string, string[]> = {};
  const responseClasses = [...input.schemaSource.matchAll(/^class\s+([A-Za-z_]\w*Response)\s*\([^\n]+\)\s*:\s*$/gm)]
    .filter((match) => !input.responseSchema || match[1] === input.responseSchema);
  for (const match of responseClasses) {
    const fields = classFields(input.schemaSource, match[1]);
    responseSchemas[match[1]] = Object.keys(fields);
    for (const [field, schemaField] of Object.entries(fields)) {
      if (!entityProperties[field]) issues.push(`response schema ${match[1]}.${field} is not an ORM entity field`);
      else if (/password|secret|token|credential/i.test(field)) issues.push(`response schema ${match[1]}.${field} exposes a sensitive field`);
      else if (schemaField.type !== entityProperties[field].type && !(schemaField.type === "enum" && entityProperties[field].type === "enum")) issues.push(`response type mismatch for ${match[1]}.${field}`);
    }
  }
  return { mappings, requestOnlyFields, ...(credentialHashing ? { credentialHashing } : {}), duplicateFields, requiredOrmFields, responseSchemas, issues: [...new Set(issues)] };
}

export function createEntityCreateOperationSpec(input: {
  architecture: ProjectArchitectureContract; catalog: BusinessDomainCatalog; modelSource: string; schemaSource: string;
  operationId: string; targetModule: string; routePath: string; functionName: string; actorRole: string; permission: string;
  entity: string; bodySchema: string; responseSchema: string; auditEntity: string; auditAction: string;
  auditActorField: string; auditSubjectField: string; auditActionField: string; serverState?: { field: string; value: string };
}): { spec: EntityCreateOperationSpec; fieldContract: ReturnType<typeof deriveEntityCreateFieldContract>; issues: string[] } {
  const fieldContract = deriveEntityCreateFieldContract({
    modelSource: input.modelSource, schemaSource: input.schemaSource, entity: input.entity,
    bodySchema: input.bodySchema, responseSchema: input.responseSchema,
    actorFields: input.architecture.reviewScope ? [input.architecture.reviewScope.userField] : [],
  });
  const stateMapping = input.serverState && input.catalog.entities[input.entity]?.fields.includes(input.serverState.field)
    && input.catalog.entities[input.entity]?.states?.includes(input.serverState.value)
    ? [{ targetField: input.serverState.field, source: "state" as const, value: input.serverState.value }]
    : [];
  const spec: EntityCreateOperationSpec = {
    schemaVersion: "1.0", operationKind: "entity-create", operationId: input.operationId,
    architectureHash: input.architecture.contractHash, targetModule: input.targetModule,
    route: { method: "POST", path: input.routePath, functionName: input.functionName },
    actor: { entity: "User", role: input.actorRole, permission: input.permission },
    input: { bodySchema: input.bodySchema, fieldMappings: [...fieldContract.mappings, ...stateMapping] },
    requestOnlyFields: fieldContract.requestOnlyFields,
    ...(fieldContract.credentialHashing ? { credentialHashing: fieldContract.credentialHashing } : {}),
    duplicateFields: fieldContract.duplicateFields,
    ...(input.architecture.reviewScope && input.actorRole === "customer" ? { scopeAssignment: "inherit-authenticated-customer" } : {}),
    output: { entity: input.entity, responseSchema: input.responseSchema, statusCode: 201 },
    audit: { entity: input.auditEntity, action: input.auditAction, actorField: input.auditActorField, subjectField: input.auditSubjectField, actionField: input.auditActionField },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
    failures: { duplicate: 409, rollbackOnError: true },
  };
  return { spec, fieldContract, issues: [...fieldContract.issues, ...validateEntityCreateOperationSpec(spec, input.architecture, input.catalog)] };
}

export interface CustomerReadOperationContracts {
  customerList: EntityCollectionReadOperationSpec;
  managerQueue: EntityCollectionReadOperationSpec;
  customerDetail: EntityRecordReadOperationSpec;
  managerDetail: EntityRecordReadOperationSpec;
  auditHistory: EntityHistoryReadOperationSpec;
}

export function appendCustomerPageResponseSchema(source: string): string {
  if (/^class\s+CustomerPageResponse\s*\(/m.test(source)) return source;
  if (!/^class\s+CustomerResponse\s*\(/m.test(source)) throw new Error("CustomerPageResponse requires the PAC CustomerResponse schema");
  return `${source.trimEnd()}\n\nclass CustomerPageResponse(BaseModel):\n    items: list[CustomerResponse]\n    total: int\n    offset: int\n    limit: int\n`;
}

export function createCustomerReadOperationContracts(
  architecture: ProjectArchitectureContract,
  modelSource: string,
  schemaSource: string,
  targetModule = "backend/routes/customers.py",
): CustomerReadOperationContracts {
  const schemas = appendCustomerPageResponseSchema(schemaSource);
  const catalog = extractBusinessDomainCatalog(architecture, modelSource, schemas, ["customer", "manager"], ["customer.listOwn", "manager.listReviewQueue", "customer.getOwn", "manager.getReviewable", "customer.audit.read"]);
  const collectionBase = {
    schemaVersion: "1.0" as const, operationKind: "entity-collection-read" as const, architectureHash: architecture.contractHash, targetModule,
    route: { method: "GET" as const, path: "/customers" as const, functionName: "get_customers" },
    actor: { entity: "User" as const, customerRole: "customer" as const, managerRole: "manager" as const },
    authorization: {
      customer: { entity: "Customer" as const, ownerField: "owner_id" as const, actorField: "id" as const },
      manager: architecture.reviewScope
        ? { mode: "review-scope" as const, userScopeField: architecture.reviewScope.userField, customerScopeField: architecture.reviewScope.customerField, requiresSubmittedAudit: true }
        : { mode: "global" as const, requiresSubmittedAudit: true },
    },
    query: { statusField: "status" as const, pageSizeDefault: 25, pageSizeMaximum: 100, orderBy: ["created_at", "id"] as ["created_at", "id"] },
    output: { entity: "Customer" as const, responseSchema: "CustomerPageResponse", statusCode: 200 as const },
    transaction: { driver: "sqlalchemy-async" as const, scope: "single-request" as const, readOnly: true as const },
    failures: { unauthenticated: 401 as const, forbidden: 403 as const },
  };
  const recordBase = {
    schemaVersion: "1.0" as const, operationKind: "entity-record-read" as const, architectureHash: architecture.contractHash, targetModule,
    route: { method: "GET" as const, path: "/customers/{customer_id}" as const, functionName: "get_customer" },
    actor: { entity: "User" as const, customerRole: "customer" as const, managerRole: "manager" as const },
    authorization: { ownerField: "owner_id" as const, ownerActorField: "id" as const, manager: architecture.reviewScope
      ? { mode: "review-scope" as const, userScopeField: architecture.reviewScope.userField, customerScopeField: architecture.reviewScope.customerField }
      : { mode: "global" as const } },
    output: { entity: "Customer" as const, responseSchema: "CustomerResponse", statusCode: 200 as const, unauthorized: 404 as const },
    transaction: { driver: "sqlalchemy-async" as const, scope: "single-request" as const, readOnly: true as const },
  };
  const result: CustomerReadOperationContracts = {
    customerList: { ...collectionBase, operationId: "customer.listOwn" },
    managerQueue: { ...collectionBase, operationId: "manager.listReviewQueue" },
    customerDetail: { ...recordBase, operationId: "customer.getOwn" },
    managerDetail: { ...recordBase, operationId: "manager.getReviewable" },
    auditHistory: {
      schemaVersion: "3.0", operationKind: "entity-history-read", operationId: "customer.audit.read", architectureHash: architecture.contractHash, targetModule,
      route: { method: "GET", path: "/customers/{customer_id}/audit", functionName: "read_customer_audit_history" },
      actor: { entity: "User", access: "owner-or-role", ownerEntity: "Customer", ownerField: "owner_id", privilegedRole: "manager" },
      managerAuthorization: architecture.reviewScope
        ? { mode: "review-scope", userField: architecture.reviewScope.userField, subjectField: architecture.reviewScope.customerField }
        : { mode: "global" },
      subject: { entity: "Customer", idField: "id" },
      output: { entity: "AuditEvent", subjectField: "customer_id", responseSchema: "AuditEventResponse", statusCode: 200, orderBy: ["created_at", "id"] },
      transaction: { driver: "sqlalchemy-async", scope: "single-request", readOnly: true },
      failures: { notFound: 404, forbidden: 403 },
    },
  };
  const errors = [
    ...validateEntityCollectionReadOperationSpec(result.customerList, architecture, catalog),
    ...validateEntityCollectionReadOperationSpec(result.managerQueue, architecture, catalog),
    ...validateEntityRecordReadOperationSpec(result.customerDetail, architecture, catalog),
    ...validateEntityRecordReadOperationSpec(result.managerDetail, architecture, catalog),
    ...validateEntityHistoryReadOperationSpec(result.auditHistory, architecture, catalog),
  ];
  if (errors.length) throw new Error(`customer read operation contract failed PAC validation: ${[...new Set(errors)].join("; ")}`);
  return result;
}

export function extractBusinessDomainCatalog(
  architecture: ProjectArchitectureContract,
  modelSource: string,
  schemaSource: string,
  approvedRoles: string[],
  approvedPermissions: string[],
): BusinessDomainCatalog {
  const entities: BusinessDomainCatalog["entities"] = {};
  const entityProperties: NonNullable<BusinessDomainCatalog["entityProperties"]> = {};
  const enumMembers: NonNullable<BusinessDomainCatalog["enumMembers"]> = {};
  const classes = [...modelSource.matchAll(/^class\s+([A-Za-z_]\w*)\s*\(Base\)\s*:\s*$/gm)];
  for (let index = 0; index < classes.length; index += 1) {
    const match = classes[index];
    const name = match[1];
    const body = modelSource.slice(match.index! + match[0].length, classes[index + 1]?.index ?? modelSource.length);
    const fields = [...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*=\s*(?:Column|mapped_column|relationship)\s*\(/gm)].map((field) => field[1]);
    entities[name] = { fields };
    entityProperties[name] = parseEntityProperties(modelSource, name);
  }
  const allClasses = [...modelSource.matchAll(/^class\s+([A-Za-z_]\w*)\s*\([^\n]+\)\s*:\s*$/gm)];
  for (let index = 0; index < allClasses.length; index += 1) {
    const match = allClasses[index];
    if (!/Enum\)$|Enum\(|Status$/.test(match[0] + match[1])) continue;
    const body = modelSource.slice(match.index! + match[0].length, allClasses[index + 1]?.index ?? modelSource.length);
    const members: Record<string, string> = {};
    for (const field of body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*=\s*["']([^"']+)["']/gm)) members[field[2]] = field[1];
    if (Object.keys(members).length) enumMembers[match[1]] = members;
  }
  const statusClassIndex = allClasses.findIndex((match) => /Status$/.test(match[1]));
  if (statusClassIndex >= 0) {
    const statusClass = allClasses[statusClassIndex];
    const statusBody = modelSource.slice(statusClass.index! + statusClass[0].length, allClasses[statusClassIndex + 1]?.index ?? modelSource.length);
    const states = [...statusBody.matchAll(/^\s{4}\w+\s*=\s*["']([^"']+)["']/gm)].map((state) => state[1]);
    if (entities.Customer && states.length) entities.Customer.states = states;
  }
  const roleDefaults = [...modelSource.matchAll(/\brole\s*=\s*(?:Column|mapped_column)\([^\n]*default\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const declaredRoles = [...modelSource.matchAll(/require_role\(["']([a-z][a-z0-9_-]*)["']\)/g)].map((match) => match[1]);
  const responseSchemas = [...schemaSource.matchAll(/^class\s+([A-Za-z_]\w*Response)\s*\(/gm)].map((match) => match[1]);
  const requestSchemas: Record<string, string[]> = {};
  const requestProperties: NonNullable<BusinessDomainCatalog["requestProperties"]> = {};
  const schemaClasses = [...schemaSource.matchAll(/^class\s+([A-Za-z_]\w*)\s*\([^\n]+\)\s*:\s*$/gm)];
  for (let index = 0; index < schemaClasses.length; index += 1) {
    const match = schemaClasses[index];
    const body = schemaSource.slice(match.index! + match[0].length, schemaClasses[index + 1]?.index ?? schemaSource.length);
    requestSchemas[match[1]] = [...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*:/gm)].map((field) => field[1]);
    requestProperties[match[1]] = classFields(schemaSource, match[1]);
  }
  const responseSchemaFields: Record<string, string[]> = Object.fromEntries(responseSchemas.map((schema) => [schema, Object.keys(classFields(schemaSource, schema))]));
  const approvedRouteModules = architecture.modules.filter((module) => module.path.startsWith("backend/routes/")).map((module) => module.path);
  if (!approvedRouteModules.includes("backend/routes/customers.py")) throw new Error("PAC has no approved customer route module for this operation");
  return {
    entities,
    roles: [...new Set([...approvedRoles, ...roleDefaults, ...declaredRoles])],
    permissions: [...new Set(approvedPermissions)],
    responseSchemas,
    requestSchemas,
    responseSchemaFields,
    entityProperties,
    requestProperties,
    enumMembers,
  };
}

export function validateEntityHistoryReadOperationSpec(value: unknown, architecture: ProjectArchitectureContract, catalog: BusinessDomainCatalog): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["history-read operation must be a JSON object"];
  const spec = value as Partial<EntityHistoryReadOperationSpec>;
  const issues: string[] = [];
  if (spec.schemaVersion !== "3.0" || spec.operationKind !== "entity-history-read") issues.push("unsupported history-read operation schema");
  if (typeof spec.operationId !== "string" || !safeOperationId.test(spec.operationId)) issues.push("invalid business operation identifier");
  if (spec.architectureHash !== architecture.contractHash) issues.push("business operation architecture hash does not match the PAC");
  if (!architecture.modules.some((module) => module.path === spec.targetModule && module.path.startsWith("backend/routes/"))) issues.push("business operation target module is not an approved PAC route module");
  if (spec.route?.method !== "GET" || typeof spec.route.path !== "string" || !safePath.test(spec.route.path) || !identifier.test(spec.route.functionName ?? "")) issues.push("history-read route is invalid or unsupported");
  if (spec.actor?.entity !== "User" || spec.actor.access !== "owner-or-role" || !catalog.roles.includes(spec.actor.privilegedRole)) issues.push("history-read actor policy must allow the owner or an approved privileged role");
  if (!catalog.entities[spec.actor?.ownerEntity ?? ""]?.fields.includes(spec.actor?.ownerField ?? "")) issues.push("history-read owner policy references an unknown entity field");
  if (spec.managerAuthorization?.mode === "global") {
    if (architecture.reviewScope) issues.push("global manager history access conflicts with the PAC review-scope policy");
  } else if (spec.managerAuthorization?.mode === "review-scope") {
    if (spec.managerAuthorization.userField !== "review_scope_id" || spec.managerAuthorization.subjectField !== "review_scope_id" || !architecture.reviewScope || !catalog.entities.User?.fields.includes(spec.managerAuthorization.userField) || !catalog.entities[spec.subject?.entity ?? ""]?.fields.includes(spec.managerAuthorization.subjectField)) issues.push("history-read manager scope must be declared by the PAC and domain model");
  } else issues.push("history-read manager authorization must explicitly declare global or PAC-approved review-scope access");
  if (!catalog.entities[spec.subject?.entity ?? ""]?.fields.includes(spec.subject?.idField ?? "")) issues.push("history-read subject references an unknown entity field");
  if (!catalog.entities[spec.output?.entity ?? ""] || !catalog.entities[spec.output?.entity ?? ""]?.fields.includes(spec.output?.subjectField ?? "") || !spec.output?.responseSchema || !catalog.responseSchemas.includes(spec.output.responseSchema)) issues.push("history-read output entity, subject field, or response schema is unknown");
  if (spec.output?.statusCode !== 200 || !spec.output?.orderBy?.length || spec.output.orderBy.some((field) => !catalog.entities[spec.output!.entity]?.fields.includes(field))) issues.push("history-read output ordering must use declared entity fields");
  if (spec.transaction?.driver !== "sqlalchemy-async" || spec.transaction.scope !== "single-request" || spec.transaction.readOnly !== true) issues.push("history-read must use the approved read-only SQLAlchemy request scope");
  if (spec.failures?.notFound !== 404 || spec.failures.forbidden !== 403) issues.push("history-read failure behavior is incomplete");
  return [...new Set(issues)];
}

/** Upgrade only the known pre-v3 checkpoint shape that incorrectly required
 * review_scope_id when the immutable PAC has no review-scope relationship. */
export function reconcileEntityHistoryReadOperation(
  saved: unknown,
  canonical: EntityHistoryReadOperationSpec,
  architecture: ProjectArchitectureContract,
): { operation: EntityHistoryReadOperationSpec; replacedLegacyScope: boolean } {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { operation: canonical, replacedLegacyScope: false };
  const value = saved as { schemaVersion?: unknown; managerScope?: unknown };
  if (value.schemaVersion === "2.0" && value.managerScope !== undefined && !architecture.reviewScope) {
    return { operation: canonical, replacedLegacyScope: true };
  }
  return { operation: saved as EntityHistoryReadOperationSpec, replacedLegacyScope: false };
}

export function appendEntityHistoryReadOperation(source: string, spec: EntityHistoryReadOperationSpec): string {
  const imports = [
    "from fastapi import APIRouter, Depends, HTTPException",
    "from sqlalchemy import select",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from backend.auth import get_current_user",
    "from backend.database import get_db",
    `from backend.models import ${[spec.actor.entity, spec.subject.entity, spec.output.entity].join(", ")}`,
    `from backend.schemas import ${spec.output.responseSchema}`,
  ];
  let result = removeExistingRoute(source.trimEnd(), spec.route.path, spec.route.method);
  for (const statement of imports) if (!result.split(/\r?\n/).includes(statement)) result = `${statement}\n${result}`;
  if (!/^\s*router\s*=\s*APIRouter\s*\(/m.test(result)) result = `router = APIRouter()\n${result}`;
  const pathParameter = spec.route.path.match(/\{([A-Za-z_]\w*)\}/)?.[1];
  if (!pathParameter) throw new Error("history-read route must declare one path parameter");
  const ordering = spec.output.orderBy.map((field) => `        ${spec.output.entity}.${field}.asc(),`).join("\n");
  const managerSubjectLookup = spec.managerAuthorization.mode === "global"
    ? `    if current_user.role == ${JSON.stringify(spec.actor.privilegedRole)}:\n        subject_result = await db.execute(select(${spec.subject.entity}).where(${spec.subject.entity}.${spec.subject.idField} == ${pathParameter}))`
    : `    if current_user.role == ${JSON.stringify(spec.actor.privilegedRole)}:\n        if current_user.${spec.managerAuthorization.userField} is None:\n            raise HTTPException(status_code=403, detail="Manager has no review scope")\n        subject_result = await db.execute(select(${spec.subject.entity}).where(${spec.subject.entity}.${spec.subject.idField} == ${pathParameter}, ${spec.subject.entity}.${spec.managerAuthorization.subjectField} == current_user.${spec.managerAuthorization.userField}))`;
  const route = [
    "", "# Generated from a PAC-validated entity-history-read operation.",
    `@router.get(${JSON.stringify(spec.route.path)}, response_model=list[${spec.output.responseSchema}])`,
    `async def ${spec.route.functionName}(${pathParameter}: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):` ,
    ...managerSubjectLookup.split("\n"),
    `    elif current_user.role == "customer":`,
    `        subject_result = await db.execute(select(${spec.subject.entity}).where(${spec.subject.entity}.${spec.subject.idField} == ${pathParameter}, ${spec.subject.entity}.${spec.actor.ownerField} == current_user.id))`,
    "    else:",
    "        raise HTTPException(status_code=403, detail=\"Insufficient permissions\")",
    "    subject = subject_result.scalar_one_or_none()",
    "    if subject is None:",
    "        raise HTTPException(status_code=404, detail=\"Customer not found\")",
    `    result = await db.execute(select(${spec.output.entity}).where(${spec.output.entity}.${spec.output.subjectField} == ${pathParameter}).order_by(`,
    ordering,
    "    ))",
    "    return result.scalars().all()", "",
  ].join("\n");
  return `${result.trimEnd()}\n${route}`;
}

export function validateEntityCollectionReadOperationSpec(value: unknown, architecture: ProjectArchitectureContract, catalog: BusinessDomainCatalog): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["collection-read operation must be a JSON object"];
  const spec = value as Partial<EntityCollectionReadOperationSpec>;
  const issues: string[] = [];
  if (spec.schemaVersion !== "1.0" || spec.operationKind !== "entity-collection-read") issues.push("unsupported collection-read operation schema");
  if (spec.operationId !== "customer.listOwn" && spec.operationId !== "manager.listReviewQueue") issues.push("collection-read operation identifier is not approved");
  if (spec.architectureHash !== architecture.contractHash) issues.push("collection-read architecture hash does not match the PAC");
  if (!architecture.modules.some((module) => module.path === spec.targetModule && module.path.startsWith("backend/routes/"))) issues.push("collection-read target module is not an approved PAC route module");
  if (spec.route?.method !== "GET" || spec.route.path !== "/customers" || !identifier.test(spec.route.functionName ?? "")) issues.push("collection-read route is invalid or unsupported");
  if (!catalog.entities.Customer?.fields.includes("owner_id") || !catalog.entities.User?.fields.includes("id")) issues.push("collection-read ownership rule references unknown fields");
  if (spec.actor?.entity !== "User" || spec.actor.customerRole !== "customer" || spec.actor.managerRole !== "manager") issues.push("collection-read must define explicit customer and manager roles");
  if (spec.authorization?.customer?.entity !== "Customer" || spec.authorization.customer.ownerField !== "owner_id" || spec.authorization.customer.actorField !== "id") issues.push("customer collection must filter by authenticated ownership");
  if (spec.authorization?.manager?.requiresSubmittedAudit !== true) issues.push("manager queue must include submitted-audit evidence");
  if (spec.authorization?.manager?.mode === "global") {
    if (architecture.reviewScope) issues.push("global manager queue access conflicts with the PAC review-scope policy");
    if (spec.authorization.manager.userScopeField || spec.authorization.manager.customerScopeField) issues.push("global manager queue contract must not include review-scope fields");
  } else if (spec.authorization?.manager?.mode === "review-scope") {
    if (spec.authorization.manager.userScopeField !== "review_scope_id" || spec.authorization.manager.customerScopeField !== "review_scope_id" || !catalog.entities.User?.fields.includes("review_scope_id") || !catalog.entities.Customer?.fields.includes("review_scope_id") || !architecture.reviewScope) issues.push("manager queue scope must be declared by the PAC and domain model");
  } else issues.push("manager queue must explicitly declare global access or a PAC-approved review scope");
  if (spec.query?.statusField !== "status" || spec.query.pageSizeDefault !== 25 || spec.query.pageSizeMaximum !== 100 || JSON.stringify(spec.query.orderBy) !== JSON.stringify(["created_at", "id"])) issues.push("collection-read pagination, filtering, or ordering policy is invalid");
  if (spec.output?.entity !== "Customer" || !catalog.responseSchemas.includes(spec.output.responseSchema ?? "") || spec.output.statusCode !== 200) issues.push("collection-read output schema is unknown");
  if (spec.transaction?.driver !== "sqlalchemy-async" || spec.transaction.scope !== "single-request" || spec.transaction.readOnly !== true) issues.push("collection-read must use the approved read-only SQLAlchemy request scope");
  if (spec.failures?.unauthenticated !== 401 || spec.failures.forbidden !== 403) issues.push("collection-read failure behavior is incomplete");
  return [...new Set(issues)];
}

export function appendEntityCollectionReadOperation(source: string, spec: EntityCollectionReadOperationSpec): string {
  const imports = [
    "from fastapi import APIRouter, Depends, HTTPException, Query",
    "from sqlalchemy import select, func, exists",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from backend.auth import get_current_user",
    "from backend.database import get_db",
    "from backend.models import AuditEvent, Customer, CustomerStatus, User",
    `from backend.schemas import ${spec.output.responseSchema}`,
  ];
  let result = removeExistingRoute(source.trimEnd(), spec.route.path, spec.route.method);
  for (const statement of imports) if (!result.split(/\r?\n/).includes(statement)) result = `${statement}\n${result}`;
  if (!/^\s*router\s*=\s*APIRouter\s*\(/m.test(result)) result = `router = APIRouter()\n${result}`;
  const fn = [
    "", "# Generated from a PAC-validated owner-and-manager-policy collection operation.",
    `@router.get(${JSON.stringify(spec.route.path)}, response_model=${spec.output.responseSchema})`,
    `async def ${spec.route.functionName}(status_filter: CustomerStatus | None = Query(default=None, alias="status"), offset: int = Query(0, ge=0), limit: int = Query(${spec.query.pageSizeDefault}, ge=1, le=${spec.query.pageSizeMaximum}), db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):` ,
    "    statement = select(Customer)",
    "    predicates = []",
    "    if current_user.role == \"customer\":",
    "        predicates.append(Customer.owner_id == current_user.id)",
    "    elif current_user.role == \"manager\":",
    ...(spec.authorization.manager.mode === "review-scope" ? [
      "        if current_user.review_scope_id is None:",
      "            raise HTTPException(status_code=403, detail=\"Manager has no review scope\")",
      "        predicates.append(Customer.review_scope_id == current_user.review_scope_id)",
    ] : []),
    "        submitted = exists(select(AuditEvent.id).where(AuditEvent.customer_id == Customer.id, AuditEvent.action == \"submitted\"))",
    "        predicates.append(submitted)",
    "        predicates.append(Customer.status == CustomerStatus.PENDING)",
    "    else:",
    "        raise HTTPException(status_code=403, detail=\"Insufficient permissions\")",
    "    if status_filter is not None:",
    "        predicates.append(Customer.status == status_filter)",
    "    statement = statement.where(*predicates)",
    "    count_result = await db.execute(select(func.count()).select_from(Customer).where(*predicates))",
    "    result = await db.execute(statement.order_by(Customer.created_at.desc(), Customer.id.desc()).offset(offset).limit(limit))",
    "    return {\"items\": result.scalars().all(), \"total\": count_result.scalar_one(), \"offset\": offset, \"limit\": limit}",
    "",
  ].join("\n");
  return `${result.trimEnd()}\n${fn}`;
}

export function validateEntityRecordReadOperationSpec(value: unknown, architecture: ProjectArchitectureContract, catalog: BusinessDomainCatalog): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["record-read operation must be a JSON object"];
  const spec = value as Partial<EntityRecordReadOperationSpec>;
  const issues: string[] = [];
  if (spec.schemaVersion !== "1.0" || spec.operationKind !== "entity-record-read") issues.push("unsupported record-read operation schema");
  if (spec.operationId !== "customer.getOwn" && spec.operationId !== "manager.getReviewable") issues.push("record-read operation identifier is not approved");
  if (spec.architectureHash !== architecture.contractHash) issues.push("record-read architecture hash does not match the PAC");
  if (!architecture.modules.some((module) => module.path === spec.targetModule && module.path.startsWith("backend/routes/"))) issues.push("record-read target module is not an approved PAC route module");
  if (spec.route?.method !== "GET" || spec.route.path !== "/customers/{customer_id}" || !identifier.test(spec.route.functionName ?? "")) issues.push("record-read route is invalid or unsupported");
  if (spec.actor?.entity !== "User" || spec.actor.customerRole !== "customer" || spec.actor.managerRole !== "manager") issues.push("record-read must define explicit customer and manager roles");
  if (spec.authorization?.ownerField !== "owner_id" || spec.authorization.ownerActorField !== "id" || !catalog.entities.Customer?.fields.includes("owner_id")) issues.push("record-read owner authorization references unknown fields");
  if (spec.authorization?.manager?.mode === "global") {
    if (architecture.reviewScope) issues.push("global manager record access conflicts with the PAC review-scope policy");
  } else if (spec.authorization?.manager?.mode === "review-scope") {
    if (spec.authorization.manager.userScopeField !== "review_scope_id" || spec.authorization.manager.customerScopeField !== "review_scope_id" || !catalog.entities.User?.fields.includes("review_scope_id") || !catalog.entities.Customer?.fields.includes("review_scope_id") || !architecture.reviewScope) issues.push("record-read manager scope must be declared by the PAC and domain model");
  } else issues.push("record-read must explicitly declare global manager access or a PAC-approved review scope");
  if (spec.output?.entity !== "Customer" || !catalog.responseSchemas.includes(spec.output.responseSchema ?? "") || spec.output.statusCode !== 200 || spec.output.unauthorized !== 404) issues.push("record-read response schema or authorization-safe failure behavior is invalid");
  if (spec.transaction?.driver !== "sqlalchemy-async" || spec.transaction.scope !== "single-request" || spec.transaction.readOnly !== true) issues.push("record-read must use the approved read-only SQLAlchemy request scope");
  return [...new Set(issues)];
}

export function appendEntityRecordReadOperation(source: string, spec: EntityRecordReadOperationSpec): string {
  const imports = [
    "from fastapi import APIRouter, Depends, HTTPException",
    "from sqlalchemy import select",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from backend.auth import get_current_user",
    "from backend.database import get_db",
    "from backend.models import Customer, User",
    `from backend.schemas import ${spec.output.responseSchema}`,
  ];
  let result = removeExistingRoute(source.trimEnd(), spec.route.path, spec.route.method);
  for (const statement of imports) if (!result.split(/\r?\n/).includes(statement)) result = `${statement}\n${result}`;
  if (!/^\s*router\s*=\s*APIRouter\s*\(/m.test(result)) result = `router = APIRouter()\n${result}`;
  const route = [
    "", "# Generated from a PAC-validated owner-and-manager-policy record-read operation.",
    `@router.get(${JSON.stringify(spec.route.path)}, response_model=${spec.output.responseSchema})`,
    `async def ${spec.route.functionName}(customer_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):` ,
    "    if current_user.role == \"customer\":",
    "        predicate = Customer.owner_id == current_user.id",
    "    elif current_user.role == \"manager\":",
    ...(spec.authorization.manager.mode === "review-scope" ? [
      "        if current_user.review_scope_id is None:",
      "            raise HTTPException(status_code=403, detail=\"Manager has no review scope\")",
      "        predicate = Customer.review_scope_id == current_user.review_scope_id",
    ] : ["        predicate = True"]),
    "    else:",
    "        raise HTTPException(status_code=403, detail=\"Insufficient permissions\")",
    "    result = await db.execute(select(Customer).where(Customer.id == customer_id, predicate))",
    "    customer = result.scalar_one_or_none()",
    "    if customer is None:",
    "        raise HTTPException(status_code=404, detail=\"Customer not found\")",
    "    return customer", "",
  ].join("\n");
  return `${result.trimEnd()}\n${route}`;
}

export function businessCreateOperationPrompt(input: {
  architecture: ProjectArchitectureContract;
  operationId: string;
  targetModule: string;
  routePath: string;
  functionName: string;
  entity: string;
  bodySchema: string;
  role: string;
  permission: string;
  fieldMappings: EntityCreateOperationSpec["input"]["fieldMappings"];
  audit: EntityCreateOperationSpec["audit"];
  modelSource: string;
  schemaSource: string;
}): string {
  const exactSpec: EntityCreateOperationSpec = {
    schemaVersion: "1.0", operationKind: "entity-create", operationId: input.operationId,
    architectureHash: input.architecture.contractHash, targetModule: input.targetModule,
    route: { method: "POST", path: input.routePath, functionName: input.functionName },
    actor: { entity: "User", role: input.role, permission: input.permission },
    input: { bodySchema: input.bodySchema, fieldMappings: input.fieldMappings },
    ...(input.architecture.reviewScope && input.role === "customer" ? { scopeAssignment: "inherit-authenticated-customer" as const } : {}),
    output: { entity: input.entity, responseSchema: `${input.entity}Response`, statusCode: 201 },
    audit: input.audit,
    transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
    failures: { duplicate: 409, rollbackOnError: true },
  };
  return [
    "Return one JSON contract only. Do not return application source code or prose.",
    `Write exactly one file edit at .mobiusx/operations/${input.operationId.replaceAll(".", "-")}.v1.json.`,
    `PAC: ${JSON.stringify({ schemaVersion: input.architecture.schemaVersion, contractHash: input.architecture.contractHash, stack: input.architecture.stack, module: input.architecture.modules.find((module) => module.path === input.targetModule) })}`,
    `Approved model and schema declarations:\n${input.modelSource}\n${input.schemaSource}`,
    "Copy this exact, complete entity-create operation contract. Keep all paths, mappings, entities, fields, roles, and transaction guarantees unchanged.",
    JSON.stringify(exactSpec),
  ].join("\n\n");
}

export function validateEntityCreateOperationSpec(value: unknown, architecture: ProjectArchitectureContract, catalog: BusinessDomainCatalog): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["business operation must be a JSON object"];
  const spec = value as Partial<EntityCreateOperationSpec>;
  const issues: string[] = [];
  if (spec.schemaVersion !== "1.0" || spec.operationKind !== "entity-create") issues.push("unsupported entity-create operation schema");
  if (typeof spec.operationId !== "string" || !safeOperationId.test(spec.operationId)) issues.push("invalid business operation identifier");
  if (spec.architectureHash !== architecture.contractHash) issues.push("business operation architecture hash does not match the PAC");
  if (!architecture.modules.some((module) => module.path === spec.targetModule && module.path.startsWith("backend/routes/"))) issues.push("business operation target module is not an approved PAC route module");
  if (spec.route?.method !== "POST" || typeof spec.route.path !== "string" || !safePath.test(spec.route.path) || !identifier.test(spec.route.functionName ?? "")) issues.push("business operation route is invalid or unsupported");
  if (!catalog.roles.includes(spec.actor?.role ?? "")) issues.push(`unknown business operation role: ${spec.actor?.role ?? "(missing)"}`);
  if (!safePermission.test(spec.actor?.permission ?? "") || !catalog.permissions.includes(spec.actor?.permission ?? "")) issues.push(`unknown business operation permission: ${spec.actor?.permission ?? "(missing)"}`);
  const entity = spec.output?.entity ?? "";
  if (!catalog.entities[entity]) issues.push(`unknown output entity: ${entity || "(missing)"}`);
  if (!spec.output?.responseSchema || !catalog.responseSchemas.includes(spec.output.responseSchema)) issues.push(`unknown response schema: ${spec.output?.responseSchema ?? "(missing)"}`);
  if (spec.output?.statusCode !== 201) issues.push("entity creation must return HTTP 201");
  if (architecture.reviewScope && spec.actor?.role === "customer" && spec.scopeAssignment !== "inherit-authenticated-customer") issues.push("customer creation must inherit the authenticated user's PAC review scope");
  const bodyFields = new Set(catalog.requestSchemas[spec.input?.bodySchema ?? ""] ?? []);
  if (!bodyFields.size) issues.push(`unknown request schema: ${spec.input?.bodySchema ?? "(missing)"}`);
  const targets = new Set<string>();
  for (const mapping of spec.input?.fieldMappings ?? []) {
    if (!catalog.entities[entity]?.fields.includes(mapping.targetField)) issues.push(`unknown entity field ${entity}.${mapping.targetField}`);
    if (targets.has(mapping.targetField)) issues.push(`duplicate field mapping for ${entity}.${mapping.targetField}`);
    targets.add(mapping.targetField);
    if (mapping.source === "body" && (!mapping.sourceField || !bodyFields.has(mapping.sourceField))) issues.push(`unknown request field ${mapping.sourceField ?? "(missing)"}`);
    if (mapping.source === "body" && /(?:^|_)(?:owner|created_by|user)_id$/i.test(mapping.targetField)) issues.push(`ownership field ${entity}.${mapping.targetField} cannot be supplied by the request body`);
    if (mapping.source === "body" && /^(?:status|state)$/i.test(mapping.targetField)) issues.push(`lifecycle field ${entity}.${mapping.targetField} cannot be supplied by the request body`);
    if (mapping.source === "actor" && mapping.sourceField !== "id" && !(architecture.reviewScope && mapping.sourceField === "review_scope_id")) issues.push("actor mappings may use only PAC-approved authenticated principal fields");
    if (mapping.source === "state" && !catalog.entities[entity]?.states?.includes(mapping.value ?? "")) issues.push(`unknown entity state ${mapping.value ?? "(missing)"}`);
    if (mapping.source === "state") {
      const property = catalog.entityProperties?.[entity]?.[mapping.targetField];
      if (property?.type === "enum" && property.enumName && !catalog.enumMembers?.[property.enumName]?.[mapping.value ?? ""]) issues.push(`ORM enum ${property.enumName} has no member for persisted state ${mapping.value ?? "(missing)"}`);
      if (property && property.type !== "enum" && property.type !== "string") issues.push(`server state field ${entity}.${mapping.targetField} must be a string or declared enum`);
    }
    if (mapping.source === "credential") {
      if (!mapping.sourceField || !bodyFields.has(mapping.sourceField)) issues.push(`unknown credential request field ${mapping.sourceField ?? "(missing)"}`);
      if (mapping.sourceField !== spec.credentialHashing?.requestField || mapping.targetField !== spec.credentialHashing?.targetField || spec.credentialHashing?.hasher !== "crypt_context.hash") issues.push("credential mappings must use the validated password hashing contract");
      if (!catalog.entityProperties?.[entity]?.[mapping.targetField]) issues.push(`credential target ${entity}.${mapping.targetField} is not an ORM field`);
    }
  }
  for (const [schema, fields] of Object.entries(catalog.responseSchemaFields ?? {})) {
    if (schema !== spec.output?.responseSchema) continue;
    for (const field of fields) {
      if (!catalog.entities[entity]?.fields.includes(field)) issues.push(`response schema ${schema}.${field} is not an ORM entity field`);
      if (/password|secret|token|credential/i.test(field)) issues.push(`response schema ${schema}.${field} exposes a sensitive field`);
    }
  }
  const requestProperties = catalog.requestProperties?.[spec.input?.bodySchema ?? ""];
  if (requestProperties) {
    for (const [field, property] of Object.entries(requestProperties)) {
      const mapped = (spec.input?.fieldMappings ?? []).some((mapping) => mapping.sourceField === field);
      const explicitlyRequestOnly = spec.requestOnlyFields?.includes(field) ?? false;
      if (!mapped && !explicitlyRequestOnly) issues.push(`${property.required ? "required" : "optional"} request field ${spec.input?.bodySchema}.${field} has no declared mapping or request-only classification`);
      if (explicitlyRequestOnly && property.required && !/password|credential/i.test(field)) issues.push(`required request-only field ${spec.input?.bodySchema}.${field} has no declared secure handling`);
    }
  }
  for (const field of spec.requestOnlyFields ?? []) if (!bodyFields.has(field)) issues.push(`declared request-only field ${field} is not in the request schema`);
  if (catalog.entityProperties?.[entity]) {
    const declaredDuplicates = new Set(spec.duplicateFields ?? []);
    for (const [field, property] of Object.entries(catalog.entityProperties[entity])) {
      if (property.required && !property.serverGenerated && !targets.has(field) && !(spec.scopeAssignment === "inherit-authenticated-customer" && field === "review_scope_id")) issues.push(`required ORM field ${entity}.${field} has no operation mapping`);
      if (property.unique && !declaredDuplicates.has(field)) issues.push(`unique ORM field ${entity}.${field} is missing duplicate-registration handling`);
    }
    for (const field of spec.duplicateFields ?? []) if (!catalog.entityProperties[entity][field]?.unique) issues.push(`duplicate handling references non-unique ORM field ${entity}.${field}`);
  }
  if (spec.credentialHashing) {
    const hash = spec.credentialHashing;
    if (hash.hasher !== "crypt_context.hash" || !bodyFields.has(hash.requestField) || !catalog.entities[entity]?.fields.includes(hash.targetField)) issues.push("credential hashing contract is invalid or references unknown fields");
    if (!(spec.input?.fieldMappings ?? []).some((mapping) => mapping.source === "credential" && mapping.sourceField === hash.requestField && mapping.targetField === hash.targetField)) issues.push("credential hashing contract is not connected to an entity field mapping");
  }
  if (!targets.size) issues.push("entity creation requires explicit field mappings");
  if (!catalog.entities[spec.audit?.entity ?? ""] || !catalog.entities[spec.audit?.entity ?? ""]?.fields.includes(spec.audit?.actorField ?? "") || !catalog.entities[spec.audit?.entity ?? ""]?.fields.includes(spec.audit?.subjectField ?? "") || spec.audit?.actionField !== "action") issues.push("audit event references an unknown entity or field");
  if (!spec.audit?.action || !spec.transaction || spec.transaction.driver !== "sqlalchemy-async" || spec.transaction.scope !== "single-request" || spec.transaction.atomic !== true || spec.transaction.rollbackOnError !== true) issues.push("entity creation and audit must use one rollback-safe SQLAlchemy async transaction");
  if (spec.failures?.duplicate !== 409 || spec.failures.rollbackOnError !== true) issues.push("entity-create failure behavior is incomplete");
  return [...new Set(issues)];
}

function entityCreateMappingExpression(mapping: EntityCreateOperationSpec["input"]["fieldMappings"][number], spec: EntityCreateOperationSpec, modelSource?: string): string {
  if (mapping.source === "body") return `payload.${mapping.sourceField}`;
  if (mapping.source === "actor") return `current_user.${mapping.sourceField}`;
  if (mapping.source === "credential") return `crypt_context.hash(payload.${mapping.sourceField})`;
  if (!modelSource) return `${spec.output.entity}Status.${mapping.value!.toUpperCase()}`;
  const property = parseEntityProperties(modelSource, spec.output.entity)[mapping.targetField];
  if (property?.type === "enum" && property.enumName) {
    const enumBody = classSourceBody(modelSource, property.enumName);
    const member = [...enumBody.matchAll(/^\s{4}([A-Za-z_]\w*)\s*=\s*["']([^"']+)["']/gm)].find((match) => match[2] === mapping.value)?.[1];
    if (!member) throw new Error(`ORM enum ${property.enumName} has no declared member for state ${mapping.value}`);
    return `${property.enumName}.${member}`;
  }
  if (property?.type === "string") return JSON.stringify(mapping.value);
  throw new Error(`cannot render server state mapping for ${spec.output.entity}.${mapping.targetField} from the approved ORM declaration`);
}

export function validateEntityCreateRenderedOperation(source: string, spec: EntityCreateOperationSpec, modelSource: string): string[] {
  const issues: string[] = [];
  const signature = new RegExp(`^async\\s+def\\s+${spec.route.functionName}\\s*\\(`, "m");
  const match = signature.exec(source);
  if (!match) return [`rendered registration route is missing handler ${spec.route.functionName}`];
  const tail = source.slice(match.index);
  const nextTopLevel = tail.slice(match[0].length).search(/\n(?=(?:async\s+)?def\s+\w+\s*\(|class\s+\w+\s*\(|@router\.)/);
  const handler = nextTopLevel < 0 ? tail : tail.slice(0, nextTopLevel + match[0].length);
  for (const mapping of spec.input.fieldMappings) {
    let expression: string;
    try { expression = entityCreateMappingExpression(mapping, spec, modelSource); }
    catch (error) { issues.push((error as Error).message); continue; }
    const assignment = new RegExp(`^\\s{12}${mapping.targetField}\\s*=\\s*${expression.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*,?\\s*$`, "m");
    if (!assignment.test(handler)) issues.push(`registration route does not render approved mapping ${mapping.targetField} from ${mapping.source}`);
  }
  if (!new RegExp(`@router\\.post\\(\\s*["']${spec.route.path.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}["']`).test(source)) issues.push(`registration route is not registered at ${spec.route.path}`);
  if (!/async\s+with\s+atomic_request_transaction\(db\):/.test(handler) || !new RegExp(`db\\.add\\(\\s*${spec.audit.entity}\\(`).test(handler)) issues.push("registration must persist entity and audit in one rollback-safe transaction");
  if (!/from\s+sqlalchemy\s+import[^\n]*\bselect\b/.test(source) && /\bselect\s*\(/.test(source)) issues.push("route module uses SQLAlchemy select() without importing it");
  return [...new Set(issues)];
}

export function appendEntityCreateOperation(source: string, spec: EntityCreateOperationSpec, modelSource?: string): string {
  const entity = spec.output.entity;
  const entityHasStates = Boolean((spec.input.fieldMappings ?? []).some((mapping) => mapping.source === "state"));
  const modelImports = [spec.audit.entity, entity, "User", ...(entityHasStates ? [`${entity}Status`] : [])].join(", ");
  const imports = [
    "from contextlib import asynccontextmanager",
    "from fastapi import APIRouter, Depends, HTTPException, status",
    "from sqlalchemy.exc import IntegrityError",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from backend.database import get_db",
    `from backend.models import ${modelImports}`,
    `from backend.schemas import ${spec.input.bodySchema}, ${spec.output.responseSchema}`,
    "from backend.auth import require_role",
  ];
  let result = removeExistingRoute(source.trimEnd(), spec.route.path, spec.route.method);
  if (/\bselect\s*\(/.test(result) || entityHasStates) {
    // SQLAlchemy query helpers are added from observed source usage, not left to
    // the model to remember in an import list.
    if (/\bselect\s*\(/.test(result)) imports.push("from sqlalchemy import select");
  }
  if (spec.credentialHashing) imports.push("from backend.auth import crypt_context");
  for (const statement of imports) if (!result.split(/\r?\n/).includes(statement)) result = `${statement}\n${result}`;
  if (!/^async\s+def\s+atomic_request_transaction\s*\(/m.test(result)) result = `${result}\n\n@asynccontextmanager\nasync def atomic_request_transaction(db: AsyncSession):\n    active_transaction = db.get_transaction()\n    if active_transaction is None:\n        async with db.begin():\n            yield\n        return\n    try:\n        yield\n        await active_transaction.commit()\n    except BaseException:\n        await active_transaction.rollback()\n        raise\n`;
  if (!/^\s*router\s*=\s*APIRouter\s*\(/m.test(result)) result = `router = APIRouter()\n${result}`;
  const mappingLines = spec.input.fieldMappings.map((mapping) => {
    const expression = entityCreateMappingExpression(mapping, spec, modelSource);
    return `            ${mapping.targetField}=${expression},`;
  });
  if (spec.scopeAssignment === "inherit-authenticated-customer" && !spec.input.fieldMappings.some((mapping) => mapping.targetField === "review_scope_id")) {
    mappingLines.push("            review_scope_id=current_user.review_scope_id,");
  }
  const fields = mappingLines.join("\n");
  const route = [
    "", "# Generated from a PAC-validated entity-create operation.",
    `@router.post(${JSON.stringify(spec.route.path)}, response_model=${spec.output.responseSchema}, status_code=status.HTTP_201_CREATED)`,
    `async def ${spec.route.functionName}(payload: ${spec.input.bodySchema}, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_role(${JSON.stringify(spec.actor.role)}))):`,
    ...(spec.scopeAssignment ? ["    if current_user.review_scope_id is None:", "        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=\"Customer has no review scope\")"] : []),
    "    try:", "        async with atomic_request_transaction(db):", `            entity_record = ${entity}(\n${fields}\n            )`,
    "            db.add(entity_record)", "            await db.flush()",
    `            db.add(${spec.audit.entity}(${spec.audit.actorField}=current_user.id, ${spec.audit.subjectField}=entity_record.id, ${spec.audit.actionField}=${JSON.stringify(spec.audit.action)}))`,
    "    except IntegrityError as error:",
    "        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=\"A record with the same unique fields already exists\") from error",
    "    await db.refresh(entity_record)", "    return entity_record", "",
  ].join("\n");
  return `${result.trimEnd()}\n${route}`;
}

export function businessOperationPrompt(input: {
  architecture: ProjectArchitectureContract;
  operationId: string;
  targetModule: string;
  role: string;
  permission: string;
  routePath: string;
  modelSource: string;
  schemaSource: string;
  functionName?: string;
  fromState?: string;
  toState?: string;
  auditAction?: string;
  requiredAuditAction?: string;
  concurrency?: "row-lock";
}): string {
  const compactModels = input.modelSource.split(/\r?\n/).filter((line) => /^class |^    (?:id|owner_id|status|user_id|customer_id|action)\s*=|^    (?:PENDING|APPROVED|REJECTED)\s*=/.test(line)).join("\n");
  const compactSchemas = input.schemaSource.split(/\r?\n/).filter((line) => /^class |^    (?:name|email|id|status|owner_id)\s*:/.test(line)).join("\n");
  const isManagerDecision = input.role === "manager";
  const fromState = input.fromState ?? "pending";
  const toState = input.toState ?? "pending";
  const auditAction = input.auditAction ?? "submitted";
  const functionName = input.functionName ?? "submit_customer";
  const preconditions: BusinessOperationSpec["preconditions"] = [
    ...(!isManagerDecision ? [{ kind: "owner_is_actor" as const, entity: "Customer", field: "owner_id" }] : []),
    { kind: "state_is", entity: "Customer", field: "status", value: fromState },
    ...(input.requiredAuditAction ? [{ kind: "audit_exists" as const, entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: input.requiredAuditAction }] : []),
    { kind: "audit_absent", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: auditAction },
  ];
  const exactContractShape: BusinessOperationSpec = {
    schemaVersion: "1.0",
    operationId: input.operationId,
    architectureHash: input.architecture.contractHash,
    targetModule: input.targetModule,
    route: { method: "POST", path: input.routePath, functionName },
    actor: { entity: "User", role: input.role, permission: input.permission },
    ...(isManagerDecision && input.architecture.reviewScope ? { managerScope: { userField: "review_scope_id" as const, subjectField: "review_scope_id" as const } } : {}),
    input: { pathParams: [{ name: "customer_id", entity: "Customer", field: "id", type: "integer" }] },
    output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 200 },
    preconditions: [
      ...preconditions,
    ],
    mutation: { entity: "Customer", field: "status", value: toState },
    audit: { entity: "AuditEvent", action: auditAction, actorField: "user_id", subjectField: "customer_id", actionField: "action" },
    transition: { entity: "Customer", field: "status", from: fromState, to: toState, auditAction },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
    ...(input.concurrency ? { concurrency: { strategy: input.concurrency } } : {}),
    idempotency: { strategy: "reject-duplicate-audit", auditAction },
    failures: { notFound: 404, forbidden: 403, invalidTransition: 409, rollbackOnError: true },
  };
  return [
    "Create one versioned business-operation specification as JSON, not application source code.",
    `Return exactly one structured file edit at .mobiusx/operations/${input.operationId.replaceAll(".", "-")}.v1.json. The edit content must be a single JSON object, with no markdown or prose.`,
    "Use only entities, fields, enum values, response schemas, route modules, roles, and permissions included below. Do not invent values.",
    `Approved PAC: ${JSON.stringify({ schemaVersion: input.architecture.schemaVersion, contractHash: input.architecture.contractHash, stack: input.architecture.stack, modules: input.architecture.modules.filter((module) => module.path === input.targetModule) })}`,
    `Operation: ${input.operationId}; targetModule: ${input.targetModule}; route POST ${input.routePath}; actor role: ${input.role}; permission: ${input.permission}.`,
    "Operation contract fields required: schemaVersion, operationId, architectureHash, targetModule, route {method,path,functionName}, actor {entity,role,permission}, input {pathParams:[{name,entity,field,type}]}, output {entity,responseSchema,statusCode}, preconditions[], mutation {entity,field,value}, audit {entity,action,actorField,subjectField,actionField}, transition {entity,field,from,to,auditAction}, transaction {driver,scope,atomic,rollbackOnError}, idempotency {strategy,auditAction}, failures {notFound,forbidden,invalidTransition,rollbackOnError}; include concurrency when required.",
    `Use exactly the preconditions in this contract: ${JSON.stringify(preconditions)}. Set mutation and transition to ${fromState} -> ${toState}; write audit action ${auditAction}.`,
    `${isManagerDecision ? `This is a manager decision. Require a row lock, persisted current state ${fromState}, and an existing ${input.requiredAuditAction} audit event; do not enforce owner identity.` : "Require the authenticated customer to own the record."} Reject an existing decision audit event, record the acting user, reject invalid transitions, and use a single SQLAlchemy async request transaction with rollback on any exception.`,
    ...(input.concurrency ? ["Use SQLAlchemy SELECT ... FOR UPDATE for the entity read so concurrent manager decisions serialize; include concurrency: {strategy:'row-lock'} in the spec."] : []),
    `Approved roles: ${JSON.stringify([input.role])}; approved permission: ${JSON.stringify([input.permission])}.`,
    `Existing model declarations:\n${compactModels}`,
    `Existing response schemas:\n${compactSchemas}`,
    `Use statusCode 200, method POST, functionName ${functionName}, route path exactly as supplied, idempotency strategy reject-duplicate-audit, and failure statuses 404/403/409.`,
    "Copy the complete JSON contract below into the file content exactly. Preserve every required property and value; do not abbreviate, rename, omit, or add fields. This specification is the approved operation contract, not a request to invent another schema.",
    JSON.stringify(exactContractShape),
  ].join("\n\n");
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safePermission = /^[a-z][a-z0-9_.:-]{1,80}$/;
const safeOperationId = /^[a-z][a-z0-9_.-]{2,100}$/;
const safePath = /^\/[A-Za-z0-9_{}./-]+$/;

/** Validate a model-produced operation against the immutable PAC and known ORM schema. */
export function validateBusinessOperationSpec(
  value: unknown,
  architecture: ProjectArchitectureContract,
  catalog: BusinessDomainCatalog,
): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["business operation must be a JSON object"];
  const spec = value as Partial<BusinessOperationSpec>;
  if (spec.schemaVersion !== "1.0") issues.push("unsupported business operation schema version");
  if (typeof spec.operationId !== "string" || !safeOperationId.test(spec.operationId)) issues.push("invalid business operation identifier");
  if (spec.architectureHash !== architecture.contractHash) issues.push("business operation architecture hash does not match the PAC");
  if (!architecture.modules.some((module) => module.path === spec.targetModule && module.path.startsWith("backend/routes/"))) issues.push("business operation target module is not an approved PAC route module");
  if (spec.route?.method !== "POST" || typeof spec.route.path !== "string" || !safePath.test(spec.route.path) || !identifier.test(spec.route.functionName ?? "")) issues.push("business operation route is invalid or unsupported");
  if (spec.actor?.entity !== "User" || !catalog.entities.User) issues.push("business operation actor must use the PAC User entity");
  if (!catalog.roles.includes(spec.actor?.role ?? "")) issues.push(`unknown business operation role: ${spec.actor?.role ?? "(missing)"}`);
  if (!safePermission.test(spec.actor?.permission ?? "") || !catalog.permissions.includes(spec.actor?.permission ?? "")) issues.push(`unknown business operation permission: ${spec.actor?.permission ?? "(missing)"}`);
  const entity = spec.output?.entity;
  if (!entity || !catalog.entities[entity]) issues.push(`unknown output entity: ${entity ?? "(missing)"}`);
  if (!spec.output?.responseSchema || !catalog.responseSchemas.includes(spec.output.responseSchema)) issues.push(`unknown response schema: ${spec.output?.responseSchema ?? "(missing)"}`);
  if (![200, 201, 202, 204].includes(spec.output?.statusCode ?? 0)) issues.push("unsupported business operation success status");
  if (!Array.isArray(spec.input?.pathParams) || spec.input.pathParams.length !== 1) issues.push("business operation must declare exactly one entity path parameter");
  for (const param of spec.input?.pathParams ?? []) {
    if (!identifier.test(param.name) || param.type !== "integer" || param.entity !== entity || param.field !== "id") issues.push(`invalid entity path parameter: ${param.name}`);
    if (!spec.route?.path.includes(`{${param.name}}`)) issues.push(`route path does not include path parameter ${param.name}`);
  }
  const entityFields = entity ? new Set(catalog.entities[entity]?.fields ?? []) : new Set<string>();
  for (const condition of spec.preconditions ?? []) {
    const conditionEntity = catalog.entities[condition.entity];
    if (!conditionEntity) issues.push(`unknown precondition entity: ${condition.entity}`);
    if (condition.kind === "owner_is_actor" && !conditionEntity?.fields.includes(condition.field)) issues.push(`unknown owner field ${condition.entity}.${condition.field}`);
    if (condition.kind === "state_is") {
      if (!conditionEntity?.fields.includes(condition.field)) issues.push(`unknown state field ${condition.entity}.${condition.field}`);
      if (!conditionEntity?.states?.includes(condition.value)) issues.push(`unknown state ${condition.value} for ${condition.entity}.${condition.field}`);
    }
    if (condition.kind === "audit_absent" || condition.kind === "audit_exists") {
      if (!conditionEntity?.fields.includes(condition.subjectField) || !conditionEntity?.fields.includes(condition.actionField)) issues.push(`unknown audit fields on ${condition.entity}`);
      if (condition.entity !== spec.audit?.entity || condition.actionField !== "action") issues.push("audit absence precondition must target the declared audit entity/action");
    }
  }
  if (spec.mutation?.entity !== entity || !entityFields.has(spec.mutation?.field ?? "")) issues.push(`unknown mutation target ${spec.mutation?.entity ?? "(missing)"}.${spec.mutation?.field ?? "(missing)"}`);
  if (spec.mutation?.field && !catalog.entities[spec.mutation.entity]?.states?.includes(spec.mutation.value)) issues.push(`unknown mutation state ${spec.mutation.value} for ${spec.mutation.entity}.${spec.mutation.field}`);
  if (!catalog.entities[spec.audit?.entity ?? ""] || !catalog.entities[spec.audit?.entity ?? ""]?.fields.includes(spec.audit?.actorField ?? "") || !catalog.entities[spec.audit?.entity ?? ""]?.fields.includes(spec.audit?.subjectField ?? "")) issues.push("audit event references an unknown entity or field");
  if (!spec.audit?.action || spec.audit.action !== spec.transition?.auditAction || spec.audit.action !== spec.idempotency?.auditAction) issues.push("audit action must match the transition and idempotency rule");
  if (spec.transition?.entity !== entity || spec.transition?.field !== spec.mutation?.field) issues.push("state transition must target the mutated entity field");
  if (!catalog.entities[entity ?? ""]?.states?.includes(spec.transition?.from ?? "") || !catalog.entities[entity ?? ""]?.states?.includes(spec.transition?.to ?? "")) issues.push("state transition uses a state not declared by the ORM model");
  if (spec.transition?.to !== spec.mutation?.value) issues.push("state transition destination differs from the entity mutation");
  if (spec.transaction?.driver !== "sqlalchemy-async" || spec.transaction.scope !== "single-request" || spec.transaction.atomic !== true || spec.transaction.rollbackOnError !== true) issues.push("business operation must use one rollback-safe SQLAlchemy async request transaction");
  if (spec.idempotency?.strategy !== "reject-duplicate-audit") issues.push("business operation must reject duplicate execution using its audit event");
  if (spec.failures?.notFound !== 404 || spec.failures.forbidden !== 403 || spec.failures.invalidTransition !== 409 || spec.failures.rollbackOnError !== true) issues.push("business operation failure behavior is incomplete");
  if (!Array.isArray(spec.preconditions) || !spec.preconditions.some((condition) => condition.kind === "state_is" && condition.value === spec.transition?.from)) issues.push("business operation must enforce its source state precondition");
  if (spec.actor?.role === "customer" && !spec.preconditions?.some((condition) => condition.kind === "owner_is_actor")) issues.push("customer business operation must enforce actor ownership");
  if (spec.actor?.role === "manager" && spec.concurrency?.strategy !== "row-lock") issues.push("manager state transitions must declare row-lock concurrency control");
  if (spec.actor?.role === "manager" && architecture.reviewScope && (spec.managerScope?.userField !== "review_scope_id" || spec.managerScope.subjectField !== "review_scope_id" || !catalog.entities.User?.fields.includes("review_scope_id") || !catalog.entities[entity ?? ""]?.fields.includes("review_scope_id"))) issues.push("manager state transitions must declare the PAC review-scope restriction");
  if (spec.actor?.role === "manager" && !spec.preconditions?.some((condition) => condition.kind === "audit_exists")) issues.push("manager decision must require a prior submitted audit event");
  if (!spec.preconditions?.some((condition) => condition.kind === "audit_absent" && condition.action === spec.audit?.action)) issues.push("business operation must reject a duplicate audit action");
  return [...new Set(issues)];
}

/** Render a narrow, auditable FastAPI route from a validated state-transition operation. */
export function renderSqlAlchemyAsyncOperation(spec: BusinessOperationSpec): string {
  const pathParam = spec.input.pathParams[0];
  const entity = spec.output.entity;
  const statusEnum = `${entity}Status`;
  const param = pathParam.name;
  const role = JSON.stringify(spec.actor.role);
  const action = JSON.stringify(spec.audit.action);
  const routePath = JSON.stringify(spec.route.path);
  const statusConstant: Record<number, string> = { 200: "OK", 201: "CREATED", 202: "ACCEPTED", 204: "NO_CONTENT" };
  const decorator = `@router.${spec.route.method.toLowerCase()}(${routePath}, response_model=${spec.output.responseSchema}, status_code=status.HTTP_${spec.output.statusCode}_${statusConstant[spec.output.statusCode]})`;
  const ownerCondition = spec.preconditions.find((condition) => condition.kind === "owner_is_actor");
  const lockClause = spec.concurrency?.strategy === "row-lock" ? ".with_for_update()" : "";
  const managerScopeClause = spec.actor.role === "manager" && spec.managerScope
    ? `if current_user.${spec.managerScope.userField} is None:\n    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager has no review scope")\n`
    : "";
  const scopedSelect = spec.actor.role === "manager" && spec.managerScope
    ? `select(${entity}).where(${entity}.id == ${param}, ${entity}.${spec.managerScope.subjectField} == current_user.${spec.managerScope.userField})${lockClause}`
    : `select(${entity}).where(${entity}.id == ${param})${lockClause}`;
  return [
    "",
    "# Generated from a PAC-validated business operation. Do not add manual commits here.",
    decorator,
    `async def ${spec.route.functionName}(${param}: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_role(${role}))):`,
    "    async with atomic_request_transaction(db):",
    ...managerScopeClause.trimEnd().split("\n").map((line) => `        ${line}`),
    `        result = await db.execute(${scopedSelect})`,
    "        entity_record = result.scalar_one_or_none()",
    "        if entity_record is None:",
    "            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=\"Not found\")",
    ...(ownerCondition ? [`        if entity_record.${ownerCondition.field} != current_user.id:`] : []),
    ...(ownerCondition ? ["            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=\"Forbidden\")"] : []),
    `        if getattr(entity_record.${spec.transition.field}, \"value\", entity_record.${spec.transition.field}) != ${JSON.stringify(spec.transition.from)}:`,
    "            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=\"Invalid state transition\")",
    ...spec.preconditions.filter((condition) => condition.kind === "audit_exists" || condition.kind === "audit_absent").flatMap((condition) => [
      `        event_match = await db.scalar(select(${condition.entity}.id).where(${condition.entity}.${condition.subjectField} == entity_record.id, ${condition.entity}.${condition.actionField} == ${JSON.stringify(condition.action)}).limit(1))`,
      `        if ${condition.kind === "audit_exists" ? "event_match is None" : "event_match is not None"}:`,
      `            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=${JSON.stringify(condition.kind === "audit_exists" ? "Required prior event is missing" : "Operation already applied")})`,
    ]),
    `        entity_record.${spec.mutation.field} = ${statusEnum}.${spec.transition.to.toUpperCase()}`,
    `        db.add(${spec.audit.entity}(${spec.audit.actorField}=current_user.id, ${spec.audit.subjectField}=entity_record.id, action=${action}))`,
    "    await db.refresh(entity_record)",
    "    return entity_record",
    "",
  ].join("\n");
}

/** Keep customer creation owned by the same authorized role that may submit it. */
export function alignCustomerRegistrationRole(source: string, role: string): { content: string; changed: boolean } {
  const content = source.replace(
    /(async\s+def\s+create_customer\([^\n]*current_user:\s*User\s*=\s*Depends\(require_role\()\s*["'][^"']+["'](\)\))/,
    `$1${JSON.stringify(role)}$2`,
  );
  return { content, changed: content !== source };
}

/** Add required imports without changing any existing application statements. */
export function appendOperationRoute(source: string, spec: BusinessOperationSpec): string {
  const imports = [
    "from contextlib import asynccontextmanager",
    "from fastapi import APIRouter, Depends, HTTPException, status",
    "from sqlalchemy import select",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from backend.database import get_db",
    `from backend.models import ${[spec.audit.entity, spec.output.entity, `${spec.output.entity}Status`, "User"].join(", ")}`,
    `from backend.schemas import ${spec.output.responseSchema}`,
    "from backend.auth import require_role",
  ];
  let result = removeExistingRoute(source.trimEnd(), spec.route.path, spec.route.method);
  for (const statement of imports) if (!result.split(/\r?\n/).includes(statement)) result = `${statement}\n${result}`;
  if (!/^async\s+def\s+atomic_request_transaction\s*\(/m.test(result)) {
    const helper = [
      "",
      "@asynccontextmanager",
      "async def atomic_request_transaction(db: AsyncSession):",
      "    active_transaction = db.get_transaction()",
      "    if active_transaction is None:",
      "        async with db.begin():",
      "            yield",
      "        return",
      "    try:",
      "        yield",
      "        await active_transaction.commit()",
      "    except BaseException:",
      "        await active_transaction.rollback()",
      "        raise",
      "",
    ].join("\n");
    const routerLine = result.match(/^router\s*=\s*APIRouter\s*\(.*\)\s*$/m);
    result = routerLine ? `${result.slice(0, routerLine.index)}${helper}\n${result.slice(routerLine.index)}` : `${helper}\n${result}`;
  }
  if (!/^\s*router\s*=\s*APIRouter\s*\(/m.test(result)) result = `router = APIRouter()\n${result}`;
  return `${result}${renderSqlAlchemyAsyncOperation(spec)}`;
}

/** Replace an earlier route for the same method/path before installing its validated contract renderer output. */
function removeExistingRoute(source: string, routePath: string, routeMethod: string): string {
  const lines = source.split(/\r?\n/);
  const retained: string[] = [];
  for (let index = 0; index < lines.length;) {
    const start = index;
    const decorators: string[] = [];
    while (index < lines.length && /^@\w+\./.test(lines[index])) decorators.push(lines[index++]);
    const replacesSameRoute = decorators.some((line) => {
      const route = line.match(/^@\w+\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/i);
      return route?.[1].toLowerCase() === routeMethod.toLowerCase() && route[2] === routePath;
    });
    if (decorators.length && replacesSameRoute) {
      while (index < lines.length && !/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(lines[index])) index += 1;
      if (index < lines.length) {
        index += 1;
        while (index < lines.length && (lines[index].trim() === "" || /^\s+/.test(lines[index]))) index += 1;
      }
      continue;
    }
    retained.push(...lines.slice(start, index));
    if (index === start) retained.push(lines[index++]);
  }
  return retained.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
