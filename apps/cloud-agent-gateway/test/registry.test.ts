import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSettings } from "@mobiusx/protocol";
import { listAllModels, resolveRunner } from "../src/runners/registry.js";

/**
 * Multi-model support: these tests exercise resolveRunner's fallback logic
 * (per-task request > Settings default > automatic choice, always with an
 * honest fallbackNote when a requested selection couldn't be honored) and
 * listAllModels' aggregation, without making any real network calls to the
 * cloud providers (key presence is all those need) or to a real local
 * Ollama install (mocked via globalThis.fetch — see the ollama-specific
 * tests below).
 */

function clearProviderEnv() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
}

const NO_DEFAULT: AgentSettings = { terminalApprovalMode: "off" };

/** Makes ollamaRunner.listModels() report "not reachable" quickly and deterministically, instead of this test suite depending on (or waiting out a timeout against) whatever may or may not be running on 127.0.0.1:11434 in the environment these tests happen to run in. */
function mockOllamaUnreachable(t: import("node:test").TestContext) {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused (mocked — no local Ollama in tests)");
  });
}

function mockOllamaTags(t: import("node:test").TestContext, tagNames: string[]) {
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(JSON.stringify({ models: tagNames.map((name) => ({ name })) }), { status: 200 });
  });
}

test("resolveRunner: nothing configured, no request -> demo, no fallback note", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  const resolved = await resolveRunner(undefined, NO_DEFAULT);
  assert.equal(resolved.runner.name, "demo");
  assert.equal(resolved.modelId, undefined);
  assert.equal(resolved.fallbackNote, undefined);
});

test("resolveRunner: Anthropic configured, no request -> auto-resolution prefers anthropic", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_MODEL = "claude-test-model";
  const resolved = await resolveRunner(undefined, NO_DEFAULT);
  assert.equal(resolved.runner.name, "anthropic");
  assert.equal(resolved.modelId, "claude-test-model");
  assert.equal(resolved.fallbackNote, undefined);
  clearProviderEnv();
});

test("resolveRunner: only OpenRouter configured -> auto-resolution picks one of its free models", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.OPENROUTER_API_KEY = "or-test";
  const resolved = await resolveRunner(undefined, NO_DEFAULT);
  assert.equal(resolved.runner.name, "openrouter");
  assert.ok(resolved.modelId, "expected a modelId to be chosen");
  clearProviderEnv();
});

test("resolveRunner: a per-task request overrides the Settings default", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.GROQ_API_KEY = "groq-test";
  const settingsWithGroqDefault: AgentSettings = {
    terminalApprovalMode: "off",
    defaultModel: { provider: "groq", model: "llama-3.3-70b-versatile" },
  };
  const resolved = await resolveRunner({ provider: "openrouter", model: "qwen/qwen-2.5-coder-32b-instruct:free" }, settingsWithGroqDefault);
  assert.equal(resolved.runner.name, "openrouter");
  assert.equal(resolved.modelId, "qwen/qwen-2.5-coder-32b-instruct:free");
  assert.equal(resolved.fallbackNote, undefined);
  clearProviderEnv();
});

test("resolveRunner: Settings default is used when no per-task request is given", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.GROQ_API_KEY = "groq-test";
  const settingsWithGroqDefault: AgentSettings = {
    terminalApprovalMode: "off",
    defaultModel: { provider: "groq", model: "llama-3.3-70b-versatile" },
  };
  const resolved = await resolveRunner(undefined, settingsWithGroqDefault);
  assert.equal(resolved.runner.name, "groq");
  assert.equal(resolved.modelId, "llama-3.3-70b-versatile");
  clearProviderEnv();
});

test("resolveRunner: requesting a provider with no key set falls back to demo with an honest, actionable note", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  const resolved = await resolveRunner({ provider: "openrouter", model: "qwen/qwen-2.5-coder-32b-instruct:free" }, NO_DEFAULT);
  assert.equal(resolved.runner.name, "demo");
  assert.match(resolved.fallbackNote ?? "", /openrouter\/qwen\/qwen-2.5-coder-32b-instruct:free/);
  assert.match(resolved.fallbackNote ?? "", /OPENROUTER_API_KEY/);
  assert.match(resolved.fallbackNote ?? "", /demo/);
});

test("resolveRunner: requesting an unknown provider falls back to auto-resolution with a note", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  const resolved = await resolveRunner({ provider: "made-up-provider" as never, model: "x" }, NO_DEFAULT);
  assert.equal(resolved.runner.name, "demo");
  assert.match(resolved.fallbackNote ?? "", /Unknown model provider "made-up-provider"/);
});

test("resolveRunner: Ollama is never auto-selected, even when it's the only reachable option", async (t) => {
  clearProviderEnv();
  // Ollama reachable AND has llama3.1 pulled -- but AUTO_PRIORITY deliberately excludes it.
  mockOllamaTags(t, ["llama3.1:8b"]);
  const resolved = await resolveRunner(undefined, NO_DEFAULT);
  assert.equal(resolved.runner.name, "demo");
});

test("resolveRunner: explicitly requesting an Ollama model not yet pulled falls back to demo with a pull hint", async (t) => {
  clearProviderEnv();
  mockOllamaTags(t, ["llama3.1:8b"]); // qwen2.5-coder NOT in this list
  const resolved = await resolveRunner({ provider: "ollama", model: "qwen2.5-coder" }, NO_DEFAULT);
  assert.equal(resolved.runner.name, "demo");
  assert.match(resolved.fallbackNote ?? "", /ollama pull/);
});

test("resolveRunner: explicitly requesting an Ollama model by its exact installed tag (as the /models picker would send) succeeds", async (t) => {
  clearProviderEnv();
  mockOllamaTags(t, ["qwen2.5-coder:latest", "llama3.1:8b"]);
  // ollamaRunner.listModels() reports the model id as the REAL installed tag
  // once matched (see its own source) -- the picker UI always echoes back
  // exactly what /models showed it, so this is the id a real request carries.
  const resolved = await resolveRunner({ provider: "ollama", model: "qwen2.5-coder:latest" }, NO_DEFAULT);
  assert.equal(resolved.runner.name, "ollama");
  assert.equal(resolved.modelId, "qwen2.5-coder:latest");
});

test("resolveRunner: a stale Ollama selection (bare candidate id, not the exact installed tag) does not match -- known limitation", async (t) => {
  clearProviderEnv();
  // Only the versioned tag is installed; requesting the bare candidate id
  // ("qwen2.5-coder", with no :suffix) is an exact-string mismatch against
  // ollamaRunner.listModels()'s reported "qwen2.5-coder:latest" -- so this
  // falls back to demo rather than fuzzy-matching. A stored Settings default
  // can go stale this way if a model gets re-pulled under a different tag
  // suffix -- documented in ollamaRunner.ts and the README, not silently
  // "fixed" with fuzzy matching that would blur the "always tell the truth
  // about availability" invariant the rest of this registry relies on.
  mockOllamaTags(t, ["qwen2.5-coder:latest"]);
  const resolved = await resolveRunner({ provider: "ollama", model: "qwen2.5-coder" }, NO_DEFAULT);
  assert.equal(resolved.runner.name, "demo");
  // No candidate in the list has this exact string as its `model` (the
  // installed one reports "qwen2.5-coder:latest"), so resolveRunner can't
  // attribute a specific reason -- it reports the generic "not available
  // right now" fallback rather than guessing which candidate was meant.
  assert.match(resolved.fallbackNote ?? "", /qwen2\.5-coder is not available right now/);
});

test("listAllModels aggregates every provider, including unavailable ones with an actionable reason", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  const models = await listAllModels();

  const byProvider = new Map<string, typeof models>();
  for (const m of models) {
    byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  }

  assert.ok(byProvider.get("demo")?.every((m) => m.available));
  assert.ok(byProvider.get("anthropic")?.every((m) => !m.available && m.unavailableReason));
  assert.ok(byProvider.get("openrouter")?.length === 3);
  assert.ok(byProvider.get("openrouter")?.every((m) => !m.available && /OPENROUTER_API_KEY/.test(m.unavailableReason ?? "")));
  assert.ok(byProvider.get("groq")?.length === 3);
  assert.ok(byProvider.get("groq")?.every((m) => !m.available && /GROQ_API_KEY/.test(m.unavailableReason ?? "")));
  assert.ok(byProvider.get("ollama")?.every((m) => !m.available && /not reachable/.test(m.unavailableReason ?? "")));
});
