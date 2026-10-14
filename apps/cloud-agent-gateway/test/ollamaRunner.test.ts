import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { TaskEvent } from "@mobiusx/protocol";
import { diagnoseOllama, ollamaRunner, ollamaBuildTimeoutMs, ollamaChatOptionsForTests, ollamaContextTokens, ollamaHeadersTimeoutMs, observeOllamaSocketForTests, promiseWithDeadline, redactedOllamaRequestForDiagnostics, setOllamaChatTransportForTests, streamOllamaNdjson } from "../src/runners/ollamaRunner.js";
import type { RunnerInput } from "../src/runners/types.js";

setOllamaChatTransportForTests((endpoint, body, signal) => fetch(endpoint, {
  method: "POST", body, signal, headers: { "content-type": "application/json" },
}));

test("Ollama inference header timeout is explicit, configurable, and bounded below the task deadline", () => {
  assert.ok(ollamaHeadersTimeoutMs() >= 1_000);
  assert.ok(ollamaHeadersTimeoutMs() <= 20 * 60_000);
});

test("Ollama full Build deadline is bounded and can exceed its independent header deadline", () => {
  assert.ok(ollamaBuildTimeoutMs() >= 20 * 60_000);
  assert.ok(ollamaBuildTimeoutMs() <= 45 * 60_000);
  assert.ok(ollamaBuildTimeoutMs() > ollamaHeadersTimeoutMs());
});

test("Ollama keeps num_ctx stable across prompt sizes to avoid replacing the loaded runner", () => {
  const small = ollamaChatOptionsForTests({ taskId: "small", mode: "build", prompt: "short" }, "system");
  const large = ollamaChatOptionsForTests({ taskId: "large", mode: "build", prompt: "x".repeat(15_000) }, "system");
  assert.equal(small.num_ctx, ollamaContextTokens());
  assert.equal(large.num_ctx, ollamaContextTokens());
  assert.equal(small.num_ctx, large.num_ctx);
  assert.ok(small.num_predict >= 1_024);
  assert.ok(large.num_predict >= 1_024);
});

test("Ollama rejects a request that cannot fit its context instead of silently truncating it", () => {
  assert.throws(
    () => ollamaChatOptionsForTests({ taskId: "oversized", mode: "build", prompt: "x".repeat(100_000) }, "system"),
    /context budget exceeded before dispatch/,
  );
});

test("Ollama request provenance retains options and message hashes without storing message content", () => {
  const privatePrompt = "source code that must not be copied to diagnostics";
  const redacted = redactedOllamaRequestForDiagnostics(JSON.stringify({ model: "qwen2.5-coder:7b-instruct-q4_K_M", keep_alive: "5m", stream: true, options: { temperature: 0.2, num_ctx: 12288, num_predict: 512 }, messages: [{ role: "system", content: "Be concise" }, { role: "user", content: privatePrompt }] }));
  assert.ok(redacted);
  assert.deepEqual(redacted.options, { temperature: 0.2, num_ctx: 12288, num_predict: 512 });
  assert.equal(redacted.messages[1].contentBytes, Buffer.byteLength(privatePrompt));
  assert.match(redacted.messages[1].contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(redacted).includes(privatePrompt), false);
  assert.equal(redactedOllamaRequestForDiagnostics("not json"), undefined);
});

test("Ollama transport does not accumulate connect listeners on a reused socket", () => {
  const socket = Object.assign(new EventEmitter(), { connecting: false, encrypted: false });
  const phases: string[] = [];
  for (let i = 0; i < 25; i += 1) observeOllamaSocketForTests(socket, (phase) => phases.push(phase));
  assert.equal(socket.listenerCount("connect"), 0);
  assert.equal(socket.listenerCount("secureConnect"), 0);
  assert.equal(phases.filter((phase) => phase === "connected").length, 25);
  assert.equal(phases.filter((phase) => phase === "connect").length, 25);
});

test("Ollama transport observes one pending connection event when a socket is still connecting", () => {
  const socket = Object.assign(new EventEmitter(), { connecting: true, encrypted: false });
  const phases: string[] = [];
  observeOllamaSocketForTests(socket, (phase) => phases.push(phase));
  assert.equal(socket.listenerCount("connect"), 1);
  socket.emit("connect");
  assert.deepEqual(phases, ["connect", "connected"]);
  assert.equal(socket.listenerCount("connect"), 0);
});

function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      controller.close();
    },
  });
}

test("diagnoseOllama separates installed local coding model availability from a broken Laya endpoint", async (t) => {
  const prior = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  t.after(() => prior === undefined ? delete process.env.OLLAMA_BASE_URL : process.env.OLLAMA_BASE_URL = prior);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b-instruct-q4_K_M" }, { name: "laya:latest" }] }), { status: 200 });
    if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.40.0" }), { status: 200 });
    return new Response(JSON.stringify({ error: "mlx runner failed: Unable to construct residency set" }), { status: 500 });
  });

  const result = await diagnoseOllama("qwen2.5-coder:7b-instruct-q4_K_M");
  assert.equal(result.reachable, true);
  assert.equal(result.version, "0.40.0");
  assert.equal(result.selectedLocalModelAvailable, true);
  assert.equal(result.layaInstalled, true);
  assert.equal(result.layaUsable, false);
  assert.match(result.detail, /local inference is available/);
  assert.match(result.detail, /Unable to construct residency set/);
});

test("diagnoseOllama discovers another loopback alias without scanning the network", async (t) => {
  const prior = process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_BASE_URL;
  t.after(() => prior === undefined ? delete process.env.OLLAMA_BASE_URL : process.env.OLLAMA_BASE_URL = prior);
  const visited: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    visited.push(url);
    if (url.startsWith("http://127.0.0.1")) throw new Error("connection refused");
    if (url.startsWith("http://localhost")) return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), { status: 200 });
    return new Response(JSON.stringify({ version: "0.40.0" }), { status: 200 });
  });

  const result = await diagnoseOllama();
  assert.equal(result.reachable, true);
  assert.equal(result.endpoint, "http://localhost:11434");
  assert.equal(result.endpointSource, "discovered");
  assert.ok(visited.every((url) => /^(http:\/\/(127\.0\.0\.1|localhost|\[::1\]):11434\/)/.test(url)));
});

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

test("streamOllamaNdjson records actual Ollama load, prompt, generation, and token metrics", async () => {
  const stream = ndjsonStream([{ message: { content: "ok" }, done: true, prompt_eval_count: 123, eval_count: 45, load_duration: 2_000_000_000, prompt_eval_duration: 3_000_000_000, eval_duration: 4_000_000_000, total_duration: 9_000_000_000 }]);
  let metrics: unknown;
  await streamOllamaNdjson(stream, () => {}, (_usage, values) => { metrics = values; });
  assert.deepEqual(metrics, { prompt_eval_count: 123, eval_count: 45, load_duration: 2_000_000_000, prompt_eval_duration: 3_000_000_000, eval_duration: 4_000_000_000, total_duration: 9_000_000_000 });
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

test("streamOllamaNdjson reports activity and rejects a stream that becomes idle", async () => {
  const encoder = new TextEncoder();
  const stalled = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "first" } }) + "\n")); } });
  const activity: Array<[number, number]> = [];
  await assert.rejects(
    () => streamOllamaNdjson(stalled, () => {}, undefined, (at, bytes) => activity.push([at, bytes]), 15),
    (error: Error) => error.name === "StreamIdleTimeoutError" && /15ms/.test(error.message),
  );
  assert.equal(activity.length, 1);
  assert.ok(activity[0][1] > 0);
});

test("streamOllamaNdjson throws on an explicit error line", async () => {
  const stream = ndjsonStream([{ error: "model not found" }]);
  await assert.rejects(() => streamOllamaNdjson(stream, () => {}), /model not found/);
});

test("promiseWithDeadline aborts and rejects a stalled Ollama operation", async () => {
  let aborted = false;
  await assert.rejects(
    () => promiseWithDeadline(new Promise<never>(() => {}), Date.now() + 20, () => { aborted = true; }),
    (error: Error) => error.name === "TimeoutError",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(aborted, true);
});

test("promiseWithDeadline rejects even when abort cleanup throws", async () => {
  await assert.rejects(
    () => promiseWithDeadline(new Promise<never>(() => {}), Date.now() + 20, () => { throw new Error("abort cleanup failed"); }),
    (error: Error) => error.name === "TimeoutError",
  );
});

function baseInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return { taskId: "t1", mode: "ask", prompt: "hello", modelId: "qwen2.5-coder", ...overrides };
}

test("listModels reports every candidate as unavailable, with a reachability reason, when Ollama can't be reached", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("connection refused");
  });
  const models = await ollamaRunner.listModels();
  assert.ok(models.length >= 3, "all configured local model candidates should be reported");
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

test("run() surfaces a failed Ollama repair request instead of reducing it to an empty repair", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(ndjsonStream([
        { message: { content: "I will build a customer onboarding application with a frontend and backend." }, done: false },
        { done: true },
      ]));
    }
    throw new TypeError("fetch failed");
  });

  const events: TaskEvent[] = [];
  await ollamaRunner.run(baseInput({
    mode: "build",
    archMode: "web",
    prompt: "Build a customer onboarding application with login, approvals, PostgreSQL, and tests.",
    projectContext: { projectPath: "/tmp/customer-onboarding-test", relevantFiles: [], indexedChunkCount: 0 },
  }), (event) => events.push(event));

  assert.equal(calls, 2, "one generation request and one bounded format-recovery request");
  assert.ok(events.some((event) => event.type === "error" && /Ollama repair request failed: fetch failed/.test(event.message)));
  const diagnostic = events.find((event) => event.type === "model_diagnostic")?.diagnostic;
  assert.ok(diagnostic);
  assert.equal(diagnostic.provider, "ollama");
  assert.equal(diagnostic.modelId, "qwen2.5-coder");
  assert.equal(diagnostic.phase, "connect");
  assert.equal(diagnostic.errorCategory, "unknown_network_error", "generic fetch failure must not be misreported as model unavailable");
  assert.equal(diagnostic.retryHistory[0], "structured-output-retry");
});

test("run() classifies Undici header timeout causes as provider timeouts", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) return new Response(ndjsonStream([{ message: { content: "I will implement the app." }, done: false }, { done: true }]));
    const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    throw new TypeError("fetch failed", { cause });
  });

  const events: TaskEvent[] = [];
  await ollamaRunner.run(baseInput({
    mode: "build",
    archMode: "web",
    prompt: "Build a customer onboarding application with login, approvals, PostgreSQL, and tests.",
    projectContext: { projectPath: "/tmp/customer-onboarding-test", relevantFiles: [], indexedChunkCount: 0 },
  }), (event) => events.push(event));

  const diagnostic = events.find((event) => event.type === "model_diagnostic")?.diagnostic;
  assert.ok(diagnostic);
  assert.equal(diagnostic.errorCategory, "provider_timeout");
  assert.match(diagnostic.errorCause ?? "", /UND_ERR_HEADERS_TIMEOUT/);
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
  const diagnostic = events.find((event) => event.type === "model_diagnostic")?.diagnostic;
  assert.ok(diagnostic);
  assert.equal(diagnostic.phase, "complete");
  assert.equal(diagnostic.streaming, true);
  assert.equal(diagnostic.responseBytes, Buffer.byteLength("Hi there"));
  assert.equal(diagnostic.taskId, "t1");
  assert.ok(typeof diagnostic.serializedRequestBytes === "number");
  assert.match(diagnostic.serializedRequestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(diagnostic.serializedRequestRedacted?.model, "qwen2.5-coder");
  assert.ok((diagnostic.serializedRequestRedacted?.messages.length ?? 0) >= 2);
  assert.equal(JSON.stringify(diagnostic.serializedRequestRedacted).includes("Hi there"), false);
  assert.equal(diagnostic.maxConcurrency, 1);
  assert.equal(diagnostic.queueWaitMs, 0);
  assert.ok(typeof diagnostic.timeToFirstTokenMs === "number");
  assert.ok(events.some((e) => e.type === "status" && e.status === "completed"));
});

test("run() serializes local inference and records queue wait without losing task correlation", async (t) => {
  let active = 0;
  let maxActive = 0;
  t.mock.method(globalThis, "fetch", async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return new Response(ndjsonStream([{ message: { content: "ok" }, done: false }, { done: true }]));
  });
  const diagnostics: Array<NonNullable<Extract<TaskEvent, { type: "model_diagnostic" }>["diagnostic"]>> = [];
  await Promise.all(["queue-a", "queue-b"].map(async (taskId) => {
    const events: TaskEvent[] = [];
    await ollamaRunner.run(baseInput({ taskId }), (event) => events.push(event));
    const diagnostic = events.find((event) => event.type === "model_diagnostic")?.diagnostic;
    assert.ok(diagnostic);
    diagnostics.push(diagnostic);
  }));
  assert.equal(maxActive, 1);
  assert.deepEqual(new Set(diagnostics.map((item) => item.taskId)), new Set(["queue-a", "queue-b"]));
  assert.ok(diagnostics.every((item) => typeof item.queueWaitMs === "number"));
  assert.ok(diagnostics.some((item) => (item.queueWaitMs ?? 0) > 0 && (item.queuePosition ?? 0) > 0));
});

test("cancelling a queued local request removes it without starting a second provider request", async (t) => {
  let requestCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requestCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 350));
    return new Response(ndjsonStream([{ message: { content: "ok" }, done: false }, { done: true }]));
  });
  const firstEvents: TaskEvent[] = [];
  const first = ollamaRunner.run(baseInput({ taskId: "queue-owner" }), (event) => firstEvents.push(event));
  const requestStartDeadline = Date.now() + 2_000;
  while (requestCalls === 0 && Date.now() < requestStartDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(requestCalls, 1, "first request should have acquired the local inference slot");
  const controller = new AbortController();
  const queuedEvents: TaskEvent[] = [];
  const queued = ollamaRunner.run(baseInput({ taskId: "queue-cancelled", signal: controller.signal }), (event) => queuedEvents.push(event));
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await Promise.all([first, queued]);
  assert.equal(requestCalls, 1, "cancelled queued work must not issue an Ollama request");
  assert.ok(queuedEvents.some((event) => event.type === "status" && event.status === "cancelled"));
  const diagnostic = queuedEvents.find((event) => event.type === "model_diagnostic")?.diagnostic;
  assert.equal(diagnostic?.cancelled, true);
  assert.ok((diagnostic?.queueWaitMs ?? 0) >= 0);
});

test("run() withholds a basic payroll page when two focused repairs cannot complete the required modules", async (t) => {
  const generated = {
    summary: "A starter payroll app with frontend and FastAPI backend.",
    edits: [
      {
        path: "frontend/package.json",
        action: "create",
        content: JSON.stringify({
          name: "payroll",
          scripts: { dev: "next dev" },
          dependencies: { next: "^12.0.7", react: "^17.0.2", "react-dom": "^17.0.2", fastapi: "^0.78" },
        }),
      },
      {
        path: "frontend/pages/index.js",
        action: "create",
        content: "export default function Home() { return <main><h1>Employee Payroll</h1><p>Welcome to the payroll dashboard.</p></main>; }",
      },
      {
        path: "backend/main.py",
        action: "create",
        content: "from fastapi import FastAPI\napp = FastAPI()\nSECRET_KEY = \"your-secret-key\"\ndef get_employees():\n    return await load_employees()\n",
      },
      { path: "backend/requirements.txt", action: "create", content: "fastapi\nuvicorn[standard]\n" },
    ],
  };
  const emptyRepair = { summary: "I could not complete the missing payroll features.", edits: [] };
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call += 1;
    if (call === 1) return new Response(ndjsonStream([{ message: { content: JSON.stringify(generated) }, done: false }, { done: true }]));
    return new Response(ndjsonStream([{ message: { content: JSON.stringify(emptyRepair) }, done: false }, { done: true }]));
  });

  const events: TaskEvent[] = [];
  await ollamaRunner.run(baseInput({
    mode: "build",
    archMode: "web",
    prompt: "Build a payroll app with employee management, attendance tracking, payroll processing, and reports using Next.js and FastAPI.",
    projectContext: { projectPath: "/tmp/payroll-test", relevantFiles: [], indexedChunkCount: 0 },
  }), (event) => events.push(event));

  assert.equal(call, 3, "the original generation should receive two focused payroll repair attempts");
  const editsEvent = events.find((event): event is Extract<TaskEvent, { type: "edits" }> => event.type === "edits");
  assert.equal(editsEvent, undefined, "an incomplete payroll scaffold must not be offered for application or preview");
  const output = events.filter((event): event is Extract<TaskEvent, { type: "output" }> => event.type === "output").map((event) => event.delta).join("");
  assert.match(output, /second focused attempt/i, "the user should see that MobiusX tried a second focused repair");
  assert.match(output, /withheld the partial files/i, "the user should be told why the incomplete scaffold is not applied");
  assert.match(output, /payroll frontend is only a basic page/i, "a generic page must be reported as a UI completeness gap");
  assert.ok(events.some((event) => event.type === "status" && event.status === "failed"));
});

test("run() emits a payroll project after a focused repair supplies its missing screens and API", async (t) => {
  const first = {
    summary: "Payroll dashboard scaffold.",
    edits: [
      { path: "frontend/package.json", action: "create", content: JSON.stringify({ name: "payroll", scripts: { dev: "next dev" }, dependencies: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" } }) },
      { path: "frontend/pages/index.js", action: "create", content: "export default function Home() { return <main><h1>Employee Payroll</h1></main>; }" },
      { path: "backend/main.py", action: "create", content: "from fastapi import FastAPI\napp = FastAPI()\n" },
      { path: "backend/requirements.txt", action: "create", content: "fastapi\nuvicorn[standard]\n" },
    ],
  };
  const repaired = {
    summary: "Added the employee, attendance, payroll, and report workflows.",
    edits: [
      { path: "frontend/pages/index.js", action: "create", content: "import Link from 'next/link'; export default function Home() { return <main><h1>Employee Payroll</h1><nav><Link href='/employees'>Employees and Departments</Link><Link href='/attendance'>Attendance</Link><Link href='/payroll'>Payroll Runs and Salary</Link><Link href='/reports'>Reports and Payslips</Link></nav><button onClick={() => window.location.assign('/payroll')}>Run payroll</button></main>; }" },
      { path: "frontend/pages/employees.js", action: "create", content: "export default function Employees() { return <main><h1>Employees and Departments</h1></main>; }" },
      { path: "frontend/pages/attendance.js", action: "create", content: "export default function Attendance() { return <main><h1>Attendance</h1></main>; }" },
      { path: "frontend/pages/payroll.js", action: "create", content: "export default function Payroll() { return <main><h1>Payroll salary calculation</h1><p>Gross pay, deductions, bonuses, net pay</p></main>; }" },
      { path: "frontend/pages/reports.js", action: "create", content: "export default function Reports() { return <main><h1>Reports and Payslips</h1></main>; }" },
      { path: "backend/main.py", action: "create", content: "from fastapi import FastAPI\nfrom pydantic import BaseModel, Field\napp = FastAPI()\nclass PayrollInput(BaseModel):\n    hours: float = Field(ge=0, le=744)\n    hourly_rate: float = Field(ge=0)\n@app.get('/employees')\ndef employees(): return [{'id': 1, 'name': 'Asha Rao', 'department': 'Engineering'}]\n@app.get('/attendance')\ndef attendance(): return [{'employee_id': 1, 'hours': 160}]\n@app.post('/payroll')\ndef payroll(data: PayrollInput): return {'gross_pay': data.hours * data.hourly_rate, 'deductions': 0, 'bonus': 0, 'net_pay': data.hours * data.hourly_rate}\n@app.get('/reports/payslips')\ndef payslips(): return []\n" },
    ],
  };
  let call = 0;
  t.mock.method(globalThis, "fetch", async () => {
    call += 1;
    if (call === 1) return new Response(ndjsonStream([{ message: { content: JSON.stringify(first) }, done: false }, { done: true }]));
    if (call === 2) return new Response(ndjsonStream([{ message: { content: JSON.stringify(repaired) }, done: false }, { done: true }]));
    return new Response(JSON.stringify({ message: { content: JSON.stringify({ verdict: "approve", summary: "Review complete.", concerns: [] }) } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const events: TaskEvent[] = [];
  await ollamaRunner.run(baseInput({
    mode: "build",
    archMode: "web",
    prompt: "Build a payroll app with employee management, attendance tracking, payroll processing, and reports using Next.js and FastAPI.",
    projectContext: { projectPath: "/tmp/payroll-test", relevantFiles: [], indexedChunkCount: 0 },
  }), (event) => events.push(event));

  const editsEvent = events.find((event): event is Extract<TaskEvent, { type: "edits" }> => event.type === "edits");
  assert.ok(editsEvent, "a complete repaired project should be available for review and application");
  assert.ok(editsEvent.edits.some((edit) => edit.path === "frontend/pages/attendance.js"));
  assert.ok(editsEvent.edits.some((edit) => edit.path === "frontend/pages/reports.js"));
  assert.ok(editsEvent.edits.some((edit) => edit.path === "backend/main.py" && /@app\.post\('\/payroll'\)/.test(edit.content)));
  assert.ok(events.some((event) => event.type === "status" && event.status === "completed"));
});

test("run() treats an aborted signal as cancelled, not failed", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url: string, opts: { signal?: AbortSignal }) => {
    return new Promise((_resolve, reject) => {
      const rejectAsAborted = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (opts.signal?.aborted) rejectAsAborted();
      else opts.signal?.addEventListener("abort", rejectAsAborted, { once: true });
    });
  });
  const events: TaskEvent[] = [];
  const runPromise = ollamaRunner.run(baseInput({ signal: controller.signal }), (e) => events.push(e));
  controller.abort();
  await runPromise;
  assert.ok(events.some((e) => e.type === "status" && e.status === "cancelled"));
  assert.ok(!events.some((e) => e.type === "error"));
});
