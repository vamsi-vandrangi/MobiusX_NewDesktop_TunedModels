import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { AuthEvidence, ExistingAuthFileSample } from "@mobiusx/protocol";
import { detectProjectContext } from "./projectContext.js";

/**
 * Auth/RBAC Engineering (roadmap Phase 19, source requirement §12 --
 * "authentication and authorization engineering: RBAC, OAuth2, JWT
 * generation and verification"). Not itemized as its own phase in
 * docs/AI_ENGINEERING_PLATFORM_ROADMAP.md's original table -- it was
 * deferred as "a capability added incrementally to Phase 8/11/14," which
 * never actually happened; completion.ts's `auth_verified` criterion
 * stayed permanently `not_configured` through Phases 6-18. This module
 * closes that gap.
 *
 * Same root-cause diagnosis every generation mode before it already made
 * (Database/Phase 8, Architecture/Phase 9, Testing/Phase 10, DevOps/Phase
 * 14): a model asked to add authentication with zero real facts about
 * this project's actual backend framework and whatever auth machinery
 * already exists has nothing to go on but generic, often-wrong
 * boilerplate. This module gathers exactly the real facts Auth mode's
 * prompt needs, honestly:
 *
 * 1. authComponents -- reuses Phase 7's OWN "auth" category detection
 *    (never re-guessed here): NextAuth/Passport/jsonwebtoken on the JS
 *    side, python-jose/PyJWT/Authlib/Flask-Login on the Python side.
 *    Empty when this project declares no auth dependency at all.
 * 2. backendComponents -- this project's real detected backend
 *    component(s) and their real locations (Phase 7), so generated
 *    middleware/routes land in the right directory rather than an
 *    invented one.
 * 3. existingAuthFiles -- up to a small handful of this project's own
 *    real files matched by auth-shaped filename/path convention, full
 *    content, so the model extends/matches an existing implementation
 *    instead of introducing a second, competing one. Honestly empty when
 *    this project has no auth-shaped file yet.
 */

// Filename/path fragments that plausibly hold real auth implementation
// code -- deliberately broad (filename convention only, never content
// sniffing) matching the same "found by convention, not guessed" bar
// testingContext.ts's TEST_FILE_PATTERNS already set.
const AUTH_FILE_PATTERNS: RegExp[] = [
  /(^|\/)auth(entication)?[\/._-]/i,
  /(^|\/)(middleware|guards?)[\/._-].*auth/i,
  /(^|\/)jwt[\/._-]/i,
  /(^|\/)(login|signin|signup|register)[\/._-]/i,
  /(^|\/)rbac[\/._-]/i,
  /(^|\/)permissions?[\/._-]/i,
];

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".mobiusx", ".next"]);

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

function isAuthFile(relPath: string): boolean {
  return AUTH_FILE_PATTERNS.some((re) => re.test(relPath));
}

/**
 * Finds up to `limit` of this project's own existing auth-shaped files,
 * full content -- see this module's doc comment. Returns [] honestly when
 * none exist; Auth mode's prompt falls back to proposing a fresh
 * implementation in that case rather than guessing a style.
 */
async function findExistingAuthFiles(projectRoot: string, limit = 3): Promise<ExistingAuthFileSample[]> {
  const allFiles: string[] = [];
  await listFilesRecursive(projectRoot, 0, allFiles);
  const relCandidates = allFiles
    .map((f) => f.slice(projectRoot.length + 1))
    .filter((rel) => isAuthFile(rel))
    .slice(0, limit);
  const samples: ExistingAuthFileSample[] = [];
  for (const rel of relCandidates) {
    try {
      const content = await readFile(join(projectRoot, rel), "utf8");
      samples.push({ relPath: rel, content });
    } catch {
      // unreadable -- skip, not this module's concern
    }
  }
  return samples;
}

/**
 * Filename convention this module uses to decide a file is "real
 * auth implementation code" for completion.ts's auth_verified criterion
 * (distinct from, and stricter than, findExistingAuthFiles' broader
 * evidence-gathering match above): the file must ALSO contain a
 * token-verification-shaped call, not just live at an auth-shaped path --
 * a route file merely importing an auth library isn't "verified," it's
 * "declared." Exported so completion.ts can reuse this exact, single
 * definition rather than a second copy of the same heuristic.
 */
const TOKEN_VERIFY_CALL_RE = /\b(jwt\.decode|jwt\.verify|verify_jwt|getServerSession|passport\.authenticate|jose\.jwtVerify|check_password_hash|verify_password)\b/;

export async function hasWiredAuthImplementation(projectRoot: string): Promise<boolean> {
  const files = await findExistingAuthFiles(projectRoot, 25); // wider scan than the evidence bundle's UI-facing sample -- this is a boolean check, not something rendered
  return files.some((f) => TOKEN_VERIFY_CALL_RE.test(f.content));
}

export async function gatherAuthEvidence(projectRoot: string): Promise<AuthEvidence> {
  const projectContext = await detectProjectContext(projectRoot);
  const authComponents = projectContext.components.filter((c) => c.category === "auth");
  const backendComponents = projectContext.components.filter((c) => c.category === "backend");
  const existingAuthFiles = await findExistingAuthFiles(projectRoot);

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    authComponents,
    backendComponents,
    existingAuthFiles,
  };
}
