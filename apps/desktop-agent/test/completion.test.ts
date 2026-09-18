import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolates this file's runs from the real ~/.mobiusx/audit.jsonl: audit-log's
 * LOG_DIR is a module-top-level const captured from MOBIUSX_AUDIT_LOG_DIR at
 * import time (see packages/audit-log/src/index.ts), so it must be set
 * BEFORE that module is ever evaluated. A static top-level `import` would
 * already have run before any of this file's own code executes (ESM import
 * hoisting) -- so both `completion.js` (which itself statically imports
 * audit-log) and audit-log are loaded here via dynamic `import()` AFTER the
 * env var is set, deferring their module evaluation to this point.
 */
const tempAuditDir = await mkdtemp(join(tmpdir(), "mobiusx-audit-test-"));
process.env.MOBIUSX_AUDIT_LOG_DIR = tempAuditDir;
const { computeCompletionReport } = await import("../src/completion.js");
const { appendAuditEntry } = await import("@mobiusx/audit-log");

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-completion-test-"));
}

function criterion(report: Awaited<ReturnType<typeof computeCompletionReport>>, id: string) {
  return report.criteria.find((c) => c.id === id);
}

test("auth_verified is not_configured when no auth dependency is detected", async () => {
  const dir = await tempProject();
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "auth_verified")?.status, "not_configured");
});

test("auth_verified is fail when an auth dependency is declared but no real token-verification call exists", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "backend", "package.json"), JSON.stringify({ dependencies: { jsonwebtoken: "9.0.0" } }));
  await writeFile(join(dir, "backend", "auth.js"), "// TODO: not implemented yet\n");
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "auth_verified")?.status, "fail");
});

test("auth_verified is pass when an auth dependency is declared and a real token-verification call is found", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "backend"), { recursive: true });
  await writeFile(join(dir, "backend", "package.json"), JSON.stringify({ dependencies: { jsonwebtoken: "9.0.0" } }));
  await writeFile(join(dir, "backend", "auth.js"), "const jwt = require('jsonwebtoken');\nfunction verify(t) { return jwt.verify(t, SECRET); }\n");
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "auth_verified")?.status, "pass");
});

test("e2e_tests_pass is not_configured when no browser-validation audit entry exists for this project", async () => {
  const dir = await tempProject();
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "e2e_tests_pass")?.status, "not_configured");
});

test("e2e_tests_pass reflects the most recent cached browser-validation audit entry for this exact project", async () => {
  const dir = await tempProject();
  await appendAuditEntry({
    source: "desktop-agent",
    category: "browser-validation",
    severity: "info",
    summary: "Browser validation passed (2/2 step(s) passed) in " + dir,
    detail: { projectPath: dir, overall: "passed" },
  });
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "e2e_tests_pass")?.status, "pass");
});

test("e2e_tests_pass ignores a browser-validation entry logged for a DIFFERENT project", async () => {
  const dir = await tempProject();
  const otherDir = await tempProject();
  await appendAuditEntry({
    source: "desktop-agent",
    category: "browser-validation",
    severity: "info",
    summary: "Browser validation passed in " + otherDir,
    detail: { projectPath: otherDir, overall: "passed" },
  });
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "e2e_tests_pass")?.status, "not_configured");
});

test("security_scan_clean is not_configured when no security-scan audit entry exists for this project", async () => {
  const dir = await tempProject();
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "security_scan_clean")?.status, "not_configured");
});

test("security_scan_clean is pass when the last cached scan found zero findings, fail when it found some", async () => {
  const cleanDir = await tempProject();
  await appendAuditEntry({
    source: "desktop-agent",
    category: "security-scan",
    severity: "info",
    summary: "Security scan: 0 pattern finding(s) across 3 file(s) in " + cleanDir,
    detail: { projectPath: cleanDir, findingCount: 0 },
  });
  const cleanReport = await computeCompletionReport(cleanDir, false);
  assert.equal(criterion(cleanReport, "security_scan_clean")?.status, "pass");

  const dirtyDir = await tempProject();
  await appendAuditEntry({
    source: "desktop-agent",
    category: "security-scan",
    severity: "warning",
    summary: "Security scan: 2 pattern finding(s) across 3 file(s) in " + dirtyDir,
    detail: { projectPath: dirtyDir, findingCount: 2 },
  });
  const dirtyReport = await computeCompletionReport(dirtyDir, false);
  assert.equal(criterion(dirtyReport, "security_scan_clean")?.status, "fail");
});

test("deployment_verified stays honestly not_configured -- no live deployment mechanism exists", async () => {
  const dir = await tempProject();
  const report = await computeCompletionReport(dir, false);
  assert.equal(criterion(report, "deployment_verified")?.status, "not_configured");
});
