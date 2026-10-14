import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelOption, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import { bindComposePortsToLoopback, buildStages, ensurePlaywrightHarness, filesWithEdits, validateBuildStage } from "../src/buildContract.js";
import { resolveProjectArchitecture } from "../src/projectArchitecture.js";
import { backendSubtaskContext, backendSubtaskExecutionRules, backendSubtaskIssues, backendSubtaskPlan, checkpointValidatedDatabaseSubtasks, combineBuildEdits, compactBackendRequirements, contextForBuildStage, createBuildPipelineRunner, databaseSubtaskIssues, databaseSubtaskPlan, ensureArchitectureScaffold, ensureWebDeploymentScaffold, focusRepairContext, testStageRepairContext, frontendTypecheckArgs, hasReusableUiContributionCheckpoint, missingApprovedStagePaths, normalizeReplayedArtifactActions, normalizeComposeCredentialDefaults, promoteAwaitingPythonRoutes, registerGeneratedFastApiRouters, repairAllowedPaths, repairAllowedPathsForStage, repairBackendCheckpointSubtasks, repairDatabaseCheckpointArtifacts, repairDatabaseCheckpointSubtasks, repairFingerprint, repairGuidance, repairIncompleteCheckpointStageSnapshot, repairKnownFastApiAuthIssues, repairPydanticResponseAttributes, repairKnownFrontendToolingIssues, repairKnownPostgresEnumMigrationIssues, repairKnownPythonNameErrors, repairKnownSqlAlchemyModelIssues, repairPythonEnumMemberReferences, repairResolvablePythonRelativeImports, restoreValidatedBackendSubtaskArtifacts, setBackendImportValidatorForTests, setFrontendBuildValidatorForTests, shouldUseValidatedScaffoldOnly, uiOperationsFromCheckpoint, validateBackendImports, validateDatabaseSubtaskCheckpoint, validateFrontendBackendContract, validateFrontendBuild, validatePythonModuleSymbols, validatePythonSources, validateTypeScriptSyntax } from "../src/buildPipeline.js";
import type { AgentRunner } from "../src/runners/types.js";
import { appendOperationRoute, createAuthenticationLoginOperationSpec, type BusinessOperationSpec } from "../src/businessOperations.js";
import { buildArtifactOwnershipManifest } from "../src/artifactOwnership.js";

const prompt = "Build a React frontend, FastAPI backend, and PostgreSQL database application with login, manager approval, transactional audit history, integration tests, and Playwright E2E.";
setBackendImportValidatorForTests(async () => []);
setFrontendBuildValidatorForTests(async () => []);

test("test-stage repair context includes complete test targets and excludes application source", () => {
  const compact = { projectPath: "/tmp/project", relevantFiles: [{ relPath: "frontend/package.json", snippet: "{}", content: "{}" }] };
  const original = { projectPath: "/tmp/project", relevantFiles: [
    { relPath: "backend/main.py", snippet: "application secret", content: "application secret" },
    { relPath: "backend/requirements.txt", snippet: "pytest", content: "pytest" },
  ] };
  const repair = testStageRepairContext(compact, original, [
    { path: "backend/tests/test_api.py", action: "create", content: "def test_api():\n    assert True\n" },
    { path: "backend/main.py", action: "modify", content: "do not expose" },
  ]);
  const paths = repair.relevantFiles?.map((file) => file.relPath) ?? [];
  assert.ok(paths.includes("frontend/package.json"));
  assert.ok(paths.includes("backend/requirements.txt"));
  assert.ok(paths.includes("backend/tests/test_api.py"));
  assert.ok(!paths.includes("backend/main.py"));
  assert.equal(repair.relevantFiles?.find((file) => file.relPath === "backend/tests/test_api.py")?.content, "def test_api():\n    assert True\n");
});

function operationSpecForTest(architecture: ReturnType<typeof resolveProjectArchitecture>, operationId = "customer.submit"): BusinessOperationSpec {
  if (operationId === "manager.approve" || operationId === "manager.reject") {
    const approve = operationId === "manager.approve";
    const action = approve ? "approved" : "rejected";
    const to = approve ? "approved" : "rejected";
    return {
      schemaVersion: "1.0", operationId, architectureHash: architecture.contractHash, targetModule: "backend/routes/customers.py",
      route: { method: "POST", path: `/customers/{customer_id}/${approve ? "approve" : "reject"}`, functionName: approve ? "approve_customer" : "reject_customer" },
      actor: { entity: "User", role: "manager", permission: operationId },
      input: { pathParams: [{ name: "customer_id", entity: "Customer", field: "id", type: "integer" }] },
      output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 200 },
      preconditions: [
        { kind: "state_is", entity: "Customer", field: "status", value: "pending" },
        { kind: "audit_exists", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "submitted" },
        { kind: "audit_absent", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action },
      ],
      mutation: { entity: "Customer", field: "status", value: to },
      audit: { entity: "AuditEvent", action, actorField: "user_id", subjectField: "customer_id", actionField: "action" },
      transition: { entity: "Customer", field: "status", from: "pending", to, auditAction: action },
      transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
      concurrency: { strategy: "row-lock" },
      idempotency: { strategy: "reject-duplicate-audit", auditAction: action },
      failures: { notFound: 404, forbidden: 403, invalidTransition: 409, rollbackOnError: true },
    };
  }
  return {
    schemaVersion: "1.0", operationId: "customer.submit", architectureHash: architecture.contractHash,
    targetModule: "backend/routes/customers.py",
    route: { method: "POST", path: "/customers/{customer_id}/submit", functionName: "submit_customer" },
    actor: { entity: "User", role: "customer", permission: "customer.submit" },
    input: { pathParams: [{ name: "customer_id", entity: "Customer", field: "id", type: "integer" }] },
    output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 200 },
    preconditions: [{ kind: "owner_is_actor", entity: "Customer", field: "owner_id" }, { kind: "state_is", entity: "Customer", field: "status", value: "pending" }, { kind: "audit_absent", entity: "AuditEvent", subjectField: "customer_id", actionField: "action", action: "submitted" }],
    mutation: { entity: "Customer", field: "status", value: "pending" },
    audit: { entity: "AuditEvent", action: "submitted", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
    transition: { entity: "Customer", field: "status", from: "pending", to: "pending", auditAction: "submitted" },
    transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
    idempotency: { strategy: "reject-duplicate-audit", auditAction: "submitted" },
    failures: { notFound: 404, forbidden: 403, invalidTransition: 409, rollbackOnError: true },
  };
}

test("database generation is split into dependency ordered PAC-path subtasks", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const plan = databaseSubtaskPlan(architecture);
  assert.deepEqual(plan.map((item) => item.id), ["customer-entity", "related-entities", "schema-constraints", "alembic-revision"]);
  assert.deepEqual(plan.map((item) => item.targetPaths), [
    ["backend/models.py"], ["backend/models.py"], ["backend/models.py"], ["backend/migrations/versions/0001_initial.py"],
  ]);
  assert.ok(plan[1].acceptanceCriteria.some((criterion) => /non-null String role/.test(criterion)));
  assert.ok(plan[1].acceptanceCriteria.some((criterion) => /AuditEvent\.customer back_populates=audit_events/.test(criterion)));
});

test("backend generation is split into dependency ordered PAC-path subtasks with contracts", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const plan = backendSubtaskPlan(architecture);
  assert.deepEqual(plan.map((item) => item.id), ["backend-schemas", "authentication", "role-authorization", "customer-repository-service", "customer-registration-api", "submission-api", "manager-decision-api", "audit-history-api", "auth-api", "router-registration"]);
  assert.ok(plan.every((item) => item.targetPaths.every((path) => architecture.modules.some((module) => module.path === path))));
  assert.ok(plan[0].acceptanceCriteria.some((criterion) => /CustomerCreate/.test(criterion)));
  const architectureWithEnums = resolveProjectArchitecture(prompt);
  const approve = plan.find((item) => item.id === "manager-decision-api")!;
  assert.ok(backendSubtaskIssues(approve, [{ path: "backend/routes/customers.py", action: "create", content: "@router.post('/approve') async def approve(): return {}" }], architectureWithEnums).some((issue) => /require_role/.test(issue)));
  const registration = plan.find((item) => item.id === "customer-registration-api")!;
  const nonAtomic = "@router.post('/customers')\nasync def create_customer():\n    await db.commit()\n    db.add(AuditEvent())\n    await db.commit()\n";
  assert.ok(backendSubtaskIssues(registration, [{ path: registration.targetPaths[0], action: "create", content: nonAtomic }], architecture).some((issue) => /share one database transaction/.test(issue)));
  const submission = plan.find((item) => item.id === "submission-api")!;
  const wrongHandler = "@router.post('/unrelated')\nasync def other():\n    async with db.begin():\n        db.add(AuditEvent())\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer():\n    customer.status = CustomerStatus.PENDING\n    db.add(AuditEvent())\n";
  assert.ok(backendSubtaskIssues(submission, [{ path: submission.targetPaths[0], action: "modify", content: wrongHandler }], architecture).some((issue) => /same handler transaction/.test(issue)));
  const atomicHandler = "@router.post('/customers')\nasync def create_customer(current_user: User = Depends(require_role('customer'))):\n    return None\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer(current_user: User = Depends(require_role('customer'))):\n    async with db.begin():\n        customer.status = CustomerStatus.PENDING\n        db.add(AuditEvent(user_id=current_user.id, customer_id=customer.id, action='submitted'))\n";
  assert.deepEqual(backendSubtaskIssues(submission, [{ path: submission.targetPaths[0], action: "modify", content: atomicHandler }], architecture), []);
  const wrongOwnerRole = atomicHandler.replaceAll("require_role('customer')", "require_role('manager')");
  assert.ok(backendSubtaskIssues(submission, [{ path: submission.targetPaths[0], action: "modify", content: wrongOwnerRole }], architecture).some((issue) => /same authenticated customer owner role/.test(issue)));
  const helperBackedHandler = "from contextlib import asynccontextmanager\n@asynccontextmanager\nasync def atomic_request_transaction(db):\n    active_transaction = db.get_transaction()\n    if active_transaction is None:\n        async with db.begin():\n            yield\n        return\n    try:\n        yield\n        await active_transaction.commit()\n    except BaseException:\n        await active_transaction.rollback()\n        raise\n@router.post('/customers')\nasync def create_customer(current_user: User = Depends(require_role('customer'))):\n    return None\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer(current_user: User = Depends(require_role('customer'))):\n    async with atomic_request_transaction(db):\n        customer.status = CustomerStatus.PENDING\n        db.add(AuditEvent(user_id=current_user.id, customer_id=customer.id, action='submitted'))\n";
  assert.deepEqual(backendSubtaskIssues(submission, [{ path: submission.targetPaths[0], action: "modify", content: helperBackedHandler }], architecture), []);
  assert.ok(backendSubtaskIssues(submission, [{ path: submission.targetPaths[0], action: "modify", content: helperBackedHandler.replace("await active_transaction.rollback()", "pass") }], architecture).some((issue) => /same handler transaction/.test(issue)));
  assert.ok(backendSubtaskIssues(submission, [{ path: submission.targetPaths[0], action: "modify", content: helperBackedHandler.replace("        db.add(AuditEvent(user_id=current_user.id, customer_id=customer.id, action='submitted'))", "        db.add(AuditEvent(user_id=current_user.id, customer_id=customer.id, action='submitted'))\n    await db.commit()") }], architecture).some((issue) => /manual commits/.test(issue)));
});

test("SQLAlchemy business subtasks get an explicit atomic async transaction protocol", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const plan = backendSubtaskPlan(architecture);
  const submission = plan.find((item) => item.id === "submission-api")!;
  const rules = backendSubtaskExecutionRules(submission, architecture).join("\n");
  assert.match(rules, /async with db\.begin\(\)/);
  assert.match(rules, /before the first query or write/);
  assert.match(rules, /db\.add\(AuditEvent/);
  assert.match(rules, /do not call `db\.commit\(\)`/);
  assert.match(rules, /pending plus a submitted AuditEvent as the domain state Submitted/);
  assert.ok(submission.acceptanceCriteria.some((criterion) => /submitted AuditEvent/.test(criterion)));
  assert.equal(backendSubtaskExecutionRules(plan.find((item) => item.id === "manager-decision-api")!, architecture).length, 2);
  assert.deepEqual(backendSubtaskExecutionRules(plan.find((item) => item.id === "audit-history-api")!, architecture), []);
});

test("backend prompts use a bounded workflow summary and only relevant PAC module context", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const registration = backendSubtaskPlan(architecture).find((item) => item.id === "customer-registration-api")!;
  const names = ["backend/requirements.txt", "backend/config.py", "backend/database.py", "backend/models.py", "backend/schemas.py", "backend/auth.py", "backend/routes/customers.py", "frontend/package.json"];
  const context = backendSubtaskContext(registration, { indexedChunkCount: 0, relevantFiles: names.map((relPath) => ({ relPath, content: `${relPath} full content`, snippet: `${relPath} snippet` })) });
  assert.deepEqual(context.relevantFiles?.map((file) => file.relPath), ["backend/database.py", "backend/models.py", "backend/schemas.py", "backend/auth.py", "backend/routes/customers.py"]);
  const requirements = compactBackendRequirements(`${"Build a customer onboarding system.\n".repeat(500)}manager approval and audit records must be transactionally persisted`, 700);
  assert.ok(requirements.length <= 700);
  assert.match(requirements, /customer onboarding/i);
  assert.match(requirements, /manager approval/i);
});

test("authentication backend contracts reject invalid async-generator usage and require persisted-role enforcement", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const auth = backendSubtaskPlan(architecture).find((item) => item.id === "authentication")!;
  const invalid = "async def require_role(required_role):\n async with get_db() as db: pass\n async def inner(current_user):\n  if current_user.role != required_role: raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)\n return Depends(inner)\n";
  const issues = backendSubtaskIssues(auth, [{ path: "backend/auth.py", action: "create", content: invalid }], architecture);
  assert.ok(issues.some((issue) => /async-generator dependency/.test(issue)));
  assert.ok(issues.some((issue) => /synchronous dependency factory/.test(issue)));
  assert.ok(issues.some((issue) => /password hash/.test(issue)));
  assert.ok(issues.some((issue) => /AsyncSession dependency/.test(issue)));
  const valid = "from fastapi import Depends, HTTPException, status\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom passlib.context import CryptContext\nfrom backend.database import get_db\ncrypt_context = CryptContext(schemes=['bcrypt'], deprecated='auto')\nasync def authenticate_user(db: AsyncSession = Depends(get_db)): return crypt_context.verify(password, user.password_hash)\nasync def get_current_user(db: AsyncSession = Depends(get_db)): return user\ndef require_role(required_role: str):\n async def inner_dependency(current_user: User = Depends(get_current_user)):\n  if current_user.role != required_role: raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)\n  return current_user\n return inner_dependency\n";
  assert.deepEqual(backendSubtaskIssues(auth, [{ path: "backend/auth.py", action: "create", content: valid }], architecture), []);
});

test("known FastAPI auth repair uses PAC settings, injected AsyncSession, and synchronous role factory", () => {
  const source = "from fastapi import Depends, HTTPException, status\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom backend.database import get_db\nfrom backend.models import User\nfrom backend.config import settings\nasync def authenticate_user(username: str, password: str):\n    user = await get_user(username)\n    return user\nasync def get_current_user(token: str = Depends(oauth2_scheme)):\n    jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])\n    user = await get_user(username)\n    return user\nasync def require_role(role: str):\n    async def role_check(user: User = Depends(get_current_user)):\n        if user.role != role: raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)\n        return user\n    return Depends(role_check)\nasync def get_user(username: str):\n    async with get_db() as db:\n        return await db.scalar(db.select(User).where(User.username == username))\n";
  const edit: ProposedEdit = { path: "backend/auth.py", action: "create", content: source };
  const result = repairKnownFastApiAuthIssues([edit]);
  assert.deepEqual(result.changedPaths, ["backend/auth.py"]);
  assert.match(result.edits[0].content, /^from sqlalchemy import select/m);
  assert.match(result.edits[0].content, /^def require_role/m);
  assert.match(result.edits[0].content, /async def get_current_user\([^\n]*db: AsyncSession = Depends\(get_db\)\)/);
  assert.match(result.edits[0].content, /return role_check/);
  assert.match(result.edits[0].content, /algorithms=\[\"HS256\"\]/);
  assert.match(result.edits[0].content, /async def get_user\(username: str, db: AsyncSession\)/);
  assert.doesNotMatch(result.edits[0].content, /async with get_db\s*\(|settings\.jwt_algorithm/);
  assert.deepEqual(repairKnownFastApiAuthIssues(result.edits).changedPaths, []);
});

test("resume repairs and rechecks auth checkpoint checksums without regenerating modules", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const authContent = "from fastapi import Depends, HTTPException, status\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom backend.database import get_db\nfrom backend.models import User\nfrom backend.config import settings\nfrom passlib.context import CryptContext\ncrypt_context = CryptContext(schemes=['bcrypt'], deprecated='auto')\nasync def authenticate_user(username: str, password: str):\n user = await get_user(username)\n if not user or not crypt_context.verify(password, user.password_hash): return False\n return user\nasync def get_current_user(token: str = Depends(oauth2_scheme)):\n user = await get_user(username, db)\n return user\nasync def require_role(role: str):\n async def inner_dependency(current_user: User = Depends(get_current_user)):\n  if current_user.role != role: raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)\n  return current_user\n return Depends(inner_dependency)\nasync def get_user(username: str):\n async with get_db() as db: return await db.scalar(db.select(User).where(User.username == username))\n";
  const hash = createHash("sha256").update(authContent).digest("hex");
  const records = ["authentication", "role-authorization"].map((id) => ({ id, completedAt: new Date(0).toISOString(), architectureHash: architecture.contractHash, artifacts: [{ path: "backend/auth.py", action: "create" as const, content: authContent, sha256: hash }] }));
  const repaired = repairBackendCheckpointSubtasks(records);
  assert.deepEqual(repaired.changedPaths, ["backend/auth.py"]);
  for (const record of repaired.records ?? []) {
    const artifact = record.artifacts[0];
    assert.equal(artifact.sha256, createHash("sha256").update(artifact.content).digest("hex"));
    assert.deepEqual(backendSubtaskIssues(backendSubtaskPlan(architecture).find((item) => item.id === record.id)!, [{ path: artifact.path, action: artifact.action, content: artifact.content }], architecture), []);
  }
});

test("Pydantic response schema repair enables SQLAlchemy attribute serialization and refreshes checkpoint checksums", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const schemas = "from datetime import datetime\nfrom pydantic import BaseModel\nclass CustomerCreate(BaseModel):\n    name: str\nclass CustomerResponse(BaseModel):\n    id: int\n    status: str\n    created_at: datetime\nclass LoginRequest(BaseModel):\n    username: str\n    password: str\nclass TokenResponse(BaseModel):\n    access_token: str\n";
  const before = backendSubtaskPlan(architecture).find((item) => item.id === "backend-schemas")!;
  assert.ok(backendSubtaskIssues(before, [{ path: "backend/schemas.py", action: "create", content: schemas }], architecture).some((issue) => /enable ORM attribute validation/.test(issue)));
  const repaired = repairPydanticResponseAttributes([{ path: "backend/schemas.py", action: "create", content: schemas }]);
  assert.deepEqual(repaired.changedPaths, ["backend/schemas.py"]);
  assert.match(repaired.edits[0].content, /from pydantic import BaseModel, ConfigDict/);
  assert.match(repaired.edits[0].content, /model_config = ConfigDict\(from_attributes=True\)/);
  assert.deepEqual(backendSubtaskIssues(before, repaired.edits, architecture), []);
  const checkpoint = repairBackendCheckpointSubtasks([{ id: "backend-schemas", completedAt: new Date(0).toISOString(), architectureHash: architecture.contractHash, artifacts: [{ path: "backend/schemas.py", action: "create", content: schemas, sha256: createHash("sha256").update(schemas).digest("hex") }] }]);
  assert.deepEqual(checkpoint.changedPaths, ["backend/schemas.py"]);
  assert.equal(checkpoint.records?.[0].artifacts[0].sha256, createHash("sha256").update(checkpoint.records![0].artifacts[0].content).digest("hex"));
});

test("FastAPI auth repair imports referenced PAC schema symbols", () => {
  const route = "from fastapi import APIRouter, Depends\nfrom backend.auth import authenticate_user\nrouter = APIRouter()\n@router.post('/login')\nasync def login(form_data: LoginRequest):\n    expires = timedelta(minutes=JWT_ACCESS_TOKEN_EXPIRE_MINUTES)\n    return TokenResponse(access_token='test')\n";
  const repaired = repairKnownFastApiAuthIssues([{ path: "backend/routes/auth.py", action: "create", content: route }]);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/auth.py"]);
  assert.match(repaired.edits[0].content, /from backend\.schemas import LoginRequest, TokenResponse/);
  assert.match(repaired.edits[0].content, /from backend\.auth import authenticate_user, JWT_ACCESS_TOKEN_EXPIRE_MINUTES/);
  assert.match(repaired.edits[0].content, /from datetime import timedelta/);
});

test("resume aligns registration only from the entity-create actor and ignores manager decision roles", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const base = "from fastapi import APIRouter, Depends\nfrom backend.models import User\nfrom backend.auth import require_role\nrouter = APIRouter()\nasync def create_customer(current_user: User = Depends(require_role('manager'))):\n    return None\n";
  const route = appendOperationRoute(base, operationSpecForTest(architecture));
  const mismatched = route.replace('async def create_customer(current_user: User = Depends(require_role("customer")))', 'async def create_customer(current_user: User = Depends(require_role("manager")))');
  const operationContent = JSON.stringify(operationSpecForTest(architecture));
  const records = [{ id: "submission-api", completedAt: new Date(0).toISOString(), architectureHash: architecture.contractHash, artifacts: [{ path: "backend/routes/customers.py", action: "create" as const, content: mismatched, sha256: createHash("sha256").update(mismatched).digest("hex") }] }];
  const registrationContent = JSON.stringify({ operationKind: "entity-create", operationId: "customer.register", targetModule: "backend/routes/customers.py", actor: { role: "customer" } });
  const managerContent = JSON.stringify({ operationId: "manager.approve", targetModule: "backend/routes/customers.py", actor: { role: "manager" } });
  const repaired = repairBackendCheckpointSubtasks(records, [
    { operationId: "customer.submit", architectureHash: architecture.contractHash, content: operationContent, sha256: createHash("sha256").update(operationContent).digest("hex"), createdAt: new Date(0).toISOString() },
    { operationId: "customer.register", architectureHash: architecture.contractHash, content: registrationContent, sha256: createHash("sha256").update(registrationContent).digest("hex"), createdAt: new Date(0).toISOString() },
    { operationId: "manager.approve", architectureHash: architecture.contractHash, content: managerContent, sha256: createHash("sha256").update(managerContent).digest("hex"), createdAt: new Date(0).toISOString() },
  ]);
  const artifact = repaired.records![0].artifacts[0];
  assert.deepEqual(repaired.changedPaths, ["backend/routes/customers.py"]);
  assert.match(artifact.content, /async def create_customer\([^\n]*require_role\("customer"\)/);
  assert.equal(artifact.sha256, createHash("sha256").update(artifact.content).digest("hex"));
  const subtask = backendSubtaskPlan(architecture).find((item) => item.id === "submission-api")!;
  assert.deepEqual(backendSubtaskIssues(subtask, [{ path: artifact.path, action: artifact.action, content: artifact.content }], architecture), []);
});

test("FastAPI auth checkpoint repair restores security imports before preserving the module", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const roleTask = backendSubtaskPlan(architecture).find((item) => item.id === "role-authorization")!;
  const content = "from fastapi import Depends, HTTPException, status\nfrom jose import JWTError, jwt\nOAuth2PasswordBearer(tokenUrl='token')\n";
  const repaired = repairKnownFastApiAuthIssues([{ path: "backend/auth.py", action: "create", content }]);
  assert.deepEqual(repaired.changedPaths, ["backend/auth.py"]);
  assert.match(repaired.edits[0].content, /^from fastapi\.security import OAuth2PasswordBearer/m);
  const withoutImport = repaired.edits[0].content.replace(/^from fastapi\.security import OAuth2PasswordBearer\n/m, "");
  const issues = backendSubtaskIssues(roleTask, [{ path: "backend/auth.py", action: "create", content: withoutImport }], architecture);
  assert.ok(issues.some((issue) => /must import OAuth2PasswordBearer/.test(issue)));
});

test("SQLAlchemy async scaffold upgrades existing dependencies with the asyncio extra", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const scaffold = ensureArchitectureScaffold("scaffold", prompt, architecture, [], {
    relevantFiles: [{ relPath: "backend/requirements.txt", content: "fastapi\nsqlalchemy>=2.0,<3\nasyncpg\n" }],
    indexedChunkCount: 1,
  });
  const requirements = scaffold.find((edit) => edit.path === "backend/requirements.txt")?.content ?? "";
  assert.match(requirements, /^sqlalchemy\[asyncio\]>=2\.0,<3$/m);
  assert.match(requirements, /^bcrypt>=4\.0,<4\.1$/m, "Passlib 1.x must not resolve the incompatible bcrypt 5.x API");
  assert.doesNotMatch(requirements, /^sqlalchemy>=/m);
});

test("resuming a validated scaffold updates only the SQLAlchemy async dependency", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const modelEdit: ProposedEdit = { path: "backend/models.py", action: "modify", content: "class Customer: ...\n" };
  const edits = ensureArchitectureScaffold("backend", prompt, architecture, [modelEdit], {
    relevantFiles: [{ relPath: "backend/requirements.txt", content: "fastapi\nsqlalchemy>=2.0,<3\nasyncpg\n" }],
    indexedChunkCount: 1,
  });
  assert.deepEqual(edits.map((edit) => edit.path), ["backend/models.py", "backend/requirements.txt"]);
  assert.match(edits[1].content, /^sqlalchemy\[asyncio\]>=2\.0,<3$/m);
});

test("database subtask contract rejects incompatible ORM, missing entity fields, and malformed migrations", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const [customer, , , migration] = databaseSubtaskPlan(architecture);
  const invalidModel: ProposedEdit = { path: "backend/models.py", action: "create", content: "from tortoise import fields\nclass Customer: pass\n" };
  assert.ok(databaseSubtaskIssues(customer, [invalidModel], architecture).some((issue) => /ORM APIs incompatible/.test(issue)));
  assert.ok(databaseSubtaskIssues(customer, [invalidModel], architecture).some((issue) => /email field/.test(issue)));
  const invalidEnum: ProposedEdit = { path: "backend/models.py", action: "create", content: "from sqlalchemy import Column, Enum\nfrom backend.database import Base\nfrom enum import Enum as PyEnum\nclass CustomerStatus(PyEnum):\n    PENDING = 'pending'\nclass Customer(Base):\n    status = Column(CustomerStatus)\n" };
  assert.ok(databaseSubtaskIssues(customer, [invalidEnum], architecture).some((issue) => /must be wrapped in sqlalchemy\.Enum/.test(issue)));
  const checkpointCheck = validateDatabaseSubtaskCheckpoint([{ id: "customer-entity", artifacts: [{ path: invalidEnum.path, action: invalidEnum.action, content: invalidEnum.content }] }], architecture);
  assert.equal(checkpointCheck.invalidSubtaskId, "customer-entity", "resume revalidation catches semantic ORM failures in previously checkpointed models");
  const invalidMigration: ProposedEdit = { path: migration.targetPaths[0], action: "create", content: "revision = 'abc'\ndef upgrade(): pass\n" };
  assert.ok(databaseSubtaskIssues(migration, [invalidMigration], architecture).some((issue) => /revision identifiers/.test(issue)));
  assert.ok(databaseSubtaskIssues(migration, [invalidMigration], architecture).some((issue) => /downgrade/.test(issue)));
  assert.ok(databaseSubtaskIssues(migration, [invalidMigration], architecture).some((issue) => /create a database table/.test(issue)));
  const unnamedPostgresEnum: ProposedEdit = { path: migration.targetPaths[0], action: "create", content: "revision = 'abc'\ndown_revision = None\ndef upgrade():\n    op.create_table('customers', sa.Column('status', sa.Enum('pending', 'approved', 'rejected')))\ndef downgrade():\n    op.drop_table('customers')\n" };
  assert.ok(databaseSubtaskIssues(migration, [unnamedPostgresEnum], architecture).some((issue) => /PostgreSQL Alembic ENUM types must declare an explicit stable name/.test(issue)));
});

test("deterministic SQLAlchemy model repair fixes enum, base, and role mismatches", () => {
  const edit: ProposedEdit = { path: "backend/models.py", action: "create", content: `from sqlalchemy import Column, Enum, String\nfrom enum import Enum as PyEnum\nfrom backend.database import Base\nclass CustomerStatus(PyEnum):\n    PENDING = 'pending'\nclass User:\n    role = Column(Enum(PyEnum), default='customer')\nclass Customer(Base):\n    name = Column(String, nullable=False)\n    email = Column(String, nullable=False)\n    status = Column(CustomerStatus, default=CustomerStatus.PENDING)\n` };
  const repaired = repairKnownSqlAlchemyModelIssues([edit]);
  assert.deepEqual(repaired.changedPaths, ["backend/models.py"]);
  assert.match(repaired.edits[0].content, /status\s*=\s*Column\(Enum\(CustomerStatus, values_callable=lambda enum_cls: \[member\.value for member in enum_cls\]\),/);
  assert.match(repaired.edits[0].content, /role\s*=\s*Column\(String,/);
  assert.doesNotMatch(repaired.edits[0].content, /Column\(CustomerStatus|Enum\(PyEnum/);
  const checkpointValidation = validateDatabaseSubtaskCheckpoint([{ id: "customer-entity", artifacts: [{ path: edit.path, action: edit.action, content: repaired.edits[0].content }] }], resolveProjectArchitecture(prompt));
  assert.equal(checkpointValidation.invalidSubtaskId, undefined, "the normalized enum mapping passes checkpoint revalidation");
});

test("deterministic SQLAlchemy repair handles shadowed Enum, missing status enum, and duplicate Base", () => {
  const edit: ProposedEdit = { path: "backend/models.py", action: "modify", content: `from sqlalchemy import Column, Enum, Integer, String\nfrom sqlalchemy.ext.declarative import declarative_base\nfrom enum import Enum\nfrom backend.database import Base\nBase = declarative_base()\nclass Role(Enum):\n    OWNER = 'owner'\nclass User(Base):\n    id = Column(Integer, primary_key=True)\n    password_hash = Column(String, nullable=False)\n    role = Column(Enum(Role), default=Role.OWNER)\nclass Customer(Base):\n    name = Column(String, nullable=False)\n    email = Column(String, nullable=False)\n    status = Column(Enum(CustomerStatus))\n` };
  const repaired = repairKnownSqlAlchemyModelIssues([edit]).edits[0].content;
  assert.match(repaired, /^from enum import Enum as PyEnum$/m);
  assert.match(repaired, /^class Role\(PyEnum\):/m);
  assert.match(repaired, /^class CustomerStatus\(PyEnum\):/m);
  assert.doesNotMatch(repaired, /^Base = declarative_base\(\)/m);
  assert.match(repaired, /role = Column\(String, nullable=False, default="customer"\)/);
  assert.match(repaired, /status = Column\(Enum\(CustomerStatus, values_callable=/);
});

test("deterministic SQLAlchemy repair canonicalizes enum defaults only to declared members", () => {
  const edit: ProposedEdit = { path: "backend/models.py", action: "modify", content: `from sqlalchemy import Column, Enum
from enum import Enum as PyEnum
class CustomerStatus(PyEnum):
    PENDING = "pending"
    APPROVED = "approved"
class Customer(Base):
    status = Column(Enum(CustomerStatus), default=CustomerStatus.pending)
` };
  const repaired = repairKnownSqlAlchemyModelIssues([edit]).edits[0].content;
  assert.match(repaired, /default=CustomerStatus\.PENDING/);
  assert.match(repaired, /values_callable=/);
  const unknown = repairKnownSqlAlchemyModelIssues([{ ...edit, content: edit.content.replace("CustomerStatus.pending", "CustomerStatus.unknown") }]).edits[0].content;
  assert.match(unknown, /default=CustomerStatus\.unknown/, "unknown enum members are left for validation to reject");
});

test("database checkpoint resume repairs known enum defaults and refreshes artifact checksums", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const content = `from sqlalchemy import Column, Enum
from enum import Enum as PyEnum
class CustomerStatus(PyEnum):
    PENDING = "pending"
class Customer(Base):
    status = Column(Enum(CustomerStatus), default=CustomerStatus.pending)
`;
  const record = { id: "customer-entity", completedAt: "2026-01-01T00:00:00.000Z", architectureHash: architecture.contractHash, artifacts: [{ path: "backend/models.py", action: "create" as const, content, sha256: "old-checksum" }] };
  const resumed = repairDatabaseCheckpointSubtasks([record], architecture)!;
  assert.match(resumed[0].artifacts[0].content, /default=CustomerStatus\.PENDING/);
  assert.notEqual(resumed[0].artifacts[0].sha256, record.artifacts[0].sha256);
  assert.equal(repairDatabaseCheckpointSubtasks([record], { ...architecture, contractHash: "different-pac" })![0].artifacts[0].content, content, "a changed PAC must not rewrite checkpoint artifacts");
});

test("PostgreSQL migration repair derives an explicit enum type name from the generated model", () => {
  const migration: ProposedEdit = { path: "backend/migrations/versions/0001_initial.py", action: "create", content: "sa.Column('status', sa.Enum('pending', 'approved', 'rejected'))" };
  const model = `from sqlalchemy import Enum\nfrom enum import Enum as PyEnum\nclass CustomerStatus(PyEnum):\n    PENDING = "pending"\nclass Customer(Base):\n    status = Column(Enum(CustomerStatus))\n`;
  const repaired = repairKnownPostgresEnumMigrationIssues([migration], model);
  assert.deepEqual(repaired.changedPaths, [migration.path]);
  assert.match(repaired.edits[0].content, /sa\.Enum\('pending', 'approved', 'rejected', name="customerstatus"\)/);
  assert.equal(repairKnownPostgresEnumMigrationIssues([migration], "class Customer: pass").changedPaths.length, 0, "do not invent an enum name without a matching generated enum class");
});

test("resume normalization updates checksummed aggregate and stage migration artifacts", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const model: ProposedEdit = { path: "backend/models.py", action: "create", content: `from sqlalchemy import Enum\nfrom enum import Enum as PyEnum\nclass CustomerStatus(PyEnum):\n    PENDING = "pending"\nclass Customer(Base):\n    status = Column(Enum(CustomerStatus))\n` };
  const migration: ProposedEdit = { path: "backend/migrations/versions/0001_initial.py", action: "create", content: "revision = '0001'\ndown_revision = None\ndef upgrade():\n    op.create_table('customers', sa.Column('status', sa.Enum('pending', 'approved', 'rejected')))\ndef downgrade():\n    op.drop_table('customers')\n" };
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  const artifact = (edit: ProposedEdit) => ({ ...edit, sha256: hash(edit.content) });
  const checkpoint = {
    version: 1 as const, taskId: "task", requirementsHash: "requirements", provider: "ollama", modelId: "qwen",
    completedStageIds: ["scaffold", "database"], stages: [{ id: "scaffold", artifacts: [] }, { id: "database", artifacts: [artifact(migration)] }],
    artifacts: [artifact(model), artifact(migration)], baseFiles: [], pendingStageIds: [], pendingDependencies: [], repairHistory: [],
    projectArchitecture: architecture, updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as Parameters<typeof repairDatabaseCheckpointArtifacts>[0];
  const repaired = repairDatabaseCheckpointArtifacts(checkpoint, architecture);
  const aggregate = repaired.checkpoint.artifacts.find((item) => item.path === migration.path)!;
  const stage = repaired.checkpoint.stages.find((item) => item.id === "database")!.artifacts!.find((item) => item.path === migration.path)!;
  assert.match(aggregate.content, /name="customerstatus"/);
  assert.equal(aggregate.sha256, hash(aggregate.content));
  assert.equal(stage.sha256, hash(stage.content));
  assert.deepEqual(repaired.changedPaths, ["backend/models.py", migration.path]);
});

test("a completed database stage checkpoints a validated migration missing from legacy subtask records", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const migration: ProposedEdit = { path: "backend/migrations/versions/0001_initial.py", action: "create", content: `revision = "0001_initial"
down_revision = None
def upgrade():
    op.create_table("customers", sa.Column("status", sa.Enum("pending", "approved", "rejected", name="customerstatus")))
def downgrade():
    op.drop_table("customers")
` };
  const records = ["customer-entity", "related-entities", "schema-constraints"].map((id) => ({ id, completedAt: "2026-01-01T00:00:00.000Z", architectureHash: architecture.contractHash, artifacts: [] }));
  const result = checkpointValidatedDatabaseSubtasks(records, [migration], architecture, "2026-01-01T00:01:00.000Z");
  assert.deepEqual(result.addedIds, ["alembic-revision"]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.records[3].artifacts[0].sha256, createHash("sha256").update(migration.content).digest("hex"));
});

test("related SQLAlchemy models require reciprocal back_populates targets and persisted user roles", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const related = databaseSubtaskPlan(architecture)[1];
  const broken: ProposedEdit = { path: "backend/models.py", action: "modify", content: `from sqlalchemy import Column, ForeignKey, Integer, String\nfrom sqlalchemy.orm import relationship\nfrom backend.database import Base\nclass User(Base):\n    id = Column(Integer, primary_key=True)\n    role = Column(String)\n    customers = relationship("Customer", back_populates="owner")\nclass Customer(Base):\n    owner = relationship("User", back_populates="customers")\n    audit_events = relationship("AuditEvent", back_populates="customer")\nclass AuditEvent(Base):\n    user = relationship("User")\n` };
  const issues = databaseSubtaskIssues(related, [broken], architecture);
  assert.ok(issues.some((issue) => /missing AuditEvent\.customer/.test(issue)));
  assert.ok(!issues.some((issue) => /does not define class/.test(issue)), "all PAC entity classes are present");
  const missingRole: ProposedEdit = { ...broken, content: broken.content.replace("    role = Column(String)\n", "") };
  assert.ok(databaseSubtaskIssues(related, [missingRole], architecture).some((issue) => /role field/.test(issue)));
});

test("repair fingerprints include diagnostics, target, code baseline, and proposed patch", () => {
  const base = { diagnostics: ["missing submission transition"], targetPath: "backend/routes/submission.py", relevantCode: "def submit(): pass", proposedPatch: "def submit(): return None" };
  const first = repairFingerprint(base);
  assert.deepEqual(repairFingerprint(base), first);
  assert.equal(repairFingerprint({ ...base, diagnostics: [...base.diagnostics, "focused repair repeated the same file contents without a meaningful change"] }).fingerprint, first.fingerprint, "repair bookkeeping must not hide an otherwise duplicate proposal");
  assert.notEqual(repairFingerprint({ ...base, diagnostics: ["missing audit write"] }).fingerprint, first.fingerprint);
  assert.notEqual(repairFingerprint({ ...base, targetPath: "backend/routes/customers.py" }).fingerprint, first.fingerprint);
  assert.notEqual(repairFingerprint({ ...base, relevantCode: "def submit(): ..." }).fingerprint, first.fingerprint);
  assert.notEqual(repairFingerprint({ ...base, proposedPatch: "def submit(): raise NotImplementedError" }).fingerprint, first.fingerprint);
});

test("focused repairs may create only exact PAC targets missing from stage context", () => {
  const missing = missingApprovedStagePaths(
    ["backend/models.py", "backend/migrations/versions/0001_initial.py", "backend/migrations/env.py"],
    { relevantFiles: [{ relPath: "backend/models.py", content: "class Customer: ..." }] },
  );
  assert.deepEqual(missing, ["backend/migrations/versions/0001_initial.py", "backend/migrations/env.py"]);
});

test("generation prompts receive only the stage-relevant full files while validation can retain the complete context", () => {
  const files = [
    "backend/requirements.txt", "backend/models.py", "backend/schemas.py", "backend/auth.py",
    "backend/routes/customers.py", "backend/routes/submission.py", "backend/main.py",
    "backend/migrations/001_initial.sql", "frontend/package.json", "frontend/app/page.tsx",
    "frontend/styles/global.css", "docker-compose.yml", "README.md",
  ].map((relPath) => ({ relPath, content: `# ${relPath}`, snippet: relPath }));
  const context = { relevantFiles: files, indexedChunkCount: files.length };
  const transactions = contextForBuildStage("transactions", context).relevantFiles ?? [];
  assert.ok(transactions.some((file) => file.relPath === "backend/routes/customers.py"), "transaction handlers remain in the PAC's approved customers route module");
  assert.ok(transactions.some((file) => file.relPath === "backend/models.py"));
  assert.ok(!transactions.some((file) => file.relPath.startsWith("frontend/")));
  assert.ok(!transactions.some((file) => file.relPath.startsWith("backend/migrations/")));
  assert.equal(context.relevantFiles?.length, 13, "full validation context remains available to the pipeline");
  const frontend = contextForBuildStage("frontend", context).relevantFiles ?? [];
  assert.ok(frontend.some((file) => file.relPath === "frontend/app/page.tsx"));
  assert.ok(frontend.some((file) => file.relPath === "backend/routes/customers.py"));
});

test("frontend semantic validation uses module resolution supported by TypeScript 4.x and 5.x", () => {
  const args = frontendTypecheckArgs(["pages/index.tsx"]);
  assert.equal(args[args.indexOf("--moduleResolution") + 1], "node");
  assert.ok(args.includes("pages/index.tsx"));
  assert.ok(!args.includes("bundler"), "the validator must not pass a TS 5-only mode to a manifest that may declare TS 4");
});

test("validation file maps retain original path casing while using case-insensitive lookup keys", () => {
  const files = filesWithEdits(undefined, [{ path: "frontend/types/Customer.ts", action: "create", content: "export interface Customer {}" }]);
  assert.equal(files.get("frontend/types/customer.ts")?.originalPath, "frontend/types/Customer.ts");
});

test("test stage declares Playwright and supplies a reusable harness without writing scenario tests", () => {
  const stage = buildStages(prompt).find((item) => item.id === "tests");
  assert.equal(stage?.testFramework, "playwright");
  assert.match(stage?.instruction ?? "", /Playwright/);
  const packageJson = JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "^13.5.4" }, devDependencies: { typescript: "^4.9.5" } }, null, 2) + "\n";
  const result = ensurePlaywrightHarness([{ path: "frontend/package.json", action: "create", content: packageJson }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.changedPaths.sort(), ["frontend/package.json", "frontend/playwright.config.ts"]);
  const manifest = JSON.parse(result.edits.find((edit) => edit.path === "frontend/package.json")!.content);
  assert.equal(manifest.devDependencies["@playwright/test"], "^1.52.0");
  assert.equal(manifest.scripts["test:e2e"], "playwright test");
  assert.match(result.edits.find((edit) => edit.path === "frontend/playwright.config.ts")!.content, /testDir: "\.\/e2e"/);
  assert.ok(!result.edits.some((edit) => /customer-approval\.spec/.test(edit.path)), "business-specific test logic remains model-generated");
  const headed = ensurePlaywrightHarness([
    { path: "frontend/package.json", action: "modify", content: packageJson },
    { path: "frontend/playwright.config.ts", action: "create", content: "export default { use: { headless: false } };\n" },
  ]);
  assert.match(headed.edits.find((edit) => edit.path === "frontend/playwright.config.ts")!.content, /headless: true/);
});

test("web-stack deployment template adds runtime services, migration command, health checks, and empty secret inputs", () => {
  const input: ProposedEdit[] = [
    { path: "backend/requirements.txt", action: "create", content: "fastapi\ntortoise-orm\n" },
    { path: "backend/migrations/001_initial.sql", action: "create", content: "CREATE TABLE customers (id INTEGER PRIMARY KEY);\n" },
    { path: "frontend/package.json", action: "create", content: JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "^15.0.0", react: "^19.0.0" } }) },
    { path: "docker-compose.yml", action: "create", content: "services:\n  db:\n    image: postgres:17-alpine\nvolumes:\n  postgres_data:\n" },
  ];
  const result = ensureWebDeploymentScaffold("scaffold", prompt, input, { relevantFiles: [], indexedChunkCount: 0 });
  assert.deepEqual(result.changed.sort(), [".env.example", "README.md", "backend/Dockerfile", "backend/migrate.py", "backend/requirements.txt", "docker-compose.yml", "frontend/Dockerfile"]);
  const compose = result.edits.find((edit) => edit.path === "docker-compose.yml")!.content;
  assert.match(compose, /backend:/);
  assert.match(compose, /frontend:/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /127\.0\.0\.1:8000:8000/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /python -m backend\.migrate/);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*(?:onboarding|password|secret)\b/i);
  assert.match(result.edits.find((edit) => edit.path === ".env.example")!.content, /POSTGRES_PASSWORD=\nSECRET_KEY=\n/);
  assert.match(result.edits.find((edit) => edit.path === "backend/requirements.txt")!.content, /asyncpg/);
});

test("frontend tooling repair adds Node ambient types and fixes a unique generated relative import", () => {
  const files: ProposedEdit[] = [
    { path: "frontend/package.json", action: "create", content: JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "^13.5.4" }, devDependencies: { typescript: "^4.9.5" } }) },
    { path: "frontend/pages/index.tsx", action: "create", content: "import { Customer } from '../../types/Customer';\nconst api = process.env.NEXT_PUBLIC_API_URL;" },
    { path: "frontend/types/Customer.ts", action: "create", content: "export interface Customer { id: number }\n" },
  ];
  const result = repairKnownFrontendToolingIssues(files, [
    "pages/index.tsx(1,26): error TS2307: Cannot find module '../../types/Customer' or its corresponding type declarations.",
    "pages/index.tsx(2,13): error TS2580: Cannot find name 'process'.",
  ]);
  assert.deepEqual(result.changedPaths.sort(), ["frontend/package.json", "frontend/pages/index.tsx"]);
  assert.match(result.edits.find((edit) => edit.path === "frontend/package.json")!.content, /"@types\/node": "\^20\.17\.10"/);
  assert.match(result.edits.find((edit) => edit.path === "frontend/pages/index.tsx")!.content, /from '\.\.\/types\/Customer'/);
});

test("frontend tooling repair quotes a malformed common TypeScript include glob", () => {
  const files: ProposedEdit[] = [
    { path: "frontend/package.json", action: "create", content: JSON.stringify({ scripts: { build: "next build" }, devDependencies: { typescript: "^4.9.5" } }) },
    { path: "frontend/tsconfig.json", action: "create", content: '{\n  "include": ["next-env.d.ts", **/*.{ts,tsx}**]\n}\n' },
  ];
  const result = repairKnownFrontendToolingIssues(files, ["isolated frontend dependency/build failed: tsconfig.json(2,35): error TS1109: Expression expected"]);
  const config = result.edits.find((edit) => edit.path === "frontend/tsconfig.json")!.content;
  assert.deepEqual(JSON.parse(config).include, ["next-env.d.ts", "**/*.ts", "**/*.tsx"]);
  assert.deepEqual(result.changedPaths, ["frontend/tsconfig.json"]);
});

test("backend import validation reuses a requirements-keyed venv and imports read-only source without network", async () => {
  const root = await mkdtemp(join(tmpdir(), "mobiusx-fake-docker-"));
  const docker = join(root, "docker");
  const log = join(root, "docker-args.log");
  const priorPath = process.env.PATH;
  const priorLog = process.env.MOBIUSX_TEST_DOCKER_LOG;
  const priorImage = process.env.MOBIUSX_PYTHON_VALIDATION_IMAGE;
  try {
    await writeFile(docker, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOBIUSX_TEST_DOCKER_LOG\"\nif [ \"$1\" = \"volume\" ]; then echo \"$3\"; fi\nexit 0\n", "utf8");
    await chmod(docker, 0o755);
    process.env.PATH = root + ":" + (priorPath ?? "");
    process.env.MOBIUSX_TEST_DOCKER_LOG = log;
    process.env.MOBIUSX_PYTHON_VALIDATION_IMAGE = "python:3.12-slim";
    const issues = await validateBackendImports(new Map([
      ["backend/requirements.txt", { action: "create", content: "fastapi\n" }],
      ["backend/main.py", { action: "create", content: "from fastapi import FastAPI\napp = FastAPI()\n" }],
    ]));
    assert.deepEqual(issues, []);
    const calls = await readFile(log, "utf8");
    assert.match(calls, /--network bridge/);
    assert.match(calls, /pip install/);
    assert.match(calls, /--network none/);
    assert.match(calls, /DATABASE_URL=postgresql\+asyncpg:\/\/validation/);
    assert.match(calls, /\/workspace:ro/);
    assert.match(calls, /app\.openapi\(\)/);
    assert.match(calls, /configure_mappers\(\)/);
    assert.match(calls, /Base\.metadata\.tables/);
    assert.match(calls, /mobiusx-python-gate-[a-f0-9]{24}/);
    assert.doesNotMatch(calls, /volume rm/, "the validated venv is retained so resume does not redownload dependencies");
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorLog === undefined) delete process.env.MOBIUSX_TEST_DOCKER_LOG; else process.env.MOBIUSX_TEST_DOCKER_LOG = priorLog;
    if (priorImage === undefined) delete process.env.MOBIUSX_PYTHON_VALIDATION_IMAGE; else process.env.MOBIUSX_PYTHON_VALIDATION_IMAGE = priorImage;
    await rm(root, { recursive: true, force: true });
  }
});

test("the full-stack build contract defines ordered, capability-scoped stages", () => {
  const stages = buildStages(prompt);
  assert.deepEqual(stages.map((stage) => stage.id), ["scaffold", "database", "backend", "transactions", "frontend", "tests"]);
  assert.match(stages.find((stage) => stage.id === "database")?.instruction ?? "", /executable Alembic revision/i);
  assert.match(stages.find((stage) => stage.id === "database")?.instruction ?? "", /do not ask the user to enumerate tables/i);
  assert.match(stages.find((stage) => stage.id === "backend")?.instruction ?? "", /backend\/routes\/customers\.py/i);
  assert.match(stages.find((stage) => stage.id === "backend")?.instruction ?? "", /under 100 lines/i);
  assert.match(stages.find((stage) => stage.id === "backend")?.instruction ?? "", /manager decision routes and audit transactions belong in the next/i);
  assert.match(stages.find((stage) => stage.id === "transactions")?.instruction ?? "", /a status summary such as 'no changes needed' is not an implementation/i);
  assert.match(stages.find((stage) => stage.id === "transactions")?.instruction ?? "", /same database transaction/i);
  assert.match(stages.find((stage) => stage.id === "scaffold")?.instruction ?? "", /real FastAPI app with a working \/health endpoint/i);
  assert.match(buildStages("Build a React website")[0].label, /^Stage 1\/2/);
});

test("the scaffold contract rejects missing manifests, entry points, Compose, and placeholder code", () => {
  const files = new Map([
    ["backend/main.py", { content: "def create():\n    pass\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("scaffold", prompt, files);
  assert.ok(issues.some((issue) => issue.includes("frontend package.json is missing")));
  assert.ok(issues.includes("database service configuration is missing"));
  assert.ok(issues.some((issue) => issue.includes("placeholder")));
});

test("placeholder diagnostics identify exact source lines for focused model repairs", () => {
  const files = new Map([
    ["backend/auth.py", { content: "from fastapi import HTTPException\n\ndef require_user():\n    pass\n", action: "create" as const }],
  ]);
  const issue = validateBuildStage("backend", prompt, files).find((item) => item.includes("backend/auth.py contains a TODO, pass, or unimplemented placeholder"));
  assert.match(issue ?? "", /line\(s\) 4/);
});

test("backend authentication contract rejects fake identities, plaintext hash comparison, and duplicate user models", () => {
  const auth = [
    "from fastapi import Depends",
    "from tortoise.models import Model",
    "class User(Model):",
    "    pass",
    "async def current_user(user_id: int = Depends(lambda: 1)): return user_id",
    "async def verify(password, password_hash): return password_hash == password",
  ].join("\n");
  const issues = validateBuildStage("backend", prompt, new Map([
    ["backend/auth.py", { content: auth, action: "create" as const }],
  ]));
  assert.ok(issues.some((issue) => issue.includes("hardcoded authentication identity on line 5")));
  assert.ok(issues.some((issue) => issue.includes("submitted password directly with a stored hash on line 6")));
  assert.ok(issues.some((issue) => issue.includes("duplicate User ORM class on line 3")));
});

test("the scaffold contract rejects await inside synchronous FastAPI lifecycle handlers", () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "16.0.0", react: "19.0.0", "react-dom": "19.0.0" } }), action: "create" as const }],
    ["backend/requirements.txt", { content: "fastapi\nuvicorn\ntortoise-orm\n", action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()\n@app.on_event('startup')\ndef init_db():\n    await connect()\n", action: "create" as const }],
    ["docker-compose.yml", { content: "services:\n  db:\n    image: postgres:16\n    ports:\n      - \"127.0.0.1:5432:5432\"\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("scaffold", prompt, files);
  assert.ok(issues.some((issue) => issue.includes("await outside an async def")));

  files.set("backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()\n@app.on_event('startup')\nasync def init_db():\n    await connect()\n", action: "create" });
  assert.ok(!validateBuildStage("scaffold", prompt, files).some((issue) => issue.includes("await outside an async def")));
});

test("database and business transaction gates require executable schema, transaction, and audit evidence", () => {
  const files = new Map([
    ["backend/main.py", { content: "@app.post('/submit')\ndef submit(): return {'status':'approved'}", action: "create" as const }],
    ["backend/migrations/001.py", { content: "class Migration: pass", action: "create" as const }],
  ]);
  assert.ok(validateBuildStage("database", prompt, files).some((issue) => issue.includes("executable schema operations")));
  assert.ok(validateBuildStage("transactions", prompt, files).some((issue) => issue.includes("transaction boundary")));
  assert.ok(validateBuildStage("transactions", prompt, files).some((issue) => issue.includes("audit/history")));
  assert.ok(validateBuildStage("transactions", prompt, files).some((issue) => issue.includes("mock success")));
});

test("Alembic runner configuration is not mistaken for an executable schema revision", () => {
  const alembicPrompt = "Build a customer approval app using FastAPI, SQLAlchemy, PostgreSQL, Alembic migrations, authentication and manager approval.";
  const files = new Map([
    ["backend/alembic.ini", { content: "[alembic]\nscript_location = backend/migrations\n", action: "create" as const }],
    ["backend/migrations/env.py", { content: "from alembic import context\ncontext.run_migrations()\n", action: "create" as const }],
    ["backend/requirements.txt", { content: "fastapi\nsqlalchemy\nalembic\n", action: "create" as const }],
    ["backend/models.py", { content: "class User(Base): pass\nclass Customer(Base): pass\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("database", alembicPrompt, files);
  assert.ok(issues.some((issue) => issue.includes("Alembic database stage requires an executable revision under backend/migrations/versions")));
  assert.ok(!issues.some((issue) => /env\.py does not contain executable schema operations/.test(issue)));
});

test("customer approval contracts reject valid but unrelated employee schemas and missing persistence models", () => {
  const customerPrompt = "Build a customer onboarding application with FastAPI, PostgreSQL, authentication and manager approval.";
  const files = new Map([
    ["backend/requirements.txt", { content: "fastapi\ntortoise-orm\n", action: "create" as const }],
    ["backend/migrations/001_initial.sql", { content: "CREATE TABLE employees(id SERIAL PRIMARY KEY);", action: "create" as const }],
    ["backend/models.py", { content: "from tortoise import Model\nclass Employee(Model): pass\n", action: "create" as const }],
  ]);
  assert.ok(validateBuildStage("database", customerPrompt, files).some((issue) => issue.includes("customers table")));
  assert.ok(validateBuildStage("database", customerPrompt, files).some((issue) => issue.includes("Customer ORM entity")));
  assert.ok(validateBuildStage("backend", customerPrompt, files).some((issue) => issue.includes("Customer ORM model")));
  assert.ok(validateBuildStage("backend", customerPrompt, files).some((issue) => issue.includes("persisted User ORM model")));
});

test("backend contract requires customer request/response schemas and keeps auth fields on User", () => {
  const customerPrompt = "Build a customer onboarding application with FastAPI, PostgreSQL, authentication and manager approval.";
  const files = new Map([
    ["backend/models.py", { content: "class User(Model):\n    role = fields.CharField()\n    password_hash = fields.CharField()\nclass Customer(Model):\n    name = fields.CharField()\n    email = fields.CharField()\n", action: "create" as const }],
    ["backend/schemas.py", { content: "class CustomerCreate(BaseModel):\n    name: str\n    email: str\nclass CustomerResponse(BaseModel):\n    id: int\n    name: str\n    email: str\n", action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\nfrom .routes.customers import router\napp = FastAPI()\napp.include_router(router)\n", action: "create" as const }],
    ["backend/routes/customers.py", { content: "router = APIRouter()\n@router.post('/customers')\nasync def create_customer(): pass\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("backend", customerPrompt, files);
  assert.ok(!issues.some((issue) => /CustomerCreate|CustomerResponse|Customer ORM model|authentication fields/i.test(issue)));
});

test("customer backend preflight accepts PAC schemas whose persisted contact field is business_email", () => {
  const customerPrompt = "Build a customer onboarding application with FastAPI, PostgreSQL, authentication and manager approval.";
  const files = new Map([
    ["backend/requirements.txt", { content: "fastapi\nsqlalchemy[asyncio]\n", action: "create" as const }],
    ["backend/models.py", { content: "class User(Base):\n    id = Column(Integer, primary_key=True)\nclass Customer(Base):\n    id = Column(Integer, primary_key=True)\n    name = Column(String, nullable=False)\n    business_email = Column(String, nullable=False, unique=True)\n    status = Column(String, nullable=False, default='pending')\n", action: "create" as const }],
    ["backend/schemas.py", { content: "class CustomerCreate(BaseModel):\n    name: str\n    business_email: EmailStr\nclass CustomerResponse(BaseModel):\n    id: int\n    name: str\n    business_email: EmailStr\n    status: str\n", action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef health(): return {'ok': True}\n", action: "create" as const }],
  ]);
  const matching = validateBuildStage("backend", customerPrompt, files);
  assert.ok(!matching.some((issue) => /contact-email field|persisted contact-email|do not map/.test(issue)));
  files.set("backend/schemas.py", { content: "class CustomerCreate(BaseModel):\n    name: str\n    email: EmailStr\nclass CustomerResponse(BaseModel):\n    id: int\n    name: str\n    email: EmailStr\n    status: str\n", action: "create" });
  const mismatched = validateBuildStage("backend", customerPrompt, files);
  assert.ok(mismatched.some((issue) => /CustomerCreate contact-email field\(s\) email do not map to a persisted Customer ORM field \(business_email\)/.test(issue)));
});

test("SQLAlchemy backend contract rejects mixed Tortoise APIs and recursive session providers", () => {
  const customerPrompt = "Build a customer onboarding application with FastAPI, PostgreSQL, authentication and manager approval.";
  const files = new Map([
    ["backend/requirements.txt", { content: "fastapi\nsqlalchemy\nasyncpg\n", action: "create" as const }],
    ["backend/models.py", { content: "from sqlalchemy import Column, Integer, String\nclass User(Base):\n    id = Column(Integer, primary_key=True)\nclass Customer(Base):\n    id = Column(Integer, primary_key=True)\n", action: "create" as const }],
    ["backend/database.py", { content: "async def get_async_session():\n    async with get_async_session() as session:\n        yield session\n", action: "create" as const }],
    ["backend/auth.py", { content: "async def get_async_session():\n    async with get_async_session() as session:\n        yield session\n", action: "create" as const }],
    ["backend/schemas.py", { content: "class CustomerCreate(BaseModel):\n    name: str\n    email: str\nclass CustomerResponse(BaseModel):\n    id: int\n    name: str\n    email: str\n", action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\nfrom .routes.customers import router\napp = FastAPI()\napp.include_router(router)\n", action: "create" as const }],
    ["backend/routes/customers.py", { content: "from backend.models import Customer\nasync def list_customers():\n    return await Customer.all()\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("backend", customerPrompt, files);
  assert.ok(issues.some((issue) => issue.includes("Tortoise-style model methods")));
  assert.ok(issues.some((issue) => issue.includes("recursive get_async_session")));
  assert.ok(issues.some((issue) => issue.includes("redefines the database get_async_session")));
});

test("customer approval migration contract requires persisted users and valid foreign-key creation order", () => {
  const customerPrompt = "Build a customer onboarding application with FastAPI, PostgreSQL, authentication and manager approval.";
  const files = new Map([
    ["backend/requirements.txt", { content: "fastapi\ntortoise-orm\n", action: "create" as const }],
    ["backend/migrations/001_initial.sql", { content: "CREATE TABLE departments(id INTEGER, manager_id INTEGER REFERENCES employees(id));\nCREATE TABLE employees(id INTEGER PRIMARY KEY);\nCREATE TABLE customers(id INTEGER PRIMARY KEY);", action: "create" as const }],
    ["backend/models.py", { content: "from tortoise import Model\nclass Customer(Model): pass\nclass User(Model): pass\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("database", customerPrompt, files);
  assert.ok(issues.some((issue) => issue.includes("users table")));
  assert.ok(issues.some((issue) => issue.includes("departments references employees before that table is created")));
});

test("transaction repair guidance uses the configured SQLAlchemy transaction and audit APIs", () => {
  const guidance = repairGuidance(["requested audit/history persistence is missing", "requested transaction boundary is missing"], {
    relevantFiles: [
      { relPath: "backend/requirements.txt", content: "fastapi\nsqlalchemy[asyncio]\n" },
      { relPath: "backend/routes/customers.py", content: "async def approve_customer():\n    ...\n" },
      { relPath: "backend/routes/submission.py", content: "async def submit_customer():\n    ...\n" },
    ],
    indexedChunkCount: 0,
  });
  assert.match(guidance, /atomic_request_transaction\(db\)/);
  assert.match(guidance, /one atomic SQLAlchemy AsyncSession unit of work/i);
  assert.doesNotMatch(guidance, /in_transaction\(\)/);
  assert.match(guidance, /backend\/routes\/customers\.py/);
  assert.doesNotMatch(guidance, /backend\/routes\/submission\.py/);
  assert.doesNotMatch(guidance, /Repair only backend\/models\.py/);
});

test("transaction repair guidance names the PAC customer submission route and state change", () => {
  const guidance = repairGuidance(["customer submission transition is missing from backend handlers"]);
  assert.match(guidance, /Add POST \/customers\/\{customer_id\}\/submit/);
  assert.match(guidance, /backend\/routes\/customers\.py/);
  assert.match(guidance, /CustomerStatus\.PENDING/);
  assert.match(guidance, /atomic_request_transaction\(db\)/);
});

test("missing submission repairs target the PAC-approved customer router only", () => {
  const issue = "customer submission transition is missing from backend handlers";
  const context = {
    relevantFiles: [
      { relPath: "backend/requirements.txt", content: "fastapi\nsqlalchemy[asyncio]\n" },
      { relPath: "backend/models.py", content: "class Customer(Base): ..." },
      { relPath: "backend/schemas.py", content: "class CustomerResponse(BaseModel): ..." },
      { relPath: "backend/auth.py", content: "async def get_current_active_user(): ..." },
      { relPath: "backend/routes/customers.py", content: "async def approve_customer(): ..." },
    ],
    indexedChunkCount: 0,
  };
  const guidance = repairGuidance([issue], context);
  assert.match(guidance, /backend\/routes\/customers\.py/);
  assert.match(guidance, /atomic_request_transaction\(db\)/);
  assert.deepEqual([...repairAllowedPaths([issue], context)], ["backend/routes/customers.py"]);
  const focused = focusRepairContext(context, [], [issue]);
  assert.ok(focused.relevantFiles?.some((file) => file.relPath === "backend/routes/customers.py"));
  assert.ok(focused.relevantFiles?.some((file) => file.relPath === "backend/auth.py"), "auth is available as read-only route context");
});

test("Python NameError repair guidance targets the exact auth module and missing OAuth dependency", () => {
  const guidance = repairGuidance([
    `isolated FastAPI dependency/import validation failed: File "/workspace/backend/auth.py", line 7, in <module>\n    async def get_current_user(token: str = Depends(oauth2_scheme)):\nNameError: name 'oauth2_scheme' is not defined`,
  ], {
    relevantFiles: [
      { relPath: "backend/auth.py", snippet: "", content: "async def get_current_user(token=Depends(oauth2_scheme)): ..." },
      { relPath: "backend/models.py", snippet: "", content: "class User(Model): pass" },
    ],
    indexedChunkCount: 0,
  });
  assert.match(guidance, /Repair only backend\/auth\.py/);
  assert.match(guidance, /OAuth2PasswordBearer/);
  assert.match(guidance, /environment/);
  assert.match(guidance, /Do not modify migrations, models, frontend/);
});

test("FastAPI NameError guidance requests the exact import rather than unrelated auth imports", () => {
  const guidance = repairGuidance([
    `isolated FastAPI dependency/import validation failed: File "/workspace/backend/main.py", line 7, in <module>\n    app = FastAPI()\nNameError: name 'FastAPI' is not defined`,
  ]);
  assert.match(guidance, /Repair only backend\/main\.py/);
  assert.match(guidance, /from fastapi import FastAPI/);
  assert.match(guidance, /Do not add OAuth\/security imports/);
});

test("known FastAPI import NameErrors get a deterministic, path-scoped repair", () => {
  const edits: ProposedEdit[] = [{ path: "backend/main.py", action: "create", content: "app = FastAPI()\n" }];
  const issues = [`File "/workspace/backend/main.py", line 1, in <module>\nNameError: name 'FastAPI' is not defined`];
  const result = repairKnownPythonNameErrors(edits, issues);
  assert.deepEqual(result.changedPaths, ["backend/main.py"]);
  assert.match(result.edits[0].content, /^from fastapi import FastAPI\napp = FastAPI/);
  assert.deepEqual(repairKnownPythonNameErrors(result.edits, issues).changedPaths, [], "do not duplicate an already-added import");
  const osRepair = repairKnownPythonNameErrors([{ path: "backend/main.py", action: "modify", content: "db_url = os.getenv('DATABASE_URL')\n" }], [
    `File "/workspace/backend/main.py", line 1, in <module>\nNameError: name 'os' is not defined`,
  ]);
  assert.match(osRepair.edits[0].content, /^import os\ndb_url/);
  const routeModelRepair = repairKnownPythonNameErrors([{ path: "backend/routes/customers.py", action: "modify", content: "def create_customer(current_user: User): return current_user\n" }], [
    `File "/workspace/backend/routes/customers.py", line 1, in <module>\nNameError: name 'User' is not defined`,
  ]);
  assert.match(routeModelRepair.edits[0].content, /^from backend\.models import User\ndef create_customer/);
});

test("missing Tortoise transaction imports receive a deterministic route-local repair", () => {
  const edits: ProposedEdit[] = [{ path: "backend/routes/submission.py", action: "create", content: "async def submit_customer():\n    async with in_transaction():\n        return None\n" }];
  const issue = "backend/routes/submission.py uses in_transaction but does not import it";
  const result = repairKnownPythonNameErrors(edits, [issue]);
  assert.deepEqual(result.changedPaths, ["backend/routes/submission.py"]);
  assert.match(result.edits[0].content, /^from tortoise\.transactions import in_transaction\n/);
});

test("generated FastAPI route annotations import the persisted User model deterministically", () => {
  const edits: ProposedEdit[] = [{ path: "backend/routes/submission.py", action: "create", content: "async def submit(current_user: User):\n    return current_user\n" }];
  const repair = repairKnownPythonNameErrors(edits, []);
  assert.deepEqual(repair.changedPaths, ["backend/routes/submission.py"]);
  assert.match(repair.edits[0].content, /^from backend\.models import User/m);
});

test("later backend stages cannot overwrite checksum-validated subtask modules", () => {
  const validatedContent = "from jose import jwt\n\ndef require_role(role):\n    return role\n";
  const records = [{
    id: "authentication",
    completedAt: new Date(0).toISOString(),
    architectureHash: "pac-v1",
    artifacts: [{ path: "backend/auth.py", action: "create" as const, content: validatedContent, sha256: createHash("sha256").update(validatedContent).digest("hex") }],
  }];
  const edits: ProposedEdit[] = [
    { path: "backend/auth.py", action: "create", content: "import jwt\n# model repair attempted to change the validated auth adapter\n" },
    { path: "backend/routes/customers.py", action: "create", content: "async def create_customer():\n    return None\n" },
  ];
  const restored = restoreValidatedBackendSubtaskArtifacts(edits, records);
  assert.deepEqual(restored.restoredPaths, ["backend/auth.py"]);
  assert.equal(restored.edits.find((edit) => edit.path === "backend/auth.py")?.content, validatedContent);
  assert.equal(restored.edits.find((edit) => edit.path.endsWith("customers.py"))?.content, edits[1].content);
  assert.deepEqual(restoreValidatedBackendSubtaskArtifacts(restored.edits, records).restoredPaths, []);
});

test("validated router snapshots merge unique business handlers instead of dropping earlier operations", () => {
  const registration = "from fastapi import APIRouter, Depends\nfrom backend.models import User\nfrom backend.auth import require_role\nrouter = APIRouter()\n@router.post('/customers')\nasync def create_customer(current_user: User = Depends(require_role('customer'))):\n    return None\n";
  const submission = "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/customers')\nasync def create_customer():\n    return None\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer():\n    return None\n";
  const manager = `${submission.replace("async def create_customer():", "async def create_customer(current_user=Depends(require_role('manager'))):")}@router.post('/customers/{customer_id}/approve')\nasync def approve_customer():\n    return None\n@router.post('/customers/{customer_id}/reject')\nasync def reject_customer():\n    return None\n`;
  const audit = "from backend.models import AuditEvent\nfrom backend.schemas import AuditEventResponse\nfrom fastapi import APIRouter\nrouter = APIRouter()\n@router.get('/customers/{customer_id}/audit', response_model=list[AuditEventResponse])\nasync def read_customer_audit():\n    return []\n";
  const records = [registration, submission, manager, audit].map((content, index) => ({ id: ["customer-registration-api", "submission-api", "manager-decision-api", "audit-history-api"][index], completedAt: new Date(index).toISOString(), architectureHash: "pac-v1", artifacts: [{ path: "backend/routes/customers.py", action: "create" as const, content, sha256: createHash("sha256").update(content).digest("hex") }] }));
  const result = restoreValidatedBackendSubtaskArtifacts([{ path: "backend/routes/customers.py", action: "modify", content: audit }], records);
  const merged = result.edits[0].content;
  assert.match(merged, /async def create_customer\(current_user: User = Depends\(require_role\('customer'\)\)\)/, "registration's validated actor handler must win over a stale copy embedded in a later route snapshot");
  for (const path of ["/customers", "/customers/{customer_id}/submit", "/customers/{customer_id}/approve", "/customers/{customer_id}/reject", "/customers/{customer_id}/audit"]) assert.match(merged, new RegExp(`@router\\.(?:get|post)\\('${path.replace(/[{}]/g, "\\$&")}`));
  assert.match(merged, /from backend\.schemas import AuditEventResponse/);
});

test("Python NameError repair scopes edits to the failing traceback frame and keeps imports as read-only context", () => {
  const issue = `isolated FastAPI dependency/import validation failed:\n  File "/workspace/backend/main.py", line 34, in <module>\n  File "/workspace/backend/routes/customers.py", line 5, in <module>\n  File "/workspace/backend/auth.py", line 7, in <module>\nNameError: name 'oauth2_scheme' is not defined`;
  const context = {
    relevantFiles: [
      { relPath: "backend/main.py", snippet: "main", content: "app = FastAPI()" },
      { relPath: "backend/routes/customers.py", snippet: "route", content: "from backend.auth import get_current_active_user" },
      { relPath: "backend/auth.py", snippet: "auth", content: "Depends(oauth2_scheme)" },
      { relPath: "backend/models.py", snippet: "models", content: "class User(Model): pass" },
      { relPath: "backend/schemas.py", snippet: "schema", content: "class TokenData(BaseModel): pass" },
    ],
    indexedChunkCount: 0,
  };
  const focused = focusRepairContext(context, [], [issue]);
  assert.deepEqual(focused.relevantFiles?.map((file) => file.relPath).sort(), ["backend/auth.py", "backend/models.py", "backend/schemas.py"]);
  assert.deepEqual([...repairAllowedPaths([issue], focused)], ["backend/auth.py"]);
});

test("customer schema repair guidance rejects unrelated employee fields", () => {
  const guidance = repairGuidance(["backend/schemas.py CustomerCreate is missing a customer name/business-name field"]);
  assert.match(guidance, /Repair only backend\/schemas\.py/);
  assert.match(guidance, /customer\/business name and email/);
  assert.match(guidance, /do not use employee, department, payroll/i);
});

test("audit gate accepts a persisted ApprovalEvent variable inside the transaction", () => {
  const files = new Map([
    ["backend/routes/customers.py", { content: [
      "class ApprovalEvent:",
      "    pass",
      "@app.post('/customers/approve')",
      "def approve(db, customer):",
      "    with db.begin():",
      "        event = ApprovalEvent(customer_id=customer.id, decision='approved')",
      "        db.add(event)",
      "        customer.status = 'approved'",
      "        db.add(customer)",
      "    return {'status': customer.status, 'history': 'recorded'}",
    ].join("\n"), action: "create" as const }],
  ]);
  const issues = validateBuildStage("transactions", prompt, files);
  assert.ok(!issues.some((issue) => issue.includes("audit event persistence")));
});

test("audit gate accepts Tortoise ORM ApprovalEvent.create inside an async transaction", () => {
  const files = new Map([
    ["backend/routes/customers.py", { content: [
      "from tortoise.transactions import in_transaction",
      "@router.post('/customers/submit')",
      "async def submit_customer(customer_id: int):",
      "    async with in_transaction() as connection:",
      "        await Customer.filter(id=customer_id).using_db(connection).update(status='submitted')",
      "        await ApprovalEvent.create(customer_id=customer_id, action='submitted', using_db=connection)",
      "@router.post('/customers/{customer_id}/approve')",
      "async def approve_customer(customer_id: int): return {'status': 'approved'}",
      "@router.post('/customers/{customer_id}/reject')",
      "async def reject_customer(customer_id: int): return {'status': 'rejected'}",
    ].join("\n"), action: "create" as const }],
  ]);
  const issues = validateBuildStage("transactions", prompt, files);
  assert.ok(!issues.some((issue) => issue.includes("audit event persistence")));
  assert.ok(!issues.some((issue) => issue.includes("audit/history persistence is missing")));
});

test("backend contract catches a Tortoise transaction call with no in_transaction import", () => {
  const prompt = "Build a customer onboarding app with FastAPI and PostgreSQL.";
  const missingImport = new Map([
    ["backend/routes/submission.py", { action: "create" as const, content: "async def submit_customer():\n    async with in_transaction():\n        return None\n" }],
  ]);
  assert.ok(validateBuildStage("backend", prompt, missingImport).some((issue) => issue.includes("backend/routes/submission.py uses in_transaction but does not import it")));
  const validImport = new Map([
    ["backend/routes/submission.py", { action: "create" as const, content: "from tortoise.transactions import in_transaction\nasync def submit_customer():\n    async with in_transaction():\n        return None\n" }],
  ]);
  assert.ok(!validateBuildStage("backend", prompt, validImport).some((issue) => issue.includes("uses in_transaction but does not import it")));
});

test("audit gate rejects an ApprovalEvent that is created but never persisted", () => {
  const files = new Map([
    ["backend/routes/customers.py", { content: [
      "class ApprovalEvent:",
      "    pass",
      "@app.post('/customers/approve')",
      "def approve(db, customer):",
      "    with db.begin():",
      "        event = ApprovalEvent(customer_id=customer.id, decision='approved')",
      "        customer.status = 'approved'",
      "        db.add(customer)",
      "    return {'status': customer.status, 'history': 'recorded'}",
    ].join("\n"), action: "create" as const }],
  ]);
  assert.ok(validateBuildStage("transactions", prompt, files).some((issue) => issue.includes("audit event persistence")));
});

test("test gate rejects vacuous assertions, skipped E2E, and browser tests without interactions", () => {
  const files = new Map([
    ["backend/tests/test_flow.py", { content: "def test_flow():\n    assert True\n", action: "create" as const }],
    ["frontend/e2e/onboarding.spec.ts", { content: "import { test } from '@playwright/test';\ntest.skip('approval');", action: "create" as const }],
  ]);
  const issues = validateBuildStage("tests", prompt, files);
  assert.ok(issues.some((issue) => issue.includes("vacuous assertion")));
  assert.ok(issues.some((issue) => issue.includes("real browser interactions")));
});

test("scaffold and backend gates reject misplaced services, missing ORM models, and unresolved imports", () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "15", react: "19", "react-dom": "19" } }), action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()\n", action: "create" as const }],
    ["backend/requirements.txt", { content: "fastapi\nsqlalchemy\n", action: "create" as const }],
    ["docker-compose.yml", { content: "services:\n  backend:\n    image: api\ndatabases:\n  db:\n    image: postgres:16\n", action: "create" as const }],
    ["backend/migrations/001_initial.sql", { content: "CREATE TABLE customers(id INTEGER PRIMARY KEY);", action: "create" as const }],
    ["backend/routes/customers.py", { content: "from .schemas import CustomerCreate\n", action: "create" as const }],
  ]);
  const scaffold = validateBuildStage("scaffold", prompt, files);
  const database = validateBuildStage("database", prompt, files);
  const backend = validateBuildStage("backend", prompt, files);
  assert.ok(scaffold.some((issue) => issue.includes("under services")));
  assert.ok(database.some((issue) => issue.includes("no executable ORM entity")));
  assert.ok(database.some((issue) => issue.includes("database connection and session wiring")));
  assert.ok(backend.some((issue) => issue.includes("imports missing project module .schemas")));
});

test("Python backend import validation resolves parent-package imports and rejects imports above the package root", () => {
  const validParentImport = new Map([
    ["backend/__init__.py", { content: "", action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\nfrom backend.routes.customers import router\napp = FastAPI()\napp.include_router(router)\n", action: "create" as const }],
    ["backend/requirements.txt", { content: "fastapi\ntortoise-orm\n", action: "create" as const }],
    ["backend/models.py", { content: "from tortoise import Model\nclass Customer(Model):\n    name = 'name'\n", action: "create" as const }],
    ["backend/schemas.py", { content: "class CustomerCreate: pass\n", action: "create" as const }],
    ["backend/auth.py", { content: "def require_manager(): pass\n", action: "create" as const }],
    ["backend/routes/__init__.py", { content: "", action: "create" as const }],
    ["backend/routes/customers.py", { content: "from ..schemas import CustomerCreate\nfrom ..auth import require_manager\n", action: "create" as const }],
  ]);
  assert.ok(!validateBuildStage("backend", prompt, validParentImport).some((issue) => issue.includes("imports missing project module ..")));

  const aboveRootImport = new Map(validParentImport);
  aboveRootImport.set("backend/routes/customers.py", { content: "from ....schemas import CustomerCreate\n", action: "create" as const });
  const aboveRootIssues = validateBuildStage("backend", prompt, aboveRootImport);
  assert.ok(aboveRootIssues.some((issue) => issue.includes("goes beyond the project package root")), JSON.stringify(aboveRootIssues));
});

test("repairs wrong Python relative-import depth only when each module has a unique workspace target", () => {
  const context = {
    relevantFiles: [
      { relPath: "backend/schemas.py", content: "class CustomerCreate: pass\n", snippet: "schemas" },
      { relPath: "backend/auth.py", content: "def current_user(): pass\n", snippet: "auth" },
      { relPath: "backend/routes/__init__.py", content: "", snippet: "routes package" },
    ],
    indexedChunkCount: 3,
  };
  const edits = [{
    path: "backend/routes/customers.py",
    action: "create" as const,
    content: "from .schemas import CustomerCreate\nfrom .auth import current_user\n",
  }];
  const repaired = repairResolvablePythonRelativeImports(edits, context);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/customers.py"]);
  assert.match(repaired.edits[0].content, /from \.\.schemas import CustomerCreate/);
  assert.match(repaired.edits[0].content, /from \.\.auth import current_user/);

  const ambiguous = { ...context, relevantFiles: [...context.relevantFiles, { relPath: "backend/other/schemas.py", content: "class Other: pass\n", snippet: "other schemas" }] };
  const ambiguousResult = repairResolvablePythonRelativeImports(edits, ambiguous);
  assert.deepEqual(ambiguousResult.changedPaths, ["backend/routes/customers.py"]);
  assert.match(ambiguousResult.edits[0].content, /from \.schemas import CustomerCreate/, "ambiguous import remains unchanged");
  assert.match(ambiguousResult.edits[0].content, /from \.\.auth import current_user/, "independent unique import can still be repaired");
});

test("customer approval E2E gate requires the real registration-to-audit workflow in the expected location", () => {
  const completeFlow = [
    "import { test, expect } from '@playwright/test';",
    "test('owner submits a customer and manager approves it', async ({ page }) => {",
    "await page.goto('/login')",
    "await page.getByLabel('Email').fill('owner@example.test') // owner login",
    "await page.getByLabel('Password').fill('demo')",
    "await page.getByRole('button', { name: 'Log in' }).click()",
    "await page.goto('/customers/new') // customer registration",
    "await page.getByLabel('Company').fill('Acme')",
    "await expect(page.getByText('Business email is required')).toBeVisible() // form validation",
    "await page.getByLabel('Business email').fill('owner@acme.test')",
    "page.waitForResponse('/api/customers') // API submission",
    "await page.getByRole('button', { name: 'Submit' }).click()",
    "await page.reload() // persistence after reload",
    "await page.goto('/manager/login') // manager login",
    "await page.getByRole('button', { name: 'Approve' }).click() // approve/reject",
    "await expect(page.getByText('Approved')).toBeVisible() // updated status",
    "await expect(page.getByText('Audit history')).toBeVisible() // audit history",
    "});",
  ].join("\n");
  const misplaced = new Map([
    ["backend/tests/test_flow.py", { content: "def test_flow():\n    assert 1 == 2\n", action: "create" as const }],
    ["frontend/tests/onboarding.spec.ts", { content: "import { test, expect } from '@playwright/test';\ntest('flow', async ({page}) => { await page.goto('/'); await expect(page.getByText('Customers')).toBeVisible(); });", action: "create" as const }],
  ]);
  assert.ok(validateBuildStage("tests", prompt, misplaced).some((issue) => issue.includes("browser E2E test is missing")));

  const complete = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { "test:e2e": "playwright test" }, devDependencies: { "@playwright/test": "^1.52.0" } }), action: "create" as const }],
    ["frontend/playwright.config.ts", { content: "import { defineConfig } from '@playwright/test'; export default defineConfig({ testDir: './e2e' });", action: "create" as const }],
    ["backend/tests/test_flow.py", { content: "def test_customer_registration_required_field_validation_authentication_manager_authorization_approval_rejection_database_persistence_audit_history_unauthorized_invalid_state_transition(client):\n    response = client.get('/health')\n    assert response.status_code == 200\n", action: "create" as const }],
    ["frontend/e2e/customer-approval.spec.ts", { content: completeFlow, action: "create" as const }],
  ]);
  assert.deepEqual(validateBuildStage("tests", prompt, complete), []);

  const cypressOnly = new Map([
    ["frontend/cypress/integration/customers.spec.js", { content: "describe('approval', () => { it('approves', () => cy.visit('/')); });", action: "create" as const }],
  ]);
  const incompatible = validateBuildStage("tests", prompt, cypressOnly);
  assert.ok(incompatible.some((issue) => issue.includes("Cypress artifacts are incompatible")));
  assert.ok(incompatible.some((issue) => issue.includes("requested browser E2E test is missing")));

  const truncated = new Map([
    ["frontend/e2e/customer-approval.spec.ts", { content: "import { test, expect } from '@playwright/test';\ntest('flow', async ({ page }) => { await page.goto('/login');", action: "create" as const }],
  ]);
  assert.ok(validateBuildStage("tests", prompt, truncated).some((issue) => issue.includes("truncated or malformed")));

  const malformed = new Map([
    ["frontend/e2e/customer-approval.spec.ts", { content: "import { test, expect } from '@playwright/test';\nawait page.goto('/login');", action: "create" as const }],
  ]);
  assert.ok(validateBuildStage("tests", prompt, malformed).some((issue) => issue.includes("declare an executable test")));
});

test("scaffold gate rejects malformed multi-package pip lines and Python sqlite3", () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "15", react: "19", "react-dom": "19" } }), action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()", action: "create" as const }],
    ["backend/requirements.txt", { content: "fastapi uvicorn\nsqlite3\n", action: "create" as const }],
    ["docker-compose.yml", { content: "services:\n  db:\n    image: postgres:16", action: "create" as const }],
  ]);
  const issues = validateBuildStage("scaffold", prompt, files);
  assert.ok(issues.some((issue) => issue.includes("one valid pip requirement per line")));
  assert.ok(issues.some((issue) => issue.includes("sqlite3")));
});

test("build contract rejects hardcoded authentication credentials", () => {
  const files = new Map([
    ["backend/main.py", { content: "from os import getenv\nJWT_SECRET = 'hardcoded-local-secret-value'\n", action: "create" as const }],
  ]);
  const issue = validateBuildStage("scaffold", prompt, files).find((item) => item.includes("hardcoded credential"));
  assert.ok(issue);
  assert.match(issue, /line 2.*JWT_SECRET/i);
  assert.doesNotMatch(issue, /hardcoded-local-secret-value/);
});

test("PostgreSQL contract rejects SQLite wiring and literal database credentials in Compose", () => {
  const files = new Map([
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()\nDB_URL = 'sqlite://db.sqlite3'\n", action: "create" as const }],
    ["docker-compose.yml", { content: "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: password\n      DATABASE_URL: postgres://user:password@db:5432/app\n", action: "create" as const }],
  ]);
  const issues = validateBuildStage("scaffold", prompt, files);
  assert.ok(issues.some((issue) => issue.includes("uses SQLite even though PostgreSQL was requested")));
  assert.ok(issues.some((issue) => issue.includes("hardcoded credential or database URL")));
});

test("focused repair context contains only files implicated by the exact diagnostics", () => {
  const files: ProposedEdit[] = [
    { path: "backend/.env.example", action: "create", content: "DATABASE_URL=postgres://user:password@db/app\n" },
    { path: "docker-compose.yml", action: "create", content: "POSTGRES_PASSWORD: password\n" },
    { path: "backend/main.py", action: "create", content: "DATABASE_URL = 'sqlite:///db.sqlite3'\n" },
    { path: "frontend/src/unrelated.tsx", action: "create", content: "export default function App(){ return <main/> }\n" },
  ];
  const focused = focusRepairContext({
    relevantFiles: files.map(({ path, content }) => ({ relPath: path, snippet: content.slice(0, 20) })),
    indexedChunkCount: 0,
  }, files, [
    "backend/.env.example contains a hardcoded credential or database URL; use environment-variable interpolation",
    "docker-compose.yml contains a hardcoded credential or database URL; use environment-variable interpolation",
    "FastAPI backend uses SQLite even though PostgreSQL was requested; read a PostgreSQL DATABASE_URL from environment configuration",
  ]);
  assert.deepEqual(focused.relevantFiles?.map((file) => file.relPath).sort(), ["backend/.env.example", "backend/main.py", "docker-compose.yml"]);
  assert.match(focused.relevantFiles?.find((file) => file.relPath === "backend/main.py")?.content ?? "", /sqlite/);
  assert.ok(!focused.relevantFiles?.some((file) => file.relPath === "frontend/src/unrelated.tsx"));
});

test("frontend npm dependency diagnostics authorize only the existing package manifest for repair", () => {
  const manifest = { path: "frontend/package.json", action: "modify" as const, content: JSON.stringify({ dependencies: { react: "^19", next: "^13" } }) };
  const context = { relevantFiles: [{ relPath: manifest.path, snippet: manifest.content, content: manifest.content }, { relPath: "frontend/src/App.tsx", snippet: "export default App" }], indexedChunkCount: 0 };
  const paths = repairAllowedPathsForStage("frontend", ["isolated frontend dependency installation/build failed (npm): ERESOLVE unable to resolve dependency tree"], context, [manifest]);
  assert.deepEqual([...paths], ["frontend/package.json"]);
  assert.deepEqual([...repairAllowedPathsForStage("backend", ["npm ERESOLVE package.json"], context, [manifest])], []);
});

test("Vite scaffold repair removes only an unused Next dependency causing an npm peer conflict", () => {
  const packageEdit = { path: "frontend/package.json", action: "modify" as const, content: JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0", next: "^13.5.4" } }) };
  const vite = { path: "frontend/vite.config.ts", action: "create" as const, content: "import { defineConfig } from 'vite'; export default defineConfig({});" };
  const app = { path: "frontend/src/App.tsx", action: "create" as const, content: "export default function App() { return <main />; }" };
  const issue = "isolated frontend dependency installation/build failed (npm): ERESOLVE unable to resolve dependency tree; next@13 requires react@^18";
  const fixed = repairKnownFrontendToolingIssues([packageEdit, vite, app], [issue]);
  assert.deepEqual(fixed.changedPaths, ["frontend/package.json"]);
  assert.equal(JSON.parse(fixed.edits.find((edit) => edit.path === "frontend/package.json")!.content).dependencies.next, undefined);
  const used = repairKnownFrontendToolingIssues([packageEdit, vite, { ...app, content: "import Link from 'next/link'; export default function App(){ return <Link href='/'>home</Link>; }" }], [issue]);
  assert.deepEqual(used.changedPaths, [], "a manifest dependency used by application source is not removed automatically");
});

test("generated Compose credential defaults are repaired to required environment references", () => {
  const result = normalizeComposeCredentialDefaults([{
    path: "docker-compose.yml",
    action: "create",
    content: [
      "services:",
      "  db:",
      "    environment:",
      "      POSTGRES_PASSWORD: password",
      "      POSTGRES_USER: onboarding",
      "      DATABASE_URL: postgres://user:secret@db/onboarding",
      "      JWT_SECRET: ${JWT_SECRET:?Set JWT_SECRET in your environment}",
      "",
    ].join("\n"),
  }]);
  assert.deepEqual(result.changed, ["docker-compose.yml"]);
  assert.match(result.edits[0].content, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?Set POSTGRES_PASSWORD in your environment\}/);
  assert.match(result.edits[0].content, /DATABASE_URL: \$\{DATABASE_URL:\?Set DATABASE_URL in your environment\}/);
  assert.match(result.edits[0].content, /POSTGRES_USER: onboarding/);
  assert.match(result.edits[0].content, /JWT_SECRET: \$\{JWT_SECRET:\?Set JWT_SECRET in your environment\}/);
});

test("backend stage wires a generated FastAPI router into the existing app entry point", () => {
  const result = registerGeneratedFastApiRouters("backend", [{
    path: "backend/routes/customers.py",
    action: "create",
    content: "from fastapi import APIRouter\nrouter = APIRouter(prefix='/customers')\n",
  }], {
    relevantFiles: [{ relPath: "backend/main.py", snippet: "from fastapi import FastAPI\napp = FastAPI()\n", content: "from fastapi import FastAPI\napp = FastAPI()\n" }],
    indexedChunkCount: 0,
  });
  const main = result.edits.find((edit) => edit.path === "backend/main.py");
  assert.ok(main);
  assert.equal(main.action, "modify");
  assert.match(main.content, /from \.routes\.customers import router as mobiusx_customers_router/);
  assert.match(main.content, /app\.include_router\(mobiusx_customers_router\)/);
  assert.deepEqual(result.registered, ["backend/routes/customers.py"]);
  const secondPass = registerGeneratedFastApiRouters("backend", [main, result.edits[0]], {
    relevantFiles: [{ relPath: "backend/main.py", snippet: main.content, content: main.content }],
    indexedChunkCount: 0,
  });
  assert.equal(secondPass.registered.length, 0, "router registration is idempotent");
});

test("router registration normalizes module imports and removes duplicate includes", () => {
  const mainContent = [
    "from fastapi import FastAPI",
    "from backend.routes import auth as mobiusx_auth_router, customers as mobiusx_customers_router",
    "app = FastAPI()",
    "app.include_router(mobiusx_auth_router)",
    "if __package__:",
    "    from .routes.customers import router as mobiusx_customers_router",
    "else:",
    "    from routes.customers import router as mobiusx_customers_router",
    "app.include_router(mobiusx_customers_router)",
  ].join("\n");
  const routes = ["auth", "customers"].map((name) => ({ relPath: `backend/routes/${name}.py`, snippet: "router = APIRouter()", content: "router = APIRouter()" }));
  const result = registerGeneratedFastApiRouters("backend", [{ path: "backend/main.py", action: "modify", content: mainContent }], { projectPath: ".", indexedChunkCount: 0, relevantFiles: routes });
  const main = result.edits.find((edit) => edit.path === "backend/main.py")!;
  assert.match(main.content, /from backend\.routes\.auth import router as mobiusx_auth_router/);
  assert.match(main.content, /from backend\.routes\.customers import router as mobiusx_customers_router/);
  assert.equal((main.content.match(/app\.include_router\(mobiusx_auth_router\)/g) ?? []).length, 1);
  assert.equal((main.content.match(/app\.include_router\(mobiusx_customers_router\)/g) ?? []).length, 1);
  const architecture = resolveProjectArchitecture(prompt);
  const contract = backendSubtaskPlan(architecture).find((item) => item.id === "router-registration")!;
  assert.deepEqual(backendSubtaskIssues(contract, [main], architecture), []);
});

test("FastAPI registration adds idempotent CORS from the shared configured-origin contract", () => {
  const context = { projectPath: "/tmp/generated", indexedChunkCount: 0, relevantFiles: [
    { relPath: "backend/main.py", snippet: "from fastapi import FastAPI\napp = FastAPI(title='Generated API')\n", content: "from fastapi import FastAPI\napp = FastAPI(title='Generated API')\n" },
    { relPath: "backend/config.py", snippet: "class Settings:\n    cors_origins: str = 'http://127.0.0.1:3000'\n", content: "class Settings:\n    cors_origins: str = 'http://127.0.0.1:3000'\n" },
  ] };
  const architecture = resolveProjectArchitecture(prompt);
  const first = registerGeneratedFastApiRouters("backend", [], context, architecture);
  const main = first.edits.find((edit) => edit.path === "backend/main.py")?.content ?? "";
  assert.match(main, /from fastapi\.middleware\.cors import CORSMiddleware/);
  assert.match(main, /settings\.cors_origins\.split\(","\)/);
  assert.match(main, /allow_headers=\["Authorization", "Content-Type"\]/);
  const second = registerGeneratedFastApiRouters("backend", first.edits, { ...context, relevantFiles: [{ relPath: "backend/config.py", snippet: context.relevantFiles[1].snippet, content: context.relevantFiles[1].content }] }, architecture);
  assert.equal(second.edits.filter((edit) => edit.path === "backend/main.py").length, 1);
  assert.equal((second.edits.find((edit) => edit.path === "backend/main.py")?.content.match(/app\.add_middleware\(\s*CORSMiddleware/g) ?? []).length, 1);
});

test("transaction stage wires a focused generated submission router into the existing app", () => {
  const mainContent = "from fastapi import FastAPI\napp = FastAPI()\n";
  const result = registerGeneratedFastApiRouters("transactions", [{
    path: "backend/routes/submission.py",
    action: "create",
    content: "from fastapi import APIRouter\nrouter = APIRouter()\n",
  }], {
    relevantFiles: [{ relPath: "backend/main.py", snippet: mainContent, content: mainContent }],
    indexedChunkCount: 0,
  });
  assert.ok(result.edits.some((edit) => edit.path === "backend/main.py" && edit.content.includes("app.include_router(mobiusx_submission_router)")));
  assert.deepEqual(result.registered, ["backend/routes/submission.py"]);
});

test("scaffold gate requires PostgreSQL and binds published development ports to loopback", () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "15", react: "19", "react-dom": "19" } }), action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()", action: "create" as const }],
    ["backend/requirements.txt", { content: "fastapi\n", action: "create" as const }],
    ["docker-compose.yml", { content: "services:\n  db:\n    image: postgres:16\n    ports:\n      - \"5432:5432\"", action: "create" as const }],
  ]);
  const issues = validateBuildStage("scaffold", prompt, files);
  assert.ok(issues.some((issue) => issue.includes("must bind to 127.0.0.1")));
  assert.ok(issues.some((issue) => issue.includes('"5432:5432"')), "repair diagnostics should identify the exact unsafe mapping");
});

test("Compose safety repair binds common host port mappings to loopback and preserves container ports", () => {
  const source = "services:\n  frontend:\n    ports:\n      - \"3000:3000\"\n  backend:\n    ports:\n      - \"0.0.0.0:8000:8000\"\n";
  const result = bindComposePortsToLoopback([{ path: "docker-compose.yml", action: "create", content: source }]);
  assert.deepEqual(result.mappings, ["3000:3000 -> 127.0.0.1:3000:3000", "0.0.0.0:8000:8000 -> 127.0.0.1:8000:8000"]);
  assert.match(result.edits[0].content, /127\.0\.0\.1:3000:3000/);
  assert.match(result.edits[0].content, /127\.0\.0\.1:8000:8000/);
  assert.deepEqual(bindComposePortsToLoopback(result.edits).mappings, [], "normalization is idempotent");
});

function createPassingStageFiles(stageId: string, subtaskId?: string): ProposedEdit[] {
  if (["backend", "transactions"].includes(stageId) && subtaskId?.startsWith("business-operation-spec:")) {
    const architecture = resolveProjectArchitecture(prompt);
    const operationId = subtaskId.split(":")[1];
    const operation = operationId === "customer.register" ? {
      schemaVersion: "1.0", operationKind: "entity-create", operationId, architectureHash: architecture.contractHash,
      targetModule: "backend/routes/customers.py", route: { method: "POST", path: "/customers", functionName: "create_customer" },
      actor: { entity: "User", role: "customer", permission: "customer.register" },
      input: { bodySchema: "CustomerCreate", fieldMappings: [
        { targetField: "name", source: "body", sourceField: "name" }, { targetField: "email", source: "body", sourceField: "email" },
        { targetField: "owner_id", source: "actor", sourceField: "id" }, { targetField: "status", source: "state", value: "pending" },
      ] },
      output: { entity: "Customer", responseSchema: "CustomerResponse", statusCode: 201 },
      audit: { entity: "AuditEvent", action: "created", actorField: "user_id", subjectField: "customer_id", actionField: "action" },
      transaction: { driver: "sqlalchemy-async", scope: "single-request", atomic: true, rollbackOnError: true },
      failures: { duplicate: 409, rollbackOnError: true },
    } : operationSpecForTest(architecture, operationId);
    return [{ path: `.mobiusx/operations/${operationId.replaceAll(".", "-")}.v1.json`, action: "create", content: JSON.stringify(operation) }];
  }
  switch (stageId) {
    case "scaffold":
      return [
        { path: "frontend/package.json", action: "create", content: JSON.stringify({ scripts: { dev: "node --version", build: "node --version" }, dependencies: { react: "file:./fixture-react" } }) },
        { path: "frontend/fixture-react/package.json", action: "create", content: JSON.stringify({ name: "react", version: "19.0.0", main: "index.js" }) },
        { path: "frontend/fixture-react/index.js", action: "create", content: "module.exports = {};\n" },
        { path: "backend/requirements.txt", action: "create", content: "fastapi\n" },
        { path: "backend/main.py", action: "create", content: "from fastapi import FastAPI\napp = FastAPI()\n" },
        { path: "docker-compose.yml", action: "create", content: "services:\n  db:\n    image: postgres:16\n" },
      ];
    case "database":
      if (subtaskId === "customer-entity") return [{ path: "backend/models.py", action: "create", content: "from sqlalchemy import Column, Integer, String\nfrom backend.database import Base\n\nclass Customer(Base):\n    __tablename__ = 'customers'\n    id = Column(Integer, primary_key=True)\n    name = Column(String, nullable=False)\n    email = Column(String, nullable=False, unique=True)\n    status = Column(String, nullable=False, default='draft')\n" }];
      if (subtaskId === "related-entities") return [{ path: "backend/models.py", action: "modify", content: "from sqlalchemy import Column, ForeignKey, Integer, String\nfrom sqlalchemy.orm import relationship\nfrom backend.database import Base\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = Column(Integer, primary_key=True)\n    email = Column(String, nullable=False, unique=True)\n    role = Column(String, nullable=False)\n\nclass Customer(Base):\n    __tablename__ = 'customers'\n    id = Column(Integer, primary_key=True)\n    name = Column(String, nullable=False)\n    email = Column(String, nullable=False, unique=True)\n    status = Column(String, nullable=False, default='draft', index=True)\n    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False)\n    owner = relationship('User')\n\nclass AuditEvent(Base):\n    __tablename__ = 'audit_events'\n    id = Column(Integer, primary_key=True)\n    customer_id = Column(Integer, ForeignKey('customers.id'), nullable=False)\n    action = Column(String, nullable=False)\n" }];
      if (subtaskId === "schema-constraints") return [{ path: "backend/models.py", action: "modify", content: "from datetime import datetime\nfrom enum import Enum as PyEnum\nfrom sqlalchemy import Column, DateTime, Enum, ForeignKey, Integer, String\nfrom sqlalchemy.orm import relationship\nfrom backend.database import Base\nclass CustomerStatus(PyEnum):\n    PENDING = 'pending'\n    APPROVED = 'approved'\n    REJECTED = 'rejected'\nclass User(Base):\n    __tablename__ = 'users'\n    id = Column(Integer, primary_key=True)\n    email = Column(String, nullable=False, unique=True)\n    role = Column(String, nullable=False, default='customer')\nclass Customer(Base):\n    __tablename__ = 'customers'\n    id = Column(Integer, primary_key=True)\n    name = Column(String, nullable=False)\n    email = Column(String, nullable=False, unique=True)\n    status = Column(Enum(CustomerStatus, name='customer_status'), nullable=False, default=CustomerStatus.PENDING)\n    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)\n    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False)\n    owner = relationship('User')\nclass AuditEvent(Base):\n    __tablename__ = 'audit_events'\n    id = Column(Integer, primary_key=True)\n    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)\n    customer_id = Column(Integer, ForeignKey('customers.id'), nullable=False)\n    action = Column(String, nullable=False)\n    created_at = Column(DateTime, nullable=False)\n" }];
      if (subtaskId === "alembic-revision") return [{ path: "backend/migrations/versions/0001_initial.py", action: "create", content: "from alembic import op\nimport sqlalchemy as sa\nrevision = '0001'\ndown_revision = None\ndef upgrade():\n    op.create_table('customers', sa.Column('id', sa.Integer, primary_key=True), sa.Column('name', sa.String, nullable=False), sa.Column('email', sa.String, nullable=False, unique=True), sa.Column('status', sa.String, nullable=False))\ndef downgrade():\n    op.drop_table('customers')\n" }];
      return [
        { path: "backend/requirements.txt", action: "modify", content: "fastapi\nsqlalchemy\nalembic\nasyncpg\n" },
        { path: "backend/models.py", action: "create", content: "from sqlalchemy import Column, ForeignKey, Integer, String\nfrom backend.database import Base\n\nclass User(Base):\n    __tablename__ = 'users'\n    id = Column(Integer, primary_key=True)\n\nclass Customer(Base):\n    __tablename__ = 'customers'\n    id = Column(Integer, primary_key=True)\n    owner_id = Column(Integer, ForeignKey('users.id'))\n    status = Column(String, nullable=False, default='draft')\n\nclass AuditEvent(Base):\n    __tablename__ = 'audit_events'\n    id = Column(Integer, primary_key=True)\n    customer_id = Column(Integer, ForeignKey('customers.id'))\n" },
        { path: "backend/migrations/versions/0001_initial.py", action: "create", content: "from alembic import op\nimport sqlalchemy as sa\nrevision = '0001'\ndown_revision = None\ndef upgrade():\n    op.create_table('users', sa.Column('id', sa.Integer, primary_key=True))\n    op.create_table('customers', sa.Column('id', sa.Integer, primary_key=True), sa.Column('owner_id', sa.Integer, sa.ForeignKey('users.id')), sa.Column('status', sa.String, nullable=False))\n    op.create_table('audit_events', sa.Column('id', sa.Integer, primary_key=True), sa.Column('customer_id', sa.Integer, sa.ForeignKey('customers.id')))\ndef downgrade():\n    op.drop_table('audit_events')\n    op.drop_table('customers')\n    op.drop_table('users')\n" },
      ];
    case "backend":
      if (subtaskId === "backend-schemas") return [{ path: "backend/schemas.py", action: "create", content: "from datetime import datetime\nfrom pydantic import BaseModel, EmailStr, ConfigDict\nfrom backend.models import CustomerStatus\nclass CustomerCreate(BaseModel):\n    name: str\n    email: EmailStr\nclass CustomerResponse(BaseModel):\n    model_config = ConfigDict(from_attributes=True)\n    id: int\n    name: str\n    email: EmailStr\n    status: CustomerStatus\n    created_at: datetime\n    owner_id: int\nclass AuditEventResponse(BaseModel):\n    model_config = ConfigDict(from_attributes=True)\n    id: int\n    customer_id: int\n    user_id: int\n    action: str\n    created_at: datetime\nclass LoginRequest(BaseModel):\n    username: str\n    password: str\nclass TokenResponse(BaseModel):\n    access_token: str\n    token_type: str = 'bearer'\n" }];
      if (subtaskId === "authentication" || subtaskId === "role-authorization") return [{ path: "backend/auth.py", action: "create", content: "from datetime import datetime, timedelta, timezone\nfrom fastapi import Depends, HTTPException, status\nfrom fastapi.security import OAuth2PasswordBearer\nfrom jose import JWTError, jwt\nfrom passlib.context import CryptContext\nfrom sqlalchemy import select\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom backend.config import settings\nfrom backend.database import get_db\nfrom backend.models import User\n\noauth2_scheme = OAuth2PasswordBearer(tokenUrl='/auth/login')\ncrypt_context = CryptContext(schemes=['bcrypt'], deprecated='auto')\nasync def authenticate_user(username: str, password: str, db: AsyncSession = Depends(get_db)):\n    result = await db.execute(select(User).where(User.username == username))\n    user = result.scalar_one_or_none()\n    return user if user and crypt_context.verify(password, user.password_hash) else None\nasync def create_access_token(data: dict):\n    payload = {**data, 'exp': datetime.now(timezone.utc) + timedelta(minutes=30)}\n    return jwt.encode(payload, settings.secret_key, algorithm='HS256')\nasync def get_current_user(token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)) -> User:\n    try:\n        payload = jwt.decode(token, settings.secret_key, algorithms=['HS256'])\n        result = await db.execute(select(User).where(User.username == payload['sub']))\n        user = result.scalar_one_or_none()\n    except (JWTError, KeyError):\n        user = None\n    if user is None: raise HTTPException(status_code=401, detail='Invalid credentials')\n    return user\ndef require_role(role: str):\n    async def dependency(user: User = Depends(get_current_user)):\n        if user.role != role: raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Forbidden')\n        return user\n    return dependency\n" }];
      if (subtaskId === "customer-repository-service") return [{ path: "backend/routes/customers.py", action: "create", content: "from fastapi import APIRouter\nfrom sqlalchemy import select\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom backend.models import Customer, AuditEvent\nrouter = APIRouter()\nasync def get_customer(db: AsyncSession, customer_id: int):\n    result = await db.execute(select(Customer).where(Customer.id == customer_id))\n    return result.scalar_one_or_none()\n" }];
      if (subtaskId === "customer-registration-api") return [{ path: "backend/routes/customers.py", action: "create", content: "from fastapi import APIRouter, Depends, HTTPException, status\nfrom sqlalchemy import select\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom sqlalchemy.exc import IntegrityError\nfrom backend.database import get_db\nfrom backend.models import Customer, AuditEvent, User\nfrom backend.schemas import CustomerCreate, CustomerResponse\nfrom backend.auth import require_role\nrouter = APIRouter()\n@router.post('/customers', response_model=CustomerResponse, status_code=status.HTTP_201_CREATED)\nasync def create_customer(customer: CustomerCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_role('customer'))):\n    async with db.begin():\n        db_customer = Customer(name=customer.name, email=customer.email, owner_id=current_user.id, status='pending')\n        db.add(db_customer)\n        await db.flush()\n        db.add(AuditEvent(user_id=current_user.id, customer_id=db_customer.id, action='created'))\n    await db.refresh(db_customer)\n    return db_customer\n@router.get('/customers/{customer_id}', response_model=CustomerResponse)\nasync def get_customer_route(customer_id: int, db: AsyncSession = Depends(get_db), current_user: User = Depends(require_role('manager'))):\n    result = await db.execute(select(Customer).where(Customer.id == customer_id))\n    customer = result.scalar_one_or_none()\n    if customer is None: raise HTTPException(status_code=404, detail='Not found')\n    return customer\n" }];
      if (subtaskId === "auth-api") return [{ path: "backend/routes/auth.py", action: "create", content: "from fastapi import APIRouter, Depends, HTTPException, status\nfrom sqlalchemy.ext.asyncio import AsyncSession\nfrom backend.auth import authenticate_user, create_access_token\nfrom backend.database import get_db\nfrom backend.schemas import LoginRequest, TokenResponse\nrouter = APIRouter()\n@router.post('/auth/login', response_model=TokenResponse)\nasync def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):\n    user = await authenticate_user(payload.username, payload.password, db)\n    if user is None: raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid credentials')\n    token = await create_access_token({'sub': user.username})\n    return TokenResponse(access_token=token, token_type='bearer')\n" }];
      if (subtaskId === "router-registration") return [{ path: "backend/main.py", action: "modify", content: "from fastapi import FastAPI\nfrom backend.routes.auth import router as auth\nfrom backend.routes.customers import router as customers\napp = FastAPI()\napp.include_router(auth)\napp.include_router(customers)\n@app.get('/health')\ndef health(): return {'status': 'ok'}\n" }];
      return [
        { path: "backend/main.py", action: "modify", content: "from fastapi import FastAPI\nfrom backend.routes.auth import router as auth_router\nfrom backend.routes.customers import router as customers_router\napp = FastAPI()\napp.include_router(auth_router)\napp.include_router(customers_router)\n" },
        { path: "backend/routes/auth.py", action: "create", content: "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/login')\ndef login(): return {'token': 'from-env'}\n" },
        { path: "backend/routes/customers.py", action: "create", content: "from fastapi import APIRouter\nrouter = APIRouter()\n@router.get('/customers')\ndef customers(): return {'role': 'manager'}\n" },
      ];
    case "transactions":
      if (subtaskId === "submission-api") return [{ path: "backend/routes/customers.py", action: "modify", content: "from fastapi import APIRouter\nfrom backend.models import Customer, AuditEvent\nrouter = APIRouter()\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer(db, customer):\n    async with db.begin():\n        customer.status = 'submitted'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='submitted'))\n    return customer\n" }];
      if (subtaskId === "manager-decision-api") return [{ path: "backend/routes/customers.py", action: "modify", content: "from fastapi import APIRouter, Depends\nfrom backend.models import Customer, AuditEvent\nfrom backend.auth import require_role\nrouter = APIRouter()\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer(db, customer):\n    async with db.begin():\n        customer.status = 'submitted'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='submitted'))\n    return customer\n@router.post('/customers/{customer_id}/approve')\nasync def approve_customer(db, customer, manager=Depends(require_role('manager'))):\n    async with db.begin():\n        customer.status = 'approved'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='approved'))\n    return customer\n@router.post('/customers/{customer_id}/reject')\nasync def reject_customer(db, customer, manager=Depends(require_role('manager'))):\n    async with db.begin():\n        customer.status = 'rejected'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='rejected'))\n    return customer\n" }];
      if (subtaskId === "audit-history-api") return [{ path: "backend/routes/customers.py", action: "modify", content: "from fastapi import APIRouter, Depends, HTTPException\nfrom sqlalchemy import select\nfrom backend.models import Customer, AuditEvent\nfrom backend.schemas import AuditEventResponse\nfrom backend.auth import get_current_user\nrouter = APIRouter()\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer(db, customer):\n    async with db.begin():\n        customer.status = 'submitted'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='submitted'))\n    return customer\n@router.post('/customers/{customer_id}/approve')\nasync def approve_customer(db, customer, manager=Depends(get_current_user)):\n    async with db.begin():\n        customer.status = 'approved'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='approved'))\n    return customer\n@router.post('/customers/{customer_id}/reject')\nasync def reject_customer(db, customer, manager=Depends(get_current_user)):\n    async with db.begin():\n        customer.status = 'rejected'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='rejected'))\n    return customer\n@router.get('/customers/{customer_id}/audit', response_model=list[AuditEventResponse])\nasync def get_audit_history(customer_id: int, db, current_user=Depends(get_current_user)):\n    subject = await db.execute(select(Customer).where(Customer.id == customer_id))\n    record = subject.scalar_one_or_none()\n    if record is None or (current_user.role == 'customer' and record.owner_id != current_user.id):\n        raise HTTPException(status_code=404, detail='Customer not found')\n    result = await db.execute(select(AuditEvent).where(AuditEvent.customer_id == customer_id).order_by(AuditEvent.created_at.asc()))\n    return result.scalars().all()\n" }];
      return [{ path: "backend/main.py", action: "modify", content: "from fastapi import FastAPI\napp = FastAPI()\ndef apply_transition(db, customer):\n    with db.begin():\n        db.add(customer)\n        audit_event = ApprovalEvent()\n        db.add(audit_event)\n@app.post('/customers/submit')\ndef submit(): return apply_transition(db, customer)\n@app.post('/customers/approve')\ndef approve(): return apply_transition(db, customer)\n@app.post('/customers/reject')\ndef reject(): return apply_transition(db, customer)\n" }];
    case "frontend":
      return [{ path: "frontend/app/page.jsx", action: "create", content: "export default function Page() { return <button onClick={() => fetch('/api/customers/submit')}>Submit for approval</button>; }" }];
    case "tests":
      return [
        { path: "backend/tests/conftest.py", action: "create", content: "import pytest\nfrom fastapi.testclient import TestClient\nfrom backend.main import app\n\n@pytest.fixture\ndef client():\n    with TestClient(app, raise_server_exceptions=False) as test_client:\n        yield test_client\n" },
        { path: "backend/tests/test_flow.py", action: "create", content: "import os\nfrom uuid import uuid4\n\ndef test_customer_registration_required_fields_authentication_manager_approval_rejection_database_persistence_audit_history_and_invalid_transition(client):\n    missing = client.post('/customers', json={})\n    assert missing.status_code == 422\n    customer_headers = {'Authorization': f\"Bearer {os.environ['MOBIUSX_TEST_CUSTOMER_TOKEN']}\"}\n    manager_headers = {'Authorization': f\"Bearer {os.environ['MOBIUSX_TEST_MANAGER_TOKEN']}\"}\n    unauthenticated = client.post('/customers', json={'name': 'Denied', 'email': f'{uuid4()}@example.test'})\n    assert unauthenticated.status_code == 401\n    payload = {'name': 'Approval test', 'email': f'{uuid4()}@example.test'}\n    created = client.post('/customers', json=payload, headers=customer_headers)\n    assert created.status_code == 201\n    customer = created.json()\n    submitted = client.post(f\"/customers/{customer['id']}/submit\", headers=customer_headers)\n    assert submitted.status_code == 200\n    forbidden = client.post(f\"/customers/{customer['id']}/approve\", headers=customer_headers)\n    assert forbidden.status_code == 403\n    approved = client.post(f\"/customers/{customer['id']}/approve\", headers=manager_headers)\n    assert approved.status_code == 200 and approved.json()['status'] == 'approved'\n    persisted = client.get(f\"/customers/{customer['id']}\", headers=manager_headers)\n    assert persisted.status_code == 200 and persisted.json()['status'] == 'approved'\n    repeated = client.post(f\"/customers/{customer['id']}/approve\", headers=manager_headers)\n    assert repeated.status_code == 409\n    audit = client.get(f\"/customers/{customer['id']}/audit\", headers=manager_headers)\n    assert audit.status_code == 200 and any(event['action'] == 'approved' for event in audit.json())\n    rejected_payload = {'name': 'Rejection test', 'email': f'{uuid4()}@example.test'}\n    rejected_record = client.post('/customers', json=rejected_payload, headers=customer_headers)\n    assert rejected_record.status_code == 201\n    record_id = rejected_record.json()['id']\n    assert client.post(f\"/customers/{record_id}/submit\", headers=customer_headers).status_code == 200\n    rejected = client.post(f\"/customers/{record_id}/reject\", headers=manager_headers)\n    assert rejected.status_code == 200 and rejected.json()['status'] == 'rejected'\n" },
        { path: "frontend/e2e/customer-approval.spec.ts", action: "create", content: "import { test, expect } from '@playwright/test';\n\nconst customerUsername = process.env.MOBIUSX_TEST_CUSTOMER_USERNAME!;\nconst customerPassword = process.env.MOBIUSX_TEST_CUSTOMER_PASSWORD!;\nconst managerUsername = process.env.MOBIUSX_TEST_MANAGER_USERNAME!;\nconst managerPassword = process.env.MOBIUSX_TEST_MANAGER_PASSWORD!;\n\nasync function signIn(page, route, username, password) {\n  await page.goto(route);\n  await page.getByLabel('Username').fill(username);\n  await page.getByLabel('Password').fill(password);\n  await page.getByRole('button', { name: 'Continue' }).click();\n}\n\ntest('customer registration and submission persist, manager approval and audit are visible', async ({ page }) => {\n  await signIn(page, '/login', customerUsername, customerPassword);\n  await page.goto('/customer/new');\n  await page.getByLabel('Name').fill(`Approval ${Date.now()}`);\n  await page.getByLabel('Email').fill(`approval-${Date.now()}@example.test`);\n  const created = page.waitForResponse(response => response.url().endsWith('/customers') && response.request().method() === 'POST');\n  await page.getByRole('button', { name: 'Continue' }).click();\n  const creation = await created;\n  expect(creation.status()).toBe(201);\n  await expect(page.getByRole('heading', { name: 'Application details' })).toBeVisible();\n  await page.getByRole('button', { name: 'Submit' }).click();\n  await expect(page.getByText(/pending/i)).toBeVisible();\n  await page.reload();\n  await expect(page.getByText(/pending/i)).toBeVisible();\n  await page.getByRole('button', { name: 'Sign out' }).click();\n  await signIn(page, '/manager/login', managerUsername, managerPassword);\n  await page.goto('/manager');\n  await expect(page.getByText(/Approval/)).toBeVisible();\n  await page.getByRole('button', { name: 'Approve' }).first().click();\n  await expect(page.getByText(/approved/i)).toBeVisible();\n  await expect(page.getByText(/Activity history|audit/i)).toBeVisible();\n});\n" },
      ];
    default:
      return [];
  }
}

function createScopedPassingTransactionFiles(): ProposedEdit[] {
  return [
    { path: "backend/routes/customers.py", action: "modify", content: "from fastapi import APIRouter, Depends\nfrom backend.models import AuditEvent\nfrom backend.auth import require_role\nrouter = APIRouter()\n@router.post('/customers/{customer_id}/submit')\nasync def submit_customer(db, customer):\n    async with db.begin():\n        customer.status = 'submitted'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='submitted'))\n    return customer\n@router.post('/customers/{customer_id}/approve')\nasync def approve_customer(db, customer, manager=Depends(require_role('manager'))):\n    async with db.begin():\n        customer.status = 'approved'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='approved'))\n    return customer\n@router.post('/customers/{customer_id}/reject')\nasync def reject_customer(db, customer, manager=Depends(require_role('manager'))):\n    async with db.begin():\n        customer.status = 'rejected'\n        db.add(customer)\n        db.add(AuditEvent(customer_id=customer.id, action='rejected'))\n    return customer\n" },
  ];
}

function fakeRunner(): AgentRunner {
  return {
    name: "fake-coder",
    async listModels(): Promise<ModelOption[]> { return []; },
    async run(input, emit) {
      if (input.stagedBuild?.id === "tests" && input.mode === "ask") {
        const now = new Date().toISOString();
        emit({ type: "output", delta: JSON.stringify({ cases: [{ id: "auth.login.missing-password", operationId: "auth.login", action: "submit a login request without the required password", expectedStatus: 422 }] }) });
        emit({ type: "model_diagnostic", diagnostic: { requestId: "test-contribution-test-request", taskId: input.taskId, provider: "ollama", endpoint: "http://127.0.0.1:11434/api/chat", modelId: input.modelId ?? "test-coder", phase: "complete", startedAt: now, endedAt: now, durationMs: 1, responseBytes: 180, streaming: true, cancelled: false, deadlineExceeded: false, retryHistory: ["initial-request"] } });
        emit({ type: "status", status: "completed" }); emit({ type: "done" }); return;
      }
      if (input.stagedBuild?.id === "frontend" && input.mode === "ask") {
        const now = new Date().toISOString();
        const screenText = input.prompt.match(/Screen: (\{[^\n]+\})/)?.[1];
        const screen = screenText ? JSON.parse(screenText) as { columns?: string[]; domainStates?: string[] } : {};
        const columnOrder = screen.columns ?? [];
        const statusLabels = Object.fromEntries((screen.domainStates ?? []).map((state) => [state, state === "pending" ? "Pending review" : state[0].toUpperCase() + state.slice(1)]));
        emit({ type: "output", delta: JSON.stringify({ title: "My Applications", columnOrder, statusLabels, emptyState: "Your applications will appear here." }) });
        emit({ type: "model_diagnostic", diagnostic: { requestId: "ui-contribution-test-request", taskId: input.taskId, provider: "ollama", endpoint: "http://127.0.0.1:11434/api/chat", modelId: input.modelId ?? "test-coder", phase: "complete", startedAt: now, endedAt: now, durationMs: 1, responseBytes: 200, streaming: true, cancelled: false, deadlineExceeded: false, retryHistory: ["initial-request"] } });
        emit({ type: "status", status: "completed" }); emit({ type: "done" }); return;
      }
      if (input.stagedBuild?.id === "frontend" && /Generate one versioned UI contract/.test(input.prompt)) {
        const pacText = input.prompt.match(/PAC: (\{[^\n]+\})/)?.[1];
        const architectureHash = pacText ? (JSON.parse(pacText) as { architectureHash: string }).architectureHash : "";
        const operationsText = input.prompt.match(/Approved operations: (\[[^\n]+\])/)?.[1] ?? "[]";
        const operationIds = new Set((JSON.parse(operationsText) as Array<{ id: string }>).map((operation) => operation.id));
        const state = { loading: "Loading records", empty: "No records", success: "Saved", error: "Could not load records" };
        const accessibility = { heading: true, labels: true, keyboard: true };
        const routes: Array<Record<string, unknown>> = [
          { id: "customer-login", route: "/login", purpose: "Customer sign in", roles: ["public"], loginRole: "customer", title: "Sign in", form: { operationId: "auth.login", fields: [{ name: "username", label: "Username", type: "text", required: true }, { name: "password", label: "Password", type: "password", required: true }] }, actions: [], navigation: [{ label: "My applications", route: "/customers" }, { label: "Manager queue", route: "/manager" }], states: state, accessibility, responsive: true },
        ];
        routes[0].navigation = [{ label: "Sign in", route: "/login" }];
        if (operationIds.has("manager.approve")) routes.push({ id: "manager-login", route: "/manager/login", purpose: "Manager sign in", roles: ["public"], loginRole: "manager", title: "Manager sign in", form: { operationId: "auth.login", fields: [{ name: "username", label: "Username", type: "text", required: true }, { name: "password", label: "Password", type: "password", required: true }] }, actions: [], navigation: [{ label: "Customer sign in", route: "/login" }, { label: "Manager sign in", route: "/manager/login" }], states: state, accessibility, responsive: true });
        if (operationIds.has("customer.register")) routes.push({ id: "customer-registration", route: "/register", purpose: "Create a record", roles: ["customer"], title: "Register", form: { operationId: "customer.register", fields: [{ name: "name", label: "Name", type: "text", required: true }, { name: "email", label: "Email", type: "email", required: true }] }, actions: [], navigation: [{ label: "Register", route: "/register" }, { label: "Sign in", route: "/login" }], states: state, accessibility, responsive: true });
        if (operationIds.has("customer.listOwn")) routes.push({ id: "customer-dashboard", route: "/customers", purpose: "Your applications", roles: ["customer"], title: "My applications", dataOperation: "customer.listOwn", table: { entity: "Customer", columns: ["id", "name", "status"], filters: ["status"] }, ...(operationIds.has("customer.getOwn") ? { detailEntity: "Customer" } : {}), actions: operationIds.has("customer.submit") ? [{ label: "Submit", operationId: "customer.submit" }] : [], navigation: [{ label: "My applications", route: "/customers" }, { label: "Register", route: "/register" }], states: state, accessibility, responsive: true });
        if (operationIds.has("customer.getOwn")) routes.push({ id: "customer-detail", route: "/customers/{customer_id}", purpose: "Application details", roles: ["customer"], title: "Application details", dataOperation: "customer.getOwn", detailEntity: "Customer", ...(operationIds.has("customer.audit.read") ? { relatedData: [{ title: "Activity history", operationId: "customer.audit.read", columns: ["action", "created_at"] }] } : {}), actions: operationIds.has("customer.submit") ? [{ label: "Submit", operationId: "customer.submit" }] : [], navigation: [{ label: "My applications", route: "/customers" }], states: state, accessibility, responsive: true });
        if (operationIds.has("manager.listReviewQueue")) routes.push({ id: "manager-queue", route: "/manager", purpose: "Review records", roles: ["manager"], title: "Review queue", dataOperation: "manager.listReviewQueue", table: { entity: "Customer", columns: ["id", "name", "status"], filters: ["status"] }, ...(operationIds.has("manager.getReviewable") ? { detailEntity: "Customer" } : {}), actions: ["manager.approve", "manager.reject"].filter((id) => operationIds.has(id)).map((id) => ({ label: id.endsWith("approve") ? "Approve" : "Reject", operationId: id })), navigation: [{ label: "Manager queue", route: "/manager" }, { label: "Sign in", route: "/login" }], states: state, accessibility, responsive: true });
        if (operationIds.has("manager.getReviewable")) routes.push({ id: "manager-detail", route: "/manager/customers/{customer_id}", purpose: "Review record", roles: ["manager"], title: "Review application", dataOperation: "manager.getReviewable", detailEntity: "Customer", ...(operationIds.has("customer.audit.read") ? { relatedData: [{ title: "Activity history", operationId: "customer.audit.read", columns: ["action", "created_at"] }] } : {}), actions: ["manager.approve", "manager.reject"].filter((id) => operationIds.has(id)).map((id) => ({ label: id.endsWith("approve") ? "Approve" : "Reject", operationId: id })), navigation: [{ label: "Review queue", route: "/manager" }], states: state, accessibility, responsive: true });
        for (const route of routes) route.navigation = (route.navigation as Array<{ label: string; route: string }>).filter((item) => routes.some((candidate) => candidate.route === item.route));
        emit({ type: "edits", edits: [{ path: "frontend/ui-contract.v1.json", action: "create", content: JSON.stringify({ schemaVersion: "1.0", architectureHash, title: "Customer Portal", apiBaseUrlEnv: "VITE_API_BASE_URL", routes }) }] });
        emit({ type: "status", status: "completed" }); emit({ type: "done" }); return;
      }
      for (const edit of createPassingStageFiles(input.stagedBuild?.id ?? "", input.stagedBuild?.subtask?.id)) emit({ type: "edits", edits: [edit] });
      emit({ type: "status", status: "completed" });
      emit({ type: "done" });
    },
  };
}

test("frontend preflight rejects an incomplete generated login or customer read API before UI inference", () => {
  const files = new Map<string, { content: string; action: ProposedEdit["action"] }>([
    ["backend/routes/auth.py", { action: "create", content: "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/auth/login')\ndef login(): return {'access_token': 'x'}\n" }],
    ["backend/routes/customers.py", { action: "create", content: "from fastapi import APIRouter\nrouter = APIRouter()\n@router.get('/customers')\ndef list_customers(): return []\n" }],
    ["backend/schemas.py", { action: "create", content: "class LoginRequest(BaseModel):\n    username: str\n    password: str\nclass TokenResponse(BaseModel):\n    access_token: str\n" }],
  ]);
  const issues = validateFrontendBackendContract(files, "Build a customer onboarding dashboard with a manager approval queue.");
  assert.ok(issues.some((issue) => /customer registration contract is missing POST \/customers/.test(issue)));
  assert.ok(issues.some((issue) => /GET \/customers.*owner/.test(issue)));
});

test("frontend preflight resolves the pending enum member from the generated ORM instead of assuming uppercase naming", () => {
  const files = new Map<string, { content: string; action: ProposedEdit["action"] }>([
    ["backend/models.py", { action: "create", content: "from enum import Enum\nclass CustomerStatus(str, Enum):\n    pending = 'pending'\n    approved = 'approved'\n    rejected = 'rejected'\n" }],
    ["backend/routes/auth.py", { action: "create", content: "@router.post('/auth/login')\ndef login(): pass\n" }],
    ["backend/schemas.py", { action: "create", content: "class LoginRequest(BaseModel):\n    username: str\n    password: str\nclass TokenResponse(BaseModel):\n    access_token: str\n" }],
    ["backend/routes/customers.py", { action: "create", content: [
      "@router.post('/customers')", "def create_customer(): pass",
      "@router.post('/customers/{customer_id}/submit')", "def submit_customer(): pass",
      "@router.post('/customers/{customer_id}/approve')", "def approve_customer(): pass",
      "@router.post('/customers/{customer_id}/reject')", "def reject_customer(): pass",
      "@router.get('/customers')", "def list_customers(db=Depends(get_db), current_user=Depends(get_current_user)):",
      "    if current_user.role == 'customer': predicates.append(Customer.owner_id == current_user.id)",
      "    elif current_user.role == 'manager':", "        predicates.append(Customer.status == CustomerStatus.pending)",
      "        predicates.append(AuditEvent.action == 'submitted')", "    statement = statement.offset(offset).limit(limit)",
      "    return status_filter", "@router.get('/customers/{customer_id}')",
      "def get_customer(current_user=Depends(get_current_user)):",
      "    if current_user.role == 'customer': predicate = Customer.owner_id == current_user.id",
      "    elif current_user.role == 'manager': predicate = True", "@router.get('/customers/{customer_id}/audit')",
      "def read_audit(current_user=Depends(get_current_user)):",
      "    if current_user.role == 'customer': predicate = Customer.owner_id == current_user.id",
      "    elif current_user.role == 'manager': predicate = True",
    ].join("\n") }],
  ]);
  const issues = validateFrontendBackendContract(files, "Build a customer onboarding dashboard with a manager approval queue.");
  assert.deepEqual(issues, []);
});

test("checkpoint UI adapter accepts only complete versioned auth.login request, response and session metadata", () => {
  const architecture = resolveProjectArchitecture(prompt);
  const models = "class User(Base):\n    username: Mapped[str]\n    role: Mapped[str]\n";
  const schemas = "class LoginRequest(BaseModel):\n    username: str = Field(..., min_length=1)\n    password: str = Field(..., min_length=1)\nclass TokenResponse(BaseModel):\n    access_token: str\n    token_type: str\n";
  const auth = "async def authenticate_user(username, password, db): return None\nasync def create_access_token(data): return 'token'\n";
  const operation = createAuthenticationLoginOperationSpec(architecture, models, schemas, "backend/routes/auth.py", auth);
  const authRoute = `from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/auth/login', response_model=TokenResponse, responses={401: {'description': 'Invalid credentials'}})\nasync def login(payload: LoginRequest): pass\n`;
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  const records = [
    { operationId: "auth.login", architectureHash: architecture.contractHash, content: JSON.stringify(operation), sha256: hash(JSON.stringify(operation)), createdAt: new Date().toISOString() },
    { operationId: "customer.listOwn", architectureHash: architecture.contractHash, content: JSON.stringify({ operationId: "customer.listOwn", route: { method: "GET", path: "/customers" }, actor: { customerRole: "customer", managerRole: "manager" }, output: { entity: "Customer" } }), sha256: "", createdAt: new Date().toISOString() },
  ];
  records[1].sha256 = hash(records[1].content);
  const checkpoint = { businessOperations: records } as unknown as NonNullable<Parameters<typeof uiOperationsFromCheckpoint>[0]>;
  const files = new Map([
    ["backend/routes/auth.py", { action: "create" as const, content: authRoute }],
    ["backend/schemas.py", { action: "create" as const, content: schemas }],
    ["backend/models.py", { action: "create" as const, content: models }],
    ["backend/auth.py", { action: "create" as const, content: auth }],
  ]);
  const result = uiOperationsFromCheckpoint(checkpoint, architecture, files);
  assert.deepEqual(result.issues, []);
  const login = result.operations.find((item) => item.operationId === "auth.login") as Extract<(typeof result.operations)[number], { requestFields: string[] }>;
  assert.deepEqual(login.requestFields, ["username", "password"]);
  assert.deepEqual(login.responseFields, ["access_token", "token_type"]);
  assert.equal(login.requestContentType, "application/json");
  assert.equal(login.sessionScheme, "bearer");

  const legacyContent = JSON.stringify({ ...operation, request: undefined });
  const legacyCheckpoint = { businessOperations: [{ ...records[0], content: legacyContent, sha256: hash(legacyContent) }, records[1]] } as unknown as NonNullable<Parameters<typeof uiOperationsFromCheckpoint>[0]>;
  assert.ok(uiOperationsFromCheckpoint(legacyCheckpoint, architecture, files).issues.some((issue) => /version 2 auth\.login contract/.test(issue)));
});

test("fresh staged Build checkpoints login and read contracts before rendering the React frontend", async () => {
  const calls: string[] = [];
  const modes: string[] = [];
  const stagePrompts: string[] = [];
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      calls.push(input.stagedBuild?.id ?? "unstaged");
      modes.push(input.mode);
      stagePrompts.push(input.prompt);
      await fakeRunner().run(input, emit);
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({
    taskId: "stage-test",
    mode: "build",
    prompt,
    modelId: "test-coder",
    projectContext: { relevantFiles: [], indexedChunkCount: 0 },
  }, (event) => events.push(event));
  const latestCheckpoint = events.filter((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint").at(-1)?.checkpoint;
  assert.deepEqual(calls.slice(0, 4), ["database", "database", "database", "database"]);
  assert.ok(calls.includes("frontend") && calls.includes("tests"), `approved login/read operations should unlock frontend and tests; errors=${events.filter((event) => event.type === "error").map((event) => event.message).join("; ")}; audit=${JSON.stringify(latestCheckpoint?.backendSubtasks?.find((item) => item.id === "audit-history-api"))}`);
  assert.ok(modes.includes("build") && modes.includes("ask"), "Build generation preserves Build mode and uses a compact Ask request only for UI presentation contribution");
  assert.ok(events.some((event) => event.type === "edits" && event.edits.some((edit) => edit.path === "backend/database.py")));
  assert.ok(events.some((event) => event.type === "status" && event.status === "running"), "the parent Build task must leave queued state while a stage is executing");
  assert.ok(events.some((event) => event.type === "status" && event.status === "completed"));
  const checkpoints = events.filter((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint");
  assert.ok(checkpoints.length >= 20, "the PAC, business-operation contracts, dependency-ordered modules and passed stages remain checkpointed");
  assert.equal(checkpoints.at(5)?.checkpoint.databaseSubtasks?.length, 4, "each validated database unit is persisted before the database stage completes");
  assert.equal(checkpoints.at(-1)?.checkpoint.businessOperations?.length, 10, "authentication, transaction, customer-read, manager-read, and audit operation specs are durably checkpointed");
  assert.ok((checkpoints.at(-1)?.checkpoint.uiContracts?.length ?? 0) >= 1, "validated UI contract and selected-model contribution are checkpointed");
  const savedTestSpecification = checkpoints.at(-1)?.checkpoint.testSpecifications?.at(-1);
  assert.ok(savedTestSpecification, "the versioned mandatory test inventory and selected-model contribution are checkpointed");
  assert.equal(savedTestSpecification.modelRequestId, "test-contribution-test-request");
  assert.equal(savedTestSpecification.contributionSha256, createHash("sha256").update(savedTestSpecification.contribution!).digest("hex"));
  assert.ok(JSON.parse(savedTestSpecification.content).cases.some((item: { id: string; origin: string }) => item.id === "auth.login.missing-password" && item.origin === "model"));
  const testPrompts = stagePrompts.filter((value) => /approved test contract|Generate only executable automated test files/i.test(value));
  assert.ok(testPrompts.length >= 2 && testPrompts.every((value) => value.length < 20_000), `test inference uses bounded contract prompts rather than the full source tree: ${testPrompts.map((value) => value.length).join(",")}`);
  assert.deepEqual(checkpoints.at(-1)?.checkpoint.businessOperations?.map((item) => item.operationId), ["auth.login", "customer.register", "customer.submit", "manager.approve", "manager.reject", "customer.listOwn", "manager.listReviewQueue", "customer.getOwn", "manager.getReviewable", "customer.audit.read"]);
  assert.equal(checkpoints[0].checkpoint.projectArchitecture?.schemaVersion, "1.0", "PAC is persisted before the first generation stage");
  assert.equal(checkpoints.at(-1)?.checkpoint.projectArchitecture?.contractHash, checkpoints[0].checkpoint.projectArchitecture?.contractHash);
  assert.match(stagePrompts[0], /Structured task specification.*exact target paths/s);
  assert.match(stagePrompts[0], /backend\/models\.py/);
  assert.doesNotMatch(stagePrompts[0], /frontend\/e2e\/customer-approval\.spec\.ts/);
  const backendCheckpoint = checkpoints.find((event) => event.checkpoint.completedStageIds.at(-1) === "backend")!;
  assert.equal(backendCheckpoint.checkpoint.completedStageIds.at(-1), "backend");
  assert.ok(backendCheckpoint.checkpoint.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert.equal(events.filter((event) => event.type === "error").length, 0);
});

test("resume validates durable artifacts and continues at the first incomplete stage", async () => {
  const calls: string[] = [];
  const runner: AgentRunner = { ...fakeRunner(), async run(input, emit) { calls.push(input.stagedBuild?.id ?? "unstaged"); await fakeRunner().run(input, emit); } };
  const originalEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "checkpoint-source", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => originalEvents.push(event));
  const backendCheckpoint = originalEvents.filter((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint").find((event) => event.checkpoint.completedStageIds.at(-1) === "backend")!.checkpoint;
  calls.length = 0;
  const resumedEvents: TaskEvent[] = [];
  const resumeContext = { relevantFiles: backendCheckpoint.artifacts.filter(({ path }) => path !== "backend/routes/customers.py").map(({ path, content }) => ({ relPath: path, snippet: content.slice(0, 600), content })), indexedChunkCount: 0 };
  await createBuildPipelineRunner(runner).run({ taskId: "checkpoint-resume", mode: "build", prompt, modelId: "test-coder", projectContext: resumeContext, resumeCheckpoint: backendCheckpoint }, (event) => resumedEvents.push(event));
  assert.deepEqual(calls.slice(0, 2), ["transactions", "transactions"], JSON.stringify(resumedEvents.filter((event) => event.type === "error")));
  assert.ok(calls.includes("frontend"), "resume must continue from validated backend outputs into frontend generation");
  assert.ok(resumedEvents.some((event) => event.type === "status" && event.status === "completed"), resumedEvents.filter((event) => event.type === "error").map((event) => event.message).join("; "));
  const legacyCheckpoint = structuredClone(backendCheckpoint);
  legacyCheckpoint.stages = [
    { id: "database", completedAt: new Date().toISOString(), artifactPaths: ["backend/models.py"], validation: "passed" },
    { id: "database", completedAt: new Date().toISOString(), artifactPaths: ["backend/migrations/001.sql"], validation: "passed" },
    { id: "backend", completedAt: new Date().toISOString(), artifactPaths: ["backend/main.py"], validation: "passed" },
  ];
  calls.length = 0;
  const legacyEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "checkpoint-legacy", mode: "build", prompt, modelId: "test-coder", projectContext: resumeContext, resumeCheckpoint: legacyCheckpoint }, (event) => legacyEvents.push(event));
  assert.deepEqual(calls.slice(0, 2), ["transactions", "transactions"], "legacy checkpoint stage records resume from the first incomplete transaction validation");
  assert.ok(calls.includes("frontend"), "a checksum-valid v2 login contract lets repaired legacy stage snapshots reach frontend generation");
  assert.ok(legacyEvents.some((event) => event.type === "status" && event.status === "completed"), legacyEvents.filter((event) => event.type === "error").map((event) => event.message).join("; "));
  calls.length = 0;
  const corrupted = structuredClone(backendCheckpoint);
  corrupted.artifacts[0].sha256 = "0".repeat(64);
  const rejectedEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "checkpoint-corrupt", mode: "build", prompt, modelId: "test-coder", projectContext: resumeContext, resumeCheckpoint: corrupted }, (event) => rejectedEvents.push(event));
  assert.deepEqual(calls, [], "corrupt checkpoint must be rejected before any provider call");
  assert.ok(rejectedEvents.some((event) => event.type === "error" && /checksum mismatch/.test(event.message)));

  const failedTransactionEdits = [{
    path: "backend/routes/customers.py",
    action: "modify" as const,
    content: [
      "from fastapi import APIRouter, Depends",
      "from backend.models import AuditEvent",
      "from backend.auth import require_role",
      "router = APIRouter()",
      "@router.post('/customers/{customer_id}/submit')",
      "async def submit_customer(db, customer):",
      "    async with db.begin():",
      "        customer.status = 'pending'",
      "        db.add(customer)",
      "        db.add(AuditEvent(user_id=1, customer_id=customer.id, action='submitted'))",
      "    return customer",
      "@router.post('/customers/{customer_id}/approve')",
      "async def approve_customer(db, customer, manager=Depends(require_role('manager'))):",
      "    async with db.begin():",
      "        customer.status = 'approved'",
      "        db.add(customer)",
      "        db.add(AuditEvent(user_id=manager.id, customer_id=customer.id, action='approved'))",
      "    return customer",
      "@router.post('/customers/{customer_id}/reject')",
      "async def reject_customer(db, customer, manager=Depends(require_role('manager'))):",
      "    async with db.begin():",
      "        customer.status = 'rejected'",
      "        db.add(customer)",
      "        db.add(AuditEvent(user_id=manager.id, customer_id=customer.id, action='rejected'))",
      "    return customer",
      "@router.get('/customers/{customer_id}/audit')",
      "async def get_audit_history(customer_id: int, db):",
      "    return await db.execute(select(AuditEvent).where(AuditEvent.customer_id == customer_id))",
      "",
    ].join("\n"),
  }];
  const recoverableCheckpoint = {
    ...backendCheckpoint,
    attemptedStages: [{
      id: "transactions",
      attemptedAt: new Date().toISOString(),
      validation: "failed" as const,
      issues: ["prior gate was too strict"],
      repairOutcomes: ["attempt 1: generated files"],
      artifacts: failedTransactionEdits.map((edit) => ({
        ...edit,
        sha256: createHash("sha256").update(edit.content).digest("hex"),
      })),
    }],
  };
  calls.length = 0;
  const attemptEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({
    taskId: "checkpoint-reuse-valid-attempt",
    mode: "build",
    prompt,
    modelId: "test-coder",
    projectContext: resumeContext,
    resumeCheckpoint: recoverableCheckpoint,
  }, (event) => attemptEvents.push(event));
  assert.deepEqual(calls.slice(0, 2), ["transactions", "transactions"], "failed-stage proposals cannot overwrite validated transaction artifacts");
  assert.ok(calls.includes("frontend") && calls.includes("tests"), "a valid transaction recovery continues through frontend and test validation");
  const reused = attemptEvents.find((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint" && event.checkpoint.completedStageIds.includes("transactions"));
  assert.ok(reused, "the revalidated transaction attempt becomes part of the passed checkpoint");

  const incompleteTransaction = [{
    path: "backend/main.py",
    action: "modify" as const,
    content: "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef health(): return {'status': 'ok'}\n",
  }];
  const failedAttemptCheckpoint = {
    ...backendCheckpoint,
    attemptedStages: [{
      id: "transactions",
      attemptedAt: new Date().toISOString(),
      validation: "failed" as const,
      issues: ["requested transaction boundary is missing"],
      repairOutcomes: ["attempt 1: incomplete"],
      artifacts: incompleteTransaction.map((edit) => ({ ...edit, sha256: createHash("sha256").update(edit.content).digest("hex") })),
    }],
  };
  const recoveryCalls: string[] = [];
  const recoveryRunner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      const stageId = input.stagedBuild?.id ?? "unstaged";
      if (stageId === "transactions") {
        recoveryCalls.push(input.stagedBuild?.repair ? "transactions:repair" : "transactions:initial");
        const subtaskId = input.stagedBuild?.subtask?.id ?? "";
        if (subtaskId.startsWith("business-operation-spec:") || subtaskId === "audit-history-api") {
          await fakeRunner().run(input, emit);
        } else if (input.stagedBuild?.repair) {
          emit({ type: "edits", edits: createScopedPassingTransactionFiles() });
        }
        return;
      }
      recoveryCalls.push(stageId);
      await fakeRunner().run(input, emit);
    },
  };
  const recoveryEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(recoveryRunner).run({
    taskId: "checkpoint-focused-repair",
    mode: "build",
    prompt,
    modelId: "test-coder",
    projectContext: resumeContext,
    resumeCheckpoint: failedAttemptCheckpoint,
  }, (event) => recoveryEvents.push(event));
  assert.deepEqual(recoveryCalls.slice(0, 2), ["transactions:initial", "transactions:initial"], "resume reuses validated transaction contracts before downstream stages");
  assert.ok(recoveryCalls.includes("frontend") && recoveryCalls.includes("tests"), "validated authentication and read contracts allow resumed generation to continue");

  const timedOutCheckpoint = {
    ...backendCheckpoint,
    attemptedStages: [{
      id: "transactions",
      attemptedAt: new Date().toISOString(),
      validation: "failed" as const,
      issues: ["Ollama request exceeded its deadline before a complete structured response was received"],
      repairOutcomes: ["attempt 1: provider timeout; incomplete structured response"],
      artifacts: [],
    }],
  };
  recoveryCalls.length = 0;
  await createBuildPipelineRunner(recoveryRunner).run({ taskId: "checkpoint-timeout-repair", mode: "build", prompt, modelId: "test-coder", projectContext: resumeContext, resumeCheckpoint: timedOutCheckpoint }, () => {});
  assert.deepEqual(recoveryCalls.slice(0, 2), ["transactions:initial", "transactions:initial"], "a timeout checkpoint resumes from the validated prefix without replaying completed operations");
  assert.ok(recoveryCalls.includes("frontend") && recoveryCalls.includes("tests"), "validated auth/read contracts allow downstream generation despite an earlier transient timeout record");

  const nearExhaustedCheckpoint = {
    ...timedOutCheckpoint,
    attemptedStages: [{
      ...timedOutCheckpoint.attemptedStages[0],
      repairOutcomes: [
        "attempt 1: started", "attempt 1: incomplete; 1 edit(s)",
        "attempt 2: started", "attempt 2: incomplete; 1 edit(s)",
      ],
    }],
  };
  recoveryCalls.length = 0;
  const finalRepairEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(recoveryRunner).run({ taskId: "checkpoint-final-bounded-repair", mode: "build", prompt, modelId: "test-coder", projectContext: resumeContext, resumeCheckpoint: nearExhaustedCheckpoint }, (event) => finalRepairEvents.push(event));
  assert.deepEqual(recoveryCalls.slice(0, 2), ["transactions:initial", "transactions:initial"], "resume reuses completed transaction operations");
  assert.ok(recoveryCalls.includes("frontend") && recoveryCalls.includes("tests"), "complete auth/read contracts allow downstream generation after recovery");
  assert.equal(recoveryCalls.filter((call) => call.endsWith(":repair")).length, 0, "no repair is requested when the validated operation is not the failing gate");

  const fiveUsed = {
    ...timedOutCheckpoint,
    attemptedStages: [{
      ...timedOutCheckpoint.attemptedStages[0],
      repairOutcomes: Array.from({ length: 5 }, (_, index) => `attempt ${index + 1}: incomplete; 1 edit(s)`),
    }],
  };
  recoveryCalls.length = 0;
  const lastRepairEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(recoveryRunner).run({ taskId: "checkpoint-hard-repair-cap", mode: "build", prompt, modelId: "test-coder", projectContext: resumeContext, resumeCheckpoint: fiveUsed }, (event) => lastRepairEvents.push(event));
  assert.deepEqual(recoveryCalls.slice(0, 2), ["transactions:initial", "transactions:initial"], "prior stage retry history does not cause unnecessary operation regeneration");
  assert.ok(recoveryCalls.includes("frontend") && recoveryCalls.includes("tests"), "prior retry history does not block a valid auth/read frontend contract");
  assert.equal(recoveryCalls.filter((call) => call.endsWith(":repair")).length, 0, "historical retries do not trigger repair of an unrelated auth/UI contract gate");
});

test("resume replays checksummed stage snapshots and removes later invalid artifacts from model context", async () => {
  const sourceEvents: TaskEvent[] = [];
  await createBuildPipelineRunner(fakeRunner()).run({ taskId: "snapshot-source", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => sourceEvents.push(event));
  const checkpoint = sourceEvents.filter((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint").find((event) => event.checkpoint.completedStageIds.at(-1) === "backend")!.checkpoint;
  assert.ok(checkpoint.stages.every((stage) => stage.artifacts), "all passed stages have durable artifact deltas");

  const corruptedButRechecksummed = structuredClone(checkpoint);
  const invalidBackend = corruptedButRechecksummed.artifacts.find((artifact) => artifact.path === "backend/main.py")!;
  invalidBackend.content = "def broken():\n    await connect()\n";
  invalidBackend.sha256 = createHash("sha256").update(invalidBackend.content).digest("hex");
  const backendSnapshot = corruptedButRechecksummed.stages.find((stage) => stage.id === "backend")!.artifacts!.find((artifact) => artifact.path === "backend/main.py")!;
  backendSnapshot.content = invalidBackend.content;
  backendSnapshot.sha256 = invalidBackend.sha256;
  corruptedButRechecksummed.artifactOwnership = buildArtifactOwnershipManifest(corruptedButRechecksummed);
  const context = { relevantFiles: corruptedButRechecksummed.artifacts.map(({ path, content }) => ({ relPath: path, snippet: content.slice(0, 600), content })), indexedChunkCount: 0 };
  let backendContext: Array<{ path: string; content: string }> = [];
  const calls: string[] = [];
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      const stage = input.stagedBuild?.id ?? "unstaged";
      calls.push(stage);
      if (stage === "backend") backendContext = (input.projectContext?.relevantFiles ?? []).map((file) => ({ path: file.relPath, content: file.content ?? file.snippet ?? "" }));
      await fakeRunner().run(input, emit);
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "snapshot-resume", mode: "build", prompt, modelId: "test-coder", projectContext: context, resumeCheckpoint: corruptedButRechecksummed }, (event) => events.push(event));
  assert.deepEqual(calls.slice(0, 3), ["transactions", "transactions", "frontend"], `the platform deterministically rebuilds the invalid backend entrypoint before downstream generation; errors=${JSON.stringify(events.filter((event) => event.type === "error"))}; outputs=${events.filter((event) => event.type === "output").map((event) => event.delta).join(" ")}`);
  assert.ok(calls.includes("frontend"), "the resumed build should reach UI generation once the regenerated backend contracts pass");
  assert.ok(events.some((event) => event.type === "status" && event.status === "completed"), events.filter((event) => event.type === "error").map((event) => event.message).join("; "));
  assert.ok(!backendContext.some((file) => file.path === "backend/main.py" && file.content.includes("await connect()")), `the invalid later artifact is removed from model context after rewind; context=${JSON.stringify(backendContext)}`);
  assert.ok(!backendContext.some((file) => file.path === "backend/main.py"), "an entrypoint rejected by the compiler gate is omitted so router registration recreates it from the PAC");
  assert.ok(!backendContext.some((file) => file.path === "frontend/package.json"), "unrelated scaffold files are excluded from the backend model prompt");
  assert.ok(events.some((event) => event.type === "output" && /(?:Resuming at that stage:|Reopening the backend integration checkpoint)/.test(event.delta)), "the resume path must explain why backend integration was reopened");
});

test("checkpoint preserves original workspace checksums for generated modifications", async () => {
  const original = "from fastapi import FastAPI\napp = FastAPI()\n";
  const scaffold = createPassingStageFiles("scaffold");
  const stagedArtifacts = scaffold.map((edit) => ({ ...edit, sha256: createHash("sha256").update(edit.content).digest("hex") }));
  const checkpoint = {
    version: 1 as const,
    taskId: "checkpoint-original-base",
    requirementsHash: createHash("sha256").update(prompt).digest("hex"),
    provider: "fake-coder",
    modelId: "test-coder",
    completedStageIds: ["scaffold"],
    stages: [{ id: "scaffold", completedAt: new Date().toISOString(), artifactPaths: scaffold.map((edit) => edit.path), artifacts: stagedArtifacts, validation: "passed" as const }],
    artifacts: stagedArtifacts,
    baseFiles: [{ path: "backend/main.py", sha256: createHash("sha256").update(original).digest("hex") }],
    pendingStageIds: ["database", "backend", "transactions", "frontend", "tests"],
    pendingDependencies: [],
    repairHistory: [],
    projectArchitecture: resolveProjectArchitecture(prompt, []),
    updatedAt: new Date().toISOString(),
  };
  const contextFiles = scaffold
    .filter((edit) => edit.path !== "backend/main.py")
    .map((edit) => ({ relPath: edit.path, snippet: edit.content.slice(0, 600), content: edit.content }));
  contextFiles.push({ relPath: "backend/main.py", snippet: original, content: original });
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(fakeRunner()).run({
    taskId: "checkpoint-original-base",
    mode: "build",
    prompt,
    modelId: "test-coder",
    projectContext: { relevantFiles: contextFiles, indexedChunkCount: 0 },
    resumeCheckpoint: checkpoint,
  }, (event) => events.push(event));
  const checkpointEvent = events.find((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint" && event.checkpoint.completedStageIds.includes("scaffold"));
  assert.ok(checkpointEvent, `resume should preserve the validated scaffold checkpoint; errors=${events.filter((event) => event.type === "error").map((event) => event.message).join("; ")}`);
  const firstCheckpoint = checkpointEvent.checkpoint;
  assert.equal(firstCheckpoint.baseFiles.find((file) => file.path === "backend/main.py")?.sha256, createHash("sha256").update(original).digest("hex"));
  assert.equal(firstCheckpoint.completedStageIds[0], "scaffold");
  assert.equal(firstCheckpoint.artifacts.find((file) => file.path === "backend/main.py")?.action, "modify");
});

test("a create label for a fully shown existing file is normalized to modify without permitting blind overwrite", () => {
  const replacement = [{ path: "backend/auth.py", action: "create" as const, content: "new full contents" }];
  const normalized = combineBuildEdits([], replacement, new Set(["backend/auth.py"]));
  assert.deepEqual(normalized.actionIssues, []);
  assert.equal(normalized.edits[0].action, "modify");
  assert.equal(normalized.edits[0].content, "new full contents");

  const snippetOnly = combineBuildEdits([], replacement, new Set());
  assert.equal(snippetOnly.edits[0].action, "create");
});

test("resume normalizes later-stage modify labels against the original workspace manifest", () => {
  const replayed: ProposedEdit[] = [
    { path: "backend/routes/auth.py", action: "modify", content: "created during stage 2, then modified during stage 3" },
    { path: "backend/models.py", action: "create", content: "model existed in base workspace" },
  ];
  const normalized = normalizeReplayedArtifactActions(replayed, new Set(["backend/models.py"]));
  assert.deepEqual(normalized.map(({ path, action }) => ({ path, action })), [
    { path: "backend/routes/auth.py", action: "create" },
    { path: "backend/models.py", action: "modify" },
  ]);
});

test("resume repairs legacy stage deltas from the complete checksummed artifact manifest", () => {
  const digest = (content: string) => createHash("sha256").update(content).digest("hex");
  const checkpoint = {
    version: 1 as const, taskId: "legacy-deltas", requirementsHash: "r", provider: "test", modelId: "m",
    completedStageIds: ["scaffold", "backend"], pendingStageIds: ["transactions"], pendingDependencies: [], baseFiles: [],
    projectArchitecture: resolveProjectArchitecture(prompt), updatedAt: new Date().toISOString(), repairHistory: [], attemptedStages: [],
    stages: [
      { id: "scaffold", completedAt: "now", artifactPaths: ["backend/main.py"], validation: "passed" as const, artifacts: [{ path: "backend/main.py", action: "create" as const, content: "old", sha256: digest("old") }] },
      { id: "backend", completedAt: "now", artifactPaths: ["backend/main.py"], validation: "passed" as const, artifacts: [{ path: "backend/main.py", action: "modify" as const, content: "latest", sha256: digest("latest") }] },
    ],
    artifacts: [
      { path: "backend/main.py", action: "create" as const, content: "latest", sha256: digest("latest") },
      { path: "backend/auth.py", action: "create" as const, content: "auth output", sha256: digest("auth output") },
    ],
  } as NonNullable<Parameters<typeof repairIncompleteCheckpointStageSnapshot>[0]>;
  const repaired = repairIncompleteCheckpointStageSnapshot(checkpoint);
  assert.equal(repaired.changed, true);
  assert.deepEqual(repaired.checkpoint.stages.at(-1)?.artifacts?.map((artifact) => artifact.path), ["backend/auth.py", "backend/main.py"]);
  assert.equal(repaired.checkpoint.artifacts[1].content, "auth output", "the source artifact manifest is preserved unchanged");
  const corrupt = structuredClone(checkpoint);
  corrupt.artifacts[1].sha256 = "0".repeat(64);
  assert.equal(repairIncompleteCheckpointStageSnapshot(corrupt).changed, false, "an invalid manifest is never used to rewrite snapshots");
});

test("Python AST and compileall gate rejects await in a synchronous handler and accepts async handlers", async () => {
  const invalid = await validatePythonSources(new Map([[
    "backend/main.py", { content: "def startup():\n    await connect()\n", action: "create" },
  ]]));
  assert.ok(invalid.some((issue) => issue.includes("Python AST/compileall validation failed")));
  const valid = await validatePythonSources(new Map([[
    "backend/main.py", { content: "async def startup():\n    await connect()\n", action: "create" },
  ]]));
  assert.deepEqual(valid, []);
});

test("Python symbol gate catches the reproduced undefined SQLAlchemy select reference", async () => {
  const files = new Map([[
    "backend/routes/customers.py", { action: "create" as const, content: "from fastapi import APIRouter\nrouter = APIRouter()\nasync def create_customer():\n    return select(Customer)\n" },
  ]]);
  const issues = await validatePythonModuleSymbols(files);
  assert.ok(issues.some((issue) => issue.includes("unresolved global name 'select'")));
  const fixed = new Map([[
    "backend/routes/customers.py", { action: "create" as const, content: "from fastapi import APIRouter\nfrom sqlalchemy import select\nfrom backend.models import Customer\nrouter = APIRouter()\nasync def create_customer():\n    return select(Customer)\n" },
  ]]);
  assert.deepEqual(await validatePythonModuleSymbols(fixed), []);
});

test("Python runtime gate catches Enum member mismatches and platform repair uses declared spelling", async () => {
  const model = "from enum import Enum as PyEnum\nclass ReviewStatus(PyEnum):\n    pending = 'pending'\n    approved = 'approved'\n";
  const route = "from backend.models import ReviewStatus\ndef list_items():\n    return ReviewStatus.PENDING\n";
  const files = new Map([
    ["backend/models.py", { action: "create" as const, content: model }],
    ["backend/routes/items.py", { action: "create" as const, content: route }],
  ]);
  const issues = await validatePythonModuleSymbols(files);
  assert.ok(issues.some((issue) => issue.includes("missing Enum member ReviewStatus.PENDING")));
  const repaired = repairPythonEnumMemberReferences([{ path: "backend/routes/items.py", action: "create", content: route }], files);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/items.py"]);
  assert.match(repaired.edits[0].content, /ReviewStatus\.pending/);
  const validated = new Map(files);
  validated.set("backend/routes/items.py", { action: "create", content: repaired.edits[0].content });
  assert.deepEqual(await validatePythonModuleSymbols(validated), []);
});

test("focused deterministic repair promotes only the invalid FastAPI route to async", () => {
  const edits = [{ path: "backend/routes/customers.py", action: "create" as const, content: [
    "@router.post('/customers')",
    "def create_customer():",
    "    return await Customer.create()",
    "",
    "@router.get('/health')",
    "def health():",
    "    return {'status': 'ok'}",
  ].join("\n") }];
  const repaired = promoteAwaitingPythonRoutes(edits, ["backend/routes/customers.py uses await outside an async def; Python will fail to import this module"]);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/customers.py"]);
  assert.match(repaired.edits[0].content, /async def create_customer/);
  assert.match(repaired.edits[0].content, /def health\(\)/);
  assert.deepEqual(promoteAwaitingPythonRoutes(edits, ["backend/main.py uses await outside an async def"]), { edits, changedPaths: [] });
});

test("await-in-sync FastAPI route repair recognizes the Python compiler traceback", () => {
  const edits = [{ path: "backend/routes/customers.py", action: "create" as const, content: [
    "@router.post('/customers')",
    "def create_customer():",
    "    await db.commit()",
  ].join("\n") }];
  const diagnostic = "Python AST/compileall validation failed (python3):\n  File \"/tmp/mobiusx-python-gate/backend/routes/customers.py\", line 3\n    await db.commit()\n    ^^^^^^^^^^^^^^^^\nSyntaxError: 'await' outside async function";
  const repaired = promoteAwaitingPythonRoutes(edits, [diagnostic]);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/customers.py"]);
  assert.match(repaired.edits[0].content, /async def create_customer/);
});

test("await repair handles multiline route helpers even when a decorator alias is absent", () => {
  const content = "def load_customer(\n    customer_id: int,\n):\n    return await db.get(customer_id)\n";
  const diagnostic = "File \"/tmp/backend/routes/customers.py\", line 4\nSyntaxError: 'await' outside async function";
  const repaired = promoteAwaitingPythonRoutes([{ path: "backend/routes/customers.py", action: "modify", content }], [diagnostic]);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/customers.py"]);
  assert.match(repaired.edits[0].content, /async def load_customer/);
});

test("known Python import repair adds missing SQLAlchemy route interfaces without duplicating imports", () => {
  const edits = [{ path: "backend/routes/customers.py", action: "create" as const, content: [
    "from sqlalchemy import IntegrityError",
    "def get_customer(db: AsyncSession):",
    "    return select(Customer)",
  ].join("\n") }];
  const repaired = repairKnownPythonNameErrors(edits, []);
  assert.deepEqual(repaired.changedPaths, ["backend/routes/customers.py"]);
  assert.match(repaired.edits[0].content, /from sqlalchemy\.ext\.asyncio import AsyncSession/);
  assert.match(repaired.edits[0].content, /from sqlalchemy import select/);
  assert.deepEqual(repairKnownPythonNameErrors(repaired.edits, []), { edits: repaired.edits, changedPaths: [] });
});

test("TypeScript syntax gate rejects malformed TSX and accepts valid JSX", () => {
  assert.ok(validateTypeScriptSyntax(new Map([[
    "frontend/app/page.tsx", { content: "export default function Page() { return <main>broken</div> }", action: "create" },
  ]])).some((issue) => issue.includes("TypeScript syntax error")));
  assert.deepEqual(validateTypeScriptSyntax(new Map([[
    "frontend/app/page.tsx", { content: "export default function Page() { return <main>ready</main> }", action: "create" },
  ]])), []);
});

test("frontend runtime gate plans bounded install and build steps without installing in unit tests", async () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ name: "gate-fixture", version: "1.0.0", scripts: { build: "vite build" }, devDependencies: { typescript: "^5.6.3" } }), action: "create" as const }],
    ["frontend/src/main.tsx", { content: "export const ready = true;\n", action: "create" as const }],
    ["backend/main.py", { content: "from fastapi import FastAPI\napp = FastAPI()\n", action: "create" as const }],
  ]);
  const commands: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
  assert.deepEqual(await validateFrontendBuild(files, {
    runCommand: async (command, args, _cwd, timeoutMs) => { commands.push({ command, args, timeoutMs }); },
  }), []);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].args, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"]);
  assert.match(commands[0].command, /npm$/);
  assert.match(commands[1].command, /node_modules[\\/]\.bin[\\/]tsc(?:\.cmd)?$/);
  assert.deepEqual(commands[1].args, ["--noEmit", "--pretty", "false", "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "node", "--jsx", "react-jsx", "--esModuleInterop", "--allowSyntheticDefaultImports", "src/main.tsx"]);
  assert.deepEqual(commands[2].args, ["run", "build"]);
  assert.match(commands[2].command, /npm$/);
  assert.ok(commands.every((command) => command.timeoutMs > 0 && command.timeoutMs <= 12 * 60_000));
});

test("frontend resume materializes checkpoint file casing from original paths", async () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { typescript: "^5.6.3" } }), action: "create" as const, originalPath: "frontend/package.json" }],
    ["frontend/src/app.tsx", { content: "export default function App() { return <main />; }", action: "create" as const, originalPath: "frontend/src/App.tsx" }],
    ["frontend/src/main.tsx", { content: "import App from './App'; export default App;", action: "create" as const, originalPath: "frontend/src/main.tsx" }],
  ]);
  let sourceNames: string[] = [];
  assert.deepEqual(await validateFrontendBuild(files, {
    runCommand: async (_command, _args, cwd) => {
      if (!sourceNames.length) sourceNames = await readdir(join(cwd, "src"));
    },
  }), []);
  assert.ok(sourceNames.includes("App.tsx"));
  assert.ok(!sourceNames.includes("app.tsx"));
});

test("frontend runtime gate rejects TypeScript projects without a declared compiler", async () => {
  const files = new Map([
    ["frontend/package.json", { content: JSON.stringify({ scripts: { build: "node --version" } }), action: "create" as const }],
    ["frontend/app/page.tsx", { content: "export default function Home() { return <main />; }", action: "create" as const }],
  ]);
  assert.deepEqual(await validateFrontendBuild(files), ["frontend uses TypeScript but package.json does not declare TypeScript for semantic checking"]);
});

test("resume frontend validation honors the immutable PAC framework when requirements mention alternative frameworks", () => {
  const prompt = "Build a React or Next.js customer onboarding frontend from the approved project checkpoint.";
  const files = new Map([["frontend/package.json", { content: JSON.stringify({ scripts: { dev: "vite", build: "tsc -b && vite build" }, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } }), action: "create" as const }]]);
  assert.ok(!validateBuildStage("scaffold", prompt, files, "react").some((issue) => /must declare Next\.js/.test(issue)), "a React PAC must not be rewound because the requirements mention Next.js as an alternative");
  assert.ok(validateBuildStage("scaffold", prompt, files, "nextjs").some((issue) => /must declare Next\.js/.test(issue)), "a Next.js PAC must still enforce its declared framework dependencies");
});

test("a failed later stage leaves the already validated draft inspectable but does not expose failed-stage edits", async () => {
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      if (input.stagedBuild?.id !== "transactions") {
        await fakeRunner().run(input, emit);
        return;
      }
      emit({ type: "edits", edits: [{
        path: "backend/main.py",
        action: "modify",
        content: "@app.post('/customers/approve')\ndef approve(db, customer):\n    with db.begin():\n        db.add(customer)\n    return {'status': 'approved'}\n",
      }] });
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "partial-draft", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  const editEvents = events.filter((event): event is Extract<TaskEvent, { type: "edits" }> => event.type === "edits");
  assert.ok(editEvents.length >= 3, "each validated stage should publish the accumulated draft");
  const finalDraft = editEvents.at(-1)?.edits ?? [];
  assert.ok(finalDraft.some((edit) => edit.path === "frontend/package.json"));
  assert.ok(!finalDraft.some((edit) => edit.path === "backend/main.py" && edit.content.includes("status': 'approved")), "unvalidated transaction-stage changes must not be proposed");
  const failedCheckpoint = events.filter((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint").at(-1)?.checkpoint;
  assert.equal(failedCheckpoint?.completedStageIds.at(-1), "backend", "the resume boundary remains the last passed stage");
  const attempted = failedCheckpoint?.attemptedStages?.at(-1);
  assert.equal(attempted?.id, "transactions");
  assert.equal(attempted?.validation, "failed");
  assert.ok(attempted?.issues.some((issue) => issue.includes("unapproved generated path backend/main.py")));
  assert.ok(attempted?.artifacts.some((artifact) => artifact.path === "backend/main.py" && /^[a-f0-9]{64}$/.test(artifact.sha256)), "failed-stage content is checksummed for inspection but excluded from validated artifacts");
  assert.ok(events.some((event) => event.type === "error" && event.message.includes("Build stopped at transactions")));
  assert.ok(!events.some((event) => event.type === "status" && event.status === "completed"));
});

test("focused stage repair stays in Build mode so Ollama structured output remains enabled", async () => {
  let scaffoldCalls = 0;
  const modes: string[] = [];
  const repairFlags: boolean[] = [];
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      modes.push(input.mode);
      repairFlags.push(input.stagedBuild?.repair === true);
      if (input.stagedBuild?.id !== "database") {
        await fakeRunner().run(input, emit);
        return;
      }
      scaffoldCalls += 1;
      const subtask = input.stagedBuild?.subtask?.id;
      if (subtask === "customer-entity" && !input.stagedBuild?.repair) {
        emit({ type: "edits", edits: [{ path: "backend/models.py", action: "create", content: "from backend.database import Base\nclass Customer(Base):\n    __tablename__ = 'customers'\n" }] });
        return;
      }
      emit({ type: "edits", edits: createPassingStageFiles("database", subtask) });
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner, 15_000).run({ taskId: "build-repair-contract", mode: "build", prompt: "Build a React frontend, FastAPI backend, and PostgreSQL application with login, approvals, audit history, and Playwright tests.", modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  assert.deepEqual(modes.slice(0, 2), ["build", "build"]);
  assert.deepEqual(repairFlags.slice(0, 2), [false, true], "the provider can keep Build schema while applying its shorter repair deadline");
  assert.ok(events.some((event) => event.type === "edits"), "the focused repair should pass the database gate and let generation advance");
  assert.ok(events.some((event) => event.type === "status" && (event.status === "completed" || event.status === "failed")), "the repaired staged Build settles in a terminal state");
});

test("greenfield scaffold stages use the validated adapter without model inference", () => {
  const architecture = resolveProjectArchitecture(prompt, []);
  const blank = { relevantFiles: [], indexedChunkCount: 0 };
  assert.equal(shouldUseValidatedScaffoldOnly("scaffold", false, prompt, blank, architecture), true);
  assert.equal(shouldUseValidatedScaffoldOnly("database", false, prompt, blank, architecture), false);
  assert.equal(shouldUseValidatedScaffoldOnly("scaffold", true, prompt, blank, architecture), false, "resume still revalidates the durable scaffold checkpoint");
  assert.equal(shouldUseValidatedScaffoldOnly("scaffold", false, prompt, { ...blank, indexedChunkCount: 1 }, architecture), false, "existing projects remain model-driven");
  const scaffold = ensureArchitectureScaffold("scaffold", prompt, architecture, [], blank);
  const frontend = scaffold.find((edit) => edit.path === "frontend/package.json")?.content ?? "{}";
  assert.match(frontend, /vite/);
  assert.match(frontend, /test:e2e/);
  assert.ok(scaffold.some((edit) => edit.path === "frontend/src/main.tsx"));
});

test("PostgreSQL scaffold adds a generic safe database service and fail-stops on an invalid backend auth module", async () => {
  const calls: string[] = [];
  const runner: AgentRunner = { ...fakeRunner(), async run(input, emit) {
    calls.push(input.stagedBuild?.id ?? "unstaged");
    if (input.stagedBuild?.id === "backend" && input.stagedBuild.subtask?.id === "authentication") {
      emit({ type: "edits", edits: [{ path: "backend/auth.py", action: "create", content: "# missing required authentication symbols\n" }] });
      return;
    }
    if (input.stagedBuild?.id === "frontend" && /Generate one versioned UI contract/.test(input.prompt)) {
      await fakeRunner().run(input, emit);
      return;
    }
    emit({ type: "edits", edits: createPassingStageFiles(input.stagedBuild?.id ?? "scaffold", input.stagedBuild?.subtask?.id).filter((edit) => edit.path !== "docker-compose.yml") });
  } };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner, 60_000).run({ taskId: "compose-repair", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  assert.deepEqual(calls.slice(0, 4), ["database", "database", "database", "database"]);
  assert.ok(calls.includes("backend") && !calls.includes("frontend"), "the invalid backend auth module must stop before frontend generation");
  const edits = events.find((event): event is Extract<TaskEvent, { type: "edits" }> => event.type === "edits")?.edits ?? [];
  const compose = edits.find((edit) => edit.path === "docker-compose.yml")?.content ?? "";
  assert.match(compose, /image: postgres:16-alpine/);
  assert.match(compose, /127\.0\.0\.1:5432:5432/);
  assert.match(compose, /healthcheck:/);
  assert.ok(events.some((event) => event.type === "generation_checkpoint"), "successful recovery must persist a first stage checkpoint");
  assert.ok(events.some((event) => event.type === "error"), "a failed backend contract must be explicit and fail closed before frontend generation");
});

test("credential repair explicitly removes literal secrets and requires environment configuration", async () => {
  let repairPrompt = "";
  let backendCalls = 0;
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      if (input.stagedBuild?.id !== "backend" || input.stagedBuild?.subtask?.id !== "authentication") {
        await fakeRunner().run(input, emit);
        return;
      }
      backendCalls += 1;
      if (input.stagedBuild.repair) repairPrompt = input.prompt;
      const auth = createPassingStageFiles("backend", "authentication")[0];
      emit({ type: "edits", edits: [{ ...auth, content: input.stagedBuild.repair ? auth.content : auth.content.replace("oauth2_scheme =", "JWT_SECRET = 'hardcoded-development-secret'\noauth2_scheme =") }] });
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "credential-repair", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  assert.match(repairPrompt, /Remove every literal secret/);
  assert.match(repairPrompt, /fail clearly when a required secret is unset/);
  assert.ok(events.some((event) => event.type === "step" && event.step.label.includes("Stage 3/6 · Backend APIs and authentication · passed")));
});

test("manager operation repair is scoped to its contract artifact", async () => {
  let repairPrompt = "";
  let repairTargetPaths: string[] = [];
  const architecture = resolveProjectArchitecture(prompt);
  const valid = operationSpecForTest(architecture, "manager.approve");
  const invalid = { ...structuredClone(valid), concurrency: undefined };
  const operationPath = ".mobiusx/operations/manager-approve.v1.json";
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      if (input.stagedBuild?.id === "transactions" && input.stagedBuild?.subtask?.id === "business-operation-spec:manager.approve") {
        if (input.stagedBuild.repair) {
          repairPrompt = input.prompt;
          repairTargetPaths = input.stagedBuild.subtask.targetPaths;
        }
        emit({ type: "edits", edits: [{ path: operationPath, action: "create", content: JSON.stringify(input.stagedBuild.repair ? valid : invalid) }] });
        return;
      }
      await fakeRunner().run(input, emit);
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "transaction-repair-scope", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  assert.deepEqual(repairTargetPaths, [operationPath]);
  assert.match(repairPrompt, /\.mobiusx\/operations\/manager-approve\.v1\.json/);
  assert.match(repairPrompt, /row-lock/);
  assert.doesNotMatch(repairPrompt, /frontend\/package\.json/);
  assert.ok(events.some((event) => event.type === "edits" && event.edits.some((edit) => edit.path === "frontend/package.json")), "previously validated draft remains inspectable");
});

test("no-edit database repairs stay bounded and preserve an incomplete stage without proposing it as complete", async () => {
  let scaffoldCalls = 0;
  const stageIds: string[] = [];
  const prompts: string[] = [];
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      stageIds.push(input.stagedBuild?.id ?? "none");
      if (input.stagedBuild?.id !== "database") {
        await fakeRunner().run(input, emit);
        return;
      }
      scaffoldCalls += 1;
      if (scaffoldCalls === 1) {
        emit({ type: "edits", edits: [
          { path: "backend/requirements.txt", action: "modify", content: "fastapi\nsqlalchemy\nalembic\nasyncpg\n" },
          { path: "backend/models.py", action: "create", content: "from sqlalchemy.orm import DeclarativeBase\nclass Base(DeclarativeBase): pass\n" },
          { path: "backend/migrations/versions/0001_initial.py", action: "create", content: "from alembic import op\nrevision = '0001'\ndown_revision = None\n" },
        ] });
      } else if (scaffoldCalls === 2) {
        prompts.push(input.prompt);
      } else {
        prompts.push(input.prompt);
        emit({ type: "edits", edits: [
          { path: "backend/requirements.txt", action: "modify", content: "fastapi\nsqlalchemy\nalembic\nasyncpg\n" },
          { path: "backend/models.py", action: "create", content: "from sqlalchemy.orm import DeclarativeBase\nclass Base(DeclarativeBase): pass\n" },
          { path: "backend/migrations/versions/0001_initial.py", action: "create", content: "from alembic import op\nrevision = '0001'\ndown_revision = None\n" },
        ] });
      }
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "bounded-repair-retry", mode: "build", prompt: "Build a React frontend, FastAPI backend, and PostgreSQL application with login, approvals, audit history, and Playwright tests.", modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  assert.ok(scaffoldCalls >= 2 && scaffoldCalls <= 5, `database subtasks and at most one focused repair should stay bounded; calls=${scaffoldCalls}, stageIds=${stageIds.join(",")}, trace=${events.filter((event) => event.type === "output" || event.type === "error").map((event) => event.type === "output" ? event.delta : event.message).join(" ")}`);
  assert.ok(prompts.some((repairPrompt) => /Exact diagnostics/.test(repairPrompt) && /customer-entity/.test(repairPrompt)));
  assert.ok(events.some((event) => event.type === "error"), `an unresolved stage must be reported as incomplete; events=${events.filter((event) => ["error", "output", "status"].includes(event.type)).map((event) => event.type === "output" ? event.delta : JSON.stringify(event)).join("\n")}`);
  const proposedPaths = events.filter((event): event is Extract<TaskEvent, { type: "edits" }> => event.type === "edits").flatMap((event) => event.edits.map((edit) => edit.path));
  assert.ok(!proposedPaths.includes("backend/models.py"), "failed database-stage model edits must not be promoted");
  const checkpoint = events.filter((event) => event.type === "generation_checkpoint").at(-1);
  assert.ok(checkpoint && checkpoint.type === "generation_checkpoint");
  assert.ok(checkpoint.checkpoint.attemptedStages?.some((attempt) => attempt.id === "database" && attempt.artifacts.length > 0), "the failed database draft remains available in the checkpoint for inspection");
});

test("manager operation spec stops after an identical no-progress repair", async () => {
  const repairPrompts: string[] = [];
  const architecture = resolveProjectArchitecture(prompt);
  const valid = operationSpecForTest(architecture, "manager.approve");
  const invalid = { ...structuredClone(valid), concurrency: undefined };
  const operationPath = ".mobiusx/operations/manager-approve.v1.json";
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      if (input.stagedBuild?.id === "transactions" && input.stagedBuild?.subtask?.id === "business-operation-spec:manager.approve") {
        if (input.stagedBuild.repair) repairPrompts.push(input.prompt);
        emit({ type: "edits", edits: [{ path: operationPath, action: "create", content: JSON.stringify(invalid) }] });
        return;
      }
      await fakeRunner().run(input, emit);
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "duplicate-repair", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  const failed = events.filter((event) => event.type === "generation_checkpoint").at(-1);
  assert.ok(failed && failed.type === "generation_checkpoint");
  const attempts = failed.checkpoint.attemptedStages?.filter((attempt) => attempt.id === "transactions") ?? [];
  assert.ok(repairPrompts.length <= 1, "an identical manager operation contract is rejected without another model call");
  assert.ok(repairPrompts[0]?.includes("transaction"));
  assert.ok(events.some((event) => event.type === "step" && event.step.label.includes("repeated no-progress operation repair")), "an identical model repair is rejected and surfaced as no progress");
  assert.ok(attempts.some((attempt) => attempt.issues.some((issue) => /must lock the customer row/.test(issue))), "the persisted attempt retains the specific concurrency contract failure");
  assert.ok(events.some((event) => event.type === "error" && event.message.includes("Build stopped at transactions")));
});


test("provider header timeouts stop repeated no-response repair calls", async () => {
  let databaseCalls = 0;
  const requestTrace: string[] = [];
  const runner: AgentRunner = {
    ...fakeRunner(),
    async run(input, emit) {
      if (input.stagedBuild?.id !== "database") {
        await fakeRunner().run(input, emit);
        return;
      }
      databaseCalls += 1;
      requestTrace.push(`${input.stagedBuild?.subtask?.id}:${input.stagedBuild?.repair === true}`);
      if (input.stagedBuild.repair) emit({ type: "error", message: "Ollama response headers exceeded 900000ms" });
    },
  };
  const events: TaskEvent[] = [];
  await createBuildPipelineRunner(runner).run({ taskId: "timeout-no-repeat", mode: "build", prompt, modelId: "test-coder", projectContext: { relevantFiles: [], indexedChunkCount: 0 } }, (event) => events.push(event));
  assert.equal(databaseCalls, 2, `one initial generation and one repair timeout must not trigger more identical no-response calls: ${requestTrace.join(",")}`);
  const checkpoints = events.filter((event): event is Extract<TaskEvent, { type: "generation_checkpoint" }> => event.type === "generation_checkpoint");
  const failed = checkpoints.at(-1)?.checkpoint.attemptedStages?.find((attempt) => attempt.id === "database");
  assert.ok(failed?.repairOutcomes.some((outcome) => /database subtask (?:repair budget exhausted|failed its bounded repair gate)/.test(outcome)));
  assert.ok(failed?.issues.some((issue) => /response headers exceeded/.test(issue)));
});

test("staged generation stops a runner that ignores cancellation at the bounded pipeline deadline", async () => {
  let signalAborted = false;
  const stalled: AgentRunner = {
    ...fakeRunner(),
    async run(input) {
      input.signal?.addEventListener("abort", () => { signalAborted = true; }, { once: true });
      await new Promise<void>(() => {});
    },
  };
  const events: TaskEvent[] = [];
  const started = Date.now();
  await createBuildPipelineRunner(stalled, 1_000).run({
    taskId: "deadline-test",
    mode: "build",
    prompt,
    modelId: "test-coder",
    projectContext: { relevantFiles: [], indexedChunkCount: 0 },
  }, (event) => events.push(event));
  // PAC construction and stage prompt preparation can take over a second on
  // a loaded CI/macOS host; assert bounded settlement without coupling this
  // cancellation regression to a tight scheduler timing threshold.
  assert.ok(Date.now() - started < 5_000, "the parent Build task should settle when its deadline expires");
  assert.equal(signalAborted, true, "the in-flight provider must receive cancellation");
  assert.ok(events.some((event) => event.type === "status" && event.status === "failed"));
  assert.ok(events.some((event) => event.type === "error" && /end-to-end deadline/.test(event.message)));
  assert.ok(!events.some((event) => event.type === "status" && event.status === "completed"));
});

test("cancelling a staged Build immediately cancels the provider and parent task", async () => {
  let signalAborted = false;
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  const stalled: AgentRunner = {
    ...fakeRunner(),
    async run(input) {
      markProviderStarted();
      input.signal?.addEventListener("abort", () => { signalAborted = true; }, { once: true });
      await new Promise<void>(() => {});
    },
  };
  const controller = new AbortController();
  const events: TaskEvent[] = [];
  const run = createBuildPipelineRunner(stalled).run({
    taskId: "cancel-test",
    mode: "build",
    prompt,
    modelId: "test-coder",
    signal: controller.signal,
    projectContext: { relevantFiles: [], indexedChunkCount: 0 },
  }, (event) => events.push(event));
  let startDeadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    providerStarted,
    new Promise<never>((_resolve, reject) => {
      startDeadline = setTimeout(() => reject(new Error("Build provider did not start before cancellation test deadline")), 5_000);
      startDeadline.unref();
    }),
  ]);
  if (startDeadline) clearTimeout(startDeadline);
  controller.abort();
  await run;
  assert.equal(signalAborted, true);
  assert.ok(events.some((event) => event.type === "status" && event.status === "cancelled"));
  assert.ok(!events.some((event) => event.type === "status" && event.status === "completed"));
});

test("UI contribution checkpoint reuse requires matching PAC/model and valid contract/contribution checksums", () => {
  const content = '{"schemaVersion":"1.0"}';
  const contribution = '{"title":"My applications"}';
  const record = {
    architectureHash: "pac-hash",
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    modelId: "qwen2.5-coder:7b-instruct-q4_K_M",
    modelRequestId: "request-1",
    modelResponse: contribution,
    contribution,
    contributionSha256: createHash("sha256").update(contribution).digest("hex"),
    createdAt: new Date().toISOString(),
  };
  assert.equal(hasReusableUiContributionCheckpoint(record, "pac-hash", record.modelId), true);
  assert.equal(hasReusableUiContributionCheckpoint(record, "other-pac", record.modelId), false);
  assert.equal(hasReusableUiContributionCheckpoint(record, "pac-hash", "different-model"), false);
  assert.equal(hasReusableUiContributionCheckpoint({ ...record, sha256: "corrupt" }, "pac-hash", record.modelId), false);
  assert.equal(hasReusableUiContributionCheckpoint({ ...record, contributionSha256: "corrupt" }, "pac-hash", record.modelId), false);
  assert.equal(hasReusableUiContributionCheckpoint({ ...record, modelRequestId: undefined }, "pac-hash", record.modelId), false);
  const traced = { ...record, requestMetadata: { requestId: record.modelRequestId, provider: "ollama", endpoint: "http://127.0.0.1:11434/api/chat", modelId: record.modelId, promptSha256: "a".repeat(64), promptCharacters: 20, serializedRequestRedacted: { model: record.modelId, stream: true, options: { temperature: 0.2 }, messages: [{ role: "user", contentBytes: 20, contentSha256: "b".repeat(64) }] } } };
  assert.equal(hasReusableUiContributionCheckpoint(traced, "pac-hash", record.modelId), true);
  assert.equal(hasReusableUiContributionCheckpoint({ ...traced, requestMetadata: { ...traced.requestMetadata, promptSha256: "bad" } }, "pac-hash", record.modelId), false);
  assert.equal(hasReusableUiContributionCheckpoint({ ...traced, requestMetadata: { ...traced.requestMetadata, serializedRequestRedacted: { ...traced.requestMetadata.serializedRequestRedacted, messages: [{ ...traced.requestMetadata.serializedRequestRedacted.messages[0], content: "private prompt" }] } } }, "pac-hash", record.modelId), false);
});
