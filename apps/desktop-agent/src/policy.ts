import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PolicyMatch, PolicyRule } from "@mobiusx/protocol";

/**
 * Best-effort terminal "command guard" — NOT a security sandbox.
 *
 * Because the terminal is a real interactive PTY (raw keystrokes forwarded
 * immediately — see terminalWs.ts), there is no way to transparently block
 * a command before the shell has already started acting on it without
 * breaking live interactivity: arrow-key history, tab completion, and
 * readline-style editing all depend on the shell seeing each keystroke as
 * it's typed, not after we've decided whether to allow it. So this is
 * reactive, not preventive: it recognizes a submitted line, flags it,
 * logs it, and sends a best-effort interrupt (Ctrl+C) — which can stop a
 * long-running or slow-starting command, but cannot undo one that
 * completes instantly. It is also trivially bypassable by anyone with
 * terminal access to this machine (a different terminal window,
 * `bash --norc`, editing this policy file themselves). It exists to catch
 * accidental or AI-suggested destructive commands, not to contain a
 * malicious local user — see docs/ARCHITECTURE.md §12 and the root README
 * for this framing.
 */
export const BUILTIN_POLICY: PolicyRule[] = [
  {
    id: "rm-rf-root",
    description: "rm -rf targeting / or a home directory root",
    pattern: "rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+(/|~)(\\s|$)",
  },
  {
    id: "rm-rf-git",
    description: "rm -rf targeting a project's .git directory",
    pattern: "rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+\\S*\\.git(\\s|/|$)",
  },
  {
    id: "git-force-push-protected",
    description: "git push --force (or -f) touching main/master",
    pattern: "git\\s+push\\s+.*(--force|-f)\\b.*\\b(main|master)\\b",
  },
  {
    id: "pipe-to-shell",
    description: "downloading a remote script and piping it straight into a shell",
    pattern: "(curl|wget)\\s+[^\\n|]*\\|\\s*(sudo\\s+)?(bash|sh|zsh)\\b",
  },
  {
    id: "fork-bomb",
    description: "shell fork bomb",
    pattern: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:",
  },
  {
    id: "mkfs",
    description: "formatting a filesystem/device",
    pattern: "\\bmkfs(\\.[a-z0-9]+)?\\s+/dev/",
  },
  {
    id: "dd-to-device",
    description: "dd writing directly to a raw device",
    pattern: "\\bdd\\s+[^\\n]*\\bof=/dev/",
  },
  {
    id: "chmod-777-root",
    description: "recursively opening permissions on /",
    pattern: "chmod\\s+-R\\s+777\\s+/(\\s|$)",
  },
  {
    id: "sudo-rm-rf",
    description: "sudo rm -rf (elevated destructive delete)",
    pattern: "sudo\\s+rm\\s+-[a-zA-Z]*[rf][a-zA-Z]*",
  },
];

export interface ProjectPolicyResult {
  rules: PolicyRule[];
  path: string | null;
  error: string | null;
}

/**
 * Loads `.mobiusx/policy.json` from the project root, if present. A
 * project can only ADD rules on top of BUILTIN_POLICY, never remove or
 * override one — that's a deliberate one-way ratchet, so a repo can
 * tighten what this catches but can't quietly loosen it from inside the
 * very tree the guard is watching. A malformed file is ignored in full
 * (not partially applied) and reported via `error`, surfaced by the
 * agent's GET /policy route.
 */
export async function loadProjectPolicy(projectPath: string | null): Promise<ProjectPolicyResult> {
  if (!projectPath) return { rules: [], path: null, error: null };
  const policyPath = join(projectPath, ".mobiusx", "policy.json");

  let raw: string;
  try {
    raw = await readFile(policyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], path: null, error: null };
    return { rules: [], path: policyPath, error: `Failed to read .mobiusx/policy.json: ${(err as Error).message}` };
  }

  let parsed: { extraBlockedPatterns?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { rules: [], path: policyPath, error: `.mobiusx/policy.json is not valid JSON: ${(err as Error).message}` };
  }

  if (!Array.isArray(parsed.extraBlockedPatterns)) {
    return { rules: [], path: policyPath, error: "'extraBlockedPatterns' must be an array — ignoring the whole file" };
  }

  const rules: PolicyRule[] = [];
  for (const [i, entry] of parsed.extraBlockedPatterns.entries()) {
    const e = entry as Partial<PolicyRule>;
    if (!e || typeof e.id !== "string" || typeof e.pattern !== "string") {
      return { rules: [], path: policyPath, error: `extraBlockedPatterns[${i}] is missing a string 'id' or 'pattern' — ignoring the whole file` };
    }
    try {
      new RegExp(e.pattern);
    } catch {
      return { rules: [], path: policyPath, error: `extraBlockedPatterns[${i}] ("${e.id}") has an invalid regex pattern — ignoring the whole file` };
    }
    rules.push({ id: e.id, description: e.description ?? e.id, pattern: e.pattern });
  }
  return { rules, path: policyPath, error: null };
}

export function evaluateLine(line: string, rules: PolicyRule[]): PolicyMatch[] {
  const matches: PolicyMatch[] = [];
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      continue; // built-ins are hand-written and tested; a project rule was already validated at load time
    }
    if (re.test(line)) matches.push({ ruleId: rule.id, description: rule.description });
  }
  return matches;
}
