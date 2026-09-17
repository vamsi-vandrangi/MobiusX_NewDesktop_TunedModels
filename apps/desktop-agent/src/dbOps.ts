import { access, readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { DatabaseConsistencyMismatch, DatabaseConsistencyReport, DatabaseOrmEntity, DatabaseRelationship, DatabaseSchemaTable } from "@mobiusx/protocol";

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
// A column-level `REFERENCES table(col)` constraint, e.g.
// `product_id INTEGER NOT NULL REFERENCES products(id),` -- captures the
// column carrying the FK plus the target table/column exactly as
// declared. Deliberately line-oriented (matches this codebase's own
// generated SQL style, one column per line) rather than a full SQL
// parser -- same conservatism as CREATE_TABLE_RE above.
const REFERENCES_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+[^,]*\bREFERENCES\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/i;

/**
 * Extracts both CREATE TABLE table names and column-level REFERENCES
 * relationships in a single pass, tracking "which table are we currently
 * inside" so a relationship is attributed to the table declaring the FK
 * column (`from`) and the table it points at (`to`) -- both exactly as
 * written, never resolved or corrected (see DatabaseRelationship's doc
 * comment on why an unresolved/dangling reference is still recorded
 * faithfully).
 */
async function extractSchemaTablesAndRelationships(
  root: string,
): Promise<{ tables: DatabaseSchemaTable[]; relationships: DatabaseRelationship[] }> {
  const files: string[] = [];
  await findSqlFiles(root, root, 0, files);
  const tables: DatabaseSchemaTable[] = [];
  const relationships: DatabaseRelationship[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.slice(root.length + 1);
    const lines = content.split(/\r?\n/);
    let currentTable: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      CREATE_TABLE_RE.lastIndex = 0;
      const m = CREATE_TABLE_RE.exec(lines[i]);
      if (m) {
        tables.push({ name: m[1], source: rel, line: i + 1 });
        currentTable = m[1];
        continue;
      }
      if (currentTable) {
        const rm = lines[i].match(REFERENCES_RE);
        if (rm) {
          relationships.push({
            from: currentTable,
            to: rm[2],
            via: `${rm[1]} -> ${rm[3]}`,
            source: rel,
            line: i + 1,
          });
        }
        // A bare closing paren/semicolon line ends this CREATE TABLE
        // statement in the style this codebase generates (see
        // CREATE_TABLE_RE's own doc comment on that convention).
        if (/^\s*\)\s*;?\s*$/.test(lines[i])) currentTable = null;
      }
    }
  }
  return { tables, relationships };
}

// Python candidate dirs -- same short list projectContext.ts/previewOps.ts
// already use for a project's backend, since that's where model files live.
const PY_CANDIDATE_DIRS = [".", "backend", "server", "api", "app"];
const PY_CLASS_RE = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/;
const TABLENAME_RE = /__tablename__\s*=\s*["']([\w]+)["']/;
const SQLMODEL_TABLE_TRUE_RE = /table\s*=\s*True/;
// e.g. `product_id: int = Field(foreign_key="products.id")` -- captures
// the field name plus the "table.column" string exactly as declared.
const FOREIGN_KEY_RE = /^\s*(\w+)\s*:.*foreign_key\s*=\s*["']([\w]+)\.([\w]+)["']/;

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
async function extractPythonOrmEntities(
  root: string,
): Promise<{ entities: DatabaseOrmEntity[]; relationships: DatabaseRelationship[] }> {
  const entities: DatabaseOrmEntity[] = [];
  const relationships: DatabaseRelationship[] = [];
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
        // Scan forward for an explicit __tablename__ and any foreign_key=
        // fields within this class's body, in one pass.
        let explicitTableName: string | null = null;
        const fkFields: Array<{ field: string; targetTable: string; targetCol: string; line: number }> = [];
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          // A non-blank line back at column 0 means we've dedented past
          // this class's body (Python bodies are indented) -- stop.
          if (line.trim().length > 0 && !/^\s/.test(line)) break;
          const tm = line.match(TABLENAME_RE);
          if (tm) explicitTableName = tm[1];
          const fkm = line.match(FOREIGN_KEY_RE);
          if (fkm) fkFields.push({ field: fkm[1], targetTable: fkm[2], targetCol: fkm[3], line: j + 1 });
        }
        const tableName = explicitTableName ?? className.toLowerCase();
        entities.push({
          name: className,
          tableName,
          source: relPath,
          line: i + 1,
        });
        for (const fk of fkFields) {
          relationships.push({
            from: tableName,
            to: fk.targetTable,
            via: `${fk.field} -> ${fk.targetCol}`,
            source: relPath,
            line: fk.line,
          });
        }
      }
    }
  }
  return { entities, relationships };
}

export async function checkDatabaseConsistency(projectRoot: string): Promise<DatabaseConsistencyReport> {
  const { tables: schemaTables, relationships: schemaRelationships } = await extractSchemaTablesAndRelationships(projectRoot);
  const { entities: ormEntities, relationships: ormRelationships } = await extractPythonOrmEntities(projectRoot);
  // Deduplicate by (from, via, to) -- the same relationship can legitimately
  // show up on both the schema side and the ORM side (that's the healthy
  // case), and this report should list it once, not twice.
  const relationships: DatabaseRelationship[] = [];
  const seen = new Set<string>();
  for (const r of [...schemaRelationships, ...ormRelationships]) {
    const key = `${r.from.toLowerCase()}|${r.via}|${r.to.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push(r);
  }

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
    relationships,
    overall,
  };
}
