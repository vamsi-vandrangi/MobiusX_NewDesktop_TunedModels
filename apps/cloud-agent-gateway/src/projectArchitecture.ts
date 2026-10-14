import { createHash } from "node:crypto";
import type { ProjectArchitectureContract } from "@mobiusx/protocol";

export type ArchitectureFile = { path: string; content: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function contractHash(contract: Omit<ProjectArchitectureContract, "contractHash"> | ProjectArchitectureContract): string {
  const { contractHash: _ignored, ...value } = contract as ProjectArchitectureContract;
  return hash(JSON.stringify(value));
}

/** A small deterministic contract; material framework choices are resolved before code generation. */
export function resolveProjectArchitecture(prompt: string, files: ArchitectureFile[] = []): ProjectArchitectureContract {
  const requirements = prompt.toLowerCase();
  const declaredRequirements = files.find((file) => /(^|\/)backend\/requirements\.txt$/i.test(file.path))?.content ?? "";
  const backend = /fastapi/.test(requirements) ? "fastapi" : "fastapi";
  const database = /postgres(?:ql)?/.test(requirements) ? "postgresql" : /postgres(?:ql)?/i.test(declaredRequirements) ? "postgresql" : "postgresql";
  const orm = /\btortoise-orm\b/i.test(declaredRequirements) || /(?:from|import)\s+tortoise\b/i.test(files.map((file) => file.content).join("\n"))
    ? "tortoise" : "sqlalchemy";
  const frontend = /next(?:\.js|js)?/i.test(prompt) ? "nextjs" : "react";
  const modules: ProjectArchitectureContract["modules"] = [
    { path: "backend/config.py", provides: ["Settings", "settings"], dependsOn: ["pydantic-settings"] },
    { path: "backend/requirements.txt", provides: ["backend runtime and test dependencies"], dependsOn: ["FastAPI", "SQLAlchemy", "Alembic", "asyncpg"] },
    { path: "backend/__init__.py", provides: ["backend package"], dependsOn: [] },
    { path: "backend/routes/__init__.py", provides: ["routes package"], dependsOn: [] },
    { path: "backend/database.py", provides: ["engine", "SessionLocal", "get_db", "Base"], dependsOn: ["backend/config.py", "sqlalchemy", "asyncpg"] },
    { path: "backend/models.py", provides: ["User", "Customer", "AuditEvent"], dependsOn: ["backend/database.py"] },
    { path: "backend/schemas.py", provides: ["request and response schemas"], dependsOn: ["backend/models.py", "pydantic"] },
    { path: "backend/auth.py", provides: ["authenticate_user", "get_current_user", "require_role"], dependsOn: ["backend/database.py", "backend/models.py", "backend/config.py"] },
    { path: "backend/routes/auth.py", provides: ["router", "login endpoint"], dependsOn: ["backend/auth.py", "backend/schemas.py"] },
    { path: "backend/routes/customers.py", provides: ["router"], dependsOn: ["backend/auth.py", "backend/database.py", "backend/models.py", "backend/schemas.py"] },
    { path: "backend/main.py", provides: ["app", "health"], dependsOn: ["backend/routes/customers.py", "backend/database.py"] },
    { path: "backend/alembic.ini", provides: ["script_location"], dependsOn: ["alembic"] },
    { path: "backend/migrations/env.py", provides: ["target_metadata", "migration runners"], dependsOn: ["backend/models.py", "backend/config.py", "alembic"] },
    { path: "backend/migrations/versions/0001_initial.py", provides: ["revision", "upgrade", "downgrade"], dependsOn: ["backend/models.py", "alembic"] },
    { path: ".env.example", provides: ["required local runtime settings without secrets"], dependsOn: [] },
    { path: "backend/tests/conftest.py", provides: ["isolated PostgreSQL test fixtures"], dependsOn: ["backend/main.py", "pytest", "httpx", "postgresql"] },
    { path: "backend/tests/test_customers.py", provides: ["customer API integration acceptance tests"], dependsOn: ["backend/tests/conftest.py", "backend/routes/customers.py"] },
    { path: "backend/tests/test_approval.py", provides: ["approval authorization and audit integration tests"], dependsOn: ["backend/tests/conftest.py", "backend/routes/customers.py"] },
    { path: "frontend/package.json", provides: ["dev", "build", "start", "test:e2e"], dependsOn: ["react", "typescript", "@playwright/test"] },
    { path: "frontend/lib/api.ts", provides: ["API client", "auth helpers"], dependsOn: ["frontend/package.json"] },
    { path: frontend === "nextjs" ? "frontend/app/page.tsx" : "frontend/src/App.tsx", provides: ["owner workflow screen"], dependsOn: ["frontend/lib/api.ts"] },
    { path: frontend === "nextjs" ? "frontend/app/manager/page.tsx" : "frontend/src/Manager.tsx", provides: ["manager workflow screen"], dependsOn: ["frontend/lib/api.ts"] },
    { path: "frontend/e2e/customer-approval.spec.ts", provides: ["Playwright acceptance workflow"], dependsOn: ["frontend pages", "backend API", "@playwright/test"] },
    { path: "frontend/playwright.config.ts", provides: ["Playwright browser-test configuration"], dependsOn: ["@playwright/test"] },
    { path: "docker-compose.yml", provides: ["frontend, backend, postgres services"], dependsOn: ["Docker Compose"] },
    { path: "backend/Dockerfile", provides: ["backend runtime image"], dependsOn: ["backend/requirements.txt"] },
    { path: "frontend/Dockerfile", provides: ["frontend runtime image"], dependsOn: ["frontend/package.json"] },
    { path: "README.md", provides: ["setup and execution instructions"], dependsOn: ["Docker Compose"] },
  ];
  const base: Omit<ProjectArchitectureContract, "contractHash"> = {
    schemaVersion: "1.0" as const,
    stack: { backend, orm, migrations: "alembic", database, frontend, e2e: "playwright" },
    modules,
  };
  return { ...base, contractHash: contractHash(base) };
}

/** Resolve the explicitly approved, additive manager review-scope evolution. */
export function approveReviewScopeArchitectureChange(contract: ProjectArchitectureContract): ProjectArchitectureContract {
  if (contract.reviewScope) return contract;
  if (contract.stack.backend !== "fastapi" || contract.stack.orm !== "sqlalchemy" || contract.stack.migrations !== "alembic" || contract.stack.database !== "postgresql") {
    throw new Error("review-scope evolution is only validated for the PAC FastAPI/SQLAlchemy/Alembic/PostgreSQL stack");
  }
  const modules = contract.modules.map((module) => module.path === "backend/models.py"
    ? { ...module, provides: [...new Set([...module.provides, "ReviewScope"])] }
    : module);
  if (!modules.some((module) => module.path === "backend/migrations/versions/0002_review_scopes.py")) {
    modules.push({ path: "backend/migrations/versions/0002_review_scopes.py", provides: ["revision", "upgrade", "downgrade"], dependsOn: ["backend/models.py", "alembic"] });
  }
  const evolved: ProjectArchitectureContract = {
    ...contract,
    schemaVersion: "1.1",
    modules,
    reviewScope: {
      entity: "ReviewScope",
      userField: "review_scope_id",
      customerField: "review_scope_id",
      customerAssignment: "inherit-authenticated-customer",
      managerAccess: "same-scope-only",
      defaultProvisioning: "default-scope",
    },
    contractHash: "",
  };
  evolved.contractHash = contractHash(evolved);
  return evolved;
}

export function validateProjectArchitectureContract(contract: ProjectArchitectureContract): string[] {
  const issues: string[] = [];
  if (contract.schemaVersion !== "1.0" && contract.schemaVersion !== "1.1") issues.push("unsupported architecture contract version");
  if (contract.contractHash !== contractHash(contract)) issues.push("architecture contract integrity hash mismatch");
  if (contract.stack.backend === "fastapi" && contract.stack.database === "postgresql") {
    if (contract.stack.orm !== "sqlalchemy") issues.push("FastAPI/PostgreSQL PAC requires the approved SQLAlchemy ORM");
    if (contract.stack.migrations !== "alembic") issues.push("FastAPI/PostgreSQL PAC requires Alembic migrations");
  }
  if (contract.stack.e2e !== "playwright") issues.push("PAC requires Playwright for browser acceptance tests");
  if (contract.schemaVersion === "1.1") {
    if (!contract.reviewScope || contract.reviewScope.entity !== "ReviewScope" || contract.reviewScope.userField !== "review_scope_id" || contract.reviewScope.customerField !== "review_scope_id" || contract.reviewScope.customerAssignment !== "inherit-authenticated-customer" || contract.reviewScope.managerAccess !== "same-scope-only" || contract.reviewScope.defaultProvisioning !== "default-scope") issues.push("PAC 1.1 review-scope policy is incomplete or unsupported");
    if (!contract.modules.some((module) => module.path === "backend/models.py" && module.provides.includes("ReviewScope"))) issues.push("PAC 1.1 does not declare the ReviewScope model export");
    if (!contract.modules.some((module) => module.path === "backend/migrations/versions/0002_review_scopes.py")) issues.push("PAC 1.1 does not declare the review-scope migration");
  } else if (contract.reviewScope) issues.push("review-scope policy requires PAC schema version 1.1");
  const seen = new Set<string>();
  const moduleByPath = new Map<string, ProjectArchitectureContract["modules"][number]>();
  for (const module of contract.modules) {
    const path = module.path.replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "..")) issues.push(`unsafe PAC module path: ${module.path}`);
    if (seen.has(path.toLowerCase())) issues.push(`duplicate PAC module path: ${module.path}`);
    seen.add(path.toLowerCase());
    moduleByPath.set(path.toLowerCase(), module);
    if (!module.provides.length) issues.push(`PAC module ${module.path} must declare at least one provided interface`);
    for (const dependency of module.dependsOn) {
      if (dependency.startsWith("backend/") && !contract.modules.some((candidate) => candidate.path.replaceAll("\\", "/").toLowerCase() === dependency.toLowerCase())) {
        issues.push(`PAC module ${module.path} depends on undeclared module ${dependency}`);
      }
      if (dependency.replaceAll("\\", "/").toLowerCase() === path.toLowerCase()) issues.push(`PAC module ${module.path} cannot depend on itself`);
    }
  }
  const visits = new Set<string>();
  const active = new Set<string>();
  const reportedCycles = new Set<string>();
  const visit = (path: string, chain: string[]) => {
    if (active.has(path)) {
      reportedCycles.add(chain.slice(chain.indexOf(path)).concat(path).join(" -> "));
      return;
    }
    if (visits.has(path)) return;
    active.add(path);
    const module = moduleByPath.get(path);
    for (const dependency of module?.dependsOn ?? []) {
      const normalized = dependency.replaceAll("\\", "/").toLowerCase();
      if (moduleByPath.has(normalized)) visit(normalized, [...chain, path]);
    }
    active.delete(path);
    visits.add(path);
  };
  for (const path of moduleByPath.keys()) visit(path, []);
  for (const cycle of reportedCycles) issues.push(`PAC module dependency cycle: ${cycle}`);
  return [...new Set(issues)];
}

export function architectureTaskSpecification(
  contract: ProjectArchitectureContract,
  stageId: string,
  validatedFiles: Array<{ path: string; content: string }>,
): Record<string, unknown> {
  const stagePath = (path: string): boolean => {
    if (stageId === "scaffold") return /^(backend\/(?:config|database|__init__|alembic\.ini|migrations\/env)\.py|backend\/routes\/__init__\.py|backend\/alembic\.ini|backend\/requirements\.txt|frontend\/package\.json|docker-compose\.yml|backend\/Dockerfile|frontend\/Dockerfile|README\.md)$/i.test(path);
    if (stageId === "database") return /^(backend\/models\.py|backend\/migrations\/versions\/|backend\/alembic\.ini)/i.test(path);
    if (stageId === "backend") return /^backend\/(?:schemas|auth|main)\.py$|^backend\/routes\/(?:auth|customers)\.py$/i.test(path);
    if (stageId === "transactions") return /^backend\/(?:routes\/|models|schemas)/i.test(path);
    if (stageId === "frontend") return /^frontend\/(?!e2e\/)/i.test(path);
    if (stageId === "tests") return /^backend\/tests\/|^frontend\/(?:e2e|playwright\.config\.)/i.test(path);
    return false;
  };
  const targets = contract.modules.filter((module) => stagePath(module.path)).map((module) => module.path);
  const existing = new Set(validatedFiles.map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
  const targetModules = contract.modules.filter((module) => targets.includes(module.path));
  // Keep each model request proportional to the stage. The checkpoint keeps
  // the complete immutable PAC; a local model only needs the target modules,
  // their declared internal dependencies, and interfaces already validated.
  const relevantPaths = new Set<string>(targets.map((path) => path.toLowerCase()));
  for (const module of targetModules) {
    for (const dependency of module.dependsOn) {
      if (dependency.startsWith("backend/")) relevantPaths.add(dependency.toLowerCase());
    }
  }
  const relevantModules = contract.modules.filter((module) => relevantPaths.has(module.path.toLowerCase()));
  const interfaces = relevantModules
    .filter((module) => existing.has(module.path.toLowerCase()))
    .map(({ path, provides }) => ({ path, provides }));
  return {
    schemaVersion: "1.0",
    stage: stageId,
    architectureHash: contract.contractHash,
    ...(contract.reviewScope ? { approvedDomainExtensions: { reviewScope: contract.reviewScope } } : {}),
    exactTargetPaths: targets,
    approvedFileManifest: relevantModules.map((module) => module.path),
    existingValidatedInterfaces: interfaces,
    allowedDependencies: [...new Set(targetModules.flatMap((module) => module.dependsOn))],
    requiredExports: targetModules.map(({ path, provides }) => ({ path, provides })),
    targetFileOperations: targets.map((path) => {
      const existingFile = validatedFiles.find((file) => file.path.replaceAll("\\", "/").toLowerCase() === path.toLowerCase());
      return existingFile
        ? { path, action: "modify", expectedContentSha256: hash(existingFile.content), completeContentRequired: true }
        : { path, action: "create", completeContentRequired: true };
    }),
    acceptanceCriteria: [
      `Use ${contract.stack.orm} consistently; do not import or call any other ORM.`,
      `Use ${contract.stack.migrations} for ${contract.stack.database} schema changes.`,
      `Browser tests use ${contract.stack.e2e}; never substitute Cypress.`,
      "All cross-module imports use paths and exports declared in this PAC task slice.",
      "Do not modify the PAC or previously validated interfaces.",
      ...(contract.reviewScope ? ["Enforce the approved review-scope assignment and same-scope manager authorization exactly as declared in the PAC."] : []),
    ],
  };
}

/** Check project-local imports, named exports, ORM consistency, and migration framework against the PAC. */
export function validateArchitectureStage(stageId: string, contract: ProjectArchitectureContract, files: ArchitectureFile[]): string[] {
  const issues: string[] = [];
  const byPath = new Map(files.map((file) => [file.path.replaceAll("\\", "/").toLowerCase(), file]));
  const modules = new Map(contract.modules.map((module) => [module.path.toLowerCase(), module]));
  const requirements = byPath.get("backend/requirements.txt")?.content ?? "";
  const pythonFiles = files.filter((file) => file.path.toLowerCase().endsWith(".py"));
  const sourceImports = new Map<string, Set<string>>();
  for (const file of pythonFiles) {
    const statements = [...file.content.matchAll(/^\s*from\s+(backend(?:\.[\w]+)*)\s+import\s+([^\n#]+)/gm)];
    for (const [, imported, namesText] of statements) {
      const modulePath = `${imported.replaceAll(".", "/")}.py`.toLowerCase();
      const packagePath = `${imported.replaceAll(".", "/")}/__init__.py`.toLowerCase();
      const target = byPath.get(modulePath) ?? byPath.get(packagePath);
      const planned = contract.modules.find((module) => module.path.replace(/\.py$/i, "").replaceAll("/", ".").toLowerCase() === imported.toLowerCase());
      if (!target && !planned) {
        issues.push(`${file.path} imports missing internal module ${imported}; it is not in the approved module manifest`);
        continue;
      }
      if (!target) continue;
      const declared = new Set([...target.content.matchAll(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)|^\s*([A-Za-z_]\w*)\s*=/gm)].map((match) => match[1] ?? match[2]));
      for (const raw of namesText.split(",")) {
        const name = raw.trim().split(/\s+as\s+/i)[0];
        if (!/^[A-Za-z_]\w*$/.test(name) || name === "*" || declared.has(name)) continue;
        if (byPath.has(`${imported.replaceAll(".", "/")}/${name.toLowerCase()}.py`)) continue;
        issues.push(`${file.path} imports missing symbol ${name} from ${imported}`);
      }
    }
    for (const [, imported] of file.content.matchAll(/^\s*import\s+(backend(?:\.[\w]+)*)\b/gm)) {
      const modulePath = `${imported.replaceAll(".", "/")}.py`.toLowerCase();
      const packagePath = `${imported.replaceAll(".", "/")}/__init__.py`.toLowerCase();
      const planned = contract.modules.some((module) => module.path.replace(/\.py$/i, "").replaceAll("/", ".").toLowerCase() === imported.toLowerCase());
      if (!byPath.has(modulePath) && !byPath.has(packagePath) && !planned) issues.push(`${file.path} imports missing internal module ${imported}; it is not in the approved module manifest`);
    }
    for (const [, dots, suffix] of file.content.matchAll(/^\s*from\s+(\.+)([\w.]+)\s+import\s+([^\n#]+)/gm)) {
      const parts = file.path.replaceAll("\\", "/").replace(/\.py$/i, "").split("/");
      parts.pop();
      const parentParts = parts.slice(0, Math.max(0, parts.length - (dots.length - 1)));
      const imported = [...parentParts, ...suffix.split(".")].join(".");
      const modulePath = `${imported.replaceAll(".", "/")}.py`.toLowerCase();
      const packagePath = `${imported.replaceAll(".", "/")}/__init__.py`.toLowerCase();
      const planned = contract.modules.some((module) => module.path.replace(/\.py$/i, "").replaceAll("/", ".").toLowerCase() === imported.toLowerCase());
      if (!byPath.has(modulePath) && !byPath.has(packagePath) && !planned) issues.push(`${file.path} imports missing relative module ${imported}; it is not in the approved module manifest`);
      if (byPath.has(modulePath) || byPath.has(packagePath)) {
        const from = file.path.replaceAll("\\", "/").replace(/\.py$/i, "").toLowerCase();
        const to = (byPath.has(modulePath) ? modulePath : packagePath).replace(/\.py$/i, "").replace(/\/__init__$/i, "");
        sourceImports.set(from, new Set([...(sourceImports.get(from) ?? []), to]));
      }
    }
    for (const [, imported] of file.content.matchAll(/^\s*from\s+(backend(?:\.[\w]+)*)\s+import\s+[^\n#]+/gm)) {
      const modulePath = `${imported.replaceAll(".", "/")}.py`.toLowerCase();
      const packagePath = `${imported.replaceAll(".", "/")}/__init__.py`.toLowerCase();
      if (!byPath.has(modulePath) && !byPath.has(packagePath)) continue;
      const from = file.path.replaceAll("\\", "/").replace(/\.py$/i, "").toLowerCase();
      const to = (byPath.has(modulePath) ? modulePath : packagePath).replace(/\.py$/i, "").replace(/\/__init__$/i, "");
      sourceImports.set(from, new Set([...(sourceImports.get(from) ?? []), to]));
    }
    if (contract.stack.orm === "sqlalchemy" && /(?:from|import)\s+tortoise\b|\bTortoise\.init\b/.test(file.content)) issues.push(`${file.path} introduces Tortoise ORM into the SQLAlchemy architecture`);
    if (contract.stack.orm === "sqlalchemy" && /\b(?:User|Customer|AuditEvent|AuditHistory)\s*\.\s*(?:get|all|create|update)\s*\(/.test(file.content)) issues.push(`${file.path} uses model methods incompatible with the PAC SQLAlchemy ORM`);
    if (contract.stack.orm === "sqlalchemy" && /(?<!\.)\bForeignKey\s*\(/.test(file.content) && !/^\s*from\s+sqlalchemy(?:\.\w+)*\s+import\s+[^\n]*\bForeignKey\b/m.test(file.content)) issues.push(`${file.path} uses ForeignKey without importing the SQLAlchemy symbol`);
    if (/def\s+get_db\s*\([^)]*\)[\s\S]{0,180}get_db\s*\(/.test(file.content)) issues.push(`${file.path} recursively calls its database dependency instead of yielding from the session factory`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (node: string, path: string[]) => {
    if (visiting.has(node)) {
      const cycle = path.slice(path.indexOf(node)).concat(node);
      cycles.add(cycle.join(" -> "));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of sourceImports.get(node) ?? []) visit(dependency, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const path of sourceImports.keys()) visit(path, []);
  for (const cycle of cycles) issues.push(`Python internal import cycle detected: ${cycle}`);
  if (contract.stack.orm === "sqlalchemy" && requirements && !/^\s*sqlalchemy(?:\[[^\]]+\])?(?:[<>=!~].*)?$/im.test(requirements)) issues.push("backend/requirements.txt omits the PAC-required SQLAlchemy dependency");
  if (contract.stack.migrations === "alembic") {
    if (requirements && !/^\s*alembic(?:[<>=!~].*)?$/im.test(requirements)) issues.push("backend/requirements.txt omits the PAC-required Alembic dependency");
    if (stageId === "database" && (!byPath.has("backend/alembic.ini") || !byPath.has("backend/migrations/env.py") || !files.some((file) => /^backend\/migrations\/versions\/.+\.py$/i.test(file.path)))) issues.push("Alembic database stage requires alembic.ini, migrations/env.py, and an executable revision under migrations/versions");
  }
  for (const module of modules.values()) {
    for (const dependency of module.dependsOn) {
      if (!dependency.startsWith("backend/")) continue;
      if (!modules.has(dependency.toLowerCase())) issues.push(`PAC module ${module.path} depends on undeclared module ${dependency}`);
    }
  }
  return [...new Set(issues)];
}
