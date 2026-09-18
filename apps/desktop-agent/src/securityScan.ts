import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { scanForSecrets } from "@mobiusx/secret-scan";
import type { SecurityFinding, DependencyAuditResult, SecurityScanReport } from "@mobiusx/protocol";
import { detectProjectContext } from "./projectContext.js";

/**
 * Security Scanning Engine (roadmap Phase 20, source requirement §15 --
 * "security testing"). completion.ts's `security_scan_clean` criterion
 * was permanently `not_configured` through Phases 6-18: the only real
 * scanning in this codebase was packages/secret-scan, and only on content
 * an AI was ABOUT TO WRITE (fsOps.ts#applyEdits), never the project's
 * already-existing files. This module closes that specific, honestly-
 * documented gap with two real, bounded checks -- deliberately not a
 * claim of comprehensive SAST/vulnerability coverage:
 *
 * 1. Pattern findings -- reuses packages/secret-scan's OWN detector
 *    (never a second copy of the same rules) across every real source
 *    file in the project, plus a small, deliberately narrow set of
 *    additional static patterns for well-known dangerous constructs
 *    (eval/exec, subprocess shell=True, pickle.loads, unsafe yaml.load,
 *    React dangerouslySetInnerHTML, naive string-built SQL). This is
 *    regex pattern matching, not real static analysis (no data-flow, no
 *    taint tracking) -- it will miss real issues and can false-positive,
 *    the same honest limitation packages/secret-scan's own doc comment
 *    already states for its narrower use.
 * 2. Dependency audits -- runs `npm audit` for a detected JS/TS
 *    component with a lockfile, and `pip-audit` for a detected Python
 *    component IF that tool is actually installed. Neither is invented
 *    or assumed present -- an unavailable tool is reported as exactly
 *    that, never silently skipped or counted as "clean."
 */

// SecurityFinding / DependencyAuditResult / SecurityScanReport are the
// wire contract -- defined once in @mobiusx/protocol (imported above) and
// never re-declared here, so the module implementing the scan and the
// module describing its API can't drift apart.
export type SecuritySeverity = SecurityFinding["severity"];

const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".mobiusx", ".next"]);
const SCANNABLE_EXT = /\.(js|jsx|ts|tsx|py|json|yml|yaml|env|env\.example)$/i;
const MAX_FILE_BYTES = 500_000; // skip anything unusually large (bundled/minified output, data dumps) -- not source code this scan is meant for

async function listFilesRecursive(dir: string, depth: number, results: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".env.example") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFilesRecursive(full, depth + 1, results);
    } else {
      results.push(full);
    }
  }
}

// Deliberately narrow, high-signal patterns -- see module doc comment for
// why these six and not a larger, noisier list.
const PATTERN_RULES: { id: string; description: string; severity: SecuritySeverity; re: RegExp; exts: RegExp }[] = [
  { id: "eval-exec", description: "eval()/exec() of dynamic content", severity: "high", re: /\beval\s*\(|\bexec\s*\(/, exts: /\.(js|jsx|ts|tsx|py)$/i },
  { id: "subprocess-shell-true", description: "subprocess call with shell=True (shell injection risk if input is not fully controlled)", severity: "high", re: /shell\s*=\s*True/, exts: /\.py$/i },
  { id: "pickle-loads", description: "pickle.load(s) of potentially untrusted data (arbitrary code execution risk)", severity: "high", re: /pickle\.loads?\(/, exts: /\.py$/i },
  { id: "yaml-unsafe-load", description: "yaml.load() without a SafeLoader (arbitrary code execution risk)", severity: "high", re: /yaml\.load\(\s*[^)]*\)/, exts: /\.py$/i },
  { id: "dangerously-set-inner-html", description: "React dangerouslySetInnerHTML (XSS risk if content is not sanitized)", severity: "medium", re: /dangerouslySetInnerHTML/, exts: /\.(jsx|tsx|js|ts)$/i },
  { id: "sql-string-concat", description: "SQL statement built via string concatenation/interpolation (injection risk) instead of a parameterized query", severity: "high", re: /(SELECT|INSERT|UPDATE|DELETE)\b[^;"'`]*['"`]\s*\+\s*\w+|f['"](?:SELECT|INSERT|UPDATE|DELETE)\b[^'"]*\{/i, exts: /\.(py|js|ts)$/i },
];

async function scanFile(projectRoot: string, absPath: string): Promise<SecurityFinding[]> {
  const relPath = relative(projectRoot, absPath);
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return [];
  }
  const findings: SecurityFinding[] = [];
  for (const secret of scanForSecrets(content)) {
    findings.push({ ruleId: secret.ruleId, description: secret.description, severity: "high", relPath });
  }
  for (const rule of PATTERN_RULES) {
    if (!rule.exts.test(absPath)) continue;
    if (rule.re.test(content)) findings.push({ ruleId: rule.id, description: rule.description, severity: rule.severity, relPath });
  }
  return findings;
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs = 30_000): Promise<{ stdout: string; exitCode: number | null; timedOut: boolean; spawnError: boolean }> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let settled = false;
    const child = spawn(command, args, { cwd, shell: false });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolvePromise({ stdout, exitCode: null, timedOut: true, spawnError: false });
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, exitCode: null, timedOut: false, spawnError: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, exitCode: code, timedOut: false, spawnError: false });
    });
  });
}

async function auditNpm(projectRoot: string, location: string): Promise<DependencyAuditResult | null> {
  const dir = location === "." ? projectRoot : join(projectRoot, location);
  const hasLockfile = await readFile(join(dir, "package-lock.json"), "utf8").then(() => true).catch(() => false);
  if (!hasLockfile) {
    return { ecosystem: "npm", location, available: false, vulnerabilityCount: null, summary: "No package-lock.json found at this location — npm audit needs a lockfile to run." };
  }
  const result = await runCommand("npm", ["audit", "--json"], dir);
  if (result.spawnError) {
    return { ecosystem: "npm", location, available: false, vulnerabilityCount: null, summary: "npm is not available in this environment — could not run npm audit." };
  }
  if (result.timedOut) {
    return { ecosystem: "npm", location, available: true, vulnerabilityCount: null, summary: "npm audit timed out after 30s (likely network-bound registry lookup) — could not get a result." };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const byLevel = parsed.metadata?.vulnerabilities ?? {};
    const total = Object.values(byLevel).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(byLevel).filter(([, n]) => n > 0).map(([lvl, n]) => `${n} ${lvl}`).join(", ");
    return {
      ecosystem: "npm",
      location,
      available: true,
      vulnerabilityCount: total,
      summary: total === 0 ? "npm audit found no known vulnerabilities." : `npm audit found ${total} known vulnerabilit${total === 1 ? "y" : "ies"} (${breakdown}).`,
    };
  } catch {
    return { ecosystem: "npm", location, available: true, vulnerabilityCount: null, summary: "npm audit ran but its output could not be parsed as JSON — could not get a result." };
  }
}

async function auditPip(projectRoot: string, location: string): Promise<DependencyAuditResult | null> {
  const dir = location === "." ? projectRoot : join(projectRoot, location);
  const reqPath = await (async () => {
    for (const name of ["requirements.txt", "pyproject.toml"]) {
      const exists = await readFile(join(dir, name), "utf8").then(() => name).catch(() => null);
      if (exists) return exists;
    }
    return null;
  })();
  if (!reqPath) {
    return { ecosystem: "pip", location, available: false, vulnerabilityCount: null, summary: "No requirements.txt or pyproject.toml found at this location." };
  }
  const versionCheck = await runCommand("pip-audit", ["--version"], dir, 5_000);
  if (versionCheck.spawnError) {
    return { ecosystem: "pip", location, available: false, vulnerabilityCount: null, summary: "pip-audit is not installed in this environment — install it (`pip install pip-audit`) to enable Python dependency scanning." };
  }
  const args = reqPath === "requirements.txt" ? ["-r", "requirements.txt", "--format", "json"] : ["--format", "json"];
  const result = await runCommand("pip-audit", args, dir, 45_000);
  if (result.timedOut) {
    return { ecosystem: "pip", location, available: true, vulnerabilityCount: null, summary: "pip-audit timed out after 45s (likely network-bound advisory lookup) — could not get a result." };
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ vulns?: unknown[] }>;
    const total = parsed.reduce((sum, dep) => sum + (dep.vulns?.length ?? 0), 0);
    return {
      ecosystem: "pip",
      location,
      available: true,
      vulnerabilityCount: total,
      summary: total === 0 ? "pip-audit found no known vulnerabilities." : `pip-audit found ${total} known vulnerabilit${total === 1 ? "y" : "ies"}.`,
    };
  } catch {
    return { ecosystem: "pip", location, available: true, vulnerabilityCount: null, summary: "pip-audit ran but its output could not be parsed as JSON — could not get a result." };
  }
}

export async function runSecurityScan(projectRoot: string): Promise<SecurityScanReport> {
  const allFiles: string[] = [];
  await listFilesRecursive(projectRoot, 0, allFiles);
  const scannableFiles: string[] = [];
  for (const f of allFiles) {
    if (!SCANNABLE_EXT.test(f)) continue;
    try {
      const stat = await import("node:fs/promises").then((m) => m.stat(f));
      if (stat.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    scannableFiles.push(f);
  }

  const patternFindings: SecurityFinding[] = [];
  for (const f of scannableFiles) {
    patternFindings.push(...(await scanFile(projectRoot, f)));
  }

  const projectContext = await detectProjectContext(projectRoot);
  const jsLocations = [...new Set(projectContext.components.filter((c) => c.category === "frontend" || c.category === "backend").map((c) => c.location))];
  const pyBackends = projectContext.components.filter((c) => c.category === "backend" && /python|fastapi|flask|django/i.test(c.name));

  const dependencyAudits: DependencyAuditResult[] = [];
  for (const loc of jsLocations) {
    const isJs = await readFile(join(loc === "." ? projectRoot : join(projectRoot, loc), "package.json"), "utf8").then(() => true).catch(() => false);
    if (!isJs) continue;
    const result = await auditNpm(projectRoot, loc);
    if (result) dependencyAudits.push(result);
  }
  for (const c of pyBackends) {
    const result = await auditPip(projectRoot, c.location);
    if (result) dependencyAudits.push(result);
  }

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    filesScanned: scannableFiles.length,
    patternFindings,
    dependencyAudits,
  };
}
