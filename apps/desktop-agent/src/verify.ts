import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VerificationStep, VerifyResponse } from "@mobiusx/protocol";

const MAX_OUTPUT_CHARS = 8000; // bounded so a noisy test run can't blow up the response/DB
const DEFAULT_TIMEOUT_MS = 120_000;

/** Scripts we'll consider "verification" if present, in the order they should run. Deliberately conservative — only npm-script names a project explicitly defines, never a command the AI invents. */
const KNOWN_SCRIPT_NAMES: { name: string; label: string }[] = [
  { name: "typecheck", label: "Typecheck" },
  { name: "build", label: "Build" },
  { name: "lint", label: "Lint" },
  { name: "test", label: "Test" },
];

interface PlannedStep {
  label: string;
  command: string;
  scriptName: string;
}

/**
 * Reads the OPEN PROJECT's root package.json (only the root — a known v1
 * limitation for monorepos with per-workspace scripts, not silently
 * pretended away) and returns which of the known verification scripts it
 * actually defines, in a sensible run order. Returns [] (not an error) for
 * a project with no package.json or no matching scripts — the caller
 * reports that as "no-verification-available", not a failure.
 */
export async function detectVerificationSteps(projectRoot: string): Promise<PlannedStep[]> {
  let raw: string;
  try {
    raw = await readFile(join(projectRoot, "package.json"), "utf8");
  } catch {
    return [];
  }

  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch {
    return [];
  }

  const scripts = pkg.scripts ?? {};
  const steps: PlannedStep[] = [];
  for (const { name, label } of KNOWN_SCRIPT_NAMES) {
    if (typeof scripts[name] === "string") {
      steps.push({ label: `${label} (npm run ${name})`, command: `npm run ${name}`, scriptName: name });
    }
  }
  return steps;
}

/**
 * Runs each planned step via `npm run <script>` in the project root,
 * sequentially (later steps run regardless of earlier failures — each is
 * independent evidence, not a pipeline that stops on first red). Every
 * step gets a hard timeout (SIGTERM, then SIGKILL after a short grace
 * period if it doesn't exit) so a hung dev server or watch-mode test
 * runner can't hang verification forever.
 */
export async function runVerificationSteps(
  projectRoot: string,
  planned: PlannedStep[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VerificationStep[]> {
  const results: VerificationStep[] = [];
  for (const step of planned) {
    results.push(await runOne(projectRoot, step, timeoutMs));
  }
  return results;
}

function runOne(projectRoot: string, step: PlannedStep, timeoutMs: number): Promise<VerificationStep> {
  return new Promise((resolve) => {
    const start = Date.now();
    // detached:true puts npm (and everything it spawns) in its own process
    // group, so a timeout can kill the WHOLE tree via process.kill(-pid, ...)
    // — killing just the immediate npm process leaves its grandchildren (the
    // actual build/test runner) holding stdout/stderr open, which means the
    // "close" event below would otherwise never fire and this would hang
    // forever despite the timeout. Windows doesn't have POSIX process
    // groups the same way, so it falls back to killing just the direct
    // child there (a known, narrower guarantee on that platform).
    const child = spawn("npm", ["run", step.scriptName], {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      detached: process.platform !== "win32",
    });

    const killTree = (signal: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // process group already gone — fall through to direct kill
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    };

    let output = "";
    let truncated = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      // Grace period, then force-kill the whole tree if it's still alive (e.g. ignored SIGTERM).
      setTimeout(() => killTree("SIGKILL"), 3000);
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(killTimer);
      resolve({
        id: randomUUID(),
        label: step.label,
        command: step.command,
        status: timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed",
        exitCode,
        output: timedOut ? `${output}\n[verification timed out after ${timeoutMs}ms and was killed]` : output,
        truncated,
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      resolve({
        id: randomUUID(),
        label: step.label,
        command: step.command,
        status: "failed",
        exitCode: null,
        output: `Failed to start: ${err.message}`,
        truncated: false,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** Detects + runs verification for a project in one call, and computes the overall verdict. */
export async function verifyProject(projectRoot: string, timeoutMs?: number): Promise<VerifyResponse> {
  const planned = await detectVerificationSteps(projectRoot);
  if (planned.length === 0) {
    return { projectPath: projectRoot, overall: "no-verification-available", steps: [] };
  }
  const steps = await runVerificationSteps(projectRoot, planned, timeoutMs);
  const overall = steps.every((s) => s.status === "passed") ? "passed" : "failed";
  return { projectPath: projectRoot, overall, steps };
}
