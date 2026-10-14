import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { approveReviewScopeArchitectureChange, resolveProjectArchitecture } from "../src/projectArchitecture.js";
import { appendCustomerPageResponseSchema, appendEntityCollectionReadOperation, appendEntityCreateOperation, appendEntityHistoryReadOperation, appendEntityRecordReadOperation, appendOperationRoute, createCustomerReadOperationContracts, createEntityCreateOperationSpec, deriveComplementaryDecisionOperation, extractBusinessDomainCatalog, reconcileEntityHistoryReadOperation, validateBusinessOperationSpec, validateEntityCreateOperationSpec, validateEntityCreateRenderedOperation, validateEntityCollectionReadOperationSpec, validateEntityRecordReadOperationSpec, validateEntityHistoryReadOperationSpec, type BusinessOperationSpec, type EntityCollectionReadOperationSpec, type EntityHistoryReadOperationSpec, type EntityRecordReadOperationSpec, type EntityCreateOperationSpec, createAuthenticationLoginOperationSpec, renderAuthenticationLoginOperation, validateAuthenticationLoginOperationSpec, validateAuthenticationLoginOpenApi, upgradeAuthenticationLoginCheckpoint } from "../src/businessOperations.js";

const architecture = resolveProjectArchitecture("Build a FastAPI PostgreSQL customer approval system with SQLAlchemy, audit history and Playwright.");
const scopedArchitecture = approveReviewScopeArchitectureChange(architecture);
const modelSource = `from sqlalchemy.orm import DeclarativeBase\nclass User(Base):\n    id = Column(Integer, primary_key=True)\n    role = Column(String, default="customer")\n    review_scope_id = Column(Integer)\nclass CustomerStatus(PyEnum):\n    PENDING = "pending"\n    APPROVED = "approved"\n    REJECTED = "rejected"\nclass Customer(Base):\n    id = Column(Integer, primary_key=True)\n    name = Column(String)\n    email = Column(String)\n    owner_id = Column(Integer)\n    review_scope_id = Column(Integer)\n    status = Column(Enum(CustomerStatus))\nclass AuditEvent(Base):\n    id = Column(Integer, primary_key=True)\n    user_id = Column(Integer)\n    customer_id = Column(Integer)\n    action = Column(String)\n    created_at = Column(DateTime)\n`;
const schemaSource = `class CustomerCreate(BaseModel):\n    name: str\n    email: str\nclass CustomerResponse(BaseModel):\n    id: int\n    status: str\nclass AuditEventResponse(BaseModel):\n    id: int\n`;
const catalog = extractBusinessDomainCatalog(architecture, modelSource, schemaSource, ["customer", "manager"], ["customer.register", "customer.submit", "manager.approve", "manager.reject"]);

test("PAC login operation derives principal fields, validates auth helpers, and renders a real token endpoint", () => {
  const models = "class User(Base):\n    username: Mapped[str]\n    role: Mapped[str]\n";
  const schemas = "class LoginRequest(BaseModel):\n    username: str\n    password: str\nclass TokenResponse(BaseModel):\n    access_token: str\n    token_type: str\n";
  const auth = "async def authenticate_user(username: str, password: str, db):\n    return user\nasync def create_access_token(data: dict):\n    return jwt.encode(data, settings.secret_key, algorithm='HS256')\n";
  const operation = createAuthenticationLoginOperationSpec(architecture, models, schemas);
  assert.deepEqual(validateAuthenticationLoginOperationSpec(operation, architecture, auth, models, schemas), []);
  const route = renderAuthenticationLoginOperation(operation);
  assert.match(route, /@router\.post\("\/auth\/login", response_model=TokenResponse, responses=\{401:/);
  assert.match(route, /await authenticate_user\(payload\.username, payload\.password, db\)/);
  assert.match(route, /await create_access_token\(\{"sub": str\(principal\.username\)\}\)/);
  assert.match(route, /HTTP_401_UNAUTHORIZED/);
  assert.match(route, /TokenResponse\(access_token=token, token_type="bearer"\)/);
  const invalid = { ...operation, principal: { ...operation.principal, subjectField: "is_admin" } };
  assert.ok(validateAuthenticationLoginOperationSpec(invalid, architecture, auth, models, schemas).some((issue) => /principal subject/.test(issue)));
});

test("auth.login v2 records JSON request/response fields and validates against FastAPI OpenAPI", () => {
  const models = "class User(Base):\n    username: Mapped[str]\n    role: Mapped[str]\n";
  const schemas = "class LoginRequest(BaseModel):\n    username: str = Field(..., min_length=1)\n    password: str = Field(..., min_length=1)\nclass TokenResponse(BaseModel):\n    access_token: str\n    token_type: str\n";
  const auth = "ACCESS_TOKEN_EXPIRE_MINUTES = 30\nasync def authenticate_user(username: str, password: str, db):\n    return user\nasync def create_access_token(data: dict):\n    expire = datetime.utcnow() + timedelta(minutes=15)\n    return jwt.encode(data, settings.secret_key, algorithm='HS256')\n";
  const operation = createAuthenticationLoginOperationSpec(architecture, models, schemas, undefined, auth);
  assert.equal(operation.schemaVersion, "2.0");
  assert.deepEqual(operation.request, { contentType: "application/json", fields: [
    { name: "username", type: "string", required: true, constraints: { minLength: 1 } },
    { name: "password", type: "string", required: true, constraints: { minLength: 1 } },
  ] });
  assert.deepEqual(operation.response, { contentType: "application/json", schema: "TokenResponse", fields: [
    { name: "access_token", type: "string", required: true }, { name: "token_type", type: "string", required: true },
  ] });
  assert.equal(operation.session.expiration.defaultSeconds, 900);
  const openApi = { paths: { "/auth/login": { post: {
    requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/LoginRequest" } } } },
    responses: {
      "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/TokenResponse" } } } },
      "401": { description: "Invalid credentials" }, "422": { description: "Validation error" },
    },
  } } }, components: { schemas: {
    LoginRequest: { required: ["username", "password"], properties: { username: { type: "string", minLength: 1 }, password: { type: "string", minLength: 1 } } },
    TokenResponse: { required: ["access_token", "token_type"], properties: { access_token: { type: "string" }, token_type: { type: "string" } } },
  } } };
  assert.deepEqual(validateAuthenticationLoginOpenApi(operation, openApi), []);
  const formEncoded = structuredClone(openApi);
  formEncoded.paths["/auth/login"].post.requestBody.content = { "application/x-www-form-urlencoded": { schema: { $ref: "#/components/schemas/LoginRequest" } } };
  assert.ok(validateAuthenticationLoginOpenApi(operation, formEncoded).some((issue) => /request content type/.test(issue)));
  const missing = structuredClone(openApi);
  delete missing.components.schemas.LoginRequest.properties.password;
  assert.ok(validateAuthenticationLoginOpenApi(operation, missing).some((issue) => /missing field password/.test(issue)));
});

test("legacy auth.login checkpoint is upgraded with immutable provenance and verified hashes", () => {
  const models = "class User(Base):\n    username: Mapped[str]\n    role: Mapped[str]\n";
  const schemas = "class LoginRequest(BaseModel):\n    username: str = Field(..., min_length=1)\n    password: str = Field(..., min_length=1)\nclass TokenResponse(BaseModel):\n    access_token: str\n    token_type: str\n";
  const auth = "async def authenticate_user(username: str, password: str, db):\n    return None\nasync def create_access_token(data: dict):\n    return 'token'\n";
  const legacy = JSON.stringify({ schemaVersion: "1.0", operationKind: "authentication-login", operationId: "auth.login", architectureHash: architecture.contractHash, targetModule: "backend/routes/auth.py", route: { method: "POST", path: "/auth/login", functionName: "login" }, input: { requestSchema: "LoginRequest", usernameField: "username", passwordField: "password" }, principal: { entity: "User", subjectField: "username" }, dependencies: { authenticator: "authenticate_user", tokenIssuer: "create_access_token", responseSchema: "TokenResponse", tokenTypeField: "token_type" }, failures: { invalidCredentials: 401 } });
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  const saved = { operationId: "auth.login", architectureHash: architecture.contractHash, content: legacy, sha256: hash(legacy), createdAt: "2026-10-13T00:00:00.000Z" };
  const upgraded = upgradeAuthenticationLoginCheckpoint(saved, architecture, models, schemas, auth, "backend/routes/auth.py", "2026-10-13T01:00:00.000Z");
  assert.equal(upgraded.upgraded, true);
  assert.equal(JSON.parse(upgraded.history!.content).schemaVersion, "1.0");
  assert.equal(JSON.parse(upgraded.current.content).schemaVersion, "2.0");
  assert.equal(upgraded.history!.supersededBySha256, upgraded.current.sha256);
  assert.equal(hash(upgraded.current.content), upgraded.current.sha256);
  assert.deepEqual(upgradeAuthenticationLoginCheckpoint(upgraded.current, architecture, models, schemas, auth, "backend/routes/auth.py").upgraded, false);
});

const spec: BusinessOperationSpec = {
  schemaVersion: "1.0",
  operationId: "customer.submit",
  architectureHash: architecture.contractHash,
  targetModule: "backend/routes/customers.py",
  route: { method: "POST", path: "/customers/{customer_id}/submit", functionName: "submit_customer" },
  actor: { entity: "User", role: "customer", permission: "customer.submit" },
  input: { pathParams: [{ name: "customer_id", entity: "Customer", field: "id", type: "integer" }] },
  output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 200 },
  preconditions: [
    { kind: "owner_is_actor", entity: "Customer", field: "owner_id" },
    { kind: "state_is", entity: "Customer", field: "status", value: "pending" },
    { kind: "audit_absent", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "submitted" },
  ],
  mutation: { entity: "Customer", field: "status", value: "pending" },
  audit: { entity: "AuditEvent", action: "submitted", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
  transition: { entity: "Customer", field: "status", from: "pending", to: "pending", auditAction: "submitted" },
  transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
  idempotency: { strategy: "reject-duplicate-audit", auditAction: "submitted" },
  failures: { notFound: 404, forbidden: 403, invalidTransition: 409, rollbackOnError: true },
};

test("operation domain catalog is derived from the approved models and schemas", () => {
  assert.deepEqual(catalog.entities.Customer.fields, ["id", "name", "email", "owner_id", "review_scope_id", "status"]);
  assert.ok(catalog.entities.User.fields.includes("review_scope_id"));
  assert.deepEqual(catalog.entities.Customer.states, ["pending", "approved", "rejected"]);
  assert.ok(catalog.entities.AuditEvent.fields.includes("customer_id"));
  assert.deepEqual(catalog.responseSchemas, ["CustomerResponse", "AuditEventResponse"]);
});

test("validates a business operation against PAC paths, domain fields, states, roles, and permissions", () => {
  assert.deepEqual(validateBusinessOperationSpec(spec, architecture, catalog), []);
  const bad = structuredClone(spec);
  bad.actor.permission = "root.override";
  bad.mutation.value = "submitted";
  bad.audit.actorField = "password";
  assert.ok(validateBusinessOperationSpec(bad, architecture, catalog).some((issue) => /unknown business operation permission/.test(issue)));
  assert.ok(validateBusinessOperationSpec(bad, architecture, catalog).some((issue) => /unknown mutation state/.test(issue)));
  assert.ok(validateBusinessOperationSpec(bad, architecture, catalog).some((issue) => /audit event references an unknown/.test(issue)));
});

test("rejects PAC drift, missing ownership checks, and unsafe transaction behavior", () => {
  const bad = structuredClone(spec);
  bad.architectureHash = "stale";
  bad.targetModule = "backend/routes/unapproved.py";
  bad.preconditions = bad.preconditions.filter((item) => item.kind !== "owner_is_actor");
  bad.transaction.atomic = false;
  const issues = validateBusinessOperationSpec(bad, architecture, catalog);
  assert.ok(issues.some((issue) => /architecture hash/.test(issue)));
  assert.ok(issues.some((issue) => /not an approved PAC route/.test(issue)));
  assert.ok(issues.some((issue) => /actor ownership/.test(issue)));
  assert.ok(issues.some((issue) => /one rollback-safe/.test(issue)));
});

test("deterministic route scaffold keeps status and audit writes in one async unit of work that joins auth transactions", () => {
  const source = appendOperationRoute("from fastapi import APIRouter\nrouter = APIRouter()\n", spec);
  const handler = source.slice(source.indexOf("async def submit_customer"));
  const helper = source.slice(source.indexOf("async def atomic_request_transaction"), source.indexOf("router = APIRouter"));
  assert.match(handler, /async with atomic_request_transaction\(db\):/);
  assert.match(helper, /if active_transaction is None:[\s\S]*async with db\.begin\(\):[\s\S]*await active_transaction\.commit\(\)[\s\S]*await active_transaction\.rollback\(\)/);
  assert.match(handler, /entity_record\.status = CustomerStatus\.PENDING/);
  assert.match(handler, /db\.add\(AuditEvent\(user_id=current_user\.id, customer_id=entity_record\.id, action="submitted"\)\)/);
  assert.ok(handler.indexOf("async with atomic_request_transaction(db)") < handler.indexOf("await db.execute"));
  assert.ok(handler.indexOf("entity_record.status =") < handler.indexOf("db.add(AuditEvent"));
  assert.doesNotMatch(handler, /db\.(?:commit|rollback)\s*\(/);
  assert.match(handler, /status\.HTTP_403_FORBIDDEN/);
  assert.match(handler, /status\.HTTP_409_CONFLICT/);
});

test("owner registration and submission use the same authenticated customer identity", () => {
  const original = "from fastapi import APIRouter, Depends\nfrom backend.models import User\nfrom backend.auth import require_role\nrouter = APIRouter()\n@router.post('/customers')\nasync def create_customer(customer, db, current_user: User = Depends(require_role('customer'))):\n    return customer\n";
  const source = appendOperationRoute(original, spec);
  assert.match(source, /async def create_customer\([^\n]*Depends\(require_role\(["']customer["']\)\)/);
  assert.match(source, /async def submit_customer\([^\n]*Depends\(require_role\("customer"\)\)/);
  const managerDecision = { ...structuredClone(spec), operationId: "manager.approve", route: { ...spec.route, method: "POST" as const, path: "/customers/{customer_id}/approve", functionName: "approve_customer" }, actor: { entity: "User" as const, role: "manager", permission: "manager.approve" } };
  const withManagerRoute = appendOperationRoute(source, managerDecision);
  assert.match(withManagerRoute, /async def create_customer\([^\n]*Depends\(require_role\(["']customer["']\)\)/, "adding a manager operation must preserve the registration actor role");
});

test("manager decision contract requires a prior submission and serializes row state with a lock", () => {
  const decision: BusinessOperationSpec = {
    ...structuredClone(spec),
    operationId: "manager.approve",
    route: { method: "POST", path: "/customers/{customer_id}/approve", functionName: "approve_customer" },
    actor: { entity: "User", role: "manager", permission: "manager.approve" },
    preconditions: [
      { kind: "state_is", entity: "Customer", field: "status", value: "pending" },
      { kind: "audit_exists", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "submitted" },
      { kind: "audit_absent", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "approved" },
    ],
    mutation: { entity: "Customer", field: "status", value: "approved" },
    audit: { entity: "AuditEvent", action: "approved", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
    transition: { entity: "Customer", field: "status", from: "pending", to: "approved", auditAction: "approved" },
    concurrency: { strategy: "row-lock" },
    idempotency: { strategy: "reject-duplicate-audit", auditAction: "approved" },
  };
  assert.deepEqual(validateBusinessOperationSpec(decision, architecture, catalog), []);
  const route = appendOperationRoute(
    `from fastapi import APIRouter\nrouter = APIRouter()\n@router.post("/customers/{customer_id}/approve")\nasync def approve_customer():\n    return None\n`,
    decision,
  );
  const handler = route.slice(route.indexOf("async def approve_customer"));
  assert.match(handler, /select\(Customer\).*with_for_update\(\)/);
  assert.match(handler, /"submitted"/);
  assert.match(handler, /CustomerStatus\.APPROVED/);
  assert.match(handler, /action="approved"/);
  assert.equal((route.match(/@router\.post\("\/customers\/\{customer_id\}\/approve"/g) ?? []).length, 1);
  assert.doesNotMatch(handler, /owner_id/);
});

test("manager operation validation rejects missing row locking or submitted-state evidence", () => {
  const decision = {
    ...structuredClone(spec),
    actor: { entity: "User", role: "manager", permission: "manager.approve" },
    preconditions: spec.preconditions.filter((item) => item.kind !== "owner_is_actor"),
    concurrency: undefined,
  } as BusinessOperationSpec;
  assert.ok(validateBusinessOperationSpec(decision, architecture, catalog).some((issue) => /row-lock/.test(issue)));
  assert.ok(validateBusinessOperationSpec({ ...decision, preconditions: decision.preconditions.filter((item) => item.kind !== "audit_exists"), concurrency: { strategy: "row-lock" } }, architecture, catalog).some((issue) => /prior submitted audit/.test(issue)));
});

test("manager rejection derives as a validated atomic sibling of approval", () => {
  const approval: BusinessOperationSpec = {
    schemaVersion: "1.0", operationId: "manager.approve", architectureHash: architecture.contractHash,
    targetModule: "backend/routes/customers.py",
    route: { method: "POST", path: "/customers/{customer_id}/approve", functionName: "approve_customer" },
    actor: { entity: "User", role: "manager", permission: "manager.approve" },
    input: { pathParams: [{ name: "customer_id", entity: "Customer", field: "id", type: "integer" }] },
    output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 200 },
    preconditions: [
      { kind: "state_is", entity: "Customer", field: "status", value: "pending" },
      { kind: "audit_exists", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "submitted" },
      { kind: "audit_absent", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "approved" },
    ],
    mutation: { entity: "Customer", field: "status", value: "approved" },
    audit: { entity: "AuditEvent", action: "approved", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
    transition: { entity: "Customer", field: "status", from: "pending", to: "approved", auditAction: "approved" },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
    concurrency: { strategy: "row-lock" },
    idempotency: { strategy: "reject-duplicate-audit", auditAction: "approved" },
    failures: { notFound: 404, forbidden: 403, invalidTransition: 409, rollbackOnError: true },
  };
  const rejection = deriveComplementaryDecisionOperation(approval, { operationId: "manager.reject", permission: "manager.reject", routePath: "/customers/{customer_id}/reject", functionName: "reject_customer", toState: "rejected", auditAction: "rejected" });
  assert.deepEqual(validateBusinessOperationSpec(rejection, architecture, catalog), []);
  assert.equal(rejection.concurrency?.strategy, "row-lock");
  assert.ok(rejection.preconditions.some((condition) => condition.kind === "audit_exists" && condition.action === "submitted"));
  assert.ok(rejection.preconditions.some((condition) => condition.kind === "audit_absent" && condition.action === "rejected"));
  const route = appendOperationRoute("from fastapi import APIRouter\nrouter = APIRouter()\n", rejection);
  assert.match(route, /with_for_update\(\)/);
  assert.match(route, /CustomerStatus\.REJECTED/);
  assert.match(route, /action="rejected"/);
  const scopedApproval = { ...approval, architectureHash: scopedArchitecture.contractHash, managerScope: { userField: "review_scope_id" as const, subjectField: "review_scope_id" as const } };
  const scopedRoute = appendOperationRoute("from fastapi import APIRouter\nrouter = APIRouter()\n", scopedApproval);
  assert.match(scopedRoute, /async with atomic_request_transaction\(db\):\n        if current_user\.review_scope_id is None:\n            raise HTTPException/);
});

test("entity-create operation contract renders customer registration and initial audit in one transaction", () => {
  const create = {
    schemaVersion: "1.0" as const,
    operationKind: "entity-create" as const,
    operationId: "customer.register",
    architectureHash: architecture.contractHash,
    targetModule: "backend/routes/customers.py",
    route: { method: "POST" as const, path: "/customers", functionName: "create_customer" },
    actor: { entity: "User" as const, role: "customer", permission: "customer.register" },
    input: { bodySchema: "CustomerCreate", fieldMappings: [
      { targetField: "name", source: "body" as const, sourceField: "name" },
      { targetField: "email", source: "body" as const, sourceField: "email" },
      { targetField: "owner_id", source: "actor" as const, sourceField: "id" },
      { targetField: "status", source: "state" as const, value: "pending" },
    ] },
    output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 201 as const },
    audit: { entity: "AuditEvent", action: "created", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
    transaction: { driver: "sqlalchemy-async" as const, scope: "single-request" as const, atomic: true as const, rollbackOnError: true as const },
    failures: { duplicate: 409 as const, rollbackOnError: true as const },
  };
  assert.deepEqual(validateEntityCreateOperationSpec(create, architecture, catalog), []);
  const result = appendEntityCreateOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", create);
  const handler = result.slice(result.indexOf("async def create_customer"));
  assert.match(handler, /async with atomic_request_transaction\(db\):/);
  assert.match(handler, /Customer\(\s*name=payload\.name,\s*email=payload\.email,\s*owner_id=current_user\.id,\s*status=CustomerStatus\.PENDING/s);
  assert.match(handler, /await db\.flush\(\)[\s\S]*db\.add\(AuditEvent\(user_id=current_user\.id, customer_id=entity_record\.id, action="created"\)\)/);
  assert.doesNotMatch(handler, /db\.(?:commit|rollback)\s*\(/);
  const scopedCreate = { ...create, architectureHash: scopedArchitecture.contractHash, scopeAssignment: "inherit-authenticated-customer" as const };
  assert.deepEqual(validateEntityCreateOperationSpec(scopedCreate, scopedArchitecture, catalog), []);
  const scopedResult = appendEntityCreateOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", scopedCreate);
  assert.match(scopedResult.slice(scopedResult.indexOf("async def create_customer")), /review_scope_id=current_user\.review_scope_id/);
  const invalid = { ...create, input: { ...create.input, fieldMappings: [{ targetField: "owner_id", source: "body", sourceField: "email" }] } };
  assert.ok(validateEntityCreateOperationSpec(invalid, architecture, catalog).some((issue) => /ownership field.*cannot be supplied/.test(issue)));
  const invalidUnknown = { ...create, input: { ...create.input, fieldMappings: [{ targetField: "email", source: "body", sourceField: "password_hash" }] } };
  assert.ok(validateEntityCreateOperationSpec(invalidUnknown, architecture, catalog).some((issue) => /unknown request field/.test(issue)));
});

test("registration contract derives required fields, ownership, state, uniqueness and response from ORM/schema metadata", () => {
  const models = `from sqlalchemy import Column, Integer, String, Enum, ForeignKey
class CustomerStatus(PyEnum):
    pending = "pending"
    approved = "approved"
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    review_scope_id = Column(Integer, ForeignKey("review_scopes.id"), nullable=False)
class Customer(Base):
    __tablename__ = "customers"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    legal_name = Column(String, nullable=False)
    business_email = Column(String, nullable=False, unique=True)
    reference = Column(String, nullable=False, unique=True)
    status = Column(Enum(CustomerStatus), default=CustomerStatus.pending)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    review_scope_id = Column(Integer, ForeignKey("review_scopes.id"), nullable=False)
class AuditEvent(Base):
    __tablename__ = "audit_events"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    customer_id = Column(Integer, ForeignKey("customers.id"), nullable=False)
    action = Column(String, nullable=False)
`;
  const schemas = `class CustomerCreate(BaseModel):
    name: str = Field(..., min_length=1)
    legal_name: str = Field(..., min_length=1)
    business_email: str = Field(..., min_length=1)
    reference: str = Field(..., min_length=1)
class CustomerResponse(BaseModel):
    id: int
    name: str
    legal_name: str
    business_email: str
    status: CustomerStatus
    owner_id: int
`;
  const localCatalog = extractBusinessDomainCatalog(scopedArchitecture, models, schemas, ["customer", "manager"], ["customer.register"]);
  const resolved = createEntityCreateOperationSpec({
    architecture: scopedArchitecture, catalog: localCatalog, modelSource: models, schemaSource: schemas,
    operationId: "customer.register", targetModule: "backend/routes/customers.py", routePath: "/customers", functionName: "create_customer",
    actorRole: "customer", permission: "customer.register", entity: "Customer", bodySchema: "CustomerCreate", responseSchema: "CustomerResponse",
    auditEntity: "AuditEvent", auditAction: "created", auditActorField: "user_id", auditSubjectField: "customer_id", auditActionField: "action",
    serverState: { field: "status", value: "pending" },
  });
  assert.deepEqual(resolved.issues, []);
  assert.equal(localCatalog.enumMembers?.CustomerStatus?.pending, "pending");
  assert.deepEqual(resolved.spec.input.fieldMappings.map((item) => `${item.targetField}:${item.source}:${item.sourceField ?? item.value}`), [
    "name:body:name", "legal_name:body:legal_name", "business_email:body:business_email", "reference:body:reference",
    "owner_id:actor:id", "review_scope_id:actor:review_scope_id", "status:state:pending",
  ]);
  assert.deepEqual(resolved.spec.duplicateFields, ["business_email", "reference"]);
  assert.deepEqual(resolved.fieldContract.requiredOrmFields.sort(), ["business_email", "legal_name", "name", "owner_id", "reference", "review_scope_id"]);
  assert.deepEqual(resolved.fieldContract.responseSchemas.CustomerResponse, ["id", "name", "legal_name", "business_email", "status", "owner_id"]);
  const rendered = appendEntityCreateOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", resolved.spec, models);
  assert.match(rendered, /status=CustomerStatus\.pending/);
  assert.deepEqual(validateEntityCreateRenderedOperation(rendered, resolved.spec, models), []);
  const oldEmailSpec = structuredClone(resolved.spec);
  oldEmailSpec.input.fieldMappings.push({ targetField: "email", source: "body", sourceField: "email" });
  assert.ok(validateEntityCreateOperationSpec(oldEmailSpec, scopedArchitecture, localCatalog).some((issue) => /unknown entity field Customer\.email/.test(issue)));
  const staleSchema = schemas.replace("business_email: str", "email: str");
  const mismatch = createEntityCreateOperationSpec({
    architecture: scopedArchitecture, catalog: extractBusinessDomainCatalog(scopedArchitecture, models, staleSchema, ["customer", "manager"], ["customer.register"]),
    modelSource: models, schemaSource: staleSchema, operationId: "customer.register", targetModule: "backend/routes/customers.py",
    routePath: "/customers", functionName: "create_customer", actorRole: "customer", permission: "customer.register",
    entity: "Customer", bodySchema: "CustomerCreate", responseSchema: "CustomerResponse", auditEntity: "AuditEvent", auditAction: "created",
    auditActorField: "user_id", auditSubjectField: "customer_id", auditActionField: "action", serverState: { field: "status", value: "pending" },
  });
  assert.ok(mismatch.issues.some((issue) => /required request field CustomerCreate\.email has no ORM mapping/.test(issue)));
});

test("registration renderer supplies select import for existing route references and does not accept model-authored guesses", () => {
  const operation: EntityCreateOperationSpec = {
    schemaVersion: "1.0", operationKind: "entity-create", operationId: "customer.register", architectureHash: architecture.contractHash,
    targetModule: "backend/routes/customers.py", route: { method: "POST", path: "/customers", functionName: "create_customer" },
    actor: { entity: "User", role: "customer", permission: "customer.register" },
    input: { bodySchema: "CustomerCreate", fieldMappings: [
      { targetField: "name", source: "body", sourceField: "name" }, { targetField: "email", source: "body", sourceField: "email" },
      { targetField: "owner_id", source: "actor", sourceField: "id" }, { targetField: "status", source: "state", value: "pending" },
    ] }, output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 201 },
    audit: { entity: "AuditEvent", action: "created", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
    failures: { duplicate: 409, rollbackOnError: true },
  };
  const existing = `from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/lookup")\nasync def lookup(db):\n    return await db.execute(select(Customer))\n`;
  const rendered = appendEntityCreateOperation(existing, operation);
  assert.match(rendered, /^from sqlalchemy import select$/m);
  assert.match(rendered, /email=payload\.email/);
  assert.match(rendered, /name=payload\.name/);
  assert.match(rendered, /owner_id=current_user\.id/);
  assert.match(rendered, /status=CustomerStatus\.PENDING/);
  assert.match(rendered, /async with atomic_request_transaction\(db\):/);
});

test("owner-or-manager history-read contract validates declared fields and renders ordered audit access", () => {
  const history: EntityHistoryReadOperationSpec = {
    schemaVersion: "3.0", operationKind: "entity-history-read", operationId: "customer.audit.read",
    architectureHash: scopedArchitecture.contractHash, targetModule: "backend/routes/customers.py",
    route: { method: "GET", path: "/customers/{customer_id}/audit", functionName: "read_customer_audit_history" },
    actor: { entity: "User", access: "owner-or-role", ownerEntity: "Customer", ownerField: "owner_id", privilegedRole: "manager" },
    managerAuthorization: { mode: "review-scope", userField: "review_scope_id", subjectField: "review_scope_id" },
    subject: { entity: "Customer", idField: "id" },
    output: { entity: "AuditEvent", subjectField: "customer_id", responseSchema: "AuditEventResponse", statusCode: 200, orderBy: ["created_at", "id"] },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", readOnly: true },
    failures: { notFound: 404, forbidden: 403 },
  };
  assert.deepEqual(validateEntityHistoryReadOperationSpec(history, scopedArchitecture, catalog), []);
  const invalid = structuredClone(history);
  invalid.actor.ownerField = "password_hash";
  invalid.output.subjectField = "unknown_field";
  assert.ok(validateEntityHistoryReadOperationSpec(invalid, scopedArchitecture, catalog).length >= 2);
  const rendered = appendEntityHistoryReadOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", history);
  assert.match(rendered, /Depends\(get_current_user\)/);
  assert.match(rendered, /Customer\.review_scope_id == current_user\.review_scope_id/);
  assert.match(rendered, /Customer\.owner_id == current_user\.id/);
  assert.match(rendered, /AuditEvent\.customer_id == customer_id/);
  assert.match(rendered, /order_by\([\s\S]*AuditEvent\.created_at\.asc\(\),[\s\S]*AuditEvent\.id\.asc\(\)/);
  assert.match(rendered, /HTTPException\(status_code=403/);
  assert.doesNotMatch(rendered, /commit\s*\(/);
  const reconciled = reconcileEntityHistoryReadOperation({ ...history, schemaVersion: "2.0", managerScope: { userField: "review_scope_id", subjectField: "review_scope_id" } }, { ...history, managerAuthorization: { mode: "global" } }, architecture);
  assert.equal(reconciled.replacedLegacyScope, true);
  assert.equal(reconciled.operation.managerAuthorization.mode, "global");
});

test("global-manager history contract authorizes all owners while customers remain owner-scoped", () => {
  const noScopeModels = modelSource
    .replace("    review_scope_id = Column(Integer)\n", "")
    .replace("    review_scope_id = Column(Integer)\n", "");
  const noScopeCatalog = extractBusinessDomainCatalog(architecture, noScopeModels, schemaSource, ["customer", "manager"], ["customer.audit.read"]);
  const history: EntityHistoryReadOperationSpec = {
    schemaVersion: "3.0", operationKind: "entity-history-read", operationId: "customer.audit.read",
    architectureHash: architecture.contractHash, targetModule: "backend/routes/customers.py",
    route: { method: "GET", path: "/customers/{customer_id}/audit", functionName: "read_customer_audit_history" },
    actor: { entity: "User", access: "owner-or-role", ownerEntity: "Customer", ownerField: "owner_id", privilegedRole: "manager" },
    managerAuthorization: { mode: "global" },
    subject: { entity: "Customer", idField: "id" },
    output: { entity: "AuditEvent", subjectField: "customer_id", responseSchema: "AuditEventResponse", statusCode: 200, orderBy: ["created_at", "id"] },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", readOnly: true },
    failures: { notFound: 404, forbidden: 403 },
  };
  assert.deepEqual(validateEntityHistoryReadOperationSpec(history, architecture, noScopeCatalog), []);
  const rendered = appendEntityHistoryReadOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", history);
  assert.match(rendered, /if current_user\.role == "manager":[\s\S]*select\(Customer\)\.where\(Customer\.id == customer_id\)/);
  assert.match(rendered, /elif current_user\.role == "customer":[\s\S]*Customer\.id == customer_id, Customer\.owner_id == current_user\.id/);
  assert.match(rendered, /else:\n        raise HTTPException\(status_code=403/);
  assert.match(rendered, /select\(AuditEvent\)\.where\(AuditEvent\.customer_id == customer_id\)/);
  assert.doesNotMatch(rendered, /review_scope_id/);

  const scopedGlobal = validateEntityHistoryReadOperationSpec(history, scopedArchitecture, noScopeCatalog);
  assert.ok(scopedGlobal.some((issue) => /conflicts with the PAC review-scope policy/.test(issue)));
  const scopeInContract = { ...history, managerAuthorization: { mode: "review-scope", userField: "review_scope_id", subjectField: "review_scope_id" } } as EntityHistoryReadOperationSpec;
  assert.ok(validateEntityHistoryReadOperationSpec(scopeInContract, architecture, noScopeCatalog).some((issue) => /declared by the PAC/.test(issue)));
});

test("no-scope PAC generates a global manager queue and owner-scoped customer dashboard without scope fields", () => {
  const noScopeModels = modelSource.replaceAll("    review_scope_id = Column(Integer)\n", "");
  const contracts = createCustomerReadOperationContracts(architecture, noScopeModels, schemaSource);
  const noScopeSchemas = appendCustomerPageResponseSchema(schemaSource);
  const noScopeCatalog = extractBusinessDomainCatalog(architecture, noScopeModels, noScopeSchemas, ["customer", "manager"], ["customer.listOwn", "manager.listReviewQueue", "customer.getOwn", "manager.getReviewable", "customer.audit.read"]);
  assert.deepEqual(validateEntityCollectionReadOperationSpec(contracts.customerList, architecture, noScopeCatalog), []);
  assert.deepEqual(validateEntityCollectionReadOperationSpec(contracts.managerQueue, architecture, noScopeCatalog), []);
  assert.deepEqual(validateEntityRecordReadOperationSpec(contracts.managerDetail, architecture, noScopeCatalog), []);
  const queue = appendEntityCollectionReadOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", contracts.managerQueue);
  const detail = appendEntityRecordReadOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", contracts.managerDetail);
  assert.match(queue, /Customer\.owner_id == current_user\.id/);
  assert.match(queue, /elif current_user\.role == "manager"/);
  assert.match(queue, /AuditEvent\.action == "submitted"/);
  assert.doesNotMatch(queue, /review_scope_id/);
  assert.match(detail, /Customer\.owner_id == current_user\.id/);
  assert.match(detail, /elif current_user\.role == "manager":[\s\S]*predicate = True/);
  assert.doesNotMatch(detail, /review_scope_id/);
});

test("collection read contract requires owner and explicit manager scope filters", () => {
  const scopedModels = modelSource.replace('role = Column(String, default="customer")', 'role = Column(String, default="customer")\n    review_scope_id = Column(Integer)')
    .replace("owner_id = Column(Integer)", "owner_id = Column(Integer)\n    review_scope_id = Column(Integer)");
  const scopedCatalog = extractBusinessDomainCatalog(scopedArchitecture, scopedModels, schemaSource, ["customer", "manager"], ["customer.listOwn", "manager.listReviewQueue"]);
  const operation: EntityCollectionReadOperationSpec = {
    schemaVersion: "1.0", operationKind: "entity-collection-read", operationId: "customer.listOwn",
    architectureHash: scopedArchitecture.contractHash, targetModule: "backend/routes/customers.py",
    route: { method: "GET", path: "/customers", functionName: "list_customers" },
    actor: { entity: "User", customerRole: "customer", managerRole: "manager" },
    authorization: {
      customer: { entity: "Customer", ownerField: "owner_id", actorField: "id" },
      manager: { mode: "review-scope", userScopeField: "review_scope_id", customerScopeField: "review_scope_id", requiresSubmittedAudit: true },
    },
    query: { statusField: "status", pageSizeDefault: 25, pageSizeMaximum: 100, orderBy: ["created_at", "id"] },
    output: { entity: "Customer", responseSchema: "CustomerPageResponse", statusCode: 200 },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", readOnly: true },
    failures: { unauthenticated: 401, forbidden: 403 },
  };
  scopedCatalog.responseSchemas.push("CustomerPageResponse");
  assert.deepEqual(validateEntityCollectionReadOperationSpec(operation, scopedArchitecture, scopedCatalog), []);
  const route = appendEntityCollectionReadOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", operation);
  assert.match(route, /Customer\.owner_id == current_user\.id/);
  assert.match(route, /Customer\.review_scope_id == current_user\.review_scope_id/);
  assert.match(route, /Customer\.status == CustomerStatus\.PENDING/);
  assert.match(route, /status_filter: CustomerStatus \| None = Query\(default=None, alias="status"\)/);
  assert.match(route, /AuditEvent\.action == "submitted"/);
  assert.match(route, /offset\(offset\)\.limit\(limit\)/);
  const refreshedRoute = appendEntityCollectionReadOperation(route, operation);
  assert.equal((refreshedRoute.match(/async def list_customers\(/g) ?? []).length, 1);
  assert.match(refreshedRoute, /status_filter: CustomerStatus \| None = Query\(default=None, alias="status"\)/);
  assert.ok(validateEntityCollectionReadOperationSpec({ ...operation, authorization: { ...operation.authorization, manager: { ...operation.authorization.manager, requiresSubmittedAudit: false } } }, scopedArchitecture, scopedCatalog).some((issue) => /submitted-audit evidence/.test(issue)));
});

test("record reads constrain both customer ownership and manager review scope in SQL", async () => {
  const pac = scopedArchitecture;
  const operation: EntityRecordReadOperationSpec = {
    schemaVersion: "1.0", operationKind: "entity-record-read", operationId: "customer.getOwn",
    architectureHash: pac.contractHash, targetModule: "backend/routes/customers.py",
    route: { method: "GET", path: "/customers/{customer_id}", functionName: "get_customer" },
    actor: { entity: "User", customerRole: "customer", managerRole: "manager" },
    authorization: { ownerField: "owner_id", ownerActorField: "id", manager: { mode: "review-scope", userScopeField: "review_scope_id", customerScopeField: "review_scope_id" } },
    output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 200, unauthorized: 404 },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", readOnly: true },
  };
  assert.deepEqual(validateEntityRecordReadOperationSpec(operation, pac, catalog), []);
  const rendered = appendEntityRecordReadOperation("from fastapi import APIRouter\nrouter = APIRouter()\n", operation);
  assert.match(rendered, /Customer\.owner_id == current_user\.id/);
  assert.match(rendered, /Customer\.review_scope_id == current_user\.review_scope_id/);
  assert.match(rendered, /select\(Customer\)\.where\(Customer\.id == customer_id, predicate\)/);
  assert.doesNotMatch(rendered, /select\(Customer\)\.where\(Customer\.id == customer_id\)\s*$/m);
});
