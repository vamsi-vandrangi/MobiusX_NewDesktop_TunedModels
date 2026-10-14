import { test } from "node:test";
import assert from "node:assert/strict";
import { approveReviewScopeArchitectureChange, resolveProjectArchitecture, validateProjectArchitectureContract, architectureTaskSpecification, validateArchitectureStage } from "../src/projectArchitecture.js";
import { ensureArchitectureScaffold, ensureWebDeploymentScaffold } from "../src/buildPipeline.js";
import type { ProposedEdit } from "@mobiusx/protocol";

const prompt = "Build a React frontend, FastAPI backend, PostgreSQL app with SQLAlchemy and Alembic migrations and Playwright browser tests.";

test("PAC is a small, stable versioned JSON contract with an integrity hash", () => {
  const first = resolveProjectArchitecture(prompt, []);
  const second = resolveProjectArchitecture(prompt, []);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, "1.0");
  assert.deepEqual(first.stack, { backend: "fastapi", orm: "sqlalchemy", migrations: "alembic", database: "postgresql", frontend: "react", e2e: "playwright" });
  assert.ok(first.modules.some((module) => module.path === "backend/database.py" && module.provides.includes("get_db")));
  assert.deepEqual(validateProjectArchitectureContract(first), []);
  assert.match(validateProjectArchitectureContract({ ...first, stack: { ...first.stack, orm: "tortoise" } }).join(" "), /requires the approved SQLAlchemy/);
  assert.match(validateProjectArchitectureContract({ ...first, contractHash: "wrong" }).join(" "), /integrity hash mismatch/);
});

test("approved review-scope evolution is additive, versioned, and declares its migration", () => {
  const base = resolveProjectArchitecture(prompt, []);
  const evolved = approveReviewScopeArchitectureChange(base);
  assert.equal(evolved.schemaVersion, "1.1");
  assert.notEqual(evolved.contractHash, base.contractHash);
  assert.deepEqual(evolved.reviewScope, {
    entity: "ReviewScope", userField: "review_scope_id", customerField: "review_scope_id",
    customerAssignment: "inherit-authenticated-customer", managerAccess: "same-scope-only", defaultProvisioning: "default-scope",
  });
  assert.ok(evolved.modules.some((module) => module.path === "backend/models.py" && module.provides.includes("ReviewScope")));
  assert.ok(evolved.modules.some((module) => module.path === "backend/migrations/versions/0002_review_scopes.py"));
  assert.deepEqual(validateProjectArchitectureContract(evolved), []);
  assert.deepEqual(approveReviewScopeArchitectureChange(evolved), evolved);
  assert.ok(validateProjectArchitectureContract({ ...evolved, reviewScope: { ...evolved.reviewScope!, managerAccess: "all-customers" as never } }).some((issue) => /review-scope policy/.test(issue)));
});

test("stage specification sends exact approved targets and only validated interfaces", () => {
  const pac = resolveProjectArchitecture(prompt, []);
  const spec = architectureTaskSpecification(pac, "backend", [{ path: "backend/database.py", content: "async def get_db(): ..." }]);
  assert.deepEqual((spec.targetFileOperations as Array<{ path: string; action: string }>).find((item) => item.path === "backend/routes/auth.py"), { path: "backend/routes/auth.py", action: "create", completeContentRequired: true });
  assert.deepEqual(spec.existingValidatedInterfaces, [{ path: "backend/database.py", provides: ["engine", "SessionLocal", "get_db", "Base"] }]);
  assert.ok((spec.exactTargetPaths as string[]).includes("backend/routes/customers.py"));
  assert.ok(!(spec.exactTargetPaths as string[]).includes("backend/models.py"));
  assert.ok((spec.approvedFileManifest as string[]).includes("backend/models.py"));
  assert.ok(!(spec.approvedFileManifest as string[]).includes("frontend/e2e/customer-approval.spec.ts"));
  assert.ok(!(spec.approvedFileManifest as string[]).includes("backend/tests/test_approval.py"));
});

test("architecture validator rejects missing modules, symbols, and ORM drift while allowing planned later modules", () => {
  const pac = resolveProjectArchitecture(prompt, []);
  const files = [
    { path: "backend/main.py", content: "from backend.routers import customers\nfrom backend.routes.customers import router\nfrom backend.database import get_db, missing_symbol\n" },
    { path: "backend/database.py", content: "async def get_db():\n    yield None\n" },
    { path: "backend/routes/customers.py", content: "from fastapi import APIRouter\nfrom tortoise import Tortoise\nrouter = APIRouter()\n" },
  ];
  const issues = validateArchitectureStage("backend", pac, files).join("\n");
  assert.match(issues, /missing internal module backend\.routers/);
  assert.match(issues, /missing symbol missing_symbol/);
  assert.match(issues, /Tortoise ORM/);
  assert.doesNotMatch(issues, /backend\.routes\.customers/);
});

test("architecture validator resolves relative imports and reports project-local import cycles", () => {
  const pac = resolveProjectArchitecture(prompt, []);
  const issues = validateArchitectureStage("backend", pac, [
    { path: "backend/routes/auth.py", content: "from .missing import helper\nfrom backend.routes.customers import router\ndef get_current_user(): return None\n" },
    { path: "backend/routes/customers.py", content: "from backend.routes.auth import get_current_user\nrouter = object()\n" },
  ]).join("\n");
  assert.match(issues, /imports missing relative module backend\.routes\.missing/);
  assert.match(issues, /Python internal import cycle detected/);
});

test("validated FastAPI scaffold provides SQLAlchemy and Alembic infrastructure without customer business code", () => {
  const pac = resolveProjectArchitecture(prompt, []);
  const edits: ProposedEdit[] = [{ path: "backend/requirements.txt", action: "create", content: "fastapi\n" }];
  const result = ensureArchitectureScaffold("scaffold", prompt, pac, edits, { relevantFiles: [], indexedChunkCount: 0 });
  const contents = new Map(result.map((edit) => [edit.path, edit.content]));
  assert.match(contents.get("backend/database.py") ?? "", /async_sessionmaker/);
  assert.match(contents.get("backend/database.py") ?? "", /async def get_db/);
  assert.match(contents.get("backend/migrations/env.py") ?? "", /target_metadata = Base\.metadata/);
  assert.match(contents.get("backend/alembic.ini") ?? "", /sqlalchemy\.url =\s*\n/);
  assert.match(contents.get("backend/requirements.txt") ?? "", /^sqlalchemy/m);
  assert.doesNotMatch(contents.get("backend/main.py") ?? "", /customer|approval/i);
  const frontend = JSON.parse(contents.get("frontend/package.json") ?? "{}");
  assert.equal(frontend.scripts.build, "tsc -b && vite build");
  assert.equal(frontend.scripts["test:e2e"], "playwright test");
  assert.ok(frontend.dependencies.react);
  assert.match(contents.get("frontend/src/main.tsx") ?? "", /createRoot/);
});

test("deployment scaffold uses PAC-selected Alembic and async PostgreSQL URL", () => {
  const files: ProposedEdit[] = [
    { path: "backend/requirements.txt", action: "create", content: "fastapi\nsqlalchemy\nalembic\n" },
    { path: "frontend/package.json", action: "create", content: JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "^15", react: "^19" } }) },
    { path: "docker-compose.yml", action: "create", content: "services:\n  db:\n    image: postgres:17-alpine\nvolumes:\n  postgres_data:\n" },
  ];
  const result = ensureWebDeploymentScaffold("scaffold", prompt, files, { relevantFiles: [], indexedChunkCount: 0 }, "alembic");
  const compose = result.edits.find((edit) => edit.path === "docker-compose.yml")?.content ?? "";
  assert.match(compose, /alembic -c backend\/alembic\.ini upgrade head/);
  assert.match(compose, /postgresql\+asyncpg:\/\//);
  assert.doesNotMatch(compose, /python -m backend\.migrate/);
});
