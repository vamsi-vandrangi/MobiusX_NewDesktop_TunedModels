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

test("build mode with structured edits: parses edits from the streamed response and notes the missing second-pass review", async (t) => {
  process.env.TEST_PROVIDER_API_KEY = "test-key";
  const full = [
    "Adding a retry helper.\n\n===MOBIUSX_EDITS===\n",
    '```json\n{"edits":[{"path":"retry.ts","action":"create","content":"export const retry = () => {};"}]}\n```',
  ].join("");
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(sseStream([sseDataLine({ choices: [{ delta: { content: full } }] }), "data: [DONE]\n\n"]), { status: 200 });
  });
  const events: TaskEvent[] = [];
  await testRunner().run(baseInput({ mode: "build" }), (e) => events.push(e));
  const editsEvent = events.find((e): e is Extract<TaskEvent, { type: "edits" }> => e.type === "edits");
  assert.ok(editsEvent, "expected an edits event");
  assert.equal(editsEvent!.edits[0].path, "retry.ts");
  const output = events.filter((e): e is Extract<TaskEvent, { type: "output" }> => e.type === "output").map((e) => e.delta).join("");
  assert.match(output, /doesn't run the second-pass Reviewer agent yet/);
  assert.ok(!events.some((e) => e.type === "review"), "openrouter/groq runners don't emit a review event");
  delete process.env.TEST_PROVIDER_API_KEY;
});
