import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskEvent } from "@mobiusx/protocol";
import { ollamaRunner, streamOllamaNdjson } from "../src/runners/ollamaRunner.js";
import type { RunnerInput } from "../src/runners/types.js";

function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      controller.close();
    },
  });
}

test("streamOllamaNdjson accumulates message.content across lines and stops at done:true", async () => {
  const stream = ndjsonStream([
    { message: { content: "Hel" }, done: false },
    { message: { content: "lo" }, done: false },
    { message: { content: "" }, done: true },
  ]);
  const chunks: string[] = [];
  const sawText = await streamOllamaNdjson(stream, (t) => chunks.push(t));
  assert.equal(sawText, true);
  assert.equal(chunks.join(""), "Hello");
});

test("streamOllamaNdjson skips a malformed line rather than crashing", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("{not json}\n"));
      controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n"));
      controller.close();
    },
  });
  const chunks: string[] = [];
  const sawText = await streamOllamaNdjson(stream, (t) => chunks.push(t));
  assert.equal(sawText, true);
  assert.equal(chunks.join(""), "ok");
});

test("streamOllamaNdjson throws on an explicit error line", async () => {
  const stream = ndjsonStream([{ error: "model not found" }]);
  await assert.rejects(() => streamOllamaNdjson(stream, () => {}), /model not found/);
});

function baseInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return { taskId: "t1", mode: "ask", prompt: "hello", modelId: "qwen2.5-coder", ...overrides };
}

test("listModels reports every candidate as unavailable, with a reachability reason, when Ollama can't be reached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  const models = await ollamaRunner.listModels();
  assert.equal(models.length, 3);
  assert.ok(models.every((m) => !m.available));
  assert.ok(models.every((m) => /not reachable/.test(m.unavailableReason ?? "")));
});

test("listModels matches a locally-pulled tag by prefix and reports the others as not-yet-pulled", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:32b" }] }), { status: 200 }));
  const models = await ollamaRunner.listModels();
  const qwen = models.find((m) => m.model.startsWith("qwen2.5-coder") || m.label.includes("Qwen"));
  assert.ok(qwen?.available);
  const llama = models.find((m) => m.label.includes("Llama"));
  assert.ok(llama && !llama.available && /ollama pull/.test(llama.unavailableReason ?? ""));
});

test("run() emits an error, not a crash, when no modelId was resolved", async () => {
  const events: TaskEvent[] = [];
  await ollamaRunner.run(baseInput({ modelId: undefined }), (e) => events.push(e));
  assert.ok(events.some((e) => e.type === "error"));
  assert.ok(events.some((e) => e.type === "done"));
});

test("run() streams output deltas from a mocked local Ollama", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      ndjsonStream([
        { message: { content: "Hi" }, done: false },
        { message: { content: " there" }, done: false },
        { done: true },
      ]),
      { status: 200 },
    );
  });
  const events: TaskEvent[] = [];
  await ollamaRunner.run(baseInput(), (e) => events.push(e));
  const output = events.filter((e): e is Extract<TaskEvent, { type: "output" }> => e.type === "output").map((e) => e.delta).join("");
  assert.equal(output, "Hi there");
  assert.ok(events.some((e) => e.type === "status" && e.status === "completed"));
});

test("run() treats an aborted signal as cancelled, not failed", async (t) => {
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
  const runPromise = ollamaRunner.run(baseInput({ signal: controller.signal }), (e) => events.push(e));
  controller.abort();
  await runPromise;
  assert.ok(events.some((e) => e.type === "status" && e.status === "cancelled"));
  assert.ok(!events.some((e) => e.type === "error"));
});
