import { access, readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { DatabaseConsistencyMismatch, DatabaseConsistencyReport, DatabaseOrmEntity, DatabaseSchemaTable } from "@mobiusx/protocol";

/**
 * Database Engineering (roadmap Phase 8, source requirement §8): a real,
 * evidence-based cross-check between a project's SQL schema/migration
 * source(s) and its ORM model file(s) -- the "domain-model -> ER -> schema
 * -> ORM -> API consistency check" the source requirement asks for.
 *
 * v1 scope, deliberately conservative in the same spirit as verify.ts and
 * projectContext.ts: schema-side detection is real SQL parsing (regex-based
 * `CREATE TABLE` extraction, not a full SQL parser, but grounded in real
 * file content, never guessed) across a bounded set of conventional
 * locations. ORM-side detection currently understands ONE convention --
 * Python SQLModel/SQLAlchemy declarative classes (`class Foo(SQLModel,
 * table=True):` / `class Foo(Base):`) -- because that's the only ORM this
 * codebase's own test projects (and Phase 7's ORM detection) can evidence
 * live. Prisma/Sequelize/TypeORM/Mongoose are NOT parsed yet: a project
 * using one of those gets ormDetected: null and an empty ormEntities list
 * -- never a fabricated, unparsed guess. This mirrors ProjectContextReport
 * and ProjectCompletionReport's honesty discipline exactly: an unsupported
 * case is reported as "not measured", not silently wrong.
 *
 * Also mirrors SQLModel/SQLAlchemy's own real default: a model class with
 * no explicit __tablename__ maps to its class name lowercased (not
 * pluralized) -- this checker applies that exact rule rather than
 * guessing a different convention.
 */

const SQL_DIR_NAMES = new Set(["db", "database", "migrations"]);
const MAX_DEPTH = 4;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Bounded recursive walk collecting .sql files under the project root, plus any directory literally named db/database/migrations (at any depth up to MAX_DEPTH) -- never a full unrestricted tree walk. */
async function findSqlFiles(root: string, dir: string, depth: number, results: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SQL_DIR_NAMES.has(entry.name.toLowerCase()) || depth < 2) {
        await findSqlFiles(root, full, depth + 1, results);
      }
    } else if (extname(entry.name).toLowerCase() === ".sql") {
      results.push(full);
    }
  }
}

const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?/gi;

async function extractSchemaTables(root: string): Promise<DatabaseSchemaTable[]> {
  const files: string[] = [];
  await findSqlFiles(root, root, 0, files);
  const tables: DatabaseSchemaTable[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.slice(root.length + 1);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      CREATE_TABLE_RE.lastIndex = 0;
      const m = CREATE_TABLE_RE.exec(lines[i]);
      if (m) tables.push({ name: m[1], source: rel, line: i + 1 });
    }
  }
  return tables;
}

// Python candidate dirs -- same short list projectContext.ts/previewOps.ts
// already use for a project's backend, since that's where model files live.
const PY_CANDIDATE_DIRS = [".", "backend", "server", "api", "app"];
const PY_CLASS_RE = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/;
const TABLENAME_RE = /__tablename__\s*=\s*["']([\w]+)["']/;
const SQLMODEL_TABLE_TRUE_RE = /table\s*=\s*True/;

/**
 * Regex-based (not an AST parser) scan for SQLModel/SQLAlchemy declarative
 * model classes: a class definition, its base list, and -- if present --
 * an explicit __tablename__ within the class body (found by scanning
 * forward until the next top-level `class`/`def` or end of file). Only
 * counts a class as a real ORM entity when its bases evidence SQLModel
 * (`SQLModel` base + `table=True`) or a SQLAlchemy declarative base
 * (base name containing "Base"), matching what Phase 7's projectContext.ts
 * already looks for when it reports "SQLModel"/"SQLAlchemy" as the
 * project's ORM.
 */
async function extractPythonOrmEntities(root: string): Promise<DatabaseOrmEntity[]> {
  const entities: DatabaseOrmEntity[] = [];
  for (const rel of PY_CANDIDATE_DIRS) {
    const dir = join(root, rel);
    if (rel !== "." && !(await fileExists(dir))) continue;
    let files: string[];
    try {
      files = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".py")).map((e) => e.name);
    } catch {
      continue;
    }
    for (const fname of files) {
      const filePath = join(dir, fname);
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const relPath = rel === "." ? fname : `${rel}/${fname}`;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(PY_CLASS_RE);
        if (!m) continue;
        const [, className, bases] = m;
        const isSqlModel = /SQLModel/.test(bases) && SQLMODEL_TABLE_TRUE_RE.test(lines[i]);
        const isSqlAlchemyBase = /\bBase\b/.test(bases);
        if (!isSqlModel && !isSqlAlchemyBase) continue;
        // Scan forward for an explicit __tablename__ within this class's body.
        let explicitTableName: string | null = null;
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          // A non-blank line back at column 0 means we've dedented past
          // this class's body (Python bodies are indented) -- stop.
          if (line.trim().length > 0 && !/^\s/.test(line)) break;
          const tm = line.match(TABLENAME_RE);
          if (tm) {
            explicitTableName = tm[1];
            break;
          }
        }
        entities.push({
          name: className,
          tableName: explicitTableName ?? className.toLowerCase(),
          source: relPath,
          line: i + 1,
        });
      }
    }
  }
  return entities;
}

export async function checkDatabaseConsistency(projectRoot: string): Promise<DatabaseConsistencyReport> {
  const schemaTables = await extractSchemaTables(projectRoot);
  const ormEntities = await extractPythonOrmEntities(projectRoot);

  const ormDetected = ormEntities.length > 0 ? "SQLModel/SQLAlchemy (Python)" : null;

  const mismatches: DatabaseConsistencyMismatch[] = [];
  // Only a REAL cross-check when both a schema source and ORM entities
  // were found -- otherwise there is nothing on one side to compare
  // against, so no mismatch is reported (never a fabricated "gap" just
  // because this project keeps its schema entirely in ORM metadata, or
  // entirely in hand-written SQL with no ORM at all -- both are
  // legitimate, common setups).
  if (schemaTables.length > 0 && ormEntities.length > 0) {
    const ormTableNames = new Set(ormEntities.map((e) => e.tableName.toLowerCase()));
    const schemaTableNames = new Set(schemaTables.map((t) => t.name.toLowerCase()));
    for (const t of schemaTables) {
      if (!ormTableNames.has(t.name.toLowerCase())) {
        mismatches.push({
          kind: "table_without_model",
          tableName: t.name,
          detail: `"${t.name}" is defined in ${t.source}:${t.line} but no ORM model maps to it.`,
        });
      }
    }
    for (const e of ormEntities) {
      if (!schemaTableNames.has(e.tableName.toLowerCase())) {
        mismatches.push({
          kind: "model_without_table",
          tableName: e.tableName,
          detail: `${e.name} (${e.source}:${e.line}) maps to table "${e.tableName}", which no schema source defines.`,
        });
      }
    }
  }

  const overall: DatabaseConsistencyReport["overall"] =
    schemaTables.length === 0 && ormEntities.length === 0
      ? "unknown"
      : schemaTables.length > 0 && ormEntities.length > 0
        ? mismatches.length === 0
          ? "consistent"
          : "mismatches_found"
        : "unknown";

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    ormDetected,
    schemaTables,
    ormEntities,
    mismatches,
    overall,
  };
}
