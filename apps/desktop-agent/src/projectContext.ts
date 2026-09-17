import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DetectedComponent, ProjectContextCategory, ProjectContextReport } from "@mobiusx/protocol";

/**
 * Project Understanding Engine (roadmap Phase 7, source requirement §5): a
 * real, evidence-based tech-stack detector -- never a guess from the
 * project's name or the request that built it. Deliberately conservative,
 * in the same spirit as verify.ts and previewOps.ts: a component is only
 * ever reported because a real dependency, file, or connection string was
 * found on disk, with that evidence recorded alongside it.
 *
 * Scans the project root plus a short list of common monorepo
 * subdirectories (the same candidate list previewOps.ts's
 * detectFrontend/detectBackend use, unioned) since many generated projects
 * -- see Test Projects/GreenThumbGarden -- have no root package.json at
 * all: their frontend and backend each live in their own subdirectory with
 * their own manifest.
 */

const CANDIDATE_DIRS = [".", "frontend", "client", "web", "app", "backend", "server", "api"];

// package.json dependency name -> [category, display name]. Checked against
// the union of dependencies + devDependencies. First match per category
// wins for a given directory (a project's package.json realistically
// declares one frontend framework, one backend framework, etc.).
const JS_DEP_SIGNALS: Array<[RegExp, ProjectContextCategory, string]> = [
  [/^next$/, "frontend", "Next.js"],
  [/^nuxt$/, "frontend", "Nuxt"],
  [/^@angular\/core$/, "frontend", "Angular"],
  [/^svelte$/, "frontend", "Svelte"],
  [/^vue$/, "frontend", "Vue"],
  [/^react-native$/, "frontend", "React Native"],
  [/^react$/, "frontend", "React"],
  [/^@nestjs\/core$/, "backend", "NestJS"],
  [/^express$/, "backend", "Express"],
  [/^fastify$/, "backend", "Fastify"],
  [/^koa$/, "backend", "Koa"],
  [/^@prisma\/client$/, "orm", "Prisma"],
  [/^prisma$/, "orm", "Prisma"],
  [/^sequelize$/, "orm", "Sequelize"],
  [/^typeorm$/, "orm", "TypeORM"],
  [/^drizzle-orm$/, "orm", "Drizzle"],
  [/^mongoose$/, "orm", "Mongoose"],
  [/^pg$/, "database", "PostgreSQL"],
  [/^mysql2?$/, "database", "MySQL"],
  [/^mongodb$/, "database", "MongoDB"],
  [/^better-sqlite3$/, "database", "SQLite"],
  [/^sqlite3$/, "database", "SQLite"],
  [/^next-auth$/, "auth", "NextAuth"],
  [/^passport$/, "auth", "Passport"],
  [/^jsonwebtoken$/, "auth", "JWT (jsonwebtoken)"],
  [/^jest$/, "testFramework", "Jest"],
  [/^vitest$/, "testFramework", "Vitest"],
  [/^mocha$/, "testFramework", "Mocha"],
  [/^@playwright\/test$/, "testFramework", "Playwright"],
  [/^cypress$/, "testFramework", "Cypress"],
];

// requirements.txt / pyproject.toml package name -> [category, display
// name]. Matched as a whole line/token (package specifiers can carry
// version pins like "fastapi==0.110.0" or "fastapi>=0.100").
const PY_DEP_SIGNALS: Array<[RegExp, ProjectContextCategory, string]> = [
  [/^fastapi/i, "backend", "FastAPI"],
  [/^django\b/i, "backend", "Django"],
  [/^flask\b/i, "backend", "Flask"],
  [/^sqlmodel/i, "orm", "SQLModel"],
  [/^sqlalchemy/i, "orm", "SQLAlchemy"],
  [/^alembic/i, "orm", "Alembic (migrations)"],
  [/^psycopg2?/i, "database", "PostgreSQL"],
  [/^asyncpg/i, "database", "PostgreSQL"],
  [/^pymysql|mysqlclient/i, "database", "MySQL"],
  [/^pymongo/i, "database", "MongoDB"],
  [/^python-jose|pyjwt/i, "auth", "JWT"],
  [/^authlib/i, "auth", "Authlib"],
  [/^flask-login/i, "auth", "Flask-Login"],
  [/^pytest/i, "testFramework", "pytest"],
];

// Connection-string patterns checked against a short list of common
// config/source filenames -- catches the SQLite/Postgres/MySQL/Mongo
// choice even when it's only visible in code (e.g. SQLModel's
// `create_engine("sqlite:///...")`), not in a dependency name.
const DB_URL_FILES = ["database.py", "db.py", "settings.py", "config.py", ".env", ".env.example"];
const DB_URL_SIGNALS: Array<[RegExp, string]> = [
  [/sqlite:\/\//, "SQLite"],
  [/postgres(ql)?:\/\//, "PostgreSQL"],
  [/mysql:\/\//, "MySQL"],
  [/mongodb(\+srv)?:\/\//, "MongoDB"],
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function detectFromPackageJson(dir: string, relDir: string, found: DetectedComponent[]): Promise<void> {
  const pkg = await readJson(join(dir, "package.json"));
  if (!pkg) return;
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
  const claimedCategories = new Set<ProjectContextCategory>();
  for (const [pattern, category, name] of JS_DEP_SIGNALS) {
    if (claimedCategories.has(category)) continue; // one frontend framework, one backend framework, etc. per directory
    const match = Object.keys(deps).find((dep) => pattern.test(dep));
    if (match) {
      found.push({ category, name, location: relDir, evidence: `${relDir}/package.json: dependency "${match}"@${deps[match]}` });
      claimedCategories.add(category);
    }
  }
}

async function detectFromPython(dir: string, relDir: string, found: DetectedComponent[]): Promise<void> {
  let raw: string | null = null;
  let sourceFile = "requirements.txt";
  if (await fileExists(join(dir, "requirements.txt"))) {
    raw = await readFile(join(dir, "requirements.txt"), "utf8").catch(() => null);
  } else if (await fileExists(join(dir, "pyproject.toml"))) {
    raw = await readFile(join(dir, "pyproject.toml"), "utf8").catch(() => null);
    sourceFile = "pyproject.toml";
  }
  if (!raw) return;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const claimedCategories = new Set<ProjectContextCategory>();
  for (const [pattern, category, name] of PY_DEP_SIGNALS) {
    if (claimedCategories.has(category)) continue;
    const match = lines.find((l) => pattern.test(l));
    if (match) {
      found.push({ category, name, location: relDir, evidence: `${relDir}/${sourceFile}: "${match}"` });
      claimedCategories.add(category);
    }
  }
}

async function detectDatabaseFromConnectionStrings(dir: string, relDir: string, found: DetectedComponent[]): Promise<void> {
  if (found.some((c) => c.category === "database" && c.location === relDir)) return; // already found via a dependency (e.g. `pg`) -- don't double-report
  for (const filename of DB_URL_FILES) {
    const path = join(dir, filename);
    if (!(await fileExists(path))) continue;
    const content = await readFile(path, "utf8").catch(() => "");
    for (const [pattern, name] of DB_URL_SIGNALS) {
      if (pattern.test(content)) {
        found.push({ category: "database", name, location: relDir, evidence: `${relDir}/${filename}: connection string matches ${pattern}` });
        return; // one DB per directory is the realistic case
      }
    }
  }
}

async function detectInfra(projectRoot: string, found: DetectedComponent[]): Promise<void> {
  if (await fileExists(join(projectRoot, "Dockerfile"))) {
    found.push({ category: "infra", name: "Docker", location: ".", evidence: "Dockerfile present at project root" });
  }
  for (const name of ["docker-compose.yml", "docker-compose.yaml"]) {
    if (await fileExists(join(projectRoot, name))) {
      found.push({ category: "infra", name: "Docker Compose", location: ".", evidence: `${name} present at project root` });
      break;
    }
  }
  if (await fileExists(join(projectRoot, ".github", "workflows"))) {
    found.push({ category: "infra", name: "GitHub Actions CI", location: ".", evidence: ".github/workflows/ present" });
  }
}

/**
 * Computes a real ProjectContextReport for `projectRoot` and writes it to
 * `.mobiusx/PROJECT_CONTEXT.md` + `.mobiusx/project-context.json`
 * (best-effort -- a write failure never blocks returning the report).
 */
export async function detectProjectContext(projectRoot: string): Promise<ProjectContextReport> {
  const found: DetectedComponent[] = [];

  for (const rel of CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    if (rel !== "." && !(await fileExists(dir))) continue;
    await detectFromPackageJson(dir, rel, found);
    await detectFromPython(dir, rel, found);
    await detectDatabaseFromConnectionStrings(dir, rel, found);
  }
  await detectInfra(projectRoot, found);

  const allCategories: ProjectContextCategory[] = ["frontend", "backend", "database", "orm", "auth", "testFramework", "infra"];
  const foundCategories = new Set(found.map((c) => c.category));
  const unknownCategories = allCategories.filter((c) => !foundCategories.has(c));

  const report: ProjectContextReport = {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    components: found,
    unknownCategories,
  };

  try {
    const dir = join(projectRoot, ".mobiusx");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "project-context.json"), JSON.stringify(report, null, 2), "utf8");
    await writeFile(join(dir, "PROJECT_CONTEXT.md"), renderMarkdown(report), "utf8");
  } catch {
    // best-effort artifact write -- the API response returned to the caller is still authoritative
  }

  return report;
}

function renderMarkdown(report: ProjectContextReport): string {
  const byCategory = new Map<ProjectContextCategory, DetectedComponent[]>();
  for (const c of report.components) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const labels: Record<ProjectContextCategory, string> = {
    frontend: "Frontend",
    backend: "Backend",
    database: "Database",
    orm: "ORM",
    auth: "Auth",
    testFramework: "Test framework",
    infra: "Infra",
  };
  const allCategories: ProjectContextCategory[] = ["frontend", "backend", "database", "orm", "auth", "testFramework", "infra"];
  const lines: string[] = [
    "# Project Context",
    "",
    `Auto-detected ${new Date(report.generatedAt).toLocaleString()} from on-disk evidence — see project-context.json for the machine-readable form. Regenerate via the Project Context panel any time the stack changes.`,
    "",
  ];
  for (const cat of allCategories) {
    const items = byCategory.get(cat);
    lines.push(`## ${labels[cat]}`);
    if (!items || items.length === 0) {
      lines.push("", "_Not detected._", "");
      continue;
    }
    for (const c of items) {
      lines.push(`- **${c.name}** (${c.location}/) — ${c.evidence}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
