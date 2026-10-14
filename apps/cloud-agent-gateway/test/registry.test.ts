import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSettings } from "@mobiusx/protocol";
import { autoRunnerCandidates, listAllModels, resolveRunner } from "../src/runners/registry.js";

/**
 * Multi-model support: these tests exercise resolveRunner's fallback logic
 * (per-task request > modelRouting[mode] (roadmap Phase 11, source §27) >
 * Settings default > automatic choice, always with an honest fallbackNote
 * when a requested selection couldn't be honored) and listAllModels'
 * aggregation, without making any real network calls to the cloud
 * providers (key presence is all those need) or to a real local Ollama
 * install (mocked via globalThis.fetch — see the ollama-specific tests
 * below).
 *
 * `mode` is passed explicitly as "build" on every call below except the
 * modelRouting-specific tests, which use whichever mode is actually under
 * test — matching resolveRunner's real signature (roadmap Phase 11 made
 * `mode` a required third parameter) rather than relying on it being
 * omittable at the JS call-site level.
 *
 * Model ids referenced below (Groq's "openai/gpt-oss-120b"/"-20b", and
 * OpenRouter's sole entry "inclusionai/ling-3.0-flash-vl:free") were
 * updated in this same edit (roadmap Phase 11) to match each runner's
 * actual current free-tier lineup (see groqRunner.ts/openrouterRunner.ts's
 * own module comments for the live-verified history) — this test suite had
 * drifted from three prior catalog changes and was asserting ids/counts
 * that no longer exist, a real (now fixed) pre-existing gap, not something
 * this phase introduced. Never guess a replacement id here either: check
 * the runner's own `models` array first, same discipline those files
 * already document.
 */

function clearProviderEnv() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.XKIRO_API_KEY;
  delete process.env.APINEX_API_KEY;
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
  const resolved = await resolveRunner(undefined, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "demo");
  assert.equal(resolved.modelId, undefined);
  assert.equal(resolved.fallbackNote, undefined);
});

test("resolveRunner: Anthropic configured, no request -> auto-resolution prefers anthropic", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_MODEL = "claude-test-model";
  const resolved = await resolveRunner(undefined, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "anthropic");
  assert.equal(resolved.modelId, "claude-test-model");
  assert.equal(resolved.fallbackNote, undefined);
  clearProviderEnv();
});

test("resolveRunner: only OpenRouter configured -> auto-resolution picks one of its free models", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.OPENROUTER_API_KEY = "or-test";
  const resolved = await resolveRunner(undefined, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "openrouter");
  assert.ok(resolved.modelId, "expected a modelId to be chosen");
  clearProviderEnv();
});

test("Auto Cloud includes configured xKiro and APInex free models after the primary candidates", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.GROQ_API_KEY = "groq-test";
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.XKIRO_API_KEY = "xkiro-test";
  process.env.APINEX_API_KEY = "apinex-test";

  const candidates = await autoRunnerCandidates("balanced");
  assert.deepEqual(candidates.map(({ runner }) => runner.name), ["groq", "openrouter", "xkiro", "apinex"]);
  assert.deepEqual(candidates.slice(-2).map(({ modelId }) => modelId), ["qwen/qwen3-coder-plus:free", "free/deepseek-v4.1-flash"]);
  clearProviderEnv();
});

test("resolveRunner: a per-task request overrides the Settings default", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.GROQ_API_KEY = "groq-test";
  const settingsWithGroqDefault: AgentSettings = {
    terminalApprovalMode: "off",
    defaultModel: { provider: "groq", model: "openai/gpt-oss-120b" },
  };
  const resolved = await resolveRunner({ provider: "openrouter", model: "inclusionai/ling-3.0-flash-vl:free" }, settingsWithGroqDefault, "build");
  assert.equal(resolved.runner.name, "openrouter");
  assert.equal(resolved.modelId, "inclusionai/ling-3.0-flash-vl:free");
  assert.equal(resolved.fallbackNote, undefined);
  clearProviderEnv();
});

test("resolveRunner: Settings default is used when no per-task request is given", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.GROQ_API_KEY = "groq-test";
  const settingsWithGroqDefault: AgentSettings = {
    terminalApprovalMode: "off",
    defaultModel: { provider: "groq", model: "openai/gpt-oss-120b" },
  };
  const resolved = await resolveRunner(undefined, settingsWithGroqDefault, "build");
  assert.equal(resolved.runner.name, "groq");
  assert.equal(resolved.modelId, "openai/gpt-oss-120b");
  clearProviderEnv();
});

test("resolveRunner: requesting a provider with no key set falls back to demo with an honest, actionable note", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  const resolved = await resolveRunner({ provider: "openrouter", model: "inclusionai/ling-3.0-flash-vl:free" }, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "demo");
  assert.match(resolved.fallbackNote ?? "", /openrouter\/inclusionai\/ling-3\.0-flash-vl:free/);
  assert.match(resolved.fallbackNote ?? "", /OPENROUTER_API_KEY/);
  assert.match(resolved.fallbackNote ?? "", /demo/);
});

test("resolveRunner: requesting an unknown provider falls back to auto-resolution with a note", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  const resolved = await resolveRunner({ provider: "made-up-provider" as never, model: "x" }, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "demo");
  assert.match(resolved.fallbackNote ?? "", /Unknown model provider "made-up-provider"/);
});

test("resolveRunner: Ollama is never auto-selected, even when it's the only reachable option", async (t) => {
  clearProviderEnv();
  // Ollama reachable AND has llama3.1 pulled -- but AUTO_PRIORITY deliberately excludes it.
  mockOllamaTags(t, ["llama3.1:8b"]);
  const resolved = await resolveRunner(undefined, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "demo");
});

test("resolveRunner: explicitly requesting an Ollama model not yet pulled falls back to demo with a pull hint", async (t) => {
  clearProviderEnv();
  mockOllamaTags(t, ["llama3.1:8b"]); // qwen2.5-coder NOT in this list
  const resolved = await resolveRunner({ provider: "ollama", model: "qwen2.5-coder" }, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "demo");
  assert.match(resolved.fallbackNote ?? "", /ollama pull/);
});

test("resolveRunner: explicitly requesting an Ollama model by its exact installed tag (as the /models picker would send) succeeds", async (t) => {
  clearProviderEnv();
  mockOllamaTags(t, ["qwen2.5-coder:latest", "llama3.1:8b"]);
  // ollamaRunner.listModels() reports the model id as the REAL installed tag
  // once matched (see its own source) -- the picker UI always echoes back
  // exactly what /models showed it, so this is the id a real request carries.
  const resolved = await resolveRunner({ provider: "ollama", model: "qwen2.5-coder:latest" }, NO_DEFAULT, "build");
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
  const resolved = await resolveRunner({ provider: "ollama", model: "qwen2.5-coder" }, NO_DEFAULT, "build");
  assert.equal(resolved.runner.name, "demo");
  // No candidate in the list has this exact string as its `model` (the
  // installed one reports "qwen2.5-coder:latest"), so resolveRunner can't
  // attribute a specific reason -- it reports the generic "not available
  // right now" fallback rather than guessing which candidate was meant.
  assert.match(resolved.fallbackNote ?? "", /qwen2\.5-coder is not available right now/);
});

// --- roadmap Phase 11 (source §27): per-task-type model routing ---

test("resolveRunner: modelRouting[mode] is used when no per-task request is given, even with a different defaultModel set", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_MODEL = "claude-test-model";
  process.env.GROQ_API_KEY = "groq-test";
  const settings: AgentSettings = {
    terminalApprovalMode: "off",
    // Overall standing default says Anthropic...
    defaultModel: { provider: "anthropic", model: "claude-test-model" },
    // ...but "architecture" mode is specifically routed to Groq (e.g. to
    // always send its larger evidence-bundle prompts to a distinct model).
    modelRouting: { architecture: { provider: "groq", model: "openai/gpt-oss-120b" } },
  };
  const resolved = await resolveRunner(undefined, settings, "architecture");
  assert.equal(resolved.runner.name, "groq");
  assert.equal(resolved.modelId, "openai/gpt-oss-120b");
  clearProviderEnv();
});

test("resolveRunner: modelRouting has no effect on a mode it doesn't mention -- falls through to defaultModel", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.ANTHROPIC_MODEL = "claude-test-model";
  process.env.GROQ_API_KEY = "groq-test";
  const settings: AgentSettings = {
    terminalApprovalMode: "off",
    defaultModel: { provider: "anthropic", model: "claude-test-model" },
    modelRouting: { architecture: { provider: "groq", model: "openai/gpt-oss-120b" } },
  };
  // "testing" mode has no routing rule -- must fall through to defaultModel, not be affected by architecture's rule.
  const resolved = await resolveRunner(undefined, settings, "testing");
  assert.equal(resolved.runner.name, "anthropic");
  assert.equal(resolved.modelId, "claude-test-model");
  clearProviderEnv();
});

test("resolveRunner: a per-task request still wins over modelRouting[mode]", async (t) => {
  clearProviderEnv();
  mockOllamaUnreachable(t);
  process.env.OPENROUTER_API_KEY = "or-test";
  process.env.GROQ_API_KEY = "groq-test";
  const settings: AgentSettings = {
    terminalApprovalMode: "off",
    modelRouting: { database: { provider: "groq", model: "openai/gpt-oss-120b" } },
  };
  const resolved = await resolveRunner({ provider: "openrouter", model: "inclusionai/ling-3.0-flash-vl:free" }, settings, "database");
  assert.equal(resolved.runner.name, "openrouter");
  assert.equal(resolved.modelId, "inclusionai/ling-3.0-flash-vl:free");
  clearProviderEnv();
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
  // OpenRouter's free lineup is currently just one model (see
  // openrouterRunner.ts's own module comment for the live-verified history
  // of why the others were dropped) -- asserted exactly, not just ">0", so
  // a future catalog change is caught here rather than silently ignored.
  assert.ok(byProvider.get("openrouter")?.length === 1);
  assert.ok(byProvider.get("openrouter")?.every((m) => !m.available && /OPENROUTER_API_KEY/.test(m.unavailableReason ?? "")));
  assert.ok(byProvider.get("groq")?.length === 2);
  assert.ok(byProvider.get("groq")?.every((m) => !m.available && /GROQ_API_KEY/.test(m.unavailableReason ?? "")));
  assert.ok(byProvider.get("ollama")?.every((m) => !m.available && /not reachable/.test(m.unavailableReason ?? "")));
});
