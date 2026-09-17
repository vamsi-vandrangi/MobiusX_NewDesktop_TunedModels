import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { ExistingTestFileSample, TestingEvidence } from "@mobiusx/protocol";
import { detectProjectContext } from "./projectContext.js";

/**
 * Testing Engine (roadmap Phase 10, source requirement §15).
 *
 * verify.ts (roadmap Phase 6) only ever RUNS a project's own test
 * suite -- nothing in this codebase generated one. Following the exact
 * "evidence, not intention" lesson Database mode (Phase 8) and
 * Architecture mode (Phase 9) already established: a model asked to
 * write tests with no real facts about this project's test framework has
 * nothing to go on but a guessed one (often the wrong ecosystem entirely
 * -- e.g. proposing a Jest test for a Python backend), and no facts about
 * this project's own test style has nothing to match but a generic
 * convention that may collide with what's already there. This module
 * gathers exactly those two things, honestly:
 *
 * 1. testFrameworks -- reuses Phase 7's own project-context detection
 *    (never re-guessed here) so this project's REAL, already-evidenced
 *    test framework(s) per location are what ground the prompt. Empty
 *    when nothing was detected -- Testing mode's prompt is instructed to
 *    say so and propose nothing, rather than invent a framework this
 *    project doesn't actually have installed.
 * 2. existingTestFiles -- up to a small handful of this project's own
 *    real test files (full content), found by filename convention
 *    (test_*.py / *_test.py / *.test.ts(x) / *.spec.ts(x)), so the model
 *    can match this project's own import layout, fixtures, and assertion
 *    style instead of introducing a competing convention. Honestly empty
 *    when this project has no test files yet.
 */

const TEST_FILE_PATTERNS: RegExp[] = [/^test_.+\.py$/, /.+_test\.py$/, /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/];

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

function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERNS.some((re) => re.test(filename));
}

/**
 * Finds up to `limit` of this project's own existing test files, full
 * content -- see this module's doc comment. Returns [] honestly when none
 * exist; Testing mode's prompt falls back to an idiomatic per-framework
 * default in that case rather than guessing a style.
 */
async function findExistingTestFiles(projectRoot: string, limit = 2): Promise<ExistingTestFileSample[]> {
  const allFiles: string[] = [];
  await listFilesRecursive(projectRoot, 0, allFiles);
  const testFiles = allFiles.filter((f) => isTestFile(basename(f))).slice(0, limit);
  const samples: ExistingTestFileSample[] = [];
  for (const file of testFiles) {
    try {
      const content = await readFile(file, "utf8");
      samples.push({ relPath: file.slice(projectRoot.length + 1), content });
    } catch {
      // unreadable -- skip, not this module's concern
    }
  }
  return samples;
}

export async function gatherTestingEvidence(projectRoot: string): Promise<TestingEvidence> {
  const projectContext = await detectProjectContext(projectRoot);
  const testFrameworks = projectContext.components.filter((c) => c.category === "testFramework");
  const existingTestFiles = await findExistingTestFiles(projectRoot);

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    testFrameworks,
    existingTestFiles,
  };
}
