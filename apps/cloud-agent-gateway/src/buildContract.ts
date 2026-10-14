import type { ProposedEdit } from "@mobiusx/protocol";
import type { ProjectContext } from "@mobiusx/protocol";

export type BuildStageId = "scaffold" | "database" | "backend" | "transactions" | "frontend" | "tests";
export interface BuildStage {
  id: BuildStageId;
  label: string;
  instruction: string;
  testFramework?: "playwright";
}

const FRONTEND_RE = /\b(frontend|next(?:\.js|js)?|react|vue|angular|web app|website|ui)\b/i;
const BACKEND_RE = /\b(backend|fastapi|django|flask|spring boot|\.net|express|api|microservice)\b/i;
const DATABASE_RE = /\b(database|postgres(?:ql)?|sqlite|mysql|mariadb|sql server|orm|migration|persistent|persistence)\b/i;
const TEST_RE = /\b(test|tests|testing|automated|e2e|end.to.end|playwright|integration)\b/i;
const TRANSACTION_RE = /\b(transaction|transactional|audit|approval|approve|reject|workflow|state change)\b/i;

function hasPostgresComposeService(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let inServices = false;
  let serviceIndent = -1;
  let serviceHasPostgresImage = false;
  for (const line of lines) {
    if (/^services\s*:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      serviceIndent = -1;
      serviceHasPostgresImage = false;
      continue;
    }
    if (inServices && /^\S/.test(line) && !/^services\s*:/.test(line)) inServices = false;
    if (!inServices) continue;
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    if (serviceIndent >= 0 && indent <= serviceIndent) {
      if (serviceHasPostgresImage) return true;
      serviceIndent = -1;
      serviceHasPostgresImage = false;
    }
    if (serviceIndent < 0 && indent > 0 && /^\s*[\w-]+\s*:\s*(?:#.*)?$/.test(line)) serviceIndent = indent;
    else if (serviceIndent >= 0 && indent > serviceIndent && /^\s*image\s*:\s*[^\n]*postgres/i.test(line)) serviceHasPostgresImage = true;
  }
  return serviceHasPostgresImage;
}

function findForwardForeignKeyReferences(content: string): string[] {
  const tableCreates = [...content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?/gi)]
    .map((match) => ({ name: match[1].toLowerCase(), index: match.index ?? 0 }));
  const issues: string[] = [];
  for (const ref of content.matchAll(/REFERENCES\s+["`]?([\w]+)["`]?/gi)) {
    const index = ref.index ?? 0;
    const source = [...tableCreates].reverse().find((table) => table.index <= index);
    const target = tableCreates.find((table) => table.name === ref[1].toLowerCase());
    if (source && source.name !== ref[1].toLowerCase() && (!target || target.index > index)) {
      issues.push(`${source.name} references ${ref[1]} before that table is created`);
    }
  }
  return [...new Set(issues)];
}

function classFieldNames(source: string, className: string): Set<string> {
  const declaration = new RegExp(`^class\\s+${className}\\b[^\\n]*:`, "im").exec(source);
  if (!declaration) return new Set();
  const bodyStart = declaration.index + declaration[0].length;
  const remainder = source.slice(bodyStart);
  const nextClass = remainder.search(/^class\s+/im);
  const body = nextClass < 0 ? remainder : remainder.slice(0, nextClass);
  return new Set([...body.matchAll(/^\s{1,}([A-Za-z_]\w*)\s*(?::|=)/gm)].map((match) => match[1]));
}

export function isBlankProject(context?: ProjectContext): boolean {
  return (context?.relevantFiles?.length ?? 0) === 0 && (context?.indexedChunkCount ?? 0) === 0;
}

/** Multi-tier greenfield projects use explicit generation and validation stages. */
export function shouldUseStagedBuild(prompt: string, context?: ProjectContext): boolean {
  return isBlankProject(context) && FRONTEND_RE.test(prompt) && BACKEND_RE.test(prompt) && DATABASE_RE.test(prompt);
}

export function buildStages(prompt: string): BuildStage[] {
  const stages: BuildStage[] = [{
    id: "scaffold",
    label: "Stage 1/6 · Project scaffold",
    instruction: "Create the runnable project skeleton: separated frontend/backend directories, compatible package and Python dependency manifests, entry points, environment examples, setup instructions, and loopback development configuration. For FastAPI, backend/main.py must define a real FastAPI app with a working /health endpoint and a place to register routers; do not use pass, ellipses, TODOs, or empty handler/class bodies. Include runnable frontend dev/build scripts and dependencies. The files must allow the later stages to extend the same app.",
  }];
  if (DATABASE_RE.test(prompt)) stages.push({
    id: "database",
    label: "Stage 2/6 · Database schema and migrations",
    instruction: "Derive the relational schema from the entities, fields, actors, relationships, audit events, and state transitions named in the user's requirements. Every named business entity must exist in the migration and ORM models; do not substitute unrelated entities from another task or prior context. Choose conventional column types and safe defaults for routine omissions; do not ask the user to enumerate tables, fields, indexes, or seed data when the workflow is clear. Follow the immutable PAC migration framework: for FastAPI/PostgreSQL with SQLAlchemy, create an executable Alembic revision under backend/migrations/versions with foreign keys, unique constraints, status checks, and useful indexes. Order tables so referenced tables already exist. Add reproducible synthetic seed data only when requested. Wire migration execution into the documented Alembic command. Do not use in-memory or mock storage as the business database.",
  });
  if (BACKEND_RE.test(prompt)) stages.push({
    id: "backend",
    label: "Stage 3/6 · Backend APIs and authentication",
    instruction: "Implement the backend in small, focused modules using the selected framework and the database/migration already created. Before writing ORM calls, inspect backend/requirements.txt and backend/models.py and use that exact ORM consistently in every module: if SQLAlchemy is declared, use injected SQLAlchemy sessions and select()/add()/commit() (never Tortoise .get/.all/.create/.update); if Tortoise is declared, use its models and lifespan configuration consistently. Do not mix ORM APIs. For FastAPI, keep backend/main.py limited to app setup, database/session wiring, health route, and router registration (target under 100 lines); put Pydantic request/response schemas in backend/schemas.py, password/token/user-role helpers in backend/auth.py, and customer read/create plus owner-submit routes in backend/routes/customers.py. Use only ORM entities that actually exist in the generated models; import every referenced model, helper, and schema explicitly. The requested customer onboarding workflow requires real Customer and User persistence models when those entities appear in the schema. Keep the API module under roughly 220 lines and avoid re-emitting unrelated files. Use validated input, controlled database errors, environment-only secrets, real persisted reads/writes, and role/owner authorization. Manager decision routes and audit transactions belong in the next business-transactions stage. Derive conventional authentication details from the requirements; do not ask routine questions.",
  });
  if (TRANSACTION_RE.test(prompt)) stages.push({
    id: "transactions",
    label: "Stage 4/6 · Business transactions and audit",
    instruction: "Implement every state transition named in the approved requirements as real backend handlers in the route modules that own those capabilities. If a required handler is missing, create the smallest focused route module and register it with the existing application. For each transition, validate the current state and actor/role, update persisted state and write its audit/history record inside the same database transaction, then return the persisted result. Use the ORM and schemas already declared in the supplied files; do not claim transactions exist from prose or from a model declaration alone. This stage requires concrete structured file edits whenever a required capability is missing; a status summary such as 'no changes needed' is not an implementation. Do not regenerate unrelated frontend, scaffold, or migration files.",
  });
  if (FRONTEND_RE.test(prompt)) stages.push({
    id: "frontend",
    label: "Stage 5/6 · Frontend screens and API integration",
    instruction: "Implement the requested user and manager screens, navigation, forms, empty/loading/error states, and real API integration. Every main action must call the backend and render the persisted result; no disconnected mock-only business workflow.",
  });
  if (TEST_RE.test(prompt)) stages.push({
    id: "tests",
    label: "Stage 6/6 · Automated tests",
    testFramework: "playwright",
    instruction: "Generate only executable automated tests for the existing application. Use the test specification, approved operation contracts, OpenAPI metadata, and UI contract supplied with this stage. Keep backend API/integration tests in backend/tests/ and browser E2E tests in frontend/e2e/ using Playwright (@playwright/test). Do not change application code or business behavior to satisfy tests. Do not invent endpoints, schemas, roles, states, routes, or selectors; report a capability gap explicitly. Include environment-configured endpoints/credentials, synthetic data, cleanup, and commands for running each suite. No Cypress, skipped tests, vacuous assertions, placeholders, or mocked business persistence.",
  });
  return stages.map((stage, index) => ({
    ...stage,
    label: `Stage ${index + 1}/${stages.length} · ${stage.label.split(" · ").slice(1).join(" · ")}`,
  }));
}

const SOURCE_RE = /\.(?:[cm]?[jt]sx?|py|sql|java|cs|go|rs)$/i;
const PLACEHOLDER_RE = /\b(?:TODO|FIXME|NotImplementedError|implementation\s+goes\s+here|not\s+implemented|placeholder)\b|^\s*(?:return\s+)?(?:pass|\.\.\.|NotImplemented|None)\s*(?:#.*)?$/im;

function placeholderLineNumbers(content: string): number[] {
  return content.split(/\r?\n/).flatMap((line, index) => PLACEHOLDER_RE.test(line) ? [index + 1] : []);
}

/** Catch the common async-handler syntax defect before a Python stage advances. */
function hasAwaitOutsideAsyncFunction(content: string): boolean {
  const functions: Array<{ indent: number; isAsync: boolean }> = [];
  for (const line of content.split(/\r?\n/)) {
    const uncommented = line.replace(/\s+#.*$/, "");
    if (!uncommented.trim()) continue;
    const indent = uncommented.match(/^\s*/)?.[0].length ?? 0;
    const definition = uncommented.match(/^\s*(async\s+)?def\s+[A-Za-z_]\w*\s*\(/);
    if (definition) {
      while (functions.length && functions.at(-1)!.indent >= indent) functions.pop();
      functions.push({ indent, isAsync: Boolean(definition[1]) });
      continue;
    }
    while (functions.length && functions.at(-1)!.indent >= indent) functions.pop();
    if (/\bawait\b/.test(uncommented) && !functions.some((fn) => fn.isAsync)) return true;
  }
  return false;
}

function hasBalancedDelimiters(source: string): boolean {
  const stack: string[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; i += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; i += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(" || char === "[" || char === "{") { stack.push(char); continue; }
    if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== expected) return false;
    }
  }
  return !quote && !blockComment && stack.length === 0;
}

export function validateBuildStage(
  stage: BuildStageId,
  prompt: string,
  files: Map<string, { content: string; action: ProposedEdit["action"] }>,
  approvedFrontendFramework?: string,
): string[] {
  const all = [...files.entries()].map(([path, file]) => ({ path, content: file.content }));
  const code = all.filter((file) => SOURCE_RE.test(file.path));
  const lower = code.map((file) => `${file.path}\n${file.content}`).join("\n").toLowerCase();
  const paths = all.map((file) => file.path.toLowerCase());
  const issues: string[] = [];
  for (const file of code) {
    const placeholderLines = placeholderLineNumbers(file.content);
    if (placeholderLines.length) issues.push(`${file.path} contains a TODO, pass, or unimplemented placeholder on line(s) ${placeholderLines.join(", ")}`);
    // Report the field and line, but never copy the credential value into logs,
    // repair prompts, or persisted diagnostics.
    const credentialAssignment = /^\s*(?:[A-Za-z_]\w*\.)*\b(secret(?:_key)?|jwt_secret|auth_secret|password|api[_-]?key)\b\s*[:=]\s*(["'])[^"']+\2/im;
    const credentialMatch = credentialAssignment.exec(file.content);
    if (credentialMatch) {
      const beforeMatch = file.content.slice(0, credentialMatch.index);
      const line = beforeMatch.split("\n").length;
      issues.push(`${file.path} contains a hardcoded credential: line ${line} assigns a literal to field ${credentialMatch[1]}; read it from required environment configuration and do not log or repeat its value`);
    }
    if (/(?:^|\/)auth\.py$/i.test(file.path)) {
      const fixedIdentity = /Depends\s*\(\s*lambda\s*:\s*\d+\s*\)/.exec(file.content);
      if (fixedIdentity) issues.push(`${file.path} uses a hardcoded authentication identity on line ${file.content.slice(0, fixedIdentity.index).split("\n").length}; resolve the actor from a verified session/token and persisted user`);
      const plaintextCompare = /(?:password_hash|hashed_password)\s*==\s*(?:plain_)?password\b|\bpassword\s*==\s*(?:password_hash|hashed_password)\b/i.exec(file.content);
      if (plaintextCompare) issues.push(`${file.path} compares a submitted password directly with a stored hash on line ${file.content.slice(0, plaintextCompare.index).split("\n").length}; verify passwords with the configured password-hashing scheme`);
      const duplicateUserModel = /^\s*class\s+User\s*\([^\n]*(?:Model|models\.Model)[^\n]*\)\s*:/m.exec(file.content);
      if (duplicateUserModel) issues.push(`${file.path} defines a duplicate User ORM class on line ${file.content.slice(0, duplicateUserModel.index).split("\n").length}; import the persisted User model from backend.models`);
    }
    const normalizedPythonPath = file.path.replaceAll("\\", "/").toLowerCase();
    const pythonSyntaxRequiredForStage = stage !== "database"
      || normalizedPythonPath === "backend/models.py"
      || normalizedPythonPath.startsWith("backend/migrations/");
    if (/\.py$/i.test(file.path) && pythonSyntaxRequiredForStage && hasAwaitOutsideAsyncFunction(file.content)) {
      issues.push(`${file.path} uses await outside an async def; Python will fail to import this module`);
    }
  }
  for (const file of all.filter((candidate) => /(?:docker-compose|compose|\.env(?:\.example)?|config)/i.test(candidate.path))) {
    const isPythonConfig = /\.py$/i.test(file.path);
    const hasLiteralCredential = file.content.split(/\r?\n/).some((line) => {
      // Python annotations such as `database_url: str` are declarations, not
      // credential values. Only flag an explicit string assignment there.
      const match = line.match(isPythonConfig
        ? /^\s*(?:POSTGRES_PASSWORD|DATABASE_URL|JWT_SECRET|SECRET_KEY|AUTH_SECRET)\s*=\s*(['"])(.*?)\1\s*$/i
        : /^\s*(?:-\s*)?(?:POSTGRES_PASSWORD|DATABASE_URL|JWT_SECRET|SECRET_KEY|AUTH_SECRET)\s*[:=]\s*(.*?)\s*$/i);
      if (!match) return false;
      const value = isPythonConfig ? match[2] : match[1].replace(/^['"]|['"]$/g, "");
      const hasEnvironmentReference = /\$\{[A-Z_][A-Z0-9_]*(?::\?[^}]+)?\}/i.test(value);
      return value.length > 0 && !hasEnvironmentReference && !/^(?:$|changeme|replace_me|your_[a-z0-9_]+_here)$/i.test(value);
    });
    if (hasLiteralCredential) {
      issues.push(`${file.path} contains a hardcoded credential or database URL; use environment-variable interpolation`);
    }
  }

  if (stage === "scaffold") {
    if (FRONTEND_RE.test(prompt) && !paths.some((path) => /(^|\/)(frontend|client|web)\/package\.json$/.test(path))) issues.push("frontend package.json is missing from the frontend workspace");
    if (BACKEND_RE.test(prompt) && !paths.some((path) => /(^|\/)(backend|server|api)\/(?:src\/)?(?:main|app)\.(py|js|ts|java|cs)$/.test(path))) issues.push("backend application entry point is missing from the backend workspace");
    if (DATABASE_RE.test(prompt) && !paths.some((path) => /(^|\/)(docker-compose\.ya?ml|compose\.ya?ml)$/.test(path))) issues.push("database service configuration is missing");
    const compose = all.find((file) => /(^|\/)(docker-compose\.ya?ml|compose\.ya?ml)$/i.test(file.path));
    if (compose && /\bpostgres(?:ql)?\b/i.test(prompt) && !/image\s*:\s*[^\n]*postgres/i.test(compose.content)) issues.push("Docker Compose does not define the requested PostgreSQL service");
    if (compose) {
      if (/\bpostgres(?:ql)?\b/i.test(prompt) && !hasPostgresComposeService(compose.content)) {
        issues.push("Docker Compose must define PostgreSQL as a service under services (not under an unrelated top-level key)");
      }
      const publishedPorts = compose.content.split(/\r?\n/).filter((line) => /^\s*-\s*["']?(?:\$\{[^}]+\}|\d{2,5}|127\.0\.0\.1:)/.test(line) && /:\d{2,5}/.test(line));
      const unsafePublishedPorts = publishedPorts.filter((line) => !/127\.0\.0\.1:/.test(line));
      if (unsafePublishedPorts.length) {
        issues.push(`published development service ports must bind to 127.0.0.1; correct these mappings: ${unsafePublishedPorts.map((line) => line.trim()).join(" | ")}`);
      }
    }
    if (paths.some((path) => /(^|\/)(frontend|client|web)\/package\.json$/i.test(path))) {
      const packageFile = all.find((file) => /(^|\/)(frontend|client|web)\/package\.json$/i.test(file.path));
      try {
        const parsed = JSON.parse(packageFile?.content ?? "") as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown> };
        if (!parsed.scripts || !Object.values(parsed.scripts).some((value) => typeof value === "string")) issues.push("package.json has no runnable scripts");
        if (!parsed.scripts?.dev || !parsed.scripts?.build) issues.push("frontend package.json must provide dev and build scripts");
        const requiresNext = approvedFrontendFramework ? approvedFrontendFramework.toLowerCase() === "nextjs" : /next(?:\.js|js)?/i.test(prompt);
        if (requiresNext && !(parsed.dependencies?.next && parsed.dependencies?.react && parsed.dependencies?.["react-dom"])) issues.push("frontend package.json must declare Next.js, React, and React DOM");
        if (/\breact\b/i.test(prompt) && !parsed.dependencies?.react) issues.push("frontend package.json does not declare React");
      } catch {
        issues.push("package.json is not valid JSON");
      }
    }
  }
  if (stage === "scaffold" && /\bfastapi\b/i.test(prompt)) {
    const requirements = all.find((file) => /(^|\/)backend\/requirements\.txt$/i.test(file.path));
    if (!requirements) issues.push("backend/requirements.txt is missing for the requested FastAPI service");
    else {
      const invalidLines = requirements.content.split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("-") && trimmed.split(/\s+/).length > 1;
      });
      if (invalidLines.length) issues.push("backend/requirements.txt must contain one valid pip requirement per line");
      if (/^\s*sqlite3\s*$/im.test(requirements.content)) issues.push("backend/requirements.txt lists sqlite3, which is part of Python's standard library");
    }
    if (/postgres(?:ql)?/i.test(prompt) && all.some((file) => /(^|\/)backend\/.*\.py$/i.test(file.path) && /sqlite(?:\+[^:]*)?:\/\//i.test(file.content))) {
      issues.push("FastAPI backend uses SQLite even though PostgreSQL was requested; read a PostgreSQL DATABASE_URL from environment configuration");
    }
  }
  if (stage === "database" && DATABASE_RE.test(prompt)) {
    const isAlembic = /\balembic\b/i.test(prompt) || all.some((file) => /(^|\/)backend\/alembic\.ini$/i.test(file.path));
    const alembicRevision = all.find((file) => /(^|\/)backend\/migrations\/versions\/[^/]+\.py$/i.test(file.path));
    const migration = isAlembic
      ? alembicRevision
      : all.find((file) => /(^|\/)migrations\/versions\/.*\.py$/i.test(file.path))
        ?? all.find((file) => /(^|\/)(migrations?|versions)\/.*\.(sql|py|js|ts)$/i.test(file.path));
    if (!migration) issues.push(isAlembic
      ? "Alembic database stage requires an executable revision under backend/migrations/versions; migrations/env.py is runner configuration, not a schema migration"
      : "an executable database migration file is missing");
    else if (!/(create\s+table|alter\s+table|upgrade\s*\(|op\.(create|add)|query\s*\()/i.test(migration.content)) issues.push(`${migration.path} does not contain executable schema operations`);
    const requirements = all.find((file) => /(^|\/)backend\/requirements\.txt$/i.test(file.path))?.content ?? "";
      const hasOrmDependency = /\bsqlalchemy\b|\btortoise-orm\b|\bsqlmodel\b/i.test(requirements);
    const hasOrmEntities = /(?:declarativebase|Base\.metadata|class\s+\w+\([^)]*(?:Base|Model)|models\.Model|SQLModel|@Entity\b)/i.test(lower);
    if (hasOrmDependency && !hasOrmEntities) issues.push("database ORM dependency is present but no executable ORM entity definitions were generated");
    if (!hasOrmEntities && !migration) issues.push("database schema or ORM entities are missing");
    if (/fastapi/i.test(prompt) && /postgres(?:ql)?/i.test(prompt) && hasOrmDependency) {
      const databaseModule = all.find((file) => /(^|\/)backend\/(?:database|db)\.py$/i.test(file.path));
      const databaseWiring = all.some((file) => /(^|\/)backend\//i.test(file.path) && /create_(?:async_)?engine\s*\(|DATABASE_URL|sessionmaker|AsyncSession/i.test(file.content));
      if (!databaseModule && !databaseWiring) issues.push("FastAPI/PostgreSQL database connection and session wiring are missing");
    }
    if (/customer/i.test(prompt) && /approv/i.test(prompt)) {
      if (!all.some((file) => /(?:CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?customers?["`]?\b|op\.create_table\s*\(\s*["']customers?["'])/i.test(file.content))) {
        issues.push(`${migration?.path ?? "backend/migrations/001_initial.sql"} is missing the PostgreSQL customers table required by the customer approval workflow`);
      }
      if (hasOrmDependency && !all.some((file) => /class\s+Customer\s*\(/i.test(file.content))) {
        issues.push("backend/models.py is missing the Customer ORM entity required by the customer approval workflow");
      }
    }
    if (/\b(auth|authentication|login|role|authorization|jwt|oauth)\b/i.test(prompt) && /customer/i.test(prompt)) {
      if (!all.some((file) => /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?users?["`]?\b|op\.create_table\s*\(\s*["']users?["']/i.test(file.content))) {
        issues.push(`${migration?.path ?? "backend/migrations/001_initial.sql"} is missing the users table required by persisted authentication and roles`);
      }
    }
    if (migration) {
      for (const orderingIssue of findForwardForeignKeyReferences(migration.content)) {
        issues.push(`${migration.path} has an invalid table dependency: ${orderingIssue}; create referenced tables first`);
      }
    }
  }
  if (stage === "backend" && BACKEND_RE.test(prompt)) {
    if (!/(app\.(get|post|put|patch|delete)|router\.(get|post|put|patch|delete)|@GetMapping|@PostMapping|\[Http(Get|Post|Put|Delete)|urlpatterns|route\()/i.test(lower)) issues.push("backend API route implementations are missing");
    if (/\b(auth|authentication|login|role|authorization|jwt|oauth)\b/i.test(prompt) && !/(jwt|oauth|session|login|authenticate|current_user|currentuser|authorization|role)/i.test(lower)) issues.push("requested authentication/authorization is missing");
    for (const file of code.filter((candidate) => /(^|\/)backend\/.*\.py$/i.test(candidate.path))) {
      const relativeImports = [...file.content.matchAll(/^\s*from\s+(\.+)([\w.]+)\s+import\s+/gm)];
      for (const [, dots, moduleName] of relativeImports) {
        const parentSegments = file.path.slice(0, file.path.lastIndexOf("/")).split("/").filter(Boolean);
        const levelsUp = dots.length - 1;
        if (levelsUp > parentSegments.length) {
          issues.push(`${file.path} relative import ${dots}${moduleName} goes beyond the project package root`);
          continue;
        }
        const baseSegments = [...parentSegments.slice(0, parentSegments.length - levelsUp), ...moduleName.split(".")];
        const base = baseSegments.join("/").toLowerCase();
        if (!paths.some((path) => path === `${base}.py` || path === `${base}/__init__.py`)) {
          issues.push(`${file.path} imports missing project module ${dots}${moduleName}`);
        }
      }
      const packageImports = [...file.content.matchAll(/^\s*from\s+(backend(?:\.\w+)+)\s+import\s+/gm)];
      for (const [, imported] of packageImports) {
        const base = imported.replaceAll(".", "/").toLowerCase();
        if (!paths.some((path) => path === `${base}.py` || path === `${base}/__init__.py`)) issues.push(`${file.path} imports missing project module ${imported}`);
      }
    }
    const backendFiles = code.filter((file) => /(^|\/)backend\/.*\.py$/i.test(file.path));
    const backendSource = backendFiles.map((file) => file.content).join("\n");
    const requirements = all.find((file) => /(^|\/)backend\/requirements\.txt$/i.test(file.path))?.content ?? "";
    const models = all.find((file) => /(^|\/)backend\/models\.py$/i.test(file.path))?.content ?? "";
    if (/\bsqlalchemy\b/i.test(requirements) || /from\s+sqlalchemy\s+import/i.test(models)) {
      const tortoiseStyleCalls = backendFiles.filter((file) => /\b(?:User|Customer|AuditHistory|AuditLog|ApprovalEvent)\s*\.\s*(?:get|all|create|update)\s*\(/.test(file.content));
      for (const file of tortoiseStyleCalls) issues.push(`${file.path} uses Tortoise-style model methods while this project declares SQLAlchemy; use the project's SQLAlchemy session and select/add/commit APIs consistently`);
      if (/\bForeignKey\s*\(/.test(models) && !/^\s*from\s+sqlalchemy(?:\.\w+)*\s+import\s+[^\n]*\bForeignKey\b/m.test(models)) {
        issues.push("backend/models.py uses ForeignKey without importing it from SQLAlchemy");
      }
      const database = all.find((file) => /(^|\/)backend\/(?:database|db)\.py$/i.test(file.path))?.content ?? "";
      if (/from\s+backend\.database\s+import\s+get_async_session/.test(backendSource) && !database) issues.push("backend/database.py must define the SQLAlchemy async engine, sessionmaker, and get_async_session dependency imported by the backend");
      if (database && /def\s+get_async_session\s*\([^)]*\)[\s\S]{0,160}get_async_session\s*\(/.test(database)) issues.push("backend/database.py defines a recursive get_async_session dependency; yield from the configured AsyncSessionLocal sessionmaker");
      const auth = all.find((file) => /(^|\/)backend\/auth\.py$/i.test(file.path))?.content ?? "";
      if (/def\s+get_async_session\s*\(/.test(auth)) issues.push("backend/auth.py redefines the database get_async_session dependency; import it from backend.database and use a distinct current-user dependency");
    }
    const main = all.find((file) => /(^|\/)backend\/main\.py$/i.test(file.path));
    if (main && /FastAPI\s*\(/.test(main.content) && paths.some((path) => /(^|\/)backend\/routes?\//i.test(path)) && !/include_router\s*\(/.test(main.content)) {
      issues.push("backend/main.py does not register the generated API routers");
    }
    if (/customer/i.test(prompt) && /approv/i.test(prompt)) {
      const models = all.find((file) => /(^|\/)backend\/models\.py$/i.test(file.path))?.content ?? "";
      if (!/class\s+Customer\s*\(/i.test(models)) issues.push("backend/models.py is missing the Customer ORM model referenced by its routes");
      const customerModelFields = classFieldNames(models, "Customer");
      if (customerModelFields.size > 0 && ![...customerModelFields].some((field) => /^(?:name|company_name|business_name)$/i.test(field))) {
        issues.push("backend/models.py Customer ORM model is missing a customer name/business-name field");
      }
      const customerClass = models.match(/class\s+Customer\s*\([^)]*\):[\s\S]*?(?=\nclass\s|$)/i)?.[0] ?? "";
      if (/(?:password_hash|password|role)\s*=/i.test(customerClass)) {
        issues.push("backend/models.py Customer ORM model mixes user authentication fields into the customer record; keep credentials and roles on User");
      }
      const schemas = all.find((file) => /(^|\/)backend\/schemas\.py$/i.test(file.path))?.content ?? "";
      const createFields = classFieldNames(schemas, "CustomerCreate");
      const responseFields = classFieldNames(schemas, "CustomerResponse");
      if (createFields.size === 0) issues.push("backend/schemas.py is missing the CustomerCreate request schema");
      if (responseFields.size === 0) issues.push("backend/schemas.py is missing the CustomerResponse schema");
      if (createFields.size > 0 && ![...createFields].some((field) => /^(?:name|company_name|business_name)$/i.test(field))) {
        issues.push("backend/schemas.py CustomerCreate is missing a customer name/business-name field");
      }
      if (createFields.size > 0) {
        const emailLike = (field: string) => /(?:^|_)(?:business_)?email(?:_address)?$/i.test(field) || /^email$/i.test(field);
        const requestEmailFields = [...createFields].filter(emailLike);
        const persistedEmailFields = [...customerModelFields].filter(emailLike);
        if (!requestEmailFields.length) issues.push("backend/schemas.py CustomerCreate is missing a contact-email field required for customer registration");
        else if (!persistedEmailFields.length) issues.push("backend/models.py Customer ORM model is missing a persisted contact-email field");
        else if (!requestEmailFields.some((field) => customerModelFields.has(field))) {
          issues.push(`CustomerCreate contact-email field(s) ${requestEmailFields.join(", ")} do not map to a persisted Customer ORM field (${persistedEmailFields.join(", ")})`);
        }
      }
      if (/\b(auth|authentication|login|role|authorization|jwt|oauth)\b/i.test(prompt) && !/class\s+User\s*\(/i.test(models)) {
        issues.push("backend/models.py is missing the persisted User ORM model required for authentication and role checks");
      }
    }
  }
  if (stage === "backend" || stage === "transactions") {
    for (const file of all.filter((candidate) => /(^|\/)backend\/routes?\/.*\.py$/i.test(candidate.path))) {
      if (/\bin_transaction\s*\(/.test(file.content) && !/^\s*from\s+tortoise\.transactions\s+import\s+[^\n#]*\bin_transaction\b/m.test(file.content)) {
        issues.push(`${file.path} uses in_transaction but does not import it`);
      }
    }
  }
  if (stage === "transactions" && TRANSACTION_RE.test(prompt)) {
    if (/\b(transaction|transactional|atomic)\b/i.test(prompt) && !/(transaction|begin\s+|commit\s|\.begin\(|\.commit\(|atomic\()/i.test(lower)) issues.push("requested transaction boundary is missing");
    // ApprovalEvent is the conventional Tortoise/ORM event entity name; it
    // represents audit history even when the source never uses the literal
    // words "audit" or "history". Do not reject valid persisted event writes
    // merely because the entity uses that name.
    if (/\b(audit|history)\b/i.test(prompt) && !/(audit|history|event_log|eventlog|approval\w*event|event\w*approval)/i.test(lower)) issues.push("requested audit/history persistence is missing");
    if (/\b(approve|approval|reject|submit)\b/i.test(prompt) && !/(approve|approval|reject|submit)/i.test(lower)) issues.push("requested business state transitions are missing");
    if (/customer/i.test(prompt) && /manager/i.test(prompt)) {
      if (!/submit_customer|submitcustomer|\/customers\/[^'"\s]*submit|submit.*customer/i.test(lower)) issues.push("customer submission transition is missing from backend handlers");
      if (!/approve_customer|approvecustomer|\/customers\/[^'"\s]*approve/i.test(lower)) issues.push("manager approval handler is missing");
      if (!/reject_customer|rejectcustomer|\/customers\/[^'"\s]*reject/i.test(lower)) issues.push("manager rejection handler is missing");
    }
    const backend = code.filter((file) => /(^|\/)(backend|server|api)\//i.test(file.path) && !/(^|\/)(?:tests?|__tests__)\//i.test(file.path));
    const backendCode = backend.map((file) => file.content).join("\n");
    const persistence = /(?:\.add\(|\.add_all\(|\.execute\(|\.commit\(|\.flush\(|\.save\(|\.create\(|\.insert\(|\.update\(|INSERT\s+INTO|UPDATE\s+\w+|\.save_changes\(|savechanges\(|\.persist\()/i;
    if (backend.length > 0 && !persistence.test(backendCode)) issues.push("business transition has no database write or repository persistence operation; mock success is not accepted");
    const auditWrite = /(?:audit|history|event_log|eventlog)[\s\S]{0,180}(?:\.add\(|\.execute\(|\.save\(|\.create\(|\.insert\(|INSERT\s+INTO|\.persist\()/i;
    const auditTableInsert = /INSERT\s+INTO\s+["`]?\w*(?:audit|approval|history|event)\w*["`]?/i.test(backendCode);
    const directAuditEntityWrite = /\.(?:add|create|insert|save|persist)\(\s*(?:new\s+)?\w*(?:audit|approval|history|event|log)\w*\s*\(/i.test(backendCode);
    // Tortoise persists a model with `await ApprovalEvent.create(...)`, where
    // the entity name precedes the write method. Treat this as a real database
    // write; the SQLAlchemy-oriented checks above are not sufficient here.
    const ormAuditEntityCreate = /\b\w*(?:audit|approval|history|event|log)\w*\s*\.\s*(?:create|insert|save)\s*\(/i.test(backendCode);
    const persistedEventVariables = [...backendCode.matchAll(/\b(?:(?:const|let|var)\s+)?([a-z_]\w*)\s*=\s*(?:new\s+)?([a-z_]\w*(?:audit|approval|history|event|log)\w*)\s*\(/gi)]
      .some(([, variable]) => new RegExp(`\\.(?:add|create|insert|save|persist)\\(\\s*${variable}\\b`, "i").test(backendCode));
    if (backend.length > 0 && /\b(audit|history)\b/i.test(prompt) && !auditWrite.test(backendCode) && !auditTableInsert && !directAuditEntityWrite && !ormAuditEntityCreate && !persistedEventVariables) {
      issues.push("audit/history is named but no audit event persistence operation is present");
    }
  }
  if (stage === "frontend" && FRONTEND_RE.test(prompt)) {
    if (!paths.some((path) => /(^|\/)(app|pages)\/.*\.(tsx?|jsx?)$/.test(path) || /(^|\/)(index|app)\.(tsx?|jsx?)$/.test(path) || /(^|\/)src\/(?:App|main)\.(tsx?|jsx?)$/.test(path))) issues.push("frontend application screens are missing");
    if (/\b(api|backend|fastapi|server)\b/i.test(prompt) && !/(fetch\s*\(|axios\.|\bapi\s*\()/i.test(lower)) issues.push("frontend is not connected to its backend API");
  }
  if (stage === "tests" && TEST_RE.test(prompt)) {
    const testFiles = all.filter((file) => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file.path));
    const cypressFiles = all.filter((file) => /(^|\/)(cypress)(\/|$)|\bcypress\b/i.test(file.path) || /from\s+["']cypress|\bcy\.(?:visit|request|get|contains)\s*\(/i.test(file.content));
    if (stage === "tests" && cypressFiles.length) issues.push(`Playwright is required; Cypress artifacts are incompatible: ${cypressFiles.map((file) => file.path).join(", ")}`);
    if (testFiles.length === 0) issues.push("automated test files are missing");
    if (testFiles.length > 0 && !testFiles.some((file) => /\bassert\b|\bexpect\s*\(|toHave|toBe\(/.test(file.content))) issues.push("automated tests contain no outcome assertions");
    if (testFiles.some((file) => /assert\s+(?:True|1\s*==\s*1)\s*$|\.skip\s*\(|test\.todo\s*\(/im.test(file.content))) issues.push("automated tests contain a vacuous assertion or skipped placeholder");
    if (/\b(api|integration)\b/i.test(prompt) && testFiles.length > 0 && !testFiles.some((file) => /(?:TestClient|httpx\.|requests\.|supertest|fetch\s*\(|axios\.|status_code|status\s*\))/.test(file.content))) issues.push("API integration tests do not make an HTTP request");
    if (/\b(e2e|end.to.end|playwright)\b/i.test(prompt)) {
      const e2e = all.filter((file) => /(^|\/)(?:e2e|tests\/e2e)\/.*\.spec\.[cm]?[jt]sx?$/i.test(file.path));
      if (e2e.length === 0) issues.push("requested browser E2E test is missing");
      if (!all.some((file) => /(^|\/)frontend\/playwright\.config\.[cm]?[jt]s$/i.test(file.path))) issues.push("Playwright configuration is missing from frontend/playwright.config.ts");
      const frontendManifest = all.find((file) => /(^|\/)frontend\/package\.json$/i.test(file.path));
      if (!frontendManifest) issues.push("frontend/package.json is required to install and run Playwright");
      else {
        try {
          const manifest = JSON.parse(frontendManifest.content) as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown>; dependencies?: Record<string, unknown> };
          if (!manifest.devDependencies?.["@playwright/test"] && !manifest.dependencies?.["@playwright/test"]) issues.push("frontend/package.json must declare @playwright/test");
          if (manifest.scripts?.["test:e2e"] !== "playwright test") issues.push("frontend/package.json must provide the 'test:e2e': 'playwright test' script");
        } catch {
          issues.push("frontend/package.json is invalid JSON and Playwright cannot be installed");
        }
      }
      if (e2e.length > 0 && !e2e.some((file) => /(?:page\.goto|page\.getBy|page\.locator|expect\s*\()/i.test(file.content))) issues.push("browser E2E file contains no real browser interactions or assertions");
      if (e2e.length > 0 && !e2e.some((file) => /import\s+\{[^}]*\btest\b[^}]*\bexpect\b[^}]*\}\s+from\s+["']@playwright\/test["']/s.test(file.content) && /\btest\s*\(/.test(file.content))) {
        issues.push("browser E2E artifact is malformed: it must import Playwright test/expect and declare an executable test");
      }
      if (e2e.some((file) => !hasBalancedDelimiters(file.content))) issues.push("browser E2E artifact is truncated or malformed: delimiters, strings, or comments are not closed");
      const flowPrompt = /customer/i.test(prompt) && /approv/i.test(prompt) && /manager/i.test(prompt);
      if (flowPrompt && e2e.length > 0) {
        const browserFlow = e2e.map((file) => file.content).join("\n");
        const required = [
          ["owner login", /owner|customer.*login/i],
          ["customer registration", /register|registration|create customer/i],
          ["form validation", /validation|invalid|toBeDisabled|toHaveText/i],
          ["API submission", /waitForResponse|\/customers|api/i],
          ["persistence after reload", /reload\s*\(|persist|still.*visible/i],
          ["manager authentication", /manager.*login|login.*manager/i],
          ["approval or rejection", /approve|reject/i],
          ["updated status assertion", /approved|rejected|status/i],
          ["audit history assertion", /audit|history/i],
        ] as const;
        for (const [capability, pattern] of required) if (!pattern.test(browserFlow)) issues.push(`browser E2E test does not verify ${capability}`);
        if (!/\.reload\s*\(|page\.reload\s*\(/i.test(browserFlow)) issues.push("browser E2E test does not verify customer persistence after a page reload");
        if (!/\.fill\s*\(|getByLabel\s*\(/i.test(browserFlow)) issues.push("browser E2E test does not fill and submit a real customer form");
      }
      if (flowPrompt) {
        const apiTests = all.filter((file) => /(^|\/)backend\/tests\/.*\.py$/i.test(file.path)).map((file) => file.content).join("\n");
        if (!apiTests) issues.push("backend API integration test suite is missing at backend/tests/");
        const requiredBackendScenarios: Array<[string, RegExp]> = [
          ["customer registration", /(?:registration|register|create_customer|create customer)/i],
          ["required-field validation", /(?:required|validation|missing.*field|invalid input)/i],
          ["authentication", /(?:auth|login|token|unauthorized)/i],
          ["role-based manager authorization", /(?:manager|role|forbidden|403)/i],
          ["approval", /approve/i],
          ["rejection", /reject/i],
          ["database persistence", /(?:persist|database|reload|select\(|refresh)/i],
          ["audit history", /(?:audit|history|event)/i],
          ["invalid state transition", /(?:invalid.*transition|state.*invalid|conflict|409)/i],
        ];
        for (const [scenario, pattern] of requiredBackendScenarios) if (apiTests && !pattern.test(apiTests)) issues.push(`backend API tests do not cover ${scenario}`);
      }
    }
  }
  return [...new Set(issues)];
}

export function filesWithEdits(context: ProjectContext | undefined, edits: ProposedEdit[]): Map<string, { content: string; action: ProposedEdit["action"]; originalPath?: string }> {
  const files = new Map<string, { content: string; action: ProposedEdit["action"]; originalPath?: string }>();
  for (const file of context?.relevantFiles ?? []) {
    if (file.content !== undefined) files.set(file.relPath.replaceAll("\\", "/").toLowerCase(), { content: file.content, action: "modify", originalPath: file.relPath.replaceAll("\\", "/") });
  }
  for (const edit of edits) {
    const key = edit.path.replaceAll("\\", "/").toLowerCase();
    const previous = files.get(key);
    files.set(key, { content: edit.content, action: previous?.action ?? edit.action, originalPath: edit.path.replaceAll("\\", "/") });
  }
  return files;
}

/**
 * Supply the stable Playwright harness from a small validated template. The
 * model still writes scenario-specific tests; this only wires the runner,
 * configuration, and package command consistently across providers.
 */
export function ensurePlaywrightHarness(edits: ProposedEdit[]): { edits: ProposedEdit[]; changedPaths: string[]; errors: string[] } {
  const byPath = new Map(edits.map((edit) => [edit.path.replaceAll("\\", "/").toLowerCase(), edit]));
  const manifestPath = "frontend/package.json";
  const manifestEdit = byPath.get(manifestPath);
  if (!manifestEdit) return { edits: [], changedPaths: [], errors: ["cannot configure Playwright because frontend/package.json is missing"] };
  let manifest: { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(manifestEdit.content);
  } catch {
    return { edits: [], changedPaths: [], errors: ["cannot configure Playwright because frontend/package.json is invalid JSON"] };
  }
  const scripts = { ...(manifest.scripts ?? {}), "test:e2e": "playwright test" };
  const devDependencies = { ...(manifest.devDependencies ?? {}) };
  const dependencies = { ...(manifest.dependencies ?? {}) };
  if (!dependencies["@playwright/test"] && !devDependencies["@playwright/test"]) devDependencies["@playwright/test"] = "^1.52.0";
  manifest.scripts = scripts;
  manifest.devDependencies = devDependencies;
  const updatedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const changed: ProposedEdit[] = [];
  if (updatedManifest !== manifestEdit.content) changed.push({ ...manifestEdit, path: manifestPath, content: updatedManifest });

  const configPath = "frontend/playwright.config.ts";
  if (!byPath.has(configPath)) {
    changed.push({
      path: configPath,
      action: "create",
      content: `import { defineConfig } from "@playwright/test";\n\nexport default defineConfig({\n  testDir: "./e2e",\n  testMatch: "**/*.spec.ts",\n  fullyParallel: false,\n  retries: 0,\n  reporter: "list",\n  use: {\n    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",\n    trace: "retain-on-failure",\n  },\n});\n`,
    });
  } else {
    const configEdit = byPath.get(configPath)!;
    if (/\bheadless\s*:\s*false\b/.test(configEdit.content)) {
      changed.push({ ...configEdit, content: configEdit.content.replace(/\bheadless\s*:\s*false\b/g, "headless: true") });
    }
  }
  return { edits: changed, changedPaths: changed.map((edit) => edit.path), errors: [] };
}

/**
 * Apply a narrow, deterministic safety repair to common Docker Compose short
 * port mappings. Publishing without a host address binds on every interface;
 * development services must remain reachable only from this machine. This
 * changes no container port or service behavior, only the host bind address.
 */
export function bindComposePortsToLoopback(edits: ProposedEdit[]): { edits: ProposedEdit[]; mappings: string[] } {
  const mappings: string[] = [];
  const nextEdits = edits.map((edit) => {
    if (!/(^|\/)(docker-compose|compose)\.ya?ml$/i.test(edit.path)) return edit;
    let inPorts = false;
    let portsIndent = -1;
    const content = edit.content.split(/\r?\n/).map((line) => {
      const indent = line.search(/\S/);
      const portsDeclaration = line.match(/^(\s*)ports\s*:\s*(.*)$/i);
      if (portsDeclaration) {
        portsIndent = portsDeclaration[1].length;
        inPorts = true;
        return line;
      }
      if (!inPorts || indent < 0) return line;
      if (indent <= portsIndent && !/^\s*-/.test(line)) {
        inPorts = false;
        return line;
      }
      const item = line.match(/^(\s*-\s*)(?:"([^"]*)"|'([^']*)'|([^#\s]+))(\s*(?:#.*)?)$/);
      if (!item) return line;
      const value = item[2] ?? item[3] ?? item[4] ?? "";
      const quoted = item[2] !== undefined ? '"' : item[3] !== undefined ? "'" : "";
      const parts = value.split(":");
      const validPort = (part: string) => /^\d{1,5}(?:\/(?:tcp|udp))?$/i.test(part);
      let bound = value;
      if (parts.length === 2 && parts.every(validPort)) bound = `127.0.0.1:${value}`;
      else if (parts.length === 3 && /^(?:0\.0\.0\.0|\[?::\]?)$/i.test(parts[0]) && validPort(parts[1]) && validPort(parts[2])) {
        bound = `127.0.0.1:${parts[1]}:${parts[2]}`;
      }
      if (bound === value) return line;
      mappings.push(`${value} -> ${bound}`);
      return `${item[1]}${quoted}${bound}${quoted}${item[5]}`;
    }).join("\n");
    return content === edit.content ? edit : { ...edit, content };
  });
  return { edits: nextEdits, mappings };
}
