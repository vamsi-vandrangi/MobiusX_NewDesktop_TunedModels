import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSettings, ModelSelection } from "@mobiusx/protocol";

/**
 * Shared `~/.mobiusx/settings.json` read/write. Originally lived only in
 * apps/desktop-agent (the "Approval Engine", PRD §34-35); extracted here,
 * unchanged in behavior for the fields that already existed, once
 * apps/cloud-agent-gateway also needed to know the user's chosen default
 * AI model (multi-model support) without duplicating this file-handling
 * code or introducing IPC between the two processes. Both apps read the
 * SAME file (or `MOBIUSX_SETTINGS_DIR` override, used by tests to isolate
 * from a real home directory) — desktop-agent is the only writer (its
 * PUT /settings route), the gateway only ever calls getSettings().
 *
 * Deliberately a plain JSON file, not a database — there are only two
 * small settings so far (see AgentSettings) and this mirrors the existing
 * pattern used by @mobiusx/audit-log and the cloud gateway's task store.
 */
const SETTINGS_DIR = process.env.MOBIUSX_SETTINGS_DIR ?? join(homedir(), ".mobiusx");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");

const DEFAULT_SETTINGS: AgentSettings = { terminalApprovalMode: "off" };

const KNOWN_MODEL_PROVIDERS = new Set(["demo", "anthropic", "openrouter", "groq", "ollama"]);

function isValidModelSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object") return false;
  const v = value as { provider?: unknown; model?: unknown };
  return typeof v.provider === "string" && KNOWN_MODEL_PROVIDERS.has(v.provider) && typeof v.model === "string" && v.model.length > 0;
}

/**
 * Reads the settings file, validating each field independently — a
 * corrupt or unrecognized value for one field falls back to that field's
 * default without discarding an otherwise-valid neighboring field (e.g. a
 * bad `defaultModel` shouldn't reset a correctly-set `terminalApprovalMode`
 * back to "off"). A missing or entirely unparseable file returns
 * DEFAULT_SETTINGS as-is.
 */
export async function getSettings(): Promise<AgentSettings> {
  let raw: string;
  try {
    raw = await readFile(SETTINGS_FILE, "utf8");
  } catch {
    return DEFAULT_SETTINGS;
  }

  let parsed: Partial<AgentSettings>;
  try {
    parsed = JSON.parse(raw) as Partial<AgentSettings>;
  } catch {
    return DEFAULT_SETTINGS; // corrupt file — fall back entirely rather than throwing
  }

  const result: AgentSettings = {
    terminalApprovalMode:
      parsed.terminalApprovalMode === "off" || parsed.terminalApprovalMode === "guarded"
        ? parsed.terminalApprovalMode
        : DEFAULT_SETTINGS.terminalApprovalMode,
  };
  if (isValidModelSelection(parsed.defaultModel)) {
    result.defaultModel = parsed.defaultModel;
  }
  return result;
}

/**
 * Patch type for updateSettings: `defaultModel: null` explicitly clears
 * the standing default (back to "let the gateway choose automatically"),
 * distinct from omitting the field (which leaves whatever's already set
 * untouched) — a plain `Partial<AgentSettings>` can't express "remove
 * this" since `undefined` there already means "don't touch it".
 */
export type SettingsPatch = Partial<Omit<AgentSettings, "defaultModel">> & {
  defaultModel?: ModelSelection | null;
};

export async function updateSettings(patch: SettingsPatch): Promise<AgentSettings> {
  const current = await getSettings();
  const next: AgentSettings = { ...current };

  if (patch.terminalApprovalMode !== undefined) {
    next.terminalApprovalMode = patch.terminalApprovalMode;
  }
  if ("defaultModel" in patch) {
    if (patch.defaultModel === null) {
      delete next.defaultModel;
    } else if (patch.defaultModel !== undefined) {
      next.defaultModel = patch.defaultModel;
    }
  }

  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
