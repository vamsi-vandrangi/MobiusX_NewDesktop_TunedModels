import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { EnvFileGenerateResponse, EnvVarReference } from "@mobiusx/protocol";

/**
 * Config/env-file generation (roadmap Phase 23, source requirement §13).
 * Not itemized as its own phase in docs/AI_ENGINEERING_PLATFORM_ROADMAP.md's
 * original table -- it was described as "already partially covered by
 * Phase 6's env handling," which turned out not to be true:
 * previewOps.ts's `env: process.env` just passes the CURRENT process's
 * own environment through to a spawned dev server, and
 * projectContext.ts's `.env`/`.env.example` reference is only ever READ
 * to sniff a database connection string, never generated. This module
 * closes that specific, honestly-diagnosed gap.
 *
 * Same "evidence, not invention" discipline as every generation mode
 * before it: rather than guessing what config a project "should" have
 * (an invented API_KEY, an invented FEATURE_FLAG_X that doesn't exist),
 * this scans the project's OWN real source files for actual
 * environment-variable reads (`process.env.X` / `import.meta.env.X` in
 * JS/TS, `os.environ.get("X")` / `os.getenv("X")` in Python) and reports
 * exactly the variable names the code ITSELF already depends on, each
 * with the real file that reads it. Generating `.env.example` from this
 * is then purely mechanical: one placeholder line per REAL reference,
 * never a value (never a real secret), and an existing `.env.example`'s
 * already-set entries are always preserved -- this only ever ADDS a
 * missing key, never overwrites or removes a line a person put there.
 */

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".mobiusx", ".next"]);
const SCANNABLE_EXT = /\.(js|jsx|ts|tsx|py)$/i;

const ENV_VAR_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /os\.environ(?:\.get)?\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /os\.environ\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
];

async function listFilesRecursive(dir: string, depth: number, results: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFilesRecursive(full, depth + 1, results);
    } else {
      results.push(full);
    }
  }
}

/** Scans this project's own real source files for actual environment-variable reads -- see module doc comment. Returns each DISTINCT variable name once, with the first real file found reading it, sorted alphabetically for a stable, readable report. */
export async function detectReferencedEnvVars(projectRoot: string): Promise<EnvVarReference[]> {
  const allFiles: string[] = [];
  await listFilesRecursive(projectRoot, 0, allFiles);
  const byName = new Map<string, EnvVarReference>();
  for (const abs of allFiles) {
    if (!SCANNABLE_EXT.test(abs)) continue;
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(projectRoot, abs);
    for (const pattern of ENV_VAR_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const name = match[1];
        if (!byName.has(name)) byName.set(name, { name, relPath });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parses an existing .env/.env.example's own already-set KEY names (ignoring values, comments, blank lines) so generation never overwrites or duplicates a line a person already has. */
function parseExistingKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    keys.add(trimmed.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Generates or updates `.env.example` at the project root: one
 * `KEY=` placeholder line per real detected env-var reference NOT
 * already present in the existing file, appended under a clearly labeled
 * section with a comment naming the real file that reads each one.
 * Never touches an existing line -- pure, safe addition. Returns which
 * keys were newly added (empty when the file already covered everything
 * detected, which is itself a valid, honest "nothing to do" result).
 */
export async function generateEnvExample(projectRoot: string): Promise<EnvFileGenerateResponse> {
  const references = await detectReferencedEnvVars(projectRoot);
  const envExamplePath = join(projectRoot, ".env.example");
  let existing = "";
  try {
    existing = await readFile(envExamplePath, "utf8");
  } catch {
    existing = "";
  }
  const existingKeys = parseExistingKeys(existing);
  const missing = references.filter((r) => !existingKeys.has(r.name));

  if (missing.length === 0) {
    return { projectPath: projectRoot, references, addedKeys: [], envExamplePath: ".env.example", wroteFile: false };
  }

  const additions = [
    "",
    `# Added by MobiusX.ai Auth/DevOps config detection (roadmap Phase 23) -- ${new Date().toISOString()}`,
    "# Each key below was found actually read by this project's own code (see the file noted per line).",
    "# Fill in a real value for your own environment; never commit a real .env with real secrets.",
    ...missing.map((r) => `${r.name}=  # referenced in ${r.relPath}`),
    "",
  ].join("\n");

  const newContent = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" + additions : existing + additions;
  await writeFile(envExamplePath, newContent, "utf8");

  return {
    projectPath: projectRoot,
    references,
    addedKeys: missing.map((r) => r.name),
    envExamplePath: ".env.example",
    wroteFile: true,
  };
}
