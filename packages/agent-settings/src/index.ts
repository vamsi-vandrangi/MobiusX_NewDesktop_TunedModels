import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentMode, AgentSettings, ModelSelection } from "@mobiusx/protocol";

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

// "deepseek" was missing here until Phase C's build-target picker work —
// see apps/desktop-agent/src/routes.ts's matching KNOWN_PROVIDERS fix. This
// set gates getSettings() reading a saved defaultModel/modelRouting entry
// back off disk, so a DeepSeek selection that PUT /settings had accepted was
// silently dropped the next time settings were read.
const KNOWN_MODEL_PROVIDERS = new Set(["demo", "anthropic", "openrouter", "groq", "deepseek", "cerebras", "xkiro", "apinex", "ollama"]);

// Every AgentMode this gateway actually accepts in a CreateTaskRequest (see
// packages/protocol/src/cloud.ts's AgentMode type) — the only valid keys
// for AgentSettings.modelRouting (roadmap Phase 11, source §27). Kept as an
// explicit list, not derived from the type at runtime (TS types don't
// exist at runtime), and deliberately checked against directly rather than
// just accepting any string key, so a typo'd or stale mode name in a
// hand-edited settings.json is dropped rather than silently carried
// forward as a routing rule that can never match a real task.
// "devops" and "auth" were missing here too (the same gap routes.ts's own
// KNOWN_MODES list had until its Phase 19-23 audit) -- this one matters even
// more, since this copy gates reading modelRouting BACK off disk: a devops
// or auth routing rule that PUT /settings happily accepted was silently
// dropped the very next time getSettings() ran, i.e. on every restart.
const KNOWN_AGENT_MODES = new Set<AgentMode>([
  "ask",
  "plan",
  "build",
  "spec",
  "fix",
  "database",
  "architecture",
  "testing",
  "devops",
  "auth",
]);

function isValidModelSelection(value: unknown): value is ModelSelection {
  if (!value || typeof value !== "object") return false;
  const v = value as { provider?: unknown; model?: unknown };
  return typeof v.provider === "string" && KNOWN_MODEL_PROVIDERS.has(v.provider) && typeof v.model === "string" && v.model.length > 0;
}

/** Validates a raw `modelRouting` value field-by-field, same philosophy as isValidModelSelection above: an unrecognized mode key or a malformed selection for one mode is dropped individually, never discarding the whole map over one bad entry. Returns undefined for an empty or entirely invalid input (so callers can treat "no valid entries" the same as "field absent"). */
function sanitizeModelRouting(value: unknown): Partial<Record<AgentMode, ModelSelection>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: Partial<Record<AgentMode, ModelSelection>> = {};
  for (const [mode, selection] of Object.entries(value as Record<string, unknown>)) {
    if (KNOWN_AGENT_MODES.has(mode as AgentMode) && isValidModelSelection(selection)) {
      result[mode as AgentMode] = selection;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
  if (parsed.fixLoopMode === "manual" || parsed.fixLoopMode === "auto") {
    result.fixLoopMode = parsed.fixLoopMode;
  }
  if (parsed.memoryMode === "off" || parsed.memoryMode === "auto") {
    result.memoryMode = parsed.memoryMode;
  }
  const modelRouting = sanitizeModelRouting(parsed.modelRouting);
  if (modelRouting) {
    result.modelRouting = modelRouting;
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
export type SettingsPatch = Partial<Omit<AgentSettings, "defaultModel" | "modelRouting">> & {
  defaultModel?: ModelSelection | null;
  /**
   * Per-mode merge, not a wholesale replace (roadmap Phase 11, source §27):
   * each key present here is applied to that ONE mode's routing entry —
   * `null` clears that mode's rule (falls back to `defaultModel`/automatic,
   * same as never having set one), a `ModelSelection` sets/replaces it, and
   * a mode simply absent from this object is left exactly as it already
   * was. This mirrors `defaultModel`'s null-clears convention above, at the
   * per-mode granularity the Settings UI's per-mode dropdowns need — e.g.
   * clearing just the "architecture" routing rule must never also clear
   * "testing"'s.
   */
  modelRouting?: Partial<Record<AgentMode, ModelSelection | null>>;
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
  if (patch.fixLoopMode !== undefined) {
    next.fixLoopMode = patch.fixLoopMode;
  }
  if (patch.memoryMode !== undefined) {
    next.memoryMode = patch.memoryMode;
  }
  if (patch.modelRouting !== undefined) {
    const merged: Partial<Record<AgentMode, ModelSelection>> = { ...current.modelRouting };
    for (const [mode, selection] of Object.entries(patch.modelRouting) as [AgentMode, ModelSelection | null | undefined][]) {
      if (selection === null) {
        delete merged[mode];
      } else if (selection !== undefined) {
        merged[mode] = selection;
      }
    }
    if (Object.keys(merged).length > 0) {
      next.modelRouting = merged;
    } else {
      delete next.modelRouting;
    }
  }

  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
