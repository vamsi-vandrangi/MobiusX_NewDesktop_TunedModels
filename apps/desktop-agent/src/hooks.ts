import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendAuditEntry } from "@mobiusx/audit-log";
import type { HookEvent, HookRule, HookRunResult } from "@mobiusx/protocol";

/**
 * Event-driven hooks (roadmap Phase 16, source requirement §25's second
 * half). See HookRule's doc comment in @mobiusx/protocol for the two real
 * trigger points this wires into (POST /fs/apply-edits for
 * "after-api-change", the embedded terminal for "before-commit") and why
 * "before-commit" is necessarily reactive rather than preventive -- same
 * honesty policy.ts's own doc comment already established for this PTY.
 *
 * `.mobiusx/hooks.json` follows the exact same one-way-ratchet-of-honesty
 * convention as policy.ts's `.mobiusx/policy.json`: a malformed file is
 * ignored in FULL (never partially applied), and the parse error is
 * surfaced via GET /hooks rather than swallowed.
 */

const MAX_OUTPUT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface ProjectHooksResult {
  rules: HookRule[];
  path: string | null;
  error: string | null;
}

export async function loadProjectHooks(projectPath: string | null): Promise<ProjectHooksResult> {
  if (!projectPath) return { rules: [], path: null, error: null };
  const hooksPath = join(projectPath, ".mobiusx", "hooks.json");

  let raw: string;
  try {
    raw = await readFile(hooksPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], path: null, error: null };
    return { rules: [], path: hooksPath, error: `Failed to read .mobiusx/hooks.json: ${(err as Error).message}` };
  }

  let parsed: { hooks?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { rules: [], path: hooksPath, error: `.mobiusx/hooks.json is not valid JSON: ${(err as Error).message}` };
  }

  if (!Array.isArray(parsed.hooks)) {
    return { rules: [], path: hooksPath, error: "'hooks' must be an array -- ignoring the whole file" };
  }

  const rules: HookRule[] = [];
  for (const [i, entry] of parsed.hooks.entries()) {
    const e = entry as Partial<HookRule>;
    if (!e || typeof e.id !== "string" || typeof e.command !== "string" || (e.event !== "before-commit" && e.event !== "after-api-change")) {
      return { rules: [], path: hooksPath, error: `hooks[${i}] is missing a string 'id'/'command' or a valid 'event' ("before-commit" | "after-api-change") -- ignoring the whole file` };
    }
    if (e.pathPattern !== undefined) {
      if (typeof e.pathPattern !== "string") {
        return { rules: [], path: hooksPath, error: `hooks[${i}] ("${e.id}")'s pathPattern must be a string -- ignoring the whole file` };
      }
      try {
        new RegExp(e.pathPattern);
      } catch {
        return { rules: [], path: hooksPath, error: `hooks[${i}] ("${e.id}") has an invalid pathPattern regex -- ignoring the whole file` };
      }
    }
    rules.push({ id: e.id, event: e.event, command: e.command, description: e.description, pathPattern: e.pathPattern });
  }
  return { rules, path: hooksPath, error: null };
}

function runOne(rule: HookRule, cwd: string, timeoutMs: number): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    // shell:true is deliberate here (unlike verify.ts's fixed npm-script
    // spawns) -- a hook command is an arbitrary user-authored shell line
    // from .mobiusx/hooks.json (e.g. "npm test && npm run lint"), the same
    // trust boundary as anything typed into the project's own package.json
    // scripts, which this app already runs unquestioned via verify.ts.
    const child = spawn(rule.command, { cwd, env: process.env, shell: true });

    let output = "";
    let truncated = false;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(killTimer);
      resolve({
        ruleId: rule.id,
        event: rule.event,
        command: rule.command,
        status: !timedOut && exitCode === 0 ? "passed" : "failed",
        exitCode,
        output: (timedOut ? `${output}\n[hook timed out after ${timeoutMs}ms and was killed]` : output) + (truncated ? "\n[output truncated]" : ""),
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        ruleId: rule.id,
        event: rule.event,
        command: rule.command,
        status: "failed",
        exitCode: null,
        output: `Failed to start: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Runs every enabled rule for `event`, in order, sequentially (a hook
 * command may itself depend on a prior hook's side effect, e.g. a lint
 * fix before a test run -- running them concurrently would make that
 * ordering unreliable). For "after-api-change", `changedPaths` narrows
 * which rules actually fire: a rule with a `pathPattern` only runs if at
 * least one changed path matches it; a rule with no pathPattern always
 * fires on any applied edit. Every run is audit-logged individually,
 * mirroring verify.ts/policy.ts's existing transparency.
 */
export async function runHooksForEvent(
  projectPath: string,
  event: HookEvent,
  opts: { changedPaths?: string[]; timeoutMs?: number } = {},
): Promise<HookRunResult[]> {
  const { rules } = await loadProjectHooks(projectPath);
  const applicable = rules.filter((r) => {
    if (r.event !== event) return false;
    // A pathPattern only narrows when real changed paths were supplied
    // (the POST /fs/apply-edits caller always passes them). A manual test
    // run (POST /hooks/run) has no real changed-file context -- passing
    // `changedPaths: undefined` there runs every rule for the event
    // regardless of pathPattern, so a scoped rule can still be tested.
    if (event === "after-api-change" && r.pathPattern && opts.changedPaths !== undefined) {
      const re = new RegExp(r.pathPattern);
      return opts.changedPaths.some((p) => re.test(p));
    }
    return true;
  });

  const results: HookRunResult[] = [];
  for (const rule of applicable) {
    const result = await runOne(rule, projectPath, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    results.push(result);
    void appendAuditEntry({
      source: "desktop-agent",
      category: "hook-run",
      severity: result.status === "passed" ? "info" : "warning",
      summary: `Hook "${rule.id}" (${event}) ${result.status}: ${rule.command}`,
      detail: { ruleId: rule.id, event, command: rule.command, status: result.status, exitCode: result.exitCode, projectPath },
    });
  }
  return results;
}
