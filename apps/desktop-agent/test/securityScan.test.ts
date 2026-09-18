import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityScan } from "../src/securityScan.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-secscan-test-"));
}

test("runSecurityScan reports honestly empty for a project with no scannable files", async () => {
  const dir = await tempProject();
  const report = await runSecurityScan(dir);
  assert.equal(report.projectPath, dir);
  assert.equal(report.filesScanned, 0);
  assert.deepEqual(report.patternFindings, []);
  assert.deepEqual(report.dependencyAudits, []);
});

test("runSecurityScan detects a hardcoded secret via packages/secret-scan's own rules", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "config.py"), 'API_KEY = "sk-abcdefghijklmnopqrstuvwx"\n');
  const report = await runSecurityScan(dir);
  assert.ok(report.patternFindings.some((f) => f.ruleId === "anthropic-openai-style-key" && f.relPath === "config.py"));
});

test("runSecurityScan detects eval(), subprocess shell=True, and pickle.loads as high-severity findings", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "risky.py"), "import subprocess, pickle\nsubprocess.run(cmd, shell=True)\nresult = eval(user_input)\ndata = pickle.loads(payload)\n");
  const report = await runSecurityScan(dir);
  const ruleIds = report.patternFindings.map((f) => f.ruleId);
  assert.ok(ruleIds.includes("subprocess-shell-true"));
  assert.ok(ruleIds.includes("eval-exec"));
  assert.ok(ruleIds.includes("pickle-loads"));
  assert.ok(report.patternFindings.every((f) => f.severity === "high"));
});

test("runSecurityScan detects dangerouslySetInnerHTML as a medium-severity finding, scoped to JS/TS files only", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "Widget.tsx"), "export function Widget({ html }) {\n  return <div dangerouslySetInnerHTML={{ __html: html }} />;\n}\n");
  const report = await runSecurityScan(dir);
  const finding = report.patternFindings.find((f) => f.ruleId === "dangerously-set-inner-html");
  assert.ok(finding);
  assert.equal(finding!.severity, "medium");
  assert.equal(finding!.relPath, "Widget.tsx");
});

test("runSecurityScan reports a clean file with no findings and counts it as scanned", async () => {
  const dir = await tempProject();
  await writeFile(join(dir, "clean.py"), "def add(a, b):\n    return a + b\n");
  const report = await runSecurityScan(dir);
  assert.equal(report.filesScanned, 1);
  assert.deepEqual(report.patternFindings, []);
});

test("runSecurityScan honestly reports npm audit as unavailable when there is no package-lock.json", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "frontend"), { recursive: true });
  await writeFile(join(dir, "frontend", "package.json"), JSON.stringify({ dependencies: { next: "14.0.0" } }));
  const report = await runSecurityScan(dir);
  const audit = report.dependencyAudits.find((a) => a.ecosystem === "npm");
  assert.ok(audit, "expected an npm audit attempt for the detected frontend");
  assert.equal(audit!.available, false);
  assert.equal(audit!.vulnerabilityCount, null);
  assert.match(audit!.summary, /lockfile/i);
});
