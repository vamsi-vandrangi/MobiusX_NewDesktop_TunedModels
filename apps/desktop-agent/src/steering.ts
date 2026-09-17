import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SteeringFile } from "@mobiusx/protocol";

/**
 * Project Memory/Steering (roadmap Phase 16, source requirement §24/§25) --
 * persistent `.mobiusx/steering/*.md` files the agent consults
 * automatically on EVERY task, in every mode (see promptShared.ts's
 * steeringContextBlock -- this is deliberately not scoped to one mode the
 * way architecture/testing evidence are, since a real engineer reads a
 * project's own conventions before touching code regardless of what
 * they're asked to do). Never AI-generated silently: a file only exists
 * here because the user wrote it (via this module's writeSteeringFile,
 * exposed through PUT /steering) or scaffoldDefaults() seeded an honestly
 * EMPTY template for them to fill in -- this app never invents
 * architecture/security conventions on a project's behalf.
 */

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export const DEFAULT_STEERING_TEMPLATES: { name: string; content: string }[] = [
  {
    name: "architecture",
    content: "# Architecture Conventions\n\nDescribe this project's real architectural conventions here -- layering rules, module boundaries, naming conventions for services/components, patterns to follow or avoid. Left empty, the AI Assistant has nothing to consult beyond what it can see in the code itself.\n",
  },
  {
    name: "security",
    content: "# Security Conventions\n\nDescribe this project's real security requirements here -- auth patterns to use, secrets handling, input validation rules, things that must never be done (e.g. \"never log request bodies\", \"all endpoints require the auth middleware unless explicitly public\").\n",
  },
  {
    name: "api-standards",
    content: "# API Standards\n\nDescribe this project's real API conventions here -- REST resource naming, versioning, error response shape, pagination convention, required headers.\n",
  },
  {
    name: "testing-conventions",
    content: "# Testing Conventions\n\nDescribe this project's real testing conventions here -- beyond what testingContext.ts can detect from dependencies alone (e.g. \"integration tests go under tests/integration, use the shared fixtures in tests/fixtures.py\", \"mock external HTTP calls, never hit real third-party APIs in tests\").\n",
  },
];

function steeringDir(projectRoot: string): string {
  return join(projectRoot, ".mobiusx", "steering");
}

function safePath(projectRoot: string, name: string): string {
  if (!SAFE_NAME.test(name)) {
    throw new Error("name must contain only letters, numbers, hyphens, and underscores");
  }
  return join(steeringDir(projectRoot), `${name}.md`);
}

export async function listSteeringFiles(projectRoot: string): Promise<SteeringFile[]> {
  const dir = steeringDir(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // no .mobiusx/steering/ yet -- not an error, just nothing written yet
  }
  const files: SteeringFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(dir, entry);
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

export async function writeSteeringFile(projectRoot: string, name: string, content: string): Promise<SteeringFile> {
  const abs = safePath(projectRoot, name);
  await mkdir(steeringDir(projectRoot), { recursive: true });
  await writeFile(abs, content, "utf8");
  const st = await stat(abs);
  return { name, path: abs, content, updatedAt: st.mtime.toISOString() };
}

export async function deleteSteeringFile(projectRoot: string, name: string): Promise<void> {
  const abs = safePath(projectRoot, name);
  await rm(abs, { force: true });
}

/** Seeds the four default templates above -- only files that don't already exist are written, so this is safe to call repeatedly and never clobbers something the user already customized. */
export async function scaffoldDefaultSteering(projectRoot: string): Promise<SteeringFile[]> {
  const existing = new Set((await listSteeringFiles(projectRoot)).map((f) => f.name));
  const written: SteeringFile[] = [];
  for (const tpl of DEFAULT_STEERING_TEMPLATES) {
    if (existing.has(tpl.name)) continue;
    written.push(await writeSteeringFile(projectRoot, tpl.name, tpl.content));
  }
  return written;
}

/**
 * The exact string injected into every mode's prompt (see
 * promptShared.ts). Returns undefined when there are no steering files at
 * all, or every one of them is empty/whitespace-only after the template
 * placeholder is filled in -- an empty template file left as-is shouldn't
 * silently tell the model "here are real project conventions" with
 * nothing in them.
 */
export async function buildSteeringContext(projectRoot: string): Promise<string | undefined> {
  const files = await listSteeringFiles(projectRoot);
  const nonEmpty = files.filter((f) => f.content.trim().length > 0);
  if (nonEmpty.length === 0) return undefined;
  return nonEmpty.map((f) => `--- .mobiusx/steering/${f.name}.md ---\n${f.content.trim()}`).join("\n\n");
}
