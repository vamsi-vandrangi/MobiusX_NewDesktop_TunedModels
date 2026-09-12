import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the log at an isolated temp dir before importing anything that reads it.
const dir = await mkdtemp(join(tmpdir(), "mobiusx-audit-test-"));
process.env.MOBIUSX_AUDIT_LOG_DIR = dir;

const { appendAuditEntry, readAuditLog } = await import("../src/index.js");

test("readAuditLog returns an empty list before anything has been logged", async () => {
  const entries = await readAuditLog();
  assert.deepEqual(entries, []);
});

test("appendAuditEntry writes an entry readable back via readAuditLog", async () => {
  const entry = await appendAuditEntry({
    source: "desktop-agent",
    category: "terminal-command-guard",
    severity: "warning",
    summary: "flagged rm -rf /",
  });
  assert.ok(entry.id);
  assert.ok(entry.timestamp);

  const entries = await readAuditLog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].summary, "flagged rm -rf /");
  assert.equal(entries[0].source, "desktop-agent");
});

test("readAuditLog respects the limit, keeping the most recent entries", async () => {
  for (let i = 0; i < 5; i++) {
    await appendAuditEntry({
      source: "cloud-agent-gateway",
      category: "secret-redaction",
      severity: "info",
      summary: `entry ${i}`,
    });
  }
  const entries = await readAuditLog(3);
  assert.equal(entries.length, 3);
  assert.equal(entries[entries.length - 1].summary, "entry 4");
});

test("detail is preserved round-trip through the JSONL file", async () => {
  await appendAuditEntry({
    source: "cloud-agent-gateway",
    category: "secret-redaction",
    severity: "warning",
    summary: "redacted 2 secrets",
    detail: { taskId: "abc-123", rules: ["aws-access-key", "generic-password-assignment"] },
  });
  const entries = await readAuditLog();
  const last = entries[entries.length - 1];
  assert.deepEqual(last.detail, { taskId: "abc-123", rules: ["aws-access-key", "generic-password-assignment"] });
});
