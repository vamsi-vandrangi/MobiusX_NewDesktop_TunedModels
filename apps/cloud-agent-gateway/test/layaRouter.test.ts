import { test } from "node:test";
import assert from "node:assert/strict";
import { resetLayaAvailabilityForTests, routeWithLaya } from "../src/runners/layaRouter.js";

test("routeWithLaya sends a compact request within the local decision model's input budget", async (t) => {
  resetLayaAvailabilityForTests();
  let capturedBody: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({
      answers: {
        workload: { choice: "coding", confidence: 0.91 },
        complexity: { score: 1.2, confidence: 0.8 },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await routeWithLaya({
    mode: "build",
    prompt: "Create a gardening storefront. ".repeat(200),
    projectContext: {
      projectPath: "/tmp/garden",
      indexedChunkCount: 1,
      relevantFiles: [{ relPath: "src/page.tsx", snippet: "x".repeat(10_000) }],
    },
  });

  assert.equal(result.source, "laya");
  assert.equal(result.tier, "balanced");
  const state = capturedBody?.state as { request?: string; project_files?: unknown } | undefined;
  assert.ok(state?.request);
  assert.ok(state.request.length <= 500);
  assert.equal(state.project_files, undefined, "source excerpts are not needed for task routing");
});

test("routeWithLaya preserves a short HTTP error detail in its safe rules fallback note", async (t) => {
  resetLayaAvailabilityForTests();
  t.mock.method(globalThis, "fetch", async () => new Response("model runner failed: context length exceeded", { status: 500 }));

  const result = await routeWithLaya({ mode: "build", prompt: "Build an employee payroll portal" });
  assert.equal(result.source, "rules");
  assert.match(result.note, /HTTP 500/);
  assert.match(result.note, /context length exceeded/);
  assert.equal(result.tier, "balanced");
});

test("a software build mode overrides Laya's image classification for asset-heavy app prompts", async (t) => {
  resetLayaAvailabilityForTests();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    answers: {
      workload: { choice: "image_generation", confidence: 0.94 },
      complexity: { score: 1.4, confidence: 0.8 },
    },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const result = await routeWithLaya({
    mode: "build",
    prompt: "Build a gardening storefront with flower and product images using Next.js and FastAPI.",
  });

  assert.equal(result.kind, "coding");
  assert.match(result.note, /mode requires software edits/);
  assert.doesNotMatch(result.note, /No image-generation model is configured/);
});
