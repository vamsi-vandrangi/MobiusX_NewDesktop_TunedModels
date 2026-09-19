import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { VerificationStep, VerifyResponse } from "@mobiusx/protocol";
import { venvPythonBin } from "./previewOps.js";

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
  /** Absolute directory this step's process runs in — the npm scripts always run at the project root; a Python test step runs inside its own backend subdirectory (see detectPythonTestSteps), the same per-directory scoping projectContext.ts and architectureContext.ts already use. */
  cwd: string;
  /** The literal binary spawned (never shell-interpreted — see runOne). */
  spawnCmd: string;
  spawnArgs: string[];
  /** Set only for an npm-script step — kept for readability/tests; not used by runOne (spawnCmd/spawnArgs are). */
  scriptName?: string;
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
      steps.push({
        label: `${label} (npm run ${name})`,
        command: `npm run ${name}`,
        cwd: projectRoot,
        spawnCmd: "npm",
        spawnArgs: ["run", name],
        scriptName: name,
      });
    }
  }
  return steps;
}

// Same short candidate-directory list projectContext.ts/architectureContext.ts
// already use for "where might this project's backend live" — many
// generated projects (see Test Projects/GreenThumbGarden) have no root
// package.json at all, so a Python backend's own test suite would
// otherwise be invisible to verification entirely.
const PYTHON_TEST_CANDIDATE_DIRS = [".", "backend", "server", "api"];

/**
 * Testing Engine (roadmap Phase 10, source requirement §15): verify.ts
 * previously only ever ran scripts from the project's ROOT package.json —
 * meaning a Python backend's pytest suite (this app's own primary test
 * fixture, GreenThumbGarden, included) was never actually executed by
 * "Run verification" at all, npm script or not. A generated test that
 * never gets run isn't "validated the same way a fix is" — it's just a
 * file. This closes that gap: only ever runs pytest when this project's
 * own requirements.txt/pyproject.toml actually declares it as a
 * dependency (the same "real evidence, never invented" discipline as
 * every other detector in this codebase) — never assumed just because a
 * .py file exists. Prefers this project's own `.venv` interpreter (the
 * exact convention previewOps.ts already establishes for launching
 * uvicorn, reused here via venvPythonBin so the two never drift apart),
 * falling back to a bare `python3`/`python` on PATH when no venv exists
 * yet.
 */
export async function detectPythonTestSteps(projectRoot: string): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];
  for (const rel of PYTHON_TEST_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    let raw: string | null = null;
    try {
      raw = await readFile(join(dir, "requirements.txt"), "utf8");
    } catch {
      try {
        raw = await readFile(join(dir, "pyproject.toml"), "utf8");
      } catch {
        continue;
      }
    }
    // requirements.txt / poetry-style TOML tables declare pytest at the
    // START of its own line ("pytest==8.0.0", or "pytest = "^8.0"" under
    // [tool.poetry.dependencies]) -- but PEP 621's pyproject.toml format
    // (the more common one today) lists it as a quoted entry inside a
    // dependencies array instead: dependencies = ["fastapi", "pytest>=8.0"].
    // Match both shapes rather than just the first -- a real fixture using
    // the PEP 621 array form was silently missed before this.
    if (!/^\s*pytest\b|["']pytest\b/im.test(raw)) continue; // only run a test framework this project actually declared, never invented
    const venvPython = venvPythonBin(dir);
    const pythonBin = existsSync(venvPython) ? venvPython : process.platform === "win32" ? "python" : "python3";
    const displayBin = pythonBin === venvPython ? (process.platform === "win32" ? ".venv\\Scripts\\python" : ".venv/bin/python3") : pythonBin;
    steps.push({
      label: `Test (pytest, ${rel === "." ? "root" : rel}/)`,
      command: `${displayBin} -m pytest -q`,
      cwd: dir,
      spawnCmd: pythonBin,
      spawnArgs: ["-m", "pytest", "-q"],
    });
  }
  return steps;
}

// Same short candidate-directory list PYTHON_TEST_CANDIDATE_DIRS above
// uses -- Java/.NET/C++ backends live in the same handful of places a
// generated project's backend realistically lives.
const OTHER_LANG_CANDIDATE_DIRS = [".", "backend", "server", "api"];

/**
 * Java (roadmap follow-up to Testing Engine): only runs when this
 * directory actually has a Maven or Gradle build file -- same "real
 * evidence, never invented" rule the Python step follows. Prefers the
 * project's own wrapper script (mvnw/gradlew) when present, exactly the
 * way the Python step prefers its own .venv interpreter over a bare
 * python3 on PATH -- a wrapper pins the exact build-tool version a
 * generated project was written against, a global install on this
 * machine might not match.
 */
export async function detectJavaTestSteps(projectRoot: string): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];
  const win = process.platform === "win32";
  for (const rel of OTHER_LANG_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    const label = rel === "." ? "root" : rel;
    if (existsSync(join(dir, "pom.xml"))) {
      const wrapper = join(dir, win ? "mvnw.cmd" : "mvnw");
      const useWrapper = existsSync(wrapper);
      steps.push({
        label: `Test (Maven, ${label}/)`,
        command: useWrapper ? (win ? ".\mvnw.cmd test -B -q" : "./mvnw test -B -q") : "mvn test -B -q",
        cwd: dir,
        spawnCmd: useWrapper ? wrapper : "mvn",
        spawnArgs: ["test", "-B", "-q"],
      });
    } else if (existsSync(join(dir, "build.gradle")) || existsSync(join(dir, "build.gradle.kts"))) {
      const wrapper = join(dir, win ? "gradlew.bat" : "gradlew");
      const useWrapper = existsSync(wrapper);
      steps.push({
        label: `Test (Gradle, ${label}/)`,
        command: useWrapper ? (win ? ".\gradlew.bat test" : "./gradlew test") : "gradle test",
        cwd: dir,
        spawnCmd: useWrapper ? wrapper : "gradle",
        spawnArgs: ["test"],
      });
    }
  }
  return steps;
}

/**
 * .NET: runs `dotnet test` from any directory holding a .sln or .csproj --
 * `dotnet test` itself already resolves which project(s)/test projects
 * that covers, so (unlike Java/Python) there's no separate "which test
 * framework" branch needed here; xUnit/NUnit/MSTest all run the same way
 * through the same `dotnet test` entry point.
 */
export async function detectDotNetTestSteps(projectRoot: string): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];
  for (const rel of OTHER_LANG_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    let hasProject = false;
    try {
      const { readdirSync } = await import("node:fs");
      hasProject = readdirSync(dir).some((e) => e.endsWith(".sln") || e.endsWith(".csproj"));
    } catch {
      continue;
    }
    if (!hasProject) continue;
    steps.push({
      label: `Test (dotnet, ${rel === "." ? "root" : rel}/)`,
      command: "dotnet test",
      cwd: dir,
      spawnCmd: "dotnet",
      spawnArgs: ["test"],
    });
  }
  return steps;
}

/**
 * C/C++ via CMake + CTest: deliberately narrower than the other language
 * steps above -- only runs when a `build/` directory already exists next
 * to CMakeLists.txt (i.e. someone already ran `cmake -B build` at least
 * once), because unlike `npm test`/`pytest`/`mvn test`/`dotnet test`,
 * CTest needs a configured build directory to exist first and this module
 * has no business silently kicking off a full CMake configure+build as a
 * side effect of clicking "Run verification". A project with no `build/`
 * yet just doesn't get a C/C++ test step, the same as a project with no
 * declared test framework at all.
 */
export async function detectCppTestSteps(projectRoot: string): Promise<PlannedStep[]> {
  const steps: PlannedStep[] = [];
  for (const rel of OTHER_LANG_CANDIDATE_DIRS) {
    const dir = join(projectRoot, rel);
    if (!existsSync(join(dir, "CMakeLists.txt"))) continue;
    if (!existsSync(join(dir, "build", "CMakeCache.txt"))) continue; // not configured yet -- nothing to test
    steps.push({
      label: `Test (CTest, ${rel === "." ? "root" : rel}/)`,
      command: "ctest --test-dir build --output-on-failure",
      cwd: dir,
      spawnCmd: "ctest",
      spawnArgs: ["--test-dir", "build", "--output-on-failure"],
    });
  }
  return steps;
}

/**
 * Runs each planned step in its own directory, sequentially (later steps
 * run regardless of earlier failures — each is independent evidence, not
 * a pipeline that stops on first red). Every step gets a hard timeout
 * (SIGTERM, then SIGKILL after a short grace period if it doesn't exit)
 * so a hung dev server or watch-mode test runner can't hang verification
 * forever.
 */
export async function runVerificationSteps(
  planned: PlannedStep[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VerificationStep[]> {
  const results: VerificationStep[] = [];
  for (const step of planned) {
    results.push(await runOne(step, timeoutMs));
  }
  return results;
}

function runOne(step: PlannedStep, timeoutMs: number): Promise<VerificationStep> {
  return new Promise((resolve) => {
    const start = Date.now();
    // detached:true puts the spawned process (and everything it spawns) in
    // its own process group, so a timeout can kill the WHOLE tree via
    // process.kill(-pid, ...) — killing just the immediate process leaves
    // its grandchildren (the actual build/test runner) holding
    // stdout/stderr open, which means the "close" event below would
    // otherwise never fire and this would hang forever despite the
    // timeout. Windows doesn't have POSIX process groups the same way, so
    // it falls back to killing just the direct child there (a known,
    // narrower guarantee on that platform).
    const child = spawn(step.spawnCmd, step.spawnArgs, {
      cwd: step.cwd,
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
  const planned = [
    ...(await detectVerificationSteps(projectRoot)),
    ...(await detectPythonTestSteps(projectRoot)),
    ...(await detectJavaTestSteps(projectRoot)),
    ...(await detectDotNetTestSteps(projectRoot)),
    ...(await detectCppTestSteps(projectRoot)),
  ];
  if (planned.length === 0) {
    return { projectPath: projectRoot, overall: "no-verification-available", steps: [] };
  }
  const steps = await runVerificationSteps(planned, timeoutMs);
  const overall = steps.every((s) => s.status === "passed") ? "passed" : "failed";
  return { projectPath: projectRoot, overall, steps };
}
