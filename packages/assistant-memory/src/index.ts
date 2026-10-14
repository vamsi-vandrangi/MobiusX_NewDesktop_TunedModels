import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryFile } from "@mobiusx/protocol";

/**
 * Assistant Memory (Oct 2026 addition) — a cross-SESSION, cross-PROJECT
 * memory for the AI Assistant itself: durable facts about the user and how
 * they like to work, written once and then surfaced automatically on every
 * future task, in any project. This is the one capability the gap
 * comparison against Claude Chat/Code turned up that MobiusX had nothing
 * resembling before this file existed — see docs/architecture.md's roadmap
 * notes for the comparison this was built from.
 *
 * Deliberately modeled on steering.ts's file shape and honesty rules (one
 * markdown file per subject, content is either user-written or
 * AI-extracted-and-reviewable, nothing is silently invented) but GLOBAL,
 * under `~/.mobiusx/memory/` rather than a single project's `.mobiusx/` —
 * the whole point is that it survives switching projects, the way the
 * user's own memory of their own preferences would. Three real differences
 * from steering.ts justify a separate module rather than reusing it:
 *  1. No projectRoot parameter anywhere — every function operates on the
 *     one global directory.
 *  2. appendMemoryFacts() below, used by the automatic-extraction path
 *     (see apps/cloud-agent-gateway/src/runners/memoryExtraction.ts) to
 *     merge newly-learned lines into an existing file without clobbering
 *     what's already there — steering.ts has no such writer; every
 *     steering write is a full, deliberate user edit.
 *  3. scaffoldDefaultMemory()'s templates are genuinely empty (just a
 *     heading) rather than steering's example-filled prose — this module
 *     must never put words in the user's mouth about who they are.
 */

const MEMORY_DIR = process.env.MOBIUSX_MEMORY_DIR ?? join(homedir(), ".mobiusx", "memory");
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** Seeded once via scaffoldDefaultMemory() — "topic-<slug>" files are created on demand by the extractor itself (see memoryExtraction.ts), never scaffolded in advance. */
export const DEFAULT_MEMORY_TEMPLATES: { name: string; title: string }[] = [
  { name: "profile", title: "Profile" },
  { name: "preferences", title: "Working Preferences" },
];

/** Absolute path to the memory directory in use (honors MOBIUSX_MEMORY_DIR, same override convention as @mobiusx/agent-settings' MOBIUSX_SETTINGS_DIR) — exposed so routes.ts can report it in MemoryListResponse.dir without duplicating the env-override logic. */
export function getMemoryDir(): string {
  return MEMORY_DIR;
}

function safePath(name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error("name must contain only letters, numbers, hyphens, and underscores");
  }
  return join(MEMORY_DIR, `${name}.md`);
}

export async function listMemoryFiles(): Promise<MemoryFile[]> {
  let entries: string[];
  try {
    entries = await readdir(MEMORY_DIR);
  } catch {
    return []; // no ~/.mobiusx/memory/ yet -- not an error, just nothing written yet
  }
  const files: MemoryFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(MEMORY_DIR, entry);
    try {
      const [content, st] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
      files.push({ name: entry.slice(0, -3), path: abs, content, updatedAt: st.mtime.toISOString() });
    } catch {
      // file vanished between readdir and read -- skip it, next list picks up reality
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

export async function writeMemoryFile(name: string, content: string): Promise<MemoryFile> {
  const abs = safePath(name);
  await mkdir(MEMORY_DIR, { recursive: true });
  await writeFile(abs, content, "utf8");
  const st = await stat(abs);
  return { name, path: abs, content, updatedAt: st.mtime.toISOString() };
}

export async function deleteMemoryFile(name: string): Promise<void> {
  const abs = safePath(name);
  await rm(abs, { force: true });
}

/** Seeds the (near-empty) default templates above — only files that don't already exist are written, same safe-to-call-repeatedly contract as steering.ts's scaffoldDefaultSteering. */
export async function scaffoldDefaultMemory(): Promise<MemoryFile[]> {
  const existing = new Set((await listMemoryFiles()).map((f) => f.name));
  const written: MemoryFile[] = [];
  for (const tpl of DEFAULT_MEMORY_TEMPLATES) {
    if (existing.has(tpl.name)) continue;
    written.push(await writeMemoryFile(tpl.name, `# ${tpl.title}\n\n`));
  }
  return written;
}

/**
 * Merges newly-learned lines into one memory file, creating it if it
 * doesn't exist yet. Intentionally simple for v1: exact-line, case-
 * insensitive dedup against what's already there, appended as a markdown
 * bullet list — no semantic merging or summarizing of near-duplicate
 * facts (e.g. "prefers TypeScript" and "likes TypeScript" would both be
 * kept). Good enough to be genuinely useful without pretending to be
 * smarter than it is; a real follow-up, named rather than silently
 * skipped, is periodic AI-assisted consolidation of a file that's grown
 * long. Returns the file unchanged (no write) when every fact was already
 * present, so a no-op extraction never bumps updatedAt for no reason.
 */
export async function appendMemoryFacts(name: string, facts: string[]): Promise<MemoryFile> {
  const trimmedFacts = facts.map((f) => f.trim()).filter(Boolean);
  const existing = await listMemoryFiles().then((files) => files.find((f) => f.name === name));
  const existingContent = existing?.content ?? "";
  const existingLines = new Set(
    existingContent
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim().toLowerCase())
      .filter(Boolean),
  );
  const newLines = trimmedFacts.filter((f) => !existingLines.has(f.toLowerCase()));
  if (newLines.length === 0) {
    if (existing) return existing;
    return writeMemoryFile(name, "");
  }
  const addition = newLines.map((f) => `- ${f}`).join("\n");
  const content = existingContent.trim().length === 0 ? `${addition}\n` : `${existingContent.replace(/\n+$/, "")}\n${addition}\n`;
  return writeMemoryFile(name, content);
}

/**
 * The exact string injected into every mode's prompt (see
 * assistantMemoryBlock() in promptShared.ts). Always consulted — unlike
 * the automatic-extraction WRITE path (gated on AgentSettings.memoryMode
 * === "auto"), reading back whatever memory already exists (whether the
 * user wrote it by hand in Settings or the extractor wrote it) is never
 * gated; a user who only ever edits these files manually should still get
 * them used. Returns undefined when there's nothing non-empty to inject,
 * same convention as buildSteeringContext.
 */
export async function buildAssistantMemoryContext(): Promise<string | undefined> {
  const files = await listMemoryFiles();
  const nonEmpty = files.filter((f) => f.content.replace(/^#.*$/m, "").trim().length > 0);
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty.map((f) => `--- memory/${f.name}.md ---\n${f.content.trim()}`).join("\n\n");
}
