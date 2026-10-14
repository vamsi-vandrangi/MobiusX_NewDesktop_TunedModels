import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskEvent } from "@mobiusx/protocol";
import { createOpenAiCompatibleRunner, streamOpenAiSse } from "../src/runners/openAiCompatibleRunner.js";
import type { RunnerInput } from "../src/runners/types.js";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseDataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test("streamOpenAiSse forwards each delta.content chunk and stops cleanly at [DONE]", async () => {
  const stream = sseStream([
    sseDataLine({ choices: [{ delta: { content: "Hel" } }] }),
    sseDataLine({ choices: [{ delta: { content: "lo" } }] }),
    "data: [DONE]\n\n",
  ]);
  const chunks: string[] = [];
  const sawText = await streamOpenAiSse(stream, (t) => chunks.push(t));
  assert.equal(sawText, true);
  assert.equal(chunks.join(""), "Hello");
});

test("streamOpenAiSse skips malformed lines instead of throwing", async () => {
  const stream = sseStream(["data: {not json\n\n", sseDataLine({ choices: [{ delta: { content: "ok" } }] })]);
  const chunks: string[] = [];
  const sawText = await streamOpenAiSse(stream, (t) => chunks.push(t));
  assert.equal(sawText, true);
  assert.equal(chunks.join(""), "ok");
});

test("streamOpenAiSse throws on an explicit error event", async () => {
  const stream = sseStream([sseDataLine({ error: { message: "rate limited" } })]);
  await assert.rejects(() => streamOpenAiSse(stream, () => {}), /rate limited/);
});

test("streamOpenAiSse reports sawText=false when the stream had no content", async () => {
  const stream = sseStream(["data: [DONE]\n\n"]);
  const sawText = await streamOpenAiSse(stream, () => {});
  assert.equal(sawText, false);
});

function baseInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return { taskId: "t1", mode: "ask", prompt: "hello", modelId: "test-model", ...overrides };
}

function testRunner(apiKeyEnvVar = "TEST_PROVIDER_API_KEY") {
  return createOpenAiCompatibleRunner({
    provider: "openrouter",
    baseUrl: "https://example.invalid/v1",
    apiKeyEnvVar,
    models: [{ model: "test-model", label: "Test Model", free: true }],
  });
}

test("run() emits an error and never calls fetch when the API key env var is unset", async (t) => {
  delete process.env.TEST_PROVIDER_API_KEY;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch should not have been called");
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput(), (e) => events.push(e));
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.ok(events.some((e) => e.type === "error" && e.message.includes("TEST_PROVIDER_API_KEY")));
  assert.ok(events.some((e) => e.type === "done"));
});

test("run() streams output deltas end to end against a mocked fetch", async (t) => {
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(sseStream([sseDataLine({ choices: [{ delta: { content: "Hi there" } }] }), "data: [DONE]\n\n"]), {
      status: 200,
    });
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput(), (e) => events.push(e));
  const output = events.filter((e): e is Extract<TaskEvent, { type: "output" }> => e.type === "output").map((e) => e.delta).join("");
  assert.equal(output, "Hi there");
  assert.ok(events.some((e) => e.type === "status" && e.status === "completed"));
  assert.ok(events.some((e) => e.type === "done"));
  delete process.env.TEST_PROVIDER_API_KEY;
});

test("run() reports a non-2xx response as an error, not a crash", async (t) => {
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  t.mock.method(globalThis, "fetch", async () => new Response("rate limited", { status: 429 }));
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput(), (e) => events.push(e));
  assert.ok(events.some((e) => e.type === "error" && e.message.includes("429")));
  delete process.env.TEST_PROVIDER_API_KEY;
});

test("run() treats an aborted signal as cancelled, not failed", async (t) => {
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: string, opts: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
  const events: TaskEvent[] = [];
  const runPromise = testRunner().run(baseInput({ signal: controller.signal }), (e) => events.push(e));
  controller.abort();
  await runPromise;
  assert.ok(events.some((e) => e.type === "status" && e.status === "cancelled"));
  assert.ok(!events.some((e) => e.type === "error"));
  delete process.env.TEST_PROVIDER_API_KEY;
});

test("build mode with structured edits: parses edits from the streamed response and runs a real persona second-pass review", async (t) => {
  // Roadmap Phase 11 (source §26/§27): this runner now runs the same
  // persona-based second-pass Reviewer agent anthropicRunner.ts does (see
  // runners/personas.ts) -- previously a real, documented scope cut
  // ("openrouter/groq runners don't emit a review event"), closed as of
  // this phase. The mock below answers two DIFFERENT requests against the
  // same /chat/completions endpoint: call #1 is the streaming build-mode
  // response (edits), call #2 is the non-streamed review call:.
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  const full = [
    "Adding a retry helper.\n\n===MOBIUSX_EDITS===\n",
    '```json\n{"edits":[{"path":"retry.ts","action":"create","content":"export const retry = () => {};"}]}\n```',
  ].join("");
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, opts: { body?: string }) => {
    callCount += 1;
    const body = JSON.parse((opts?.body as string) ?? "{}") as { stream?: boolean };
    if (body.stream === false) {
      // The review call: respond with a real, well-formed verdict.
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve","summary":"Looks safe."}' } }] }),
        { status: 200 },
      );
    }
    return new Response(sseStream([sseDataLine({ choices: [{ delta: { content: full } }] }), "data: [DONE]\n\n"]), { status: 200 });
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput({ mode: "build" }), (e) => events.push(e));
  const editsEvent = events.find((e): e is Extract<TaskEvent, { type: "edits" }> => e.type === "edits");
  assert.ok(editsEvent, "expected an edits event");
  assert.equal(editsEvent!.edits[0].path, "retry.ts");
  const output = events.filter((e): e is Extract<TaskEvent, { type: "output" }> => e.type === "output").map((e) => e.delta).join("");
  assert.ok(!output.includes("doesn't run the second-pass Reviewer agent yet"), "the old scope-cut note should be gone");
  const reviewEvent = events.find((e): e is Extract<TaskEvent, { type: "review" }> => e.type === "review");
  assert.ok(reviewEvent, "expected a review event now that this runner has a real persona reviewer");
  assert.equal(reviewEvent!.review.verdict, "approve");
  assert.equal(reviewEvent!.review.summary, "Looks safe.");
  // "retry.ts" matches none of classifyPersona's api/frontend path patterns -- backend is the default.
  assert.equal(reviewEvent!.review.persona, "backend");
  assert.ok(callCount >= 2 && callCount <= 3, "expected the build, its review, and at most one optional memory-extraction call");
  delete process.env.TEST_PROVIDER_API_KEY;
});

test("build mode: a reasoning-only first response (no real content) recovers via retry and proposes edits", async (t) => {
  // Real, observed failure mode (Oct 2026: openai/gpt-oss-20b via Groq) --
  // the model's FIRST attempt spends its whole response on
  // `delta.reasoning` and never emits any `delta.content`, so sawText is
  // false and there's no fullText for parseBuildResponse to look at at
  // all. retryWithoutReasoning should get one more shot, and if THAT
  // produces a real, well-formed response, the task should end up with
  // real edits -- not just a nicer error message.
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  const retryFull = [
    "Adding a home page.\n\n===MOBIUSX_EDITS===\n",
    '```json\n{"edits":[{"path":"index.html","action":"create","content":"<h1>Hi</h1>"}]}\n```',
  ].join("");
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, opts: { body?: string }) => {
    callCount += 1;
    const body = JSON.parse((opts?.body as string) ?? "{}") as { stream?: boolean };
    if (body.stream === false) {
      // The persona review call.
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve","summary":"Fine."}' } }] }), { status: 200 });
    }
    if (callCount === 1) {
      // First attempt: all reasoning, no real content at all.
      return new Response(
        sseStream([sseDataLine({ choices: [{ delta: { reasoning: "Let me think about this for a while..." } }] }), "data: [DONE]\n\n"]),
        { status: 200 },
      );
    }
    // The retry: a real, well-formed answer.
    return new Response(sseStream([sseDataLine({ choices: [{ delta: { content: retryFull } }] }), "data: [DONE]\n\n"]), { status: 200 });
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput({ mode: "build" }), (e) => events.push(e));
  const editsEvent = events.find((e): e is Extract<TaskEvent, { type: "edits" }> => e.type === "edits");
  assert.ok(editsEvent, "expected the retry's edits to make it through");
  assert.equal(editsEvent!.edits[0].path, "index.html");
  assert.ok(callCount >= 3 && callCount <= 4, "expected the initial attempt, retry, review, and at most one optional memory-extraction call");
  delete process.env.TEST_PROVIDER_API_KEY;
});

test("build mode: reasoning-only even after retry gives a short, actionable message instead of a multi-thousand-char dump", async (t) => {
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  const longReasoning = "x".repeat(5000); // longer than both the old 4000-char cap and the new 500-char one
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      sseStream([sseDataLine({ choices: [{ delta: { reasoning: longReasoning } }] }), "data: [DONE]\n\n"]),
      { status: 200 },
    );
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput({ mode: "build" }), (e) => events.push(e));
  assert.ok(!events.some((e) => e.type === "edits"), "no edits should be proposed when nothing usable ever came back");
  const output = events.filter((e): e is Extract<TaskEvent, { type: "output" }> => e.type === "output").map((e) => e.delta).join("");
  assert.ok(output.includes("No file changes were proposed"), "the actionable explanation must be present");
  assert.ok(output.includes("even after asking again"), "should reflect that a retry was actually attempted");
  assert.ok(output.includes("try again") || output.includes("switch models"), "should suggest a concrete next step");
  assert.ok(!output.includes(longReasoning), "provider-private reasoning must never be emitted to the user");
  assert.ok(output.length < 1200, `expected a short, actionable message, got ${output.length} chars`);
  delete process.env.TEST_PROVIDER_API_KEY;
});

test("Auto Cloud marks a prose-only build as provider failure after recovery so it can fail over", async (t) => {
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  const signOff = "With this foundation you have a secure, compliant payroll system ready for rapid feature expansion while staying lean and maintainable. Happy coding!";
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount += 1;
    return new Response(sseStream([sseDataLine({ choices: [{ delta: { content: signOff } }] }), "data: [DONE]\n\n"]), {
      status: 200,
    });
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput({ mode: "build", autoCloud: true }), (event) => events.push(event));

  assert.equal(callCount, 2, "expected one initial generation and one focused file-edit recovery attempt");
  assert.ok(events.some((event) => event.type === "provider_failure"), "Auto Cloud needs a failure signal to try its next configured model");
  assert.ok(!events.some((event) => event.type === "edits"), "prose must not be mistaken for generated files");
  const output = events.filter((event): event is Extract<TaskEvent, { type: "output" }> => event.type === "output").map((event) => event.delta).join("");
  assert.ok(!output.includes("No file changes were proposed"), "the task-level Auto Cloud flow should own the final failure message");
  delete process.env.TEST_PROVIDER_API_KEY;
});
