import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSettings } from "@mobiusx/protocol";

/**
 * Desktop-agent-wide settings (PRD §34-35, Approval Engine). Deliberately
 * a plain JSON file, not a database — there's exactly one small setting
 * so far (see AgentSettings) and this mirrors the existing pattern used
 * by @mobiusx/audit-log and the cloud gateway's task store: a file under
 * ~/.mobiusx, overridable for tests via an env var.
 */
const SETTINGS_DIR = process.env.MOBIUSX_SETTINGS_DIR ?? join(homedir(), ".mobiusx");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");

const DEFAULT_SETTINGS: AgentSettings = { terminalApprovalMode: "off" };

export async function getSettings(): Promise<AgentSettings> {
  let raw: string;
  try {
    raw = await readFile(SETTINGS_FILE, "utf8");
  } catch {
    return DEFAULT_SETTINGS;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    if (parsed.terminalApprovalMode === "off" || parsed.terminalApprovalMode === "guarded") {
      return { terminalApprovalMode: parsed.terminalApprovalMode };
    }
  } catch {
    /* corrupt file — fall through to defaults rather than throwing */
  }
  return DEFAULT_SETTINGS;
}

export async function updateSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const current = await getSettings();
  const next: AgentSettings = { ...current, ...patch };
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
