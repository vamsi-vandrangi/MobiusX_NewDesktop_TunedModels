import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the settings file at an isolated temp dir before importing anything
// that reads it — same pattern used throughout this repo's test suites
// (taskEngine.test.ts's MOBIUSX_CLOUD_DATA_DIR, terminalWs.test.ts's own
// MOBIUSX_SETTINGS_DIR) so tests never touch a real ~/.mobiusx.
const settingsDir = await mkdtemp(join(tmpdir(), "mobiusx-agent-settings-test-"));
process.env.MOBIUSX_SETTINGS_DIR = settingsDir;

const { getSettings, updateSettings } = await import("../src/index.js");

test("getSettings returns defaults when no file exists yet", async () => {
  const settings = await getSettings();
  assert.deepEqual(settings, { terminalApprovalMode: "off" });
});

test("updateSettings persists terminalApprovalMode and getSettings reflects it", async () => {
  const updated = await updateSettings({ terminalApprovalMode: "guarded" });
  assert.equal(updated.terminalApprovalMode, "guarded");
  assert.deepEqual(await getSettings(), { terminalApprovalMode: "guarded" });
});

test("updateSettings sets and persists a defaultModel selection", async () => {
  const updated = await updateSettings({ defaultModel: { provider: "openrouter", model: "qwen/qwen-2.5-coder-32b-instruct:free" } });
  assert.deepEqual(updated.defaultModel, { provider: "openrouter", model: "qwen/qwen-2.5-coder-32b-instruct:free" });
  const settings = await getSettings();
  assert.deepEqual(settings.defaultModel, { provider: "openrouter", model: "qwen/qwen-2.5-coder-32b-instruct:free" });
  // terminalApprovalMode from the previous test must be untouched by this unrelated patch.
  assert.equal(settings.terminalApprovalMode, "guarded");
});

test("updateSettings with defaultModel: null clears a previously-set default", async () => {
  await updateSettings({ defaultModel: { provider: "groq", model: "llama-3.3-70b-versatile" } });
  assert.ok((await getSettings()).defaultModel);

  const cleared = await updateSettings({ defaultModel: null });
  assert.equal(cleared.defaultModel, undefined);
  assert.equal((await getSettings()).defaultModel, undefined);
});

test("updateSettings omitting defaultModel leaves an existing default untouched", async () => {
  await updateSettings({ defaultModel: { provider: "anthropic", model: "claude-x" } });
  await updateSettings({ terminalApprovalMode: "off" });
  const settings = await getSettings();
  assert.equal(settings.terminalApprovalMode, "off");
  assert.deepEqual(settings.defaultModel, { provider: "anthropic", model: "claude-x" });
});

test("getSettings drops an invalid defaultModel (unknown provider) without discarding terminalApprovalMode", async () => {
  const file = join(settingsDir, "settings.json");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(file, JSON.stringify({ terminalApprovalMode: "guarded", defaultModel: { provider: "bogus-provider", model: "x" } })),
  );
  const settings = await getSettings();
  assert.equal(settings.terminalApprovalMode, "guarded");
  assert.equal(settings.defaultModel, undefined);
});

test("getSettings falls back to full defaults on a corrupt (unparseable) file", async () => {
  const file = join(settingsDir, "settings.json");
  await import("node:fs/promises").then((fs) => fs.writeFile(file, "{ not json"));
  assert.deepEqual(await getSettings(), { terminalApprovalMode: "off" });
});

test("settings file on disk is valid, readable JSON", async () => {
  await updateSettings({ terminalApprovalMode: "guarded", defaultModel: { provider: "ollama", model: "qwen2.5-coder" } });
  const raw = await readFile(join(settingsDir, "settings.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.terminalApprovalMode, "guarded");
  assert.deepEqual(parsed.defaultModel, { provider: "ollama", model: "qwen2.5-coder" });
});
