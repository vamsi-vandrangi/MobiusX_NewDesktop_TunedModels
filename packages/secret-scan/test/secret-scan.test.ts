import { test } from "node:test";
import assert from "node:assert/strict";
import { scanAndRedact, scanForSecrets } from "../src/index.js";

test("redacts an AWS access key and reports the match", () => {
  const { text, matches } = scanAndRedact('const key = "AKIAABCDEFGHIJKLMNOP";');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, "aws-access-key");
  assert.ok(!text.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(text.includes("[REDACTED:aws-access-key]"));
});

test("redacts an Anthropic/OpenAI-style sk- key", () => {
  const { text, matches } = scanAndRedact("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  assert.ok(matches.some((m) => m.ruleId === "anthropic-openai-style-key"));
  assert.ok(!text.includes("sk-ant-api03"));
});

test("redacts a GitHub personal access token", () => {
  const { text, matches } = scanAndRedact("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
  assert.ok(matches.some((m) => m.ruleId === "github-token"));
  assert.ok(!text.includes("ghp_1234567890"));
});

test("redacts a PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
  const { text, matches } = scanAndRedact(`before\n${pem}\nafter`);
  assert.ok(matches.some((m) => m.ruleId === "private-key-block"));
  assert.ok(!text.includes("MIIEowIBAAKCAQEA"));
  assert.ok(text.includes("before"));
  assert.ok(text.includes("after"));
});

test("redacts a hardcoded password assignment", () => {
  const { text, matches } = scanAndRedact('DB_PASSWORD = "correct horse battery staple"');
  assert.ok(matches.some((m) => m.ruleId === "generic-secret-assignment"));
  assert.ok(!text.includes("correct horse battery staple"));
});

test("redacts a JWT-looking token", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abcdefghijklmno";
  const { text, matches } = scanAndRedact(`Authorization: Bearer ${jwt}`);
  assert.ok(matches.some((m) => m.ruleId === "jwt"));
  assert.ok(!text.includes(jwt));
});

test("multiple distinct secrets in one snippet are all redacted and all reported", () => {
  const input = [
    'const awsKey = "AKIAABCDEFGHIJKLMNOP";',
    'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz12";',
  ].join("\n");
  const { text, matches } = scanAndRedact(input);
  assert.equal(matches.length, 2);
  assert.ok(!text.includes("AKIAABCDEFGHIJKLMNOP"));
  assert.ok(!text.includes("ghp_1234567890"));
});

test("ordinary code with no secrets passes through unchanged and unflagged", () => {
  const code = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
  const { text, matches } = scanAndRedact(code);
  assert.equal(text, code);
  assert.deepEqual(matches, []);
});

test("scanForSecrets detects without altering the text", () => {
  const src = 'const key = "AKIAABCDEFGHIJKLMNOP";';
  const matches = scanForSecrets(src);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ruleId, "aws-access-key");
});

test("scanForSecrets reports no matches for ordinary code", () => {
  const code = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
  assert.deepEqual(scanForSecrets(code), []);
});
