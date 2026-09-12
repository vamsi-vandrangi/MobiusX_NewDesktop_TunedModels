import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AuditCategory, AuditEntry, AuditSeverity } from "@mobiusx/protocol";

/**
 * Append-only local audit log for Phase 5 governance events. One JSON
 * object per line (JSONL) so it's append-safe across two separate
 * processes (desktop-agent, cloud-agent-gateway) writing concurrently —
 * no read-modify-write, no shared in-memory cache to get out of sync.
 * Lives outside any project repo (like cloud-agent-gateway's tasks.json)
 * since it spans every project the desktop touches. Override the
 * directory with MOBIUSX_AUDIT_LOG_DIR for tests.
 */
const LOG_DIR = process.env.MOBIUSX_AUDIT_LOG_DIR ?? join(homedir(), ".mobiusx");
const LOG_FILE = join(LOG_DIR, "audit.jsonl");

export interface AppendAuditEntryInput {
  source: AuditEntry["source"];
  category: AuditCategory;
  severity: AuditSeverity;
  summary: string;
  detail?: Record<string, unknown>;
}

export async function appendAuditEntry(input: AppendAuditEntryInput): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
  };
  await mkdir(dirname(LOG_FILE), { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * Reads the most recent `limit` entries (default 100), oldest-to-newest
 * within that window. Tolerant of a missing file (nothing logged yet —
 * returns []) and of a corrupt trailing line (e.g. the process was killed
 * mid-write) — skips lines that don't parse rather than failing the whole
 * read.
 */
export async function readAuditLog(limit = 100): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // corrupt/partial line — skip rather than fail the whole read
    }
  }
  return entries.slice(-limit);
}
