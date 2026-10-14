import { execFile, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { promisify } from "node:util";
import { BUILD_RESPONSE_CONTRACT_VERSION, type ModelExecutionDiagnostic, type ModelFailureCategory, type ModelOption, type OllamaDiagnosticsResponse, type ProposedEdit, type TaskEvent, type TaskStep } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { createStructuredProseStreamer, EDITS_MARKER, historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor, systemPromptForLocalBuild } from "./promptShared.js";
import { runPersonaReview } from "./personas.js";
import { maybeExtractAssistantMemory } from "./memoryExtraction.js";

/**
 * Local Ollama (https://ollama.com) — no API key, runs entirely on the
 * user's own machine against whatever models they've pulled. Unlike the
 * cloud providers, "available" here can't be answered from an env var: it
 * genuinely depends on whether Ollama is running right now and which
 * models are actually pulled, so listModels() makes a real (short-timeout)
 * HTTP call to Ollama's own /api/tags rather than assuming anything.
 *
 * Deliberately never auto-selected (see registry.ts's AUTO_PRIORITY
 * comment) — using local compute is always an explicit user choice, not
 * something that silently becomes "the AI Assistant's brain" just because
 * a background process happens to be running.
 *
 * Uses Ollama's own /api/chat, whose streaming format is newline-delimited
 * JSON (one `{"message":{"content":"..."},"done":false}` object per line),
 * NOT Server-Sent Events — a different framing from the cloud providers,
 * handled by streamOllamaNdjson below rather than reusing streamOpenAiSse.
 *
 * Runs the same persona-based second-pass Reviewer agent the other runners
 * do (roadmap Phase 11, source §26/§27 — see runners/personas.ts), via one
 * extra non-streamed /api/chat call (`stream: false`) after edits are
 * parsed. A small local model is more likely to miss the review's expected
 * JSON verdict shape too — handled the same conservative way as any other
 * unparseable review (personas.ts#parseReview: reported as "concerns", not
 * silently dropped or upgraded to "approve").
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DISCOVERY_BASE_URLS = ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"];
const TAGS_TIMEOUT_MS = 1000;
// A full-stack build can take several minutes on a CPU-only local model. The
// previous 8-minute ceiling expired after Qwen had streamed 11 file paths
// but before it closed the structured edit JSON, so the gateway had to
// discard the whole (safely unparsed) bundle. Keep one finite bound, but
// allow a realistic 20-minute window for a complete local application.
// The 20-minute run17/P0.2 build ended after 2,237 streamed tokens and 9.7 KB
// with the JSON bundle still open. Extend only the whole Build response window
// to 30 minutes; header timeout and ordinary repairs retain their own bounds.
const OLLAMA_BUILD_TIMEOUT_MS = boundedTimeout(process.env.MOBIUSX_OLLAMA_BUILD_TIMEOUT_MS, 30 * 60_000, 45 * 60_000);
const OLLAMA_REPAIR_TIMEOUT_MS = boundedTimeout(process.env.MOBIUSX_OLLAMA_REPAIR_TIMEOUT_MS, 4 * 60_000, 20 * 60_000);
// P0.2 measured a CPU-only focused repair that received headers in 4m22s but
// had emitted only 2.6 KB of its structured file at the former 20m deadline.
// Give this specific staged repair a configurable, still-bounded completion
// window; other modes keep their shorter defaults.
const OLLAMA_STAGED_REPAIR_TIMEOUT_MS = boundedTimeout(process.env.MOBIUSX_OLLAMA_STAGED_REPAIR_TIMEOUT_MS, 35 * 60_000, 45 * 60_000);
// Node's global fetch uses Undici's fixed ~300s headersTimeout. CPU-bound local
// inference can legitimately spend longer preparing a large response. Use
// Node's streaming HTTP client instead, with an explicit bounded and
// configurable header deadline that is independent of the total task timer.
const OLLAMA_HEADERS_TIMEOUT_MS = boundedTimeout(process.env.MOBIUSX_OLLAMA_HEADERS_TIMEOUT_MS, 15 * 60_000, 20 * 60_000);
const OLLAMA_MAX_CONCURRENCY = boundedCount(process.env.MOBIUSX_OLLAMA_MAX_CONCURRENCY, 1, 2);
const OLLAMA_MAX_QUEUE = boundedCount(process.env.MOBIUSX_OLLAMA_MAX_QUEUE, 4, 16);
const OLLAMA_STREAM_IDLE_TIMEOUT_MS = boundedTimeout(process.env.MOBIUSX_OLLAMA_STREAM_IDLE_TIMEOUT_MS, 180_000, 600_000);

type InferenceWaiter = {
  queuedAt: number;
  queuePosition: number;
  signal: AbortSignal;
  resolve: (result: { release: () => void; queuePosition: number; activeRequests: number; queueWaitMs: number }) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
};
let ollamaActiveRequests = 0;
const ollamaInferenceQueue: InferenceWaiter[] = [];

function releaseOllamaSlot(): void {
  ollamaActiveRequests = Math.max(0, ollamaActiveRequests - 1);
  while (ollamaActiveRequests < OLLAMA_MAX_CONCURRENCY && ollamaInferenceQueue.length) {
    const waiter = ollamaInferenceQueue.shift()!;
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(new DOMException("Ollama request cancelled while queued", "AbortError"));
      continue;
    }
    ollamaActiveRequests += 1;
    waiter.resolve({ release: releaseOllamaSlot, queuePosition: waiter.queuePosition, activeRequests: ollamaActiveRequests, queueWaitMs: Date.now() - waiter.queuedAt });
  }
}

function acquireOllamaSlot(signal: AbortSignal, deadlineAt: number): Promise<{ release: () => void; queuePosition: number; activeRequests: number; queueWaitMs: number }> {
  if (signal.aborted) return Promise.reject(new DOMException("Ollama request cancelled", "AbortError"));
  if (ollamaActiveRequests < OLLAMA_MAX_CONCURRENCY && ollamaInferenceQueue.length === 0) {
    ollamaActiveRequests += 1;
    return Promise.resolve({ release: releaseOllamaSlot, queuePosition: 0, activeRequests: ollamaActiveRequests, queueWaitMs: 0 });
  }
  if (ollamaInferenceQueue.length >= OLLAMA_MAX_QUEUE) return Promise.reject(new Error(`Ollama inference queue is full (${OLLAMA_MAX_QUEUE} waiting requests)`));
  return new Promise((resolve, reject) => {
    const waiter = {} as InferenceWaiter;
    waiter.queuedAt = Date.now();
    waiter.queuePosition = ollamaInferenceQueue.length + 1;
    waiter.signal = signal;
    waiter.resolve = resolve;
    waiter.reject = reject;
    waiter.onAbort = () => {
      const index = ollamaInferenceQueue.indexOf(waiter);
      if (index >= 0) ollamaInferenceQueue.splice(index, 1);
      clearTimeout(waiter.timer);
      reject(new DOMException("Ollama request cancelled while queued", "AbortError"));
    };
    waiter.timer = setTimeout(() => {
      const index = ollamaInferenceQueue.indexOf(waiter);
      if (index >= 0) ollamaInferenceQueue.splice(index, 1);
      signal.removeEventListener("abort", waiter.onAbort);
      const error = new Error("Ollama inference queue wait exceeded the request deadline");
      error.name = "TimeoutError";
      reject(error);
    }, Math.max(1, deadlineAt - Date.now()));
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    ollamaInferenceQueue.push(waiter);
  });
}

async function captureSerializedOllamaRequest(requestId: string, body: string): Promise<{ sha256: string; bytes: number; path?: string; error?: string }> {
  const bytes = Buffer.byteLength(body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (process.env.MOBIUSX_OLLAMA_CAPTURE_REQUESTS !== "1") return { sha256, bytes };
  const directory = process.env.MOBIUSX_OLLAMA_CAPTURE_DIR;
  if (!directory || !directory.startsWith("/")) return { sha256, bytes, error: "request capture enabled but MOBIUSX_OLLAMA_CAPTURE_DIR is not an absolute path" };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await stat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      return { sha256, bytes, error: "request capture directory must be a directory owned by this user with owner-only permissions" };
    }
    const path = join(directory, `${requestId}-${sha256.slice(0, 12)}.json`);
    await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { sha256, bytes, path };
  } catch (error) {
    return { sha256, bytes, error: `restricted request capture failed: ${(error as Error).message}` };
  }
}

export function redactedOllamaRequestForDiagnostics(body: string): NonNullable<import("@mobiusx/protocol").ModelExecutionDiagnostic["serializedRequestRedacted"]> | undefined {
  try {
    const request = JSON.parse(body) as Record<string, unknown>;
    if (typeof request.model !== "string" || typeof request.stream !== "boolean" || !Array.isArray(request.messages)) return undefined;
    const messages = request.messages.map((message) => {
      if (!message || typeof message !== "object") throw new Error("invalid Ollama message");
      const item = message as Record<string, unknown>;
      if (typeof item.role !== "string" || typeof item.content !== "string") throw new Error("invalid Ollama message content");
      return { role: item.role, contentBytes: Buffer.byteLength(item.content), contentSha256: createHash("sha256").update(item.content).digest("hex") };
    });
    const options = request.options && typeof request.options === "object" && !Array.isArray(request.options)
      ? Object.fromEntries(Object.entries(request.options as Record<string, unknown>).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1])))
      : undefined;
    return {
      model: request.model,
      ...(typeof request.keep_alive === "string" ? { keepAlive: request.keep_alive } : {}),
      stream: request.stream,
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(options ? { options } : {}),
      messages,
    };
  } catch { return undefined; }
}

async function captureOllamaText(requestId: string, kind: "response", text: string): Promise<{ path?: string; error?: string }> {
  if (process.env.MOBIUSX_OLLAMA_CAPTURE_RESPONSES !== "1") return {};
  const directory = process.env.MOBIUSX_OLLAMA_CAPTURE_DIR;
  if (!directory || !directory.startsWith("/")) return { error: "response capture enabled but MOBIUSX_OLLAMA_CAPTURE_DIR is not an absolute path" };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await stat(directory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      return { error: "response capture directory must be owned by this user with owner-only permissions" };
    }
    const digest = createHash("sha256").update(text).digest("hex");
    const path = join(directory, `${requestId}-${kind}-${digest.slice(0, 12)}.txt`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { path };
  } catch (error) {
    return { error: `restricted response capture failed: ${(error as Error).message}` };
  }
}

function boundedTimeout(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? Math.min(Math.floor(parsed), max) : fallback;
}

function boundedCount(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, maximum) : fallback;
}

function rejectedEditSummary(paths: string[] | undefined, count: number): string {
  if (paths?.length) return `modify operations referenced paths that were not present in full context: ${[...new Set(paths)].join(", ")}`;
  return `${count} response operation(s) failed structured edit validation; enable restricted response capture to inspect the raw output`;
}

export function ollamaHeadersTimeoutMs(): number { return OLLAMA_HEADERS_TIMEOUT_MS; }
export function ollamaBuildTimeoutMs(): number { return OLLAMA_BUILD_TIMEOUT_MS; }

async function postOllamaChat(endpoint: string, body: string, signal: AbortSignal, requestId?: string, onPhase?: (phase: ModelExecutionDiagnostic["phase"]) => void): Promise<Response> {
  const url = new URL(endpoint);
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest);
  return await new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: "POST", signal, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(requestId ? { "x-mobiusx-request-id": requestId } : {}) } }, (incoming) => {
      onPhase?.("headers");
      req.setTimeout(0);
      const stream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolve(new Response(stream, { status: incoming.statusCode ?? 500, headers: incoming.headers as HeadersInit }));
    });
    req.once("socket", (socket) => observeOllamaSocket(socket, onPhase));
    req.setTimeout(OLLAMA_HEADERS_TIMEOUT_MS, () => {
      const error = new Error(`Ollama response headers exceeded ${OLLAMA_HEADERS_TIMEOUT_MS}ms`);
      error.name = "HeadersTimeoutError";
      req.destroy(error);
    });
    req.once("error", reject);
    req.end(body);
  });
}

type OllamaSocketLike = { connecting: boolean; encrypted?: boolean; once: (event: string, callback: () => void) => unknown };
function observeOllamaSocket(socket: OllamaSocketLike, onPhase?: (phase: ModelExecutionDiagnostic["phase"]) => void): void {
  onPhase?.("connect");
  if (!socket.connecting) {
    onPhase?.("connected");
    return;
  }
  socket.once(socket.encrypted ? "secureConnect" : "connect", () => onPhase?.("connected"));
}
export function observeOllamaSocketForTests(socket: OllamaSocketLike, onPhase?: (phase: ModelExecutionDiagnostic["phase"]) => void): void {
  observeOllamaSocket(socket, onPhase);
}
let ollamaChatTransport = postOllamaChat;
/** Test seam: production always uses the bounded native HTTP transport above. */
export function setOllamaChatTransportForTests(transport?: typeof postOllamaChat): void {
  ollamaChatTransport = transport ?? postOllamaChat;
}
// Keep a conservative ceiling so small local models do not reserve a needlessly
// large KV cache. chatOptionsFor() chooses the smallest context that fits the
// actual request and a useful bounded completion.
const MAX_CONTEXT_TOKENS = 16_384;
const MIN_CONTEXT_TOKENS = 8_192;
// Ollama keys its loaded llama-server runner by model options such as context
// size. Choosing a different num_ctx for each prompt repeatedly tears down
// and reloads a CPU-only model. Keep one bounded context per gateway process;
// operators can tune it for their machine without changing the selected model.
const OLLAMA_CONTEXT_TOKENS = boundedContext(process.env.MOBIUSX_OLLAMA_NUM_CTX);
const REVIEW_CONTEXT_TOKENS = 16_384;
const CHAT_OPTIONS = { temperature: 0.2, num_ctx: MIN_CONTEXT_TOKENS, num_predict: 4_096, repeat_penalty: 1.05 };
let discoveredBaseUrl: string | undefined;


function chatOptionsFor(input: RunnerInput, systemPrompt: string) {
  const historyChars = (input.history ?? []).reduce((sum, turn) => sum + turn.content.length, 0);
  const promptChars = systemPrompt.length + input.prompt.length + historyChars;
  // A conservative character/token estimate leaves room for tokenizer
  // variance, JSON escaping, and the chat template. Large existing-project
  // contexts grow the window only as far as the configured ceiling.
  const estimatedPromptTokens = Math.ceil(promptChars / 3.2) + 256;
  const safetyMarginTokens = Math.ceil(OLLAMA_CONTEXT_TOKENS * 0.12);
  const templateOverheadTokens = 256;
  const requestedOutputTokens = input.mode === "build" && input.stagedBuild?.id === "tests"
    ? 2_048
    : input.mode === "build" ? 6_144 : 4_096;
  const availableOutputTokens = OLLAMA_CONTEXT_TOKENS - estimatedPromptTokens - safetyMarginTokens - templateOverheadTokens;
  if (availableOutputTokens < 1_024) {
    const error = new Error(`Ollama context budget exceeded before dispatch: ${estimatedPromptTokens} estimated input tokens + ${requestedOutputTokens} requested output tokens + ${templateOverheadTokens} template overhead + ${safetyMarginTokens} safety margin exceeds ${OLLAMA_CONTEXT_TOKENS} context tokens; prompt size ${Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(input.prompt, "utf8")} bytes. Reduce relevant context without removing requirements or authorization constraints.`);
    error.name = "ContextBudgetExceededError";
    throw error;
  }
  const outputTokens = Math.min(requestedOutputTokens, availableOutputTokens);
  return { ...CHAT_OPTIONS, num_ctx: OLLAMA_CONTEXT_TOKENS, num_predict: outputTokens };
}

function boundedContext(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_CONTEXT_TOKENS) return 12_288;
  return Math.min(MAX_CONTEXT_TOKENS, Math.floor(parsed / 1_024) * 1_024);
}

export function ollamaContextTokens(): number { return OLLAMA_CONTEXT_TOKENS; }
export function ollamaChatOptionsForTests(input: RunnerInput, systemPrompt: string) { return chatOptionsFor(input, systemPrompt); }

interface OllamaMetrics {
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  total_duration?: number;
  size_vram?: number;
}

const execFileAsync = promisify(execFile);

function psCpuTimeSeconds(value: string): number | undefined {
  const [daysPart, clock = ""] = value.split("-");
  const parts = (clock || daysPart).split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return undefined;
  const seconds = parts.pop()!;
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  const days = clock ? Number(daysPart) || 0 : 0;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

async function sampleOllamaProcessResources(): Promise<{ cpuSeconds?: number; rssBytes?: number }> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "time=,rss=,comm="], { timeout: 900, maxBuffer: 1_000_000 });
    const processes = String(stdout).split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*(\S+)\s+(\d+)\s+(.+)$/);
      if (!match || !/(?:llama-server|ollama.*runner|ollama_llama)/i.test(match[3])) return [];
      const rssBytes = Number(match[2]) * 1024;
      const cpuSeconds = psCpuTimeSeconds(match[1]);
      return cpuSeconds !== undefined && Number.isFinite(rssBytes) ? [{ cpuSeconds, rssBytes }] : [];
    });
    if (!processes.length) return {};
    return {
      cpuSeconds: processes.reduce((total, sample) => total + sample.cpuSeconds, 0),
      rssBytes: processes.reduce((total, sample) => total + sample.rssBytes, 0),
    };
  } catch {
    return {};
  }
}

async function sampleHostMemoryFreePercent(): Promise<number | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync("memory_pressure", ["-Q"], { timeout: 900, maxBuffer: 16_000 });
    const match = String(stdout).match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
  } catch {
    return undefined;
  }
}

async function finishLocalResourceTelemetry(
  eventLoopDelay: ReturnType<typeof monitorEventLoopDelay>,
  gatewayCpuStarted: NodeJS.CpuUsage,
  ollamaStarted: { cpuSeconds?: number },
  hostMemoryFreePercentAtStart: number | undefined,
  resourceStartedAtMs: number,
): Promise<Pick<ModelExecutionDiagnostic, "ollamaProcessCpuPercent" | "ollamaCpuSeconds" | "resourceSampleDurationMs" | "ollamaProcessRssBytes" | "hostMemoryFreePercent" | "hostMemoryFreePercentAtStart" | "eventLoopDelayMaxMs" | "gatewayCpuUserMs" | "gatewayCpuSystemMs">> {
  const [ollama, hostMemoryFreePercent] = await Promise.all([sampleOllamaProcessResources(), sampleHostMemoryFreePercent()]);
  eventLoopDelay.disable();
  const gatewayCpu = process.cpuUsage(gatewayCpuStarted);
  const elapsedMs = Date.now() - resourceStartedAtMs;
  const ollamaCpuSeconds = ollamaStarted.cpuSeconds !== undefined && ollama.cpuSeconds !== undefined
    ? Math.max(0, ollama.cpuSeconds - ollamaStarted.cpuSeconds)
    : undefined;
  return {
    ...(ollamaCpuSeconds !== undefined ? {
      ollamaProcessCpuPercent: elapsedMs > 0 ? Math.round(ollamaCpuSeconds / (elapsedMs / 1_000) * 10_000) / 100 : 0,
      ollamaCpuSeconds: Math.round(ollamaCpuSeconds * 100) / 100,
      resourceSampleDurationMs: elapsedMs,
    } : {}),
    ...(ollama.rssBytes !== undefined ? { ollamaProcessRssBytes: ollama.rssBytes } : {}),
    ...(hostMemoryFreePercent !== undefined ? { hostMemoryFreePercent } : {}),
    ...(hostMemoryFreePercentAtStart !== undefined ? { hostMemoryFreePercentAtStart } : {}),
    eventLoopDelayMaxMs: Math.round(eventLoopDelay.max / 1_000_000),
    gatewayCpuUserMs: Math.round(gatewayCpu.user / 1_000),
    gatewayCpuSystemMs: Math.round(gatewayCpu.system / 1_000),
  };
}

function durationMs(nanoseconds: number | undefined): number | undefined {
  return typeof nanoseconds === "number" && Number.isFinite(nanoseconds) && nanoseconds >= 0
    ? Math.round(nanoseconds / 1_000_000)
    : undefined;
}

function ollamaRequestSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/**
 * Keep a hard wall-clock deadline around both response headers and NDJSON
 * consumption. AbortSignal.timeout alone did not reliably end a long-running
 * local inference stream on the host; the explicit race makes the task
 * terminal even if the transport ignores the abort, while aborting the
 * request so Ollama can release CPU work.
 */
export function promiseWithDeadline<T>(operation: Promise<T>, deadlineAt: number, abort: () => void): Promise<T> {
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("local model request exceeded its deadline");
      error.name = "TimeoutError";
      reject(error);
      // Settle the caller before abort listeners run. A slow transport abort
      // must not extend the observable deadline; abort is cleanup, not part
      // of the request's completion path.
      setImmediate(() => { try { abort(); } catch { /* the deadline already settled */ } });
    }, remainingMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function reviewOptionsFor(systemPrompt: string, userContent: string) {
  const estimatedPromptTokens = Math.ceil((systemPrompt.length + userContent.length) / 3.2) + 256;
  const outputTokens = Math.max(1_024, Math.min(2_048, REVIEW_CONTEXT_TOKENS - estimatedPromptTokens - 256));
  const neededContext = estimatedPromptTokens + outputTokens + 256;
  const contextTokens = Math.min(REVIEW_CONTEXT_TOKENS, Math.max(4_096, Math.ceil(neededContext / 1_024) * 1_024));
  return { temperature: 0.1, num_ctx: contextTokens, num_predict: outputTokens, repeat_penalty: 1.05 };
}

function uniqueChatModels(models: InstalledOllamaModel[]): InstalledOllamaModel[] {
  const chatModels = models.filter(({ name }) => {
    const base = name.toLowerCase().split(":")[0];
    return base !== "laya" && base !== "julia-1" && !/(?:embed|embedding)/i.test(base);
  });
  const preferredTag = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes("qwen2.5-coder:7b-instruct")) return 0;
    if (lower.includes("qwen2.5-coder") && !lower.endsWith(":latest")) return 1;
    if (lower.includes("qwen2.5:14b-instruct")) return 2;
    if (lower.includes("qwen2.5:7b-instruct")) return 3;
    if (lower.startsWith("llama3.1")) return 4;
    if (lower.startsWith("llama3:")) return 5;
    return 10;
  };
  const byDigest = new Map<string, InstalledOllamaModel>();
  const withoutDigest: InstalledOllamaModel[] = [];
  for (const model of chatModels) {
    if (!model.digest) {
      withoutDigest.push(model);
      continue;
    }
    const prior = byDigest.get(model.digest);
    if (!prior || preferredTag(model.name) < preferredTag(prior.name)) byDigest.set(model.digest, model);
  }
  return [...byDigest.values(), ...withoutDigest]
    .sort((a, b) => preferredTag(a.name) - preferredTag(b.name) || a.name.localeCompare(b.name));
}

function installedModelLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("qwen2.5-coder:7b-instruct")) return `Qwen2.5-Coder 7B Instruct — ${name} (recommended local coding model)`;
  if (lower.includes("qwen2.5-coder")) return `Qwen2.5-Coder — ${name} (local coding model)`;
  if (lower.includes("qwen2.5:14b-instruct")) return `Qwen2.5 14B Instruct — ${name} (complex architecture reasoning; slow on CPU)`;
  if (lower.includes("qwen2.5:7b-instruct")) return `Qwen2.5 7B Instruct — ${name} (requirements and simple planning)`;
  if (lower.startsWith("llama3.1")) return `Llama 3.1 — ${name} (local general-purpose model)`;
  if (lower.startsWith("llama3:")) return `Llama 3 — ${name} (local general-purpose model)`;
  return `${name} (local via Ollama)`;
}

/**
 * Ollama can constrain its output to a JSON schema. Use that for local
 * build tasks instead of asking a smaller local model to remember MobiusX's
 * custom marker + markdown-fence convention. File edits still pass through
 * parseBuildResponse below, which applies the same path/content safety rules
 * as every other provider.
 */
const OLLAMA_BUILD_FORMAT = {
  type: "object",
  properties: {
    summary: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["create", "modify"] },
          content: { type: "string" },
        },
        required: ["path", "action", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "edits"],
  additionalProperties: false,
} as const;

const OLLAMA_BUILD_FORMAT_INSTRUCTIONS = [
  "LOCAL OLLAMA BUILD OUTPUT: return one JSON object only, with summary as the first property: {\"summary\":\"brief user-facing summary\",\"edits\":[{\"path\":\"relative/path\",\"action\":\"create or modify\",\"content\":\"complete file contents\"}]}.",
  "Do not include markdown fences, the MobiusX marker, or text outside the JSON object. Escape newlines inside content as JSON requires. Use an empty edits array only when you need to ask the user a clarifying question; otherwise create the requested files.",
  "LOCAL QUALITY CHECK: before returning, verify that every requested filter, button, and cart action actually changes visible state; never use an empty click handler. For a blank Next.js project include package.json with compatible next/react/react-dom dependencies and all required entry/style files. Prefer plain CSS unless Tailwind is installed and configured. Match the requested colors exactly, use domain-appropriate distinct content, and do not create empty asset files.",
  "PAYROLL UI CHECK: the user must be able to navigate between actual Employees/Departments, Attendance, Payroll Runs, and Reports/Payslips views. Implement them as concise routes or functional tabs with visible data and working actions. A one-page dashboard that only lists module names does not satisfy the request.",
  "For Python dependencies, write backend/requirements.txt with exactly one valid pip requirement per line; never place multiple package names on one line separated only by spaces. Python's sqlite3 module is built in and must never be listed as a pip dependency.",
].join("\n");

function parseOllamaBuildResponse(fullText: string, input: RunnerInput): ReturnType<typeof parseBuildResponse> {
  const trimmed = fullText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  try {
    const parsed = JSON.parse(trimmed) as { summary?: unknown; edits?: unknown };
    if (typeof parsed.summary === "string" && Array.isArray(parsed.edits)) {
      // Reuse the shared parser as the authority for path safety, full-file
      // modify eligibility, malformed entries, and over-escaped contents.
      const wrapped = `${parsed.summary}\n${EDITS_MARKER}\n${JSON.stringify({ edits: parsed.edits })}`;
      return parseBuildResponse(wrapped, input);
    }
  } catch {
    // Older Ollama versions or models may ignore the schema; try the legacy
    // marker format below without ever rendering malformed JSON as prose.
  }
  const legacy = parseBuildResponse(fullText, input);
  if (legacy.hadMarker || !trimmed.startsWith("{")) return legacy;
  return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: "", prose: "", edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
}

function pythonAwaitSyntaxIssues(edits: ReturnType<typeof parseBuildResponse>["edits"]): string[] {
  const issues: string[] = [];
  for (const edit of edits.filter((candidate) => /\.py$/i.test(candidate.path))) {
    const scopes: Array<{ indent: number; name: string; async: boolean }> = [];
    const lines = edit.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const code = line.replace(/#.*$/, "");
      if (!code.trim()) continue;
      const indent = code.match(/^\s*/)?.[0].length ?? 0;
      while (scopes.length && indent <= scopes[scopes.length - 1].indent) scopes.pop();
      const def = code.match(/^\s*(async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      if (def) {
        scopes.push({ indent, name: def[2], async: Boolean(def[1]) });
        continue;
      }
      if (/\bawait\b/.test(code)) {
        const scope = scopes[scopes.length - 1];
        if (!scope || !scope.async) {
          issues.push(`${edit.path}:${index + 1} uses await outside an async def${scope ? ` (${scope.name})` : ""}`);
        }
      }
    }
  }
  return issues;
}

/** Small deterministic checks for common local-build failures seen in runs. */
function ollamaBuildQualityIssues(input: RunnerInput, edits: ReturnType<typeof parseBuildResponse>["edits"]): string[] {
  const allCode = edits.map((edit) => edit.content).join("\n");
  const sourceEdits = edits.filter((edit) => /\.(?:[cm]?[jt]sx?|py)$/i.test(edit.path));
  const sourceCode = sourceEdits.map((edit) => edit.content).join("\n").toLowerCase();
  const frontendSource = sourceEdits
    .filter((edit) => /(^|\/)frontend\//i.test(edit.path) || /(^|\/)(?:app|pages)\//i.test(edit.path))
    .map((edit) => edit.content)
    .join("\n")
    .toLowerCase();
  const issues: string[] = [];
  const hasProjectFiles = (input.projectContext?.relevantFiles?.length ?? 0) > 0;
  const isBlankProject = !hasProjectFiles && input.projectContext?.indexedChunkCount === 0;
  const isNextRequest = /\bnext(?:\.js)?\b|nextjs/i.test(input.prompt);

  issues.push(...pythonAwaitSyntaxIssues(edits));

  if (isBlankProject && isNextRequest) {
    const packageEdit = edits.find((edit) => /(^|\/)package\.json$/i.test(edit.path));
    let dependencies = "";
    if (packageEdit) {
      try {
        const manifest = JSON.parse(packageEdit.content) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        dependencies = JSON.stringify({ ...manifest.dependencies, ...manifest.devDependencies });
      } catch {
        issues.push("package.json is missing or invalid");
      }
    } else {
      issues.push("blank Next.js project is missing package.json");
    }
    if (packageEdit && !/"next"/.test(dependencies)) issues.push("package.json does not declare Next.js");
    if (packageEdit && (!/"react"/.test(dependencies) || !/"react-dom"/.test(dependencies))) {
      issues.push("package.json must declare both react and react-dom");
    }
    if (packageEdit) {
      try {
        const manifest = JSON.parse(packageEdit.content) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
        const pythonPackages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
          .filter((name) => /^(?:fastapi|uvicorn|sqlalchemy|pydantic|alembic|psycopg2?(?:-binary)?|asyncpg|python-jose|jose|passlib|python-multipart|starlette|gunicorn)$/i.test(name));
        if (pythonPackages.length) issues.push(`Python backend package(s) incorrectly listed in npm manifest: ${pythonPackages.join(", ")}`);
      } catch {
        // The invalid-manifest issue above already reports this case.
      }
    }
    const hasNextPage = edits.some((edit) => /(^|\/)(?:app\/page|pages\/index)\.(?:tsx?|jsx?)$/i.test(edit.path));
    if (!hasNextPage) issues.push("Next.js app page is missing");
    if (/fastapi/i.test(input.prompt)) {
      if (!edits.some((edit) => /\.py$/i.test(edit.path) && /FastAPI\s*\(/.test(edit.content))) {
        issues.push("requested FastAPI backend source is missing");
      }
      if (!edits.some((edit) => /(^|\/)requirements\.txt$/i.test(edit.path))) {
        issues.push("FastAPI requirements.txt is missing");
      }
    }
    if (/\b(payroll|payslip|salary)\b/i.test(input.prompt) && sourceCode) {
      const missingPayrollAreas = [
        ["employee management", /employee/],
        ["attendance tracking", /attendance/],
        ["payroll calculation or processing", /payroll|gross\s*pay|net\s*pay/],
        ["reporting or payslips", /report|payslip|pay\s*slip/],
      ].filter(([, pattern]) => !(pattern as RegExp).test(sourceCode)).map(([label]) => label);
      if (missingPayrollAreas.length) issues.push(`payroll implementation is missing ${missingPayrollAreas.join(", ")}`);

      // Backend symbols and README text must not satisfy the UI completeness
      // check: local models have returned a multi-file scaffold with a single
      // generic dashboard as the only usable frontend. Inspect frontend code
      // for reachable domain views and working navigation specifically.
      if (frontendSource) {
        const missingUiAreas = [
          ["employee/department views", /employees?|departments?/],
          ["attendance view", /attendance/],
          ["payroll run/calculation view", /payroll|salary|gross\s*pay|net\s*pay/],
          ["reports/payslip view", /reports?|payslips?|pay\s*slips?/],
        ].filter(([, pattern]) => !(pattern as RegExp).test(frontendSource)).map(([label]) => label);
        const hasNavigation = /\b(?:href|router\.push|useRouter|onClick|setActive(?:Tab|View|Section))\b/.test(frontendSource);
        if (missingUiAreas.length || !hasNavigation) {
          const gaps = [...missingUiAreas, ...(!hasNavigation ? ["working navigation between modules"] : [])];
          issues.push(`payroll frontend is only a basic page; add reachable ${gaps.join(", ")}`);
        }
      } else {
        issues.push("payroll frontend source is missing; build the actual employee, attendance, payroll, and reports UI");
      }
    }
  }

  const handlesSensitiveDataOrAuth = /\b(payroll|salary|payslip|authentication|authorization|jwt|login|employee records)\b/i.test(input.prompt);
  if (handlesSensitiveDataOrAuth && /\bfastapi\s*\(/i.test(sourceEdits.map((edit) => edit.content).join("\n"))) {
    const sourceText = sourceEdits.map((edit) => edit.content).join("\n");
    if (/\b(?:SECRET_KEY|JWT_SECRET|TOKEN_SECRET|SIGNING_KEY)\b\s*(?::\s*[\w\[\]|]+)?\s*=\s*["'][^"']{4,}["']/i.test(sourceText) ||
        /\b(?:SECRET_KEY|JWT_SECRET|TOKEN_SECRET|SIGNING_KEY)\b\s*=\s*(?:os\.)?getenv\([^,]+,\s*["'][^"']{4,}["']/i.test(sourceText)) {
      issues.push("JWT/signing secret is hard-coded; load it from environment configuration and fail safely when it is unset");
    }
    if (!/\b(?:Field|Query|Path|Body)\s*\(/.test(sourceText) && !/\b(?:field_validator|model_validator|validator)\b/.test(sourceText)) {
      issues.push("external API inputs lack explicit Pydantic/FastAPI field constraints or validators");
    }
    if (/\b(?:execute|raw|text)\s*\(\s*f["']/.test(sourceText)) {
      issues.push("SQL query appears to interpolate external values; use ORM filters or parameterized queries");
    }
    if (/dangerouslySetInnerHTML\s*=/.test(sourceText)) {
      issues.push("frontend renders untrusted HTML with dangerouslySetInnerHTML; remove it or sanitize input");
    }
  }

  const tailwindUsed = /@tailwind\s+(?:base|components|utilities)/.test(allCode) ||
    /\b(?:mx|px|py|mt|mb|gap|text|font|bg|grid|flex|rounded|shadow)-[a-z0-9][\w/-]*/.test(allCode);
  if (tailwindUsed && !/"tailwindcss"/.test(allCode)) {
    issues.push("Tailwind directives/classes are used but tailwindcss is not declared");
  }

  if (/\bon(?:Click|Change|Submit)\s*=\s*\{\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\}/.test(allCode)) {
    issues.push("one or more interactive controls have an empty event handler");
  }

  return [...new Set(issues)];
}

function mergeProposedEdits(original: ProposedEdit[], repaired: ProposedEdit[]): ProposedEdit[] {
  const byPath = new Map(original.map((edit) => [edit.path.replaceAll("\\", "/").toLowerCase(), edit]));
  for (const edit of repaired) byPath.set(edit.path.replaceAll("\\", "/").toLowerCase(), edit);
  return [...byPath.values()];
}

/**
 * A missing package manifest is deterministic scaffolding, not a reason to
 * make a small local model regenerate every source file. Build one from the
 * actual imports so the project can proceed to dependency installation and
 * preview without a second multi-thousand-token model response.
 */
function ensureNextPackageManifest(input: RunnerInput, edits: ProposedEdit[]): { edits: ProposedEdit[]; added: boolean } {
  const normalized = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const packageEdits = edits.filter((edit) => normalized(edit.path).split("/").at(-1) === "package.json");
  const pythonPackages = new Set([
    "fastapi", "uvicorn", "sqlalchemy", "pydantic", "alembic", "psycopg", "psycopg2", "psycopg2-binary",
    "asyncpg", "python-jose", "jose", "passlib", "python-multipart", "email-validator", "starlette", "gunicorn",
  ]);
  const isJsSource = (path: string) => /\.(?:[cm]?[jt]sx?)$/i.test(path);
  const dependenciesFromImports = (scope: string) => {
    const imports = edits.filter((edit) => isJsSource(edit.path) && (scope === "." || normalized(edit.path).startsWith(`${scope}/`)))
      .flatMap((edit) => [...edit.content.matchAll(/(?:from\s*|import\s*|require\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]));
    const dependencies: Record<string, string> = { next: "latest", react: "latest", "react-dom": "latest" };
    for (const specifier of imports) {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/") || specifier.startsWith("#") || specifier.startsWith("node:")) continue;
      const segments = specifier.split("/");
      const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
      if (name && !pythonPackages.has(name.toLowerCase()) && !(name in dependencies)) dependencies[name] = "latest";
    }
    return dependencies;
  };

  let changed = false;
  let nextEdits = edits.map((edit) => {
    if (!packageEdits.includes(edit)) return edit;
    const scope = normalized(edit.path).split("/").slice(0, -1).join("/") || ".";
    const imports = dependenciesFromImports(scope);
    const typescript = edits.some((source) => isJsSource(source.path) && /\.tsx?$/i.test(source.path) && (scope === "." || normalized(source.path).startsWith(`${scope}/`)));
    try {
      const prior = JSON.parse(edit.content) as { name?: string; version?: string; private?: boolean; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps: Record<string, string> = { ...imports };
      // Preserve only non-Python packages explicitly used by generated JS/TS
      // imports. This drops misplaced requirements such as fastapi@^0.78.
      for (const [name, version] of Object.entries(prior.dependencies ?? {})) {
        if (pythonPackages.has(name.toLowerCase())) { changed = true; continue; }
        if (name in deps && deps[name] !== version && !["next", "react", "react-dom"].includes(name)) deps[name] = version;
      }
      const devDeps: Record<string, string> = {};
      for (const [name, version] of Object.entries(prior.devDependencies ?? {})) {
        if (pythonPackages.has(name.toLowerCase())) { changed = true; continue; }
        if (typescript && (name.startsWith("@types/") || name === "typescript") || name === "tailwindcss" || name === "postcss" || name === "autoprefixer" || name === "eslint" || name === "eslint-config-next") {
          devDeps[name] = version;
        }
      }
      const valid = Boolean(prior.dependencies?.next && prior.dependencies.react && prior.dependencies["react-dom"]);
      const dependencyNamesChanged = Object.keys(deps).length !== Object.keys(prior.dependencies ?? {}).length ||
        Object.keys(prior.dependencies ?? {}).some((name) => !(name in deps));
      if (!valid || dependencyNamesChanged || changed) {
        changed = true;
        return { ...edit, content: `${JSON.stringify({
          name: prior.name ?? (basename(input.projectContext?.projectPath ?? "mobiusx-app").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 180) || "mobiusx-app"),
          version: prior.version ?? "0.1.0",
          private: prior.private ?? true,
          scripts: { dev: "next dev --hostname 127.0.0.1", build: "next build", start: "next start --hostname 127.0.0.1", ...prior.scripts },
          dependencies: deps,
          ...(Object.keys(devDeps).length ? { devDependencies: devDeps } : {}),
        }, null, 2)}\n` };
      }
      return edit;
    } catch {
      changed = true;
      return { ...edit, content: `${JSON.stringify({ name: "mobiusx-app", version: "0.1.0", private: true, scripts: { dev: "next dev --hostname 127.0.0.1", build: "next build", start: "next start --hostname 127.0.0.1" }, dependencies: imports }, null, 2)}\n` };
    }
  });

  if (packageEdits.length === 0) {
    const requestedName = basename(input.projectContext?.projectPath ?? "mobiusx-app").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 180) || "mobiusx-app";
    const pathPrefix = edits.some((edit) => normalized(edit.path).startsWith("frontend/")) ? "frontend/" : "";
    const usesTypeScript = edits.some((edit) => isJsSource(edit.path) && /\.tsx?$/i.test(edit.path));
    const devDependencies = usesTypeScript ? { "@types/node": "^22.0.0", "@types/react": "^19.0.0", typescript: "^5.7.0" } : undefined;
    const manifest: ProposedEdit = {
      path: `${pathPrefix}package.json`, action: "create",
      content: `${JSON.stringify({ name: requestedName, version: "0.1.0", private: true, scripts: { dev: "next dev --hostname 127.0.0.1", build: "next build", start: "next start --hostname 127.0.0.1" }, dependencies: dependenciesFromImports(pathPrefix ? "frontend" : "."), ...(devDependencies ? { devDependencies } : {}) }, null, 2)}\n`,
    };
    nextEdits = [...nextEdits, manifest];
    changed = true;
  }
  return { edits: nextEdits, added: changed };
}

/** Streams only the JSON `summary` string; edit content remains buffered. */
function createOllamaSummaryStreamer(emit: (delta: string) => void) {
  let pending = "";
  let summary = "";
  let reading = false;
  let escaped = false;
  let unicodeHex = "";
  let unicodeRemaining = 0;
  let finished = false;

  const write = (value: string) => {
    if (!value) return;
    summary += value;
    emit(value);
  };

  return {
    push(delta: string) {
      if (finished) return;
      pending += delta;
      if (!reading) {
        // Only stream the top-level first property. A loose search could
        // match a "summary" string inside a generated source file and leak
        // code before the edits pass validation.
        const match = /^\s*\{\s*"summary"\s*:\s*"/.exec(pending);
        if (!match) {
          if (pending.length > 128) pending = pending.slice(0, 128);
          return;
        }
        pending = pending.slice(match[0].length);
        reading = true;
      }

      let decoded = "";
      let consumed = 0;
      for (; consumed < pending.length; consumed++) {
        const char = pending[consumed];
        if (unicodeRemaining > 0) {
          unicodeHex += char;
          unicodeRemaining--;
          if (unicodeRemaining === 0) {
            const codePoint = Number.parseInt(unicodeHex, 16);
            if (Number.isFinite(codePoint)) decoded += String.fromCharCode(codePoint);
            unicodeHex = "";
          }
          continue;
        }
        if (escaped) {
          escaped = false;
          if (char === "u") {
            unicodeHex = "";
            unicodeRemaining = 4;
          }
          else decoded += ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[char] ?? char;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          finished = true;
          consumed++;
          break;
        }
        decoded += char;
      }
      pending = pending.slice(consumed);
      write(decoded);
    },
    value() {
      return summary;
    },
  };
}
let ollamaLaunchAttemptedAt = 0;

function findOllamaExecutable(): string | null {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = process.platform === "win32"
    ? [...pathEntries.map((dir) => join(dir, "ollama.exe")), join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe")]
    : [
        ...pathEntries.map((dir) => join(dir, "ollama")),
        "/usr/local/bin/ollama",
        "/opt/homebrew/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
      ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

function tryStartOllama(): boolean {
  // A custom endpoint may be a remote server; never launch a local daemon
  // on the user's behalf for that configuration.
  if (process.env.OLLAMA_BASE_URL || Date.now() - ollamaLaunchAttemptedAt < 30_000) return false;
  ollamaLaunchAttemptedAt = Date.now();
  const executable = findOllamaExecutable();
  if (!executable) return false;
  try {
    const child = spawn(executable, ["serve"], { stdio: "ignore", env: process.env });
    child.unref();
    child.once("error", () => {}); // surfaced by the next availability check, without an unhandled event
    return true;
  } catch {
    return false;
  }
}

interface CandidateModel {
  /** The model id/tag this gateway will ask Ollama to run. */
  model: string;
  label: string;
  /** Case-insensitive prefixes of a locally-pulled tag name that count as "this model is available" — Ollama tags often carry a size/quantization suffix (e.g. "llama3.1:8b"), so an exact-match would under-report what's actually usable. */
  matchPrefixes: string[];
  /** Suggested `ollama pull` argument shown in the unavailable reason when nothing matching is pulled yet. */
  pullHint: string;
}

const CANDIDATE_MODELS: CandidateModel[] = [
  { model: "llama3.1", label: "Llama 3.1 (local via Ollama)", matchPrefixes: ["llama3.1"], pullHint: "llama3.1" },
  {
    model: "qwen2.5-coder",
    label: "Qwen2.5-Coder (local via Ollama)",
    matchPrefixes: ["qwen2.5-coder", "qwen2.5coder"],
    pullHint: "qwen2.5-coder",
  },
  { model: "qwen2.5:7b-instruct", label: "Qwen2.5 7B Instruct (local via Ollama)", matchPrefixes: ["qwen2.5:7b-instruct"], pullHint: "qwen2.5:7b-instruct" },
  { model: "qwen2.5:14b-instruct", label: "Qwen2.5 14B Instruct (higher-capability local model)", matchPrefixes: ["qwen2.5:14b-instruct"], pullHint: "qwen2.5:14b-instruct" },
  { model: "llama3:latest", label: "Llama 3 (local via Ollama)", matchPrefixes: ["llama3:", "llama-3"], pullHint: "llama3" },
  {
    model: "deepseek-coder-v2",
    label: "DeepSeek-Coder (local via Ollama)",
    matchPrefixes: ["deepseek-coder"],
    pullHint: "deepseek-coder-v2",
  },
];

function baseUrl(): string {
  // An empty setting can be produced by a blank OLLAMA_BASE_URL= line in
  // model-keys.env. Treat it as unset so the normal local Ollama endpoint is
  // still used instead of querying the invalid URL prefix "/api/tags".
  return process.env.OLLAMA_BASE_URL?.trim() || discoveredBaseUrl || DEFAULT_BASE_URL;
}

function ollamaFailureCategory(error: unknown, phase: ModelExecutionDiagnostic["phase"]): ModelFailureCategory {
  const value = error instanceof Error ? error : new Error(String(error));
  const cause = value.cause && typeof value.cause === "object" ? value.cause as { code?: unknown; message?: unknown } : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = `${value.message} ${typeof cause?.message === "string" ? cause.message : ""}`.toLowerCase();
  if (value.name === "ContextBudgetExceededError") return "context_budget_exceeded";
  if (value.name === "StreamIdleTimeoutError") return "stream_idle_timeout";
  if (/inference queue is full/.test(message)) return "local_queue_full";
  if (value.name === "TimeoutError" || value.name === "HeadersTimeoutError" || /deadline|timed out|timeout|queue wait exceeded/.test(message) || /und_err_(?:headers|connect)_timeout/.test(code.toLowerCase())) return "provider_timeout";
  if (/econnrefused/.test(code.toLowerCase()) || /econnrefused|connection refused/.test(message)) return "connection_refused";
  if (/econnreset|und_err_socket/.test(code.toLowerCase()) || /econnreset|connection reset/.test(message)) return "connection_reset";
  if (/enotfound|eai_again|dns/.test(code.toLowerCase()) || /name resolution|dns|network unreachable/.test(message)) return "dns_or_network";
  if (/ePIPE|sigkill|signal 9|process.*exit|runner.*terminated/i.test(`${code} ${message}`)) return "process_terminated";
  if (/context length|maximum context|out of memory|resource exhausted|failed to allocate|metal.*memory/.test(message)) return "context_or_resource_exhaustion";
  if (/ollama returned \d{3}/.test(message)) return "provider_http_error";
  if (phase === "stream") return "stream_interrupted";
  return "unknown_network_error";
}

function diagnosticCause(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined) return undefined;
  if (error.cause instanceof Error) {
    const code = (error.cause as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.cause.message}` : error.cause.message;
  }
  if (typeof error.cause === "object") return JSON.stringify(error.cause);
  return String(error.cause);
}

function isContainerRuntime(): boolean {
  return existsSync("/.dockerenv") || (process.platform === "linux" && existsSync("/run/.containerenv"));
}

function endpointCandidates(): string[] {
  const configured = process.env.OLLAMA_BASE_URL?.trim();
  if (configured) return [configured.replace(/\/+$/, "")];
  return [...new Set([discoveredBaseUrl, ...DISCOVERY_BASE_URLS].filter((url): url is string => Boolean(url)))];
}

async function fetchTagsAt(endpoint: string): Promise<{ status: number; models?: InstalledOllamaModel[]; detail?: string }> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
  } catch (error) {
    return { status: 0, detail: (error as Error).message };
  }
  if (!response.ok) return { status: response.status, detail: (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240) };
  const body = await response.json() as { models?: { name?: string; digest?: string }[] };
  return {
    status: response.status,
    models: (body.models ?? [])
      .filter((model): model is { name: string; digest?: string } => typeof model.name === "string")
      .map((model) => ({ name: model.name, digest: model.digest })),
  };
}

/** Read-only, user-invoked diagnostic. Probes only the configured endpoint or loopback aliases; it never scans the LAN or changes Ollama's bind address. */
export async function diagnoseOllama(selectedModel?: string): Promise<OllamaDiagnosticsResponse> {
  const configured = Boolean(process.env.OLLAMA_BASE_URL?.trim());
  const candidates = endpointCandidates();
  const failures: string[] = [];
  for (const endpoint of candidates) {
    const result = await fetchTagsAt(endpoint);
    if (!result.models) {
      failures.push(`${endpoint}: ${result.status ? `HTTP ${result.status}${result.detail ? ` (${result.detail})` : ""}` : result.detail || "connection failed"}`);
      continue;
    }
    if (!configured && endpoint !== DEFAULT_BASE_URL) discoveredBaseUrl = endpoint;
    const installedModels = result.models.map((model) => model.name);
    const layaInstalled = installedModels.some((name) => name.toLowerCase().split(":")[0] === "laya");
    let version: string | undefined;
    try {
      const versionResponse = await fetch(`${endpoint}/api/version`, { signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
      if (versionResponse.ok) version = (await versionResponse.json() as { version?: string }).version;
    } catch {
      // Version is supplemental; successful /api/tags remains the reachability evidence.
    }
    let layaUsable: boolean | null = layaInstalled ? false : null;
    let layaDetail = layaInstalled ? "Laya is installed; its local decision endpoint has not returned a valid decision." : "Laya is not installed.";
    if (layaInstalled) {
      try {
        const layaResponse = await fetch(`${endpoint}/v1/systemone`, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: process.env.MOBIUSX_LAYA_MODEL ?? "laya",
            state: { task_mode: "build", request: "Check local task routing." },
            keep_alive: "1m",
            questions: { workload: { type: "choice", instructions: "Choose one work type.", criteria: { coding: "Create software.", chat: "Answer a question." } } },
          }),
        });
        const bodyText = await layaResponse.text();
        if (!layaResponse.ok) {
          layaDetail = `Laya HTTP ${layaResponse.status}: ${bodyText.replace(/\s+/g, " ").trim().slice(0, 220)}`;
        } else {
          const body = JSON.parse(bodyText) as { answers?: { workload?: { choice?: unknown } } };
          layaUsable = typeof body.answers?.workload?.choice === "string";
          layaDetail = layaUsable ? "Laya decision endpoint responded successfully." : "Laya responded without a usable workload decision.";
        }
      } catch (error) {
        layaDetail = `Laya probe failed: ${(error as Error).message.slice(0, 220)}`;
      }
    }
    const selectedLocalModelAvailable = selectedModel ? installedModels.includes(selectedModel) : undefined;
    const detail = layaUsable === false
      ? `Ollama is reachable and local inference is available. ${layaDetail}${selectedLocalModelAvailable === false ? ` Selected model ${selectedModel} is not installed.` : ""}`
      : `Ollama is reachable${version ? ` (version ${version})` : ""}; ${installedModels.length} model(s) are installed.${selectedLocalModelAvailable === false ? ` Selected model ${selectedModel} is not installed.` : ""}${layaUsable === null ? ` ${layaDetail}` : ""}`;
    return {
      endpoint,
      endpointSource: configured ? "settings/environment" : discoveredBaseUrl === endpoint && endpoint !== DEFAULT_BASE_URL ? "discovered" : "default",
      reachable: true,
      httpStatus: result.status,
      ...(version ? { version } : {}),
      installedModels,
      ...(selectedLocalModelAvailable === undefined ? {} : { selectedLocalModelAvailable }),
      layaInstalled,
      layaUsable,
      detail,
      runtime: isContainerRuntime() ? "container" : process.platform === "darwin" || process.platform === "win32" ? "host" : "unknown",
    };
  }
  return {
    endpoint: candidates[0] ?? DEFAULT_BASE_URL,
    endpointSource: configured ? "settings/environment" : "default",
    reachable: false,
    installedModels: [],
    ...(selectedModel ? { selectedLocalModelAvailable: false } : {}),
    layaInstalled: false,
    layaUsable: null,
    detail: `Ollama was not reachable from the Cloud Agent Gateway runtime. Tried ${failures.join("; ")}. If MobiusX runs in a container, 127.0.0.1 refers to that container; configure a reachable private endpoint in Settings. Keep Ollama bound to loopback and do not expose it publicly.`,
    runtime: isContainerRuntime() ? "container" : process.platform === "darwin" || process.platform === "win32" ? "host" : "unknown",
  };
}

/** Returns the locally-pulled model tag names, or null if Ollama isn't reachable at all (distinct from "reachable but nothing pulled", which is `[]`). */
interface InstalledOllamaModel { name: string; digest?: string }

async function fetchInstalledTags(): Promise<InstalledOllamaModel[] | null> {
  const candidates = endpointCandidates();
  let attemptedStart = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const endpoint of candidates) {
      const result = await fetchTagsAt(endpoint);
      if (result.models) {
        if (!process.env.OLLAMA_BASE_URL?.trim() && endpoint !== DEFAULT_BASE_URL) discoveredBaseUrl = endpoint;
        return result.models;
      }
    }
    if (!attemptedStart && !process.env.OLLAMA_BASE_URL?.trim()) {
      attemptedStart = tryStartOllama();
      if (attemptedStart) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (attempt === 0 && !attemptedStart) return null;
    if (!attemptedStart && attempt > 0) return null;
    if (attempt === 7) break;
  }
  return null;
}

export const ollamaRunner: AgentRunner = {
  name: "ollama",

  async listModels(): Promise<ModelOption[]> {
    const installed = await fetchInstalledTags();
    if (installed === null) {
      return CANDIDATE_MODELS.map((c) => ({
        provider: "ollama",
        model: c.model,
        label: c.label,
        free: true,
        available: false,
        unavailableReason: `Ollama not reachable at ${baseUrl()} — install it from ollama.com and make sure it's running`,
      }));
    }
    const chatModels = uniqueChatModels(installed);
    const discovered: ModelOption[] = chatModels.map(({ name }) => ({
      provider: "ollama",
      model: name,
      label: installedModelLabel(name),
      free: true,
      available: true,
    }));
    const suggestions = CANDIDATE_MODELS.filter((candidate) =>
      !chatModels.some(({ name }) => candidate.matchPrefixes.some((prefix) => name.toLowerCase().startsWith(prefix))),
    ).map((candidate) => ({
      provider: "ollama" as const,
      model: candidate.model,
      label: candidate.label,
      free: true,
      available: false,
      unavailableReason: `not pulled yet — run \`ollama pull ${candidate.pullHint}\``,
    }));
    // Laya and embedding checkpoints are discovered by /api/tags too, but
    // neither generates chat or code. Laya is consumed only through its
    // typed /v1/systemone routing API; embedding models remain owned by the
    // semantic-index feature. Hide both from the chat/build model picker.
    return [...discovered, ...suggestions];
  },

  async run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void> {
    const model = input.modelId;
    if (!model) {
      emit({ type: "error", message: "no Ollama model id resolved — see registry.ts#resolveRunner" });
      emit({ type: "done" });
      return;
    }

    emit({ type: "status", status: "running" });
    const isBuild = input.mode === "build";
    let activeStep: TaskStep = {
      id: stepId(),
      label: `Preparing ${isBuild ? "project build" : "request"} for local Ollama (${model})`,
      status: "in_progress" as const,
      startedAt: new Date().toISOString(),
    };
    emit({ type: "step", step: activeStep });
    const advanceStep = (label: string) => {
      if (activeStep.status === "in_progress") {
        emit({ type: "step", step: { ...activeStep, status: "completed", completedAt: new Date().toISOString() } });
      }
      activeStep = { id: stepId(), label, status: "in_progress", startedAt: new Date().toISOString() };
      emit({ type: "step", step: activeStep });
    };
    const finishStep = (status: "completed" | "failed") => {
      if (activeStep.status !== "in_progress") return;
      emit({ type: "step", step: { ...activeStep, status, completedAt: new Date().toISOString() } });
      activeStep = { ...activeStep, status };
    };

    const requestController = new AbortController();
    const requestSignal = input.signal
      ? AbortSignal.any([input.signal, requestController.signal])
      : requestController.signal;
    const requestTimeoutMs = input.stagedBuild?.repair
      ? OLLAMA_STAGED_REPAIR_TIMEOUT_MS
      : input.mode === "fix" ? OLLAMA_REPAIR_TIMEOUT_MS : OLLAMA_BUILD_TIMEOUT_MS;
    const requestDeadlineAt = Date.now() + requestTimeoutMs;
    const abortRequest = () => requestController.abort();
    const requestId = randomUUID();
    const requestStartedAtMs = Date.now();
    const requestStartedAt = new Date(requestStartedAtMs).toISOString();
    let requestPhase: ModelExecutionDiagnostic["phase"] = "queue";
    let requestHeadersMs: number | undefined;
    let requestConnectionMs: number | undefined;
    let requestResponseHeaderWaitMs: number | undefined;
    let requestConnectedAtMs: number | undefined;
    let requestConnectStartedAtMs: number | undefined;
    let requestFirstTokenMs: number | undefined;
    let requestQueueWaitMs: number | undefined;
    let requestQueueStartedAt: string | undefined;
    let requestQueuePosition: number | undefined;
    let requestActiveRequests: number | undefined;
    let requestTransportStartedAtMs = requestStartedAtMs;
    let requestFirstTokenAt: string | undefined;
    let requestStreamEndedAt: string | undefined;
    let requestLastActivityAtMs: number | undefined;
    let requestMaxStreamIdleMs = 0;
    let serializedRequestTelemetry: Awaited<ReturnType<typeof captureSerializedOllamaRequest>> | undefined;
    let serializedRequestRedacted: ReturnType<typeof redactedOllamaRequestForDiagnostics>;
    let responseCaptureTelemetry: Awaited<ReturnType<typeof captureOllamaText>> = {};
    let releaseInferenceSlot: (() => void) | undefined;
    let requestResponseBytes = 0;
    let requestHttpStatus: number | undefined;
    const requestMemoryBytes = process.memoryUsage().rss;
    const [ollamaStartResources, hostMemoryFreePercentAtStart] = await Promise.all([sampleOllamaProcessResources(), sampleHostMemoryFreePercent()]);
    const resourceStartedAtMs = Date.now();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    const gatewayCpuStarted = process.cpuUsage();
    const promptChars = (isBuild ? systemPromptForLocalBuild(input).length + OLLAMA_BUILD_FORMAT_INSTRUCTIONS.length : systemPromptFor(input).length)
      + input.prompt.length + (input.history ?? []).reduce((sum, turn) => sum + turn.content.length, 0);
    let promptOptions = { ...CHAT_OPTIONS, num_ctx: OLLAMA_CONTEXT_TOKENS, num_predict: 0 };
    let ollamaMetrics: OllamaMetrics | undefined;
    let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;

    try {
      promptOptions = chatOptionsFor(input, isBuild ? `${systemPromptForLocalBuild(input)}\n${OLLAMA_BUILD_FORMAT_INSTRUCTIONS}` : systemPromptFor(input));
      const useSchemaBuild = isBuild;
      let useSchemaFormat = useSchemaBuild;
      const systemPrompt = isBuild ? systemPromptForLocalBuild(input) : systemPromptFor(input);
      const chatBody = {
        model,
        keep_alive: "5m",
        messages: [
          { role: "system", content: useSchemaBuild ? `${systemPrompt}\n\n${OLLAMA_BUILD_FORMAT_INSTRUCTIONS}` : systemPrompt },
          ...historyMessages(input),
          { role: "user", content: input.prompt },
        ],
        stream: true,
        options: promptOptions,
      };
      const requestEndpoint = `${baseUrl()}/api/chat`;
      const requestBody = (withSchema: boolean) => JSON.stringify({ ...chatBody, ...(withSchema ? { format: OLLAMA_BUILD_FORMAT } : {}) });
      const postChat = (withSchema: boolean) => ollamaChatTransport(requestEndpoint, requestBody(withSchema), requestSignal, requestId, (phase) => {
        requestPhase = phase;
        if (phase === "connect") requestConnectStartedAtMs = Date.now();
        if (phase === "connected") {
          requestConnectedAtMs = Date.now();
          requestConnectionMs = requestConnectedAtMs - (requestConnectStartedAtMs ?? requestTransportStartedAtMs);
        }
      });
      const serializedRequest = requestBody(useSchemaFormat);
      serializedRequestTelemetry = await captureSerializedOllamaRequest(requestId, serializedRequest);
      serializedRequestRedacted = redactedOllamaRequestForDiagnostics(serializedRequest);
      requestQueueStartedAt = new Date().toISOString();
      const slot = await acquireOllamaSlot(requestSignal, requestDeadlineAt);
      releaseInferenceSlot = slot.release;
      requestQueueWaitMs = slot.queueWaitMs;
      requestQueuePosition = slot.queuePosition;
      requestActiveRequests = slot.activeRequests;
      requestTransportStartedAtMs = Date.now();
      requestPhase = "connect";
      let res = await promiseWithDeadline(postChat(useSchemaFormat), requestDeadlineAt, abortRequest);
      requestPhase = "headers";
      requestHeadersMs = Date.now() - requestTransportStartedAtMs;
      requestResponseHeaderWaitMs = requestConnectedAtMs === undefined ? requestHeadersMs : Date.now() - requestConnectedAtMs;
      requestHttpStatus = res.status;
      if (!res.ok && useSchemaFormat) {
        const errorBody = await res.text();
        // Structured outputs require a current Ollama server. If an older
        // local install rejects the field, keep the JSON instructions and
        // retry once without server-side enforcement.
        if (/format|schema/i.test(errorBody)) {
          useSchemaFormat = false;
          const fallbackBody = requestBody(false);
          serializedRequestTelemetry = await captureSerializedOllamaRequest(requestId, fallbackBody);
          serializedRequestRedacted = redactedOllamaRequestForDiagnostics(fallbackBody);
          res = await promiseWithDeadline(postChat(false), requestDeadlineAt, abortRequest);
          requestHttpStatus = res.status;
        } else {
          throw new Error(`Ollama returned ${res.status}: ${errorBody.slice(0, 500)}`);
        }
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 500)}`);
      }
      if (!res.body) {
        throw new Error("Ollama response had no body to stream");
      }
      requestPhase = "stream";
      if (isBuild) advanceStep(`Generating project files with local Ollama (${model})`);

      let sawText: boolean;
      const onUsage = (usage: { promptTokens: number; completionTokens: number }, metrics?: OllamaMetrics) => {
        capturedUsage = usage;
        ollamaMetrics = metrics;
      };
      if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
        let fullText = "";
        let pathScanBuffer = "";
        const reportedPaths = new Set<string>();
        const summaryStreamer = useSchemaBuild
          ? createOllamaSummaryStreamer((delta) => emit({ type: "output", delta }))
          : undefined;
        const publicProse = useSchemaBuild
          ? undefined
          : createStructuredProseStreamer((delta) => emit({ type: "output", delta }));
        sawText = await promiseWithDeadline(streamOllamaNdjson(
          res.body,
          (delta) => {
            requestFirstTokenMs ??= Date.now() - requestTransportStartedAtMs;
            requestFirstTokenAt ??= new Date().toISOString();
            requestResponseBytes += Buffer.byteLength(delta, "utf8");
            fullText += delta;
            if (useSchemaBuild) {
              summaryStreamer?.push(delta);
              pathScanBuffer = `${pathScanBuffer}${delta}`.slice(-2_000);
              const pathMatches = pathScanBuffer.matchAll(/\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"action"\s*:/g);
              for (const match of pathMatches) {
                try {
                  const path = JSON.parse(`"${match[1]}"`) as string;
                  if (path && !reportedPaths.has(path)) {
                    reportedPaths.add(path);
                    advanceStep(`Generating file ${reportedPaths.size}: ${path}`);
                  }
                } catch {
                  // Wait for the next streamed chunk if the path string is incomplete.
                }
              }
            }
            else publicProse?.push(delta);
          },
          onUsage,
          (receivedAt) => {
            if (requestLastActivityAtMs !== undefined) requestMaxStreamIdleMs = Math.max(requestMaxStreamIdleMs, receivedAt - requestLastActivityAtMs);
            requestLastActivityAtMs = receivedAt;
          },
        ), requestDeadlineAt, abortRequest);
        publicProse?.finish();
        if (!sawText) {
          emit({ type: "output", delta: "(model returned no text content)" });
        } else {
          responseCaptureTelemetry = await captureOllamaText(requestId, "response", fullText);
          if (useSchemaBuild) advanceStep("Checking generated files and project dependencies");
          const parseResponse = useSchemaBuild ? parseOllamaBuildResponse : parseBuildResponse;
          let { prose, edits, droppedCount, hadMarker, parseFailed, rejectedEditPaths } = parseResponse(fullText, input);
          let retried = false;
          let qualityRepairAttempts = 0;
          let qualityIssues = useSchemaBuild && !input.stagedBuild ? ollamaBuildQualityIssues(input, edits) : [];
          // Observed with qwen2.5-coder:7b-instruct-q4_K_M on a Bosch
          // Appliances build: the model streamed a coherent implementation
          // plan and file list, then stopped without the EDITS_MARKER JSON
          // block. The OpenAI-compatible runner already retries this exact
          // case; without the same recovery, Ollama silently completed a
          // build task that had applied zero files.
          if (edits.length === 0 && droppedCount === 0 && (!hadMarker || parseFailed)) {
            retried = true;
            emit({
              type: "output",
              delta: "\n\nThe first response described the app but did not include file edits. Asking the local model once to write the project files now…",
            });
            const retry = await retryForEdits(
              model,
              systemPrompt,
              input,
              fullText,
              emit,
              useSchemaBuild,
              useSchemaFormat,
              summaryStreamer ? (delta) => summaryStreamer.push(delta) : undefined,
              undefined,
              [],
              requestDeadlineAt,
              requestSignal,
              abortRequest,
            );
            if (retry) {
              if (retry.prose) prose = retry.prose;
              edits = retry.edits;
              droppedCount = retry.droppedCount;
              rejectedEditPaths = retry.rejectedEditPaths;
              hadMarker = retry.hadMarker;
              parseFailed = retry.parseFailed;
              if (retry.usage) {
                capturedUsage = {
                  promptTokens: (capturedUsage?.promptTokens ?? 0) + retry.usage.promptTokens,
                  completionTokens: (capturedUsage?.completionTokens ?? 0) + retry.usage.completionTokens,
                };
              }
              if (useSchemaBuild && !input.stagedBuild && edits.length > 0) qualityIssues = ollamaBuildQualityIssues(input, edits);
            }
          }
          // A missing/invalid Next.js manifest is deterministic project
          // scaffolding. Repair it locally from the imports in the proposed
          // files instead of asking a small Ollama model to reproduce a large
          // payroll app (which commonly truncates the repair response).
          if (useSchemaBuild && !input.stagedBuild && edits.length > 0 && qualityIssues.some((issue) =>
            issue === "blank Next.js project is missing package.json" ||
            issue === "package.json is missing or invalid" ||
            issue === "package.json does not declare Next.js" ||
            issue === "package.json must declare both react and react-dom" ||
            issue.startsWith("Python backend package(s) incorrectly listed in npm manifest:")
          )) {
            advanceStep("Repairing the Next.js manifest and removing backend packages from npm dependencies");
            const manifestRepair = ensureNextPackageManifest(input, edits);
            if (manifestRepair.added) {
              edits = manifestRepair.edits;
              emit({ type: "output", delta: "\n\nMobiusX added the missing Next.js package manifest using the generated files' imports." });
              qualityIssues = ollamaBuildQualityIssues(input, edits);
            }
          }
          const isPayrollBuild = useSchemaBuild && !input.stagedBuild && /\b(payroll|pay slip|payslip|salary calculation|salary processing)\b/i.test(input.prompt);
          const maxQualityRepairAttempts = isPayrollBuild ? 2 : 1;
          while (qualityIssues.length > 0 && qualityRepairAttempts < maxQualityRepairAttempts) {
            qualityRepairAttempts += 1;
            retried = true;
            advanceStep(`Asking Ollama to repair project checks (attempt ${qualityRepairAttempts}/${maxQualityRepairAttempts})`);
            emit({ type: "output", delta: `\n\nChecking the local build found: ${qualityIssues.join("; ")}. Asking Ollama to add or repair only the files needed for those checks${qualityRepairAttempts > 1 ? " (second focused attempt)" : ""}…` });
            const repair = await retryForEdits(
              model,
              systemPrompt,
              input,
              fullText,
              emit,
              useSchemaBuild,
              useSchemaFormat,
              summaryStreamer ? (delta) => summaryStreamer.push(delta) : undefined,
              (path, count) => advanceStep(`Repairing file ${count}: ${path}`),
              qualityIssues,
              requestDeadlineAt,
              requestSignal,
              abortRequest,
            );
            if (repair?.edits.length) {
              prose = repair.prose || prose;
              edits = mergeProposedEdits(edits, repair.edits);
              droppedCount = repair.droppedCount;
              rejectedEditPaths = repair.rejectedEditPaths;
              hadMarker = repair.hadMarker;
              parseFailed = repair.parseFailed;
              if (repair.usage) {
                capturedUsage = {
                  promptTokens: (capturedUsage?.promptTokens ?? 0) + repair.usage.promptTokens,
                  completionTokens: (capturedUsage?.completionTokens ?? 0) + repair.usage.completionTokens,
                };
              }
            }
            qualityIssues = ollamaBuildQualityIssues(input, edits);
            // A second attempt should target the remaining concrete gaps,
            // including when the first repair returned no usable edits.
            if (qualityIssues.length > 0 && qualityRepairAttempts < maxQualityRepairAttempts) {
              emit({ type: "output", delta: `\n\nThe first repair did not close all payroll gaps: ${qualityIssues.join("; ")}. Trying one more focused repair…` });
            }
          }
          const blockingPayrollIssues = isPayrollBuild
            ? qualityIssues.filter((issue) => /payroll implementation is missing|payroll frontend is only a basic page|payroll frontend source is missing|requested FastAPI backend source is missing|FastAPI requirements\.txt is missing/i.test(issue))
            : [];
          if (blockingPayrollIssues.length > 0) {
            const message = `The payroll build is incomplete after ${qualityRepairAttempts} focused repair attempt(s): ${blockingPayrollIssues.join("; ")}. MobiusX withheld the partial files so they are not mistaken for a working payroll application or preview. Try Auto/Cloud or a stronger coding model, then generate again.`;
            emit({ type: "output", delta: `\n\n${message}` });
            finishStep("failed");
            emit({ type: "error", message });
            emit({ type: "status", status: "failed" });
            emit({ type: "done" });
            return;
          }
          const blockingQualityIssues = qualityIssues.filter((issue) =>
            /(?:package\.json is missing or invalid|package\.json does not declare Next\.js|package\.json must declare both react and react-dom|blank Next\.js project is missing package\.json|Python backend package\(s\) incorrectly listed)/i.test(issue)
          );
          if (blockingQualityIssues.length > 0) {
            const message = `Ollama's generated project still has startup-blocking issues after one local repair attempt: ${blockingQualityIssues.join("; ")}. No files were proposed for application. Try a smaller request or use a stronger model.`;
            emit({ type: "output", delta: `\n\n${message}` });
            finishStep("failed");
            emit({ type: "error", message });
            emit({ type: "done" });
            return;
          }
          if (qualityIssues.length > 0) {
            emit({
              type: "output",
              delta: `\n\n[quality warning] Ollama did not resolve these completeness/polish checks after one focused repair: ${qualityIssues.join("; ")}. The generated files are available for review. Missing entry pages or backend files may prevent preview until added; the gaps are listed here so you can request a targeted follow-up.`,
            });
          }
          // Schema-constrained Ollama output is buffered until parsed so raw
          // JSON and source code never leak into the user-facing transcript.
          if (useSchemaBuild && prose.trim()) {
            const streamedSummary = summaryStreamer?.value() ?? "";
            const finalSummary = prose.trim();
            if (!streamedSummary) emit({ type: "output", delta: finalSummary });
            else if (finalSummary.startsWith(streamedSummary)) emit({ type: "output", delta: finalSummary.slice(streamedSummary.length) });
          }
          if (edits.length > 0) emit({ type: "edits", edits, contractVersion: BUILD_RESPONSE_CONTRACT_VERSION });
          if (parseFailed) {
            // See promptShared.ts's parseFailed doc comment: marker
            // present, but the JSON after it never parsed (classic cause:
            // the response hit its token ceiling mid-JSON). The one
            // structured-edit retry above already ran for this case; keep
            // the final explanation visible when it still cannot recover.
            emit({
              type: "output",
              delta: useSchemaBuild
                ? "\n\n(Ollama did not return a valid structured file response. No files were changed; try a smaller request or update Ollama.)"
                : "\n\n(This response included the file-edit marker, but the JSON that followed it didn't parse — almost always because the response was cut off before the JSON finished. No files were changed. Try again, ask for something smaller/more focused, or switch models in Settings.)",
            });
          }
          if (droppedCount > 0) {
            emit({
              type: "output",
              delta: `\n\n(${droppedCount} proposed edit(s) omitted: ${rejectedEditSummary(rejectedEditPaths, droppedCount)}.)`,
            });
          }
          const askedForClarification = hadMarker && !parseFailed && edits.length === 0 && droppedCount === 0;
          if (edits.length === 0 && !askedForClarification) {
            const message = useSchemaBuild
              ? `No project files were generated${retried ? " after the automatic retry" : ""}. ${model} did not return usable file edits in the required JSON shape. Try a smaller build request or update Ollama.`
              : `No project files were generated${retried ? " after the automatic retry" : ""}. ${model} returned a plan instead of the required ${EDITS_MARKER} file-edit block. Try a smaller build request or select a stronger model.`;
            emit({ type: "output", delta: `\n\n${message}` });
            finishStep("failed");
            emit({ type: "error", message });
            emit({ type: "done" });
            return;
          }
          if (
            (!input.stagedBuild || input.stagedBuild.final) &&
            (input.mode === "build" ||
              input.mode === "fix" ||
              input.mode === "database" ||
              input.mode === "architecture" ||
              input.mode === "testing" ||
              input.mode === "devops" ||
              input.mode === "auth" ||
              input.mode === "spec") &&
            edits.length > 0
          ) {
            advanceStep("Reviewing proposed code for implementation and security concerns");
            await runPersonaReview(input.mode, input, edits, emit, (systemPrompt, userContent) =>
              callOllamaNonStreamed(model, systemPrompt, userContent, requestSignal, requestDeadlineAt, abortRequest),
            );
          }
          // Assistant Memory's automatic-extraction call (Oct 2026 addition)
          // — see memoryExtraction.ts's module doc comment. No-ops unless
          // the user has turned AgentSettings.memoryMode to "auto".
          await maybeExtractAssistantMemory(input, prose || fullText, edits, (systemPrompt, userContent) =>
            callOllamaNonStreamed(model, systemPrompt, userContent, requestSignal, requestDeadlineAt, abortRequest),
          );
        }
      } else {
        sawText = await promiseWithDeadline(
          streamOllamaNdjson(res.body, (delta) => {
            requestFirstTokenMs ??= Date.now() - requestTransportStartedAtMs;
            requestFirstTokenAt ??= new Date().toISOString();
            requestResponseBytes += Buffer.byteLength(delta, "utf8");
            emit({ type: "output", delta });
          }, onUsage, (receivedAt) => {
            if (requestLastActivityAtMs !== undefined) requestMaxStreamIdleMs = Math.max(requestMaxStreamIdleMs, receivedAt - requestLastActivityAtMs);
            requestLastActivityAtMs = receivedAt;
          }),
          requestDeadlineAt,
          abortRequest,
        );
        if (!sawText) emit({ type: "output", delta: "(model returned no text content)" });
      }

      requestPhase = "complete";
      requestStreamEndedAt = new Date().toISOString();
      const resourceTelemetry = await finishLocalResourceTelemetry(eventLoopDelay, gatewayCpuStarted, ollamaStartResources, hostMemoryFreePercentAtStart, resourceStartedAtMs);
      emit({ type: "model_diagnostic", diagnostic: {
        requestId, taskId: input.taskId, attempt: input.stagedBuild ? input.stagedBuild.index + 1 : 1, provider: "ollama", endpoint: requestEndpoint, modelId: model, phase: requestPhase,
        startedAt: requestStartedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - requestStartedAtMs,
        queueStartedAt: requestQueueStartedAt, transportStartedAt: new Date(requestTransportStartedAtMs).toISOString(),
        ...(requestConnectedAtMs !== undefined ? { connectedAt: new Date(requestConnectedAtMs).toISOString() } : {}),
        ...(requestHeadersMs !== undefined ? { headersAt: new Date(requestTransportStartedAtMs + requestHeadersMs).toISOString() } : {}),
        ...(requestFirstTokenAt ? { firstTokenAt: requestFirstTokenAt } : {}), ...(requestStreamEndedAt ? { streamEndedAt: requestStreamEndedAt } : {}),
        queueWaitMs: requestQueueWaitMs, queuePosition: requestQueuePosition, activeRequests: requestActiveRequests, maxConcurrency: OLLAMA_MAX_CONCURRENCY,
        serializedRequestBytes: serializedRequestTelemetry?.bytes, serializedRequestSha256: serializedRequestTelemetry?.sha256,
        ...(serializedRequestRedacted ? { serializedRequestRedacted } : {}),
        ...(serializedRequestTelemetry?.path ? { serializedRequestCapturePath: serializedRequestTelemetry.path } : {}),
        ...(serializedRequestTelemetry?.error ? { serializedRequestCaptureError: serializedRequestTelemetry.error } : {}),
        ...(responseCaptureTelemetry.path ? { responseCapturePath: responseCaptureTelemetry.path } : {}),
        ...(responseCaptureTelemetry.error ? { responseCaptureError: responseCaptureTelemetry.error } : {}),
        streamIdleTimeoutMs: OLLAMA_STREAM_IDLE_TIMEOUT_MS, maxObservedStreamIdleMs: requestMaxStreamIdleMs, streamIdleTimedOut: false,
        ...(requestHeadersMs !== undefined ? { timeToHeadersMs: requestHeadersMs } : {}),
        ...(requestConnectionMs !== undefined ? { timeToConnectMs: requestConnectionMs } : {}),
        ...(requestResponseHeaderWaitMs !== undefined ? { responseHeaderWaitMs: requestResponseHeaderWaitMs } : {}),
        ...(requestFirstTokenMs !== undefined ? { timeToFirstTokenMs: requestFirstTokenMs } : {}),
        promptChars, estimatedPromptTokens: Math.ceil(promptChars / 3.2) + 256,
        ...(capturedUsage ? { promptTokens: capturedUsage.promptTokens, generatedTokens: capturedUsage.completionTokens } : {}),
        contextLength: promptOptions.num_ctx, requestTimeoutMs, headersTimeoutMs: OLLAMA_HEADERS_TIMEOUT_MS,
        ...(durationMs(ollamaMetrics?.load_duration) !== undefined ? { ollamaLoadDurationMs: durationMs(ollamaMetrics?.load_duration) } : {}),
        ...(durationMs(ollamaMetrics?.prompt_eval_duration) !== undefined ? { promptEvaluationDurationMs: durationMs(ollamaMetrics?.prompt_eval_duration) } : {}),
        ...(durationMs(ollamaMetrics?.eval_duration) !== undefined ? { generationDurationMs: durationMs(ollamaMetrics?.eval_duration) } : {}),
        ...(durationMs(ollamaMetrics?.total_duration) !== undefined ? { providerTotalDurationMs: durationMs(ollamaMetrics?.total_duration) } : {}),
        ...(typeof ollamaMetrics?.size_vram === "number" ? { ollamaVramBytes: ollamaMetrics.size_vram } : {}),
        ...resourceTelemetry,
        processMemoryBytes: process.memoryUsage().rss,
        responseBytes: requestResponseBytes, streaming: true, ...(requestHttpStatus !== undefined ? { httpStatus: requestHttpStatus } : {}),
        cancelled: false, deadlineExceeded: false, retryHistory: [input.stagedBuild?.repair ? "staged-focused-repair" : "initial-request"],
      } });

      if (capturedUsage) {
        emit({
          type: "usage",
          usage: {
            promptTokens: capturedUsage.promptTokens,
            completionTokens: capturedUsage.completionTokens,
            totalTokens: capturedUsage.promptTokens + capturedUsage.completionTokens,
            // No contextWindow: a local Ollama model's window depends on
            // the user's own pull/Modelfile, not something this gateway
            // can look up (see streamOllamaNdjson's comment above).
          },
        });
      }
      finishStep("completed");
      emit({ type: "status", status: "completed" });
      emit({ type: "done" });
    } catch (err) {
      const cancelled = input.signal?.aborted || (err as Error).name === "AbortError";
      const deadlineExceeded = (err as Error).name === "TimeoutError";
      const streamIdleTimedOut = (err as Error).name === "StreamIdleTimeoutError";
      const endedAt = new Date();
      const detail = err instanceof Error ? err.message : String(err);
      const resourceTelemetry = await finishLocalResourceTelemetry(eventLoopDelay, gatewayCpuStarted, ollamaStartResources, hostMemoryFreePercentAtStart, resourceStartedAtMs);
      emit({ type: "model_diagnostic", diagnostic: {
        requestId, taskId: input.taskId, attempt: input.stagedBuild ? input.stagedBuild.index + 1 : 1, provider: "ollama", endpoint: `${baseUrl()}/api/chat`, modelId: model, phase: requestPhase,
        startedAt: requestStartedAt, endedAt: endedAt.toISOString(), durationMs: endedAt.getTime() - requestStartedAtMs,
        ...(requestQueueStartedAt ? { queueStartedAt: requestQueueStartedAt } : {}), transportStartedAt: new Date(requestTransportStartedAtMs).toISOString(),
        ...(requestConnectedAtMs !== undefined ? { connectedAt: new Date(requestConnectedAtMs).toISOString() } : {}),
        ...(requestHeadersMs !== undefined ? { headersAt: new Date(requestTransportStartedAtMs + requestHeadersMs).toISOString() } : {}),
        ...(requestFirstTokenAt ? { firstTokenAt: requestFirstTokenAt } : {}), ...(requestStreamEndedAt ? { streamEndedAt: requestStreamEndedAt } : {}),
        queueWaitMs: requestQueueWaitMs, queuePosition: requestQueuePosition, activeRequests: requestActiveRequests, maxConcurrency: OLLAMA_MAX_CONCURRENCY,
        serializedRequestBytes: serializedRequestTelemetry?.bytes, serializedRequestSha256: serializedRequestTelemetry?.sha256,
        ...(serializedRequestRedacted ? { serializedRequestRedacted } : {}),
        ...(serializedRequestTelemetry?.path ? { serializedRequestCapturePath: serializedRequestTelemetry.path } : {}),
        ...(serializedRequestTelemetry?.error ? { serializedRequestCaptureError: serializedRequestTelemetry.error } : {}),
        ...(responseCaptureTelemetry.path ? { responseCapturePath: responseCaptureTelemetry.path } : {}),
        ...(responseCaptureTelemetry.error ? { responseCaptureError: responseCaptureTelemetry.error } : {}),
        streamIdleTimeoutMs: OLLAMA_STREAM_IDLE_TIMEOUT_MS, maxObservedStreamIdleMs: requestMaxStreamIdleMs, streamIdleTimedOut,
        ...(requestHeadersMs !== undefined ? { timeToHeadersMs: requestHeadersMs } : {}),
        ...(requestConnectionMs !== undefined ? { timeToConnectMs: requestConnectionMs } : {}),
        ...(requestResponseHeaderWaitMs !== undefined ? { responseHeaderWaitMs: requestResponseHeaderWaitMs } : {}),
        ...(requestFirstTokenMs !== undefined ? { timeToFirstTokenMs: requestFirstTokenMs } : {}),
        promptChars, estimatedPromptTokens: Math.ceil(promptChars / 3.2) + 256, contextLength: promptOptions.num_ctx,
        ...(requestResponseBytes > 0 && !capturedUsage ? { estimatedGeneratedTokens: Math.ceil(requestResponseBytes / 4) } : {}),
        requestTimeoutMs, headersTimeoutMs: OLLAMA_HEADERS_TIMEOUT_MS, processMemoryBytes: process.memoryUsage().rss,
        ...(typeof ollamaMetrics?.size_vram === "number" ? { ollamaVramBytes: ollamaMetrics.size_vram } : {}),
        ...resourceTelemetry,
        responseBytes: requestResponseBytes, streaming: true, ...(requestHttpStatus !== undefined ? { httpStatus: requestHttpStatus } : {}),
        ...(!cancelled ? { errorCategory: ollamaFailureCategory(err, requestPhase), errorMessage: detail, ...(diagnosticCause(err) ? { errorCause: diagnosticCause(err) } : {}) } : {}),
        cancelled, deadlineExceeded,
        ...(deadlineExceeded ? { deadlineOverrunMs: Math.max(0, endedAt.getTime() - requestDeadlineAt) } : {}),
        retryHistory: [input.stagedBuild?.repair ? "staged-focused-repair" : "initial-request"],
      } });
      if (input.signal?.aborted || (err as Error).name === "AbortError") {
        finishStep("completed");
        emit({ type: "status", status: "cancelled" });
        emit({ type: "done" });
        return;
      }
      finishStep("failed");
      emit({
        type: "error",
        message: (err as Error).name === "TimeoutError"
          ? `Ollama did not finish this ${input.mode === "fix" || input.stagedBuild?.repair ? "repair" : "generation"} within ${Math.round(requestTimeoutMs / 60_000)} minutes. The model may be overloaded or the request may exceed its practical output budget; try a smaller scope or a faster/larger-capability model.`
          : (err as Error).message,
      });
      emit({ type: "done" });
    } finally {
      releaseInferenceSlot?.();
      releaseInferenceSlot = undefined;
    }
  },
};

/**
 * Thin non-streamed Ollama /api/chat call, used only by the second-pass
 * persona review (see personas.ts#runPersonaReview, which supplies the
 * persona-specific system prompt and receives this as its `callModel`
 * closure). `stream: false` returns the whole response as one JSON object
 * (`{message: {content: "..."}, ...}`), no NDJSON parsing required.
 */
async function callOllamaNonStreamed(model: string, systemPrompt: string, userContent: string, signal: AbortSignal, deadlineAt: number, abort: () => void): Promise<string> {
  const operation = (async () => {
  const res = await ollamaChatTransport(`${baseUrl()}/api/chat`, JSON.stringify({
      model,
      keep_alive: "5m",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      stream: false,
      options: reviewOptionsFor(systemPrompt, userContent),
    }), signal);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama returned ${res.status} for the review call: ${body.slice(0, 500)}`);
  }
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  const content = body.message?.content ?? "";
  if (!content.trim()) throw new Error("Ollama returned an empty response for the review call");
  return content;
  })();
  return promiseWithDeadline(operation, deadlineAt, abort);
}

/**
 * One format-recovery attempt for local models that return a prose plan
 * instead of the structured edits block. Mirrors the OpenAI-compatible
 * runner's retry behavior while using Ollama's NDJSON stream and preserving
 * live prose streaming. A failed retry returns null; cancellation still
 * propagates to the runner so the task remains cancelled rather than failed.
 */
async function retryForEdits(
  model: string,
  systemPrompt: string,
  input: RunnerInput,
  priorAssistantText: string,
  emit: (event: TaskEvent) => void,
  useSchemaBuild: boolean,
  useSchemaFormat: boolean,
  onSchemaSummaryChunk?: (delta: string) => void,
  onStructuredPath?: (path: string, count: number) => void,
  qualityIssues: string[] = [],
  parentDeadlineAt = Date.now() + OLLAMA_REPAIR_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  abortParent?: () => void,
): Promise<ReturnType<typeof parseBuildResponse> & { usage?: { promptTokens: number; completionTokens: number } } | null> {
  const diagnosticId = randomUUID();
  const diagnosticStartedMs = Date.now();
  const diagnosticStartedAt = new Date(diagnosticStartedMs).toISOString();
  const [diagnosticOllamaStartResources, diagnosticHostMemoryStart] = await Promise.all([sampleOllamaProcessResources(), sampleHostMemoryFreePercent()]);
  const diagnosticResourceStartedAtMs = Date.now();
  const diagnosticEventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  diagnosticEventLoopDelay.enable();
  const diagnosticGatewayCpuStarted = process.cpuUsage();
  const diagnosticEndpoint = `${baseUrl()}/api/chat`;
  const retryReason = input.stagedBuild?.repair ? "staged-focused-repair" : qualityIssues.length ? "quality-repair" : "structured-output-retry";
  let diagnosticPhase: ModelExecutionDiagnostic["phase"] = "connect";
  let diagnosticHeadersMs: number | undefined;
  let diagnosticFirstTokenMs: number | undefined;
  let diagnosticResponseBytes = 0;
  let diagnosticHttpStatus: number | undefined;
  let diagnosticEmitted = false;
  let diagnosticPromptChars = 0;
  let diagnosticContextLength = 0;
  let diagnosticRequestTimeoutMs = 0;
  let diagnosticDeadlineAt = parentDeadlineAt;
    let diagnosticMetrics: OllamaMetrics | undefined;
    let diagnosticUsage: { promptTokens: number; completionTokens: number } | undefined;
    let diagnosticResponseCapture: Awaited<ReturnType<typeof captureOllamaText>> = {};
  const emitDiagnostic = async (error?: unknown) => {
    if (diagnosticEmitted) return;
      diagnosticEmitted = true;
    const resourceTelemetry = await finishLocalResourceTelemetry(diagnosticEventLoopDelay, diagnosticGatewayCpuStarted, diagnosticOllamaStartResources, diagnosticHostMemoryStart, diagnosticResourceStartedAtMs);
    const cancelled = input.signal?.aborted || (error as Error | undefined)?.name === "AbortError";
    const deadlineExceeded = (error as Error | undefined)?.name === "TimeoutError";
    const endedAt = new Date();
    const detail = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
      emit({ type: "model_diagnostic", diagnostic: {
      requestId: diagnosticId, provider: "ollama", endpoint: diagnosticEndpoint, modelId: model, phase: error ? diagnosticPhase : "complete",
      startedAt: diagnosticStartedAt, endedAt: endedAt.toISOString(), durationMs: endedAt.getTime() - diagnosticStartedMs,
      ...(diagnosticHeadersMs !== undefined ? { timeToHeadersMs: diagnosticHeadersMs } : {}),
      ...(diagnosticFirstTokenMs !== undefined ? { timeToFirstTokenMs: diagnosticFirstTokenMs } : {}),
      promptChars: diagnosticPromptChars,
      estimatedPromptTokens: Math.ceil(diagnosticPromptChars / 3.2) + 256,
      ...(diagnosticUsage ? { promptTokens: diagnosticUsage.promptTokens, generatedTokens: diagnosticUsage.completionTokens } : {}),
      ...(diagnosticResponseBytes > 0 && !diagnosticUsage ? { estimatedGeneratedTokens: Math.ceil(diagnosticResponseBytes / 4) } : {}),
      contextLength: diagnosticContextLength,
        requestTimeoutMs: diagnosticRequestTimeoutMs,
        headersTimeoutMs: OLLAMA_HEADERS_TIMEOUT_MS,
        ...(diagnosticResponseCapture.path ? { responseCapturePath: diagnosticResponseCapture.path } : {}),
        ...(diagnosticResponseCapture.error ? { responseCaptureError: diagnosticResponseCapture.error } : {}),
      ...(durationMs(diagnosticMetrics?.load_duration) !== undefined ? { ollamaLoadDurationMs: durationMs(diagnosticMetrics?.load_duration) } : {}),
      ...(durationMs(diagnosticMetrics?.prompt_eval_duration) !== undefined ? { promptEvaluationDurationMs: durationMs(diagnosticMetrics?.prompt_eval_duration) } : {}),
      ...(durationMs(diagnosticMetrics?.eval_duration) !== undefined ? { generationDurationMs: durationMs(diagnosticMetrics?.eval_duration) } : {}),
      ...(durationMs(diagnosticMetrics?.total_duration) !== undefined ? { providerTotalDurationMs: durationMs(diagnosticMetrics?.total_duration) } : {}),
      ...(typeof diagnosticMetrics?.size_vram === "number" ? { ollamaVramBytes: diagnosticMetrics.size_vram } : {}),
      ...resourceTelemetry,
      responseBytes: diagnosticResponseBytes, streaming: true, ...(diagnosticHttpStatus !== undefined ? { httpStatus: diagnosticHttpStatus } : {}),
      ...(!cancelled && error !== undefined ? { errorCategory: ollamaFailureCategory(error, diagnosticPhase), errorMessage: detail, ...(diagnosticCause(error) ? { errorCause: diagnosticCause(error) } : {}) } : {}),
      cancelled, deadlineExceeded,
      ...(deadlineExceeded ? { deadlineOverrunMs: Math.max(0, endedAt.getTime() - diagnosticDeadlineAt) } : {}),
      retryHistory: [retryReason],
    } });
  };
  try {
    const repairController = new AbortController();
    const repairSignal = parentSignal ? AbortSignal.any([parentSignal, repairController.signal]) : repairController.signal;
    const perRepairTimeoutMs = input.stagedBuild?.repair ? OLLAMA_STAGED_REPAIR_TIMEOUT_MS : OLLAMA_REPAIR_TIMEOUT_MS;
    const repairDeadlineAt = Math.min(parentDeadlineAt, Date.now() + perRepairTimeoutMs);
    diagnosticDeadlineAt = repairDeadlineAt;
    diagnosticRequestTimeoutMs = Math.max(0, repairDeadlineAt - diagnosticStartedMs);
    const retrySystemPrompt = useSchemaBuild ? `${systemPrompt}\n\n${OLLAMA_BUILD_FORMAT_INSTRUCTIONS}` : systemPrompt;
    const retryUserMessage = useSchemaBuild
      ? qualityIssues.length > 0
        ? `Your previous proposed files have these concrete defects: ${qualityIssues.map((issue) => `- ${issue}`).join("\n")}. Correct these defects only. Return complete contents only for new or changed files needed to resolve the listed defects; do not repeat valid files already proposed. Keep the user's requested behavior intact, use action "create" for each returned path because no files have been applied yet, and do not return another plan.`
        : "Your previous response did not contain valid project edits. Now create the requested files. Return a concise summary and complete file contents in the required JSON object; do not return another plan."
      : `Your previous answer described the requested project but did not create any files. Now write the actual files. Respond with a brief summary, then ${EDITS_MARKER} on its own line, then one fenced json block with an "edits" array containing complete file contents. Do not provide another plan or file list without the edits block. Keep the scope focused enough to finish all JSON and the closing code fence.`;
    const retryPromptChars = retrySystemPrompt.length + input.prompt.length + (input.history ?? []).reduce((sum, turn) => sum + turn.content.length, 0) + priorAssistantText.length + retryUserMessage.length;
    const retryOptions = chatOptionsFor(input, retrySystemPrompt);
    diagnosticPromptChars = retryPromptChars;
    diagnosticContextLength = retryOptions.num_ctx;
    const abortRepair = () => {
      repairController.abort();
      abortParent?.();
    };
    const operation = (async () => {
    const res = await ollamaChatTransport(diagnosticEndpoint, JSON.stringify({
        model,
        keep_alive: "5m",
        messages: [
          { role: "system", content: retrySystemPrompt },
          ...historyMessages(input),
          { role: "user", content: input.prompt },
          { role: "assistant", content: priorAssistantText },
          { role: "user", content: retryUserMessage },
        ],
        stream: true,
        ...(useSchemaFormat ? { format: OLLAMA_BUILD_FORMAT } : {}),
        options: retryOptions,
      }), repairSignal, diagnosticId, (phase) => { diagnosticPhase = phase; });
    diagnosticPhase = "headers";
    diagnosticHeadersMs = Date.now() - diagnosticStartedMs;
    diagnosticHttpStatus = res.status;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 500)}`);
    }
    if (!res.body) throw new Error("Ollama repair response had no body to stream");
    diagnosticPhase = "stream";

    let retryText = "";
    let pathScanBuffer = "";
    const reportedPaths = new Set<string>();
    const publicProse = useSchemaBuild
      ? undefined
      : createStructuredProseStreamer((delta) => emit({ type: "output", delta }));
    const sawText = await streamOllamaNdjson(
      res.body,
      (delta) => {
        diagnosticFirstTokenMs ??= Date.now() - diagnosticStartedMs;
        diagnosticResponseBytes += Buffer.byteLength(delta, "utf8");
        retryText += delta;
        if (useSchemaBuild) onSchemaSummaryChunk?.(delta);
        if (useSchemaBuild && onStructuredPath) {
          pathScanBuffer = `${pathScanBuffer}${delta}`.slice(-2_000);
          for (const match of pathScanBuffer.matchAll(/\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"action"\s*:/g)) {
            try {
              const path = JSON.parse(`"${match[1]}"`) as string;
              if (path && !reportedPaths.has(path)) {
                reportedPaths.add(path);
                onStructuredPath(path, reportedPaths.size);
              }
            } catch {
              // Wait for the path string to finish across a later NDJSON chunk.
            }
          }
        }
        else publicProse?.push(delta);
      },
      (nextUsage, metrics) => { diagnosticUsage = nextUsage; diagnosticMetrics = metrics; },
    );
    publicProse?.finish();
    if (!sawText) {
      await emitDiagnostic();
      return null;
    }
    diagnosticResponseCapture = await captureOllamaText(diagnosticId, "response", retryText);
    await emitDiagnostic();
    return { ...(useSchemaBuild ? parseOllamaBuildResponse(retryText, input) : parseBuildResponse(retryText, input)), usage: diagnosticUsage };
    })();
    return await promiseWithDeadline(operation, repairDeadlineAt, abortRepair);
  } catch (err) {
    await emitDiagnostic(err);
    if (input.signal?.aborted || (err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw err;
    const detail = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message: `Ollama repair request failed: ${detail}` });
    return null;
  }
}

/**
 * Reads Ollama's /api/chat streaming response: one JSON object per line
 * (NOT SSE — no "data:" prefix), each carrying an incremental
 * `message.content` chunk until a final line with `"done": true`. Returns
 * whether any text content was seen.
 */
export async function streamOllamaNdjson(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }, metrics?: OllamaMetrics) => void,
  onActivity?: (receivedAt: number, chunkBytes: number) => void,
  idleTimeoutMs = OLLAMA_STREAM_IDLE_TIMEOUT_MS,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawText = false;

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          idleTimer = setTimeout(() => {
            const error = new Error(`Ollama stream idle timeout after ${idleTimeoutMs}ms`);
            error.name = "StreamIdleTimeoutError";
            reject(error);
            void reader.cancel(error).catch(() => undefined);
          }, idleTimeoutMs);
        }),
      ]).finally(() => { if (idleTimer) clearTimeout(idleTimer); });
      if (done) break;
      onActivity?.(Date.now(), value.byteLength);
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        let parsed: {
          message?: { content?: string };
          error?: string;
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
          load_duration?: number;
          prompt_eval_duration?: number;
          eval_duration?: number;
          total_duration?: number;
          size_vram?: number;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // malformed/partial line — skip rather than crash the whole task on one bad chunk
        }

        if (parsed.error) {
          throw new Error(parsed.error);
        }
        const text = parsed.message?.content;
        if (text) {
          onText(text);
          sawText = true;
        }
        // Ollama's final NDJSON line (done:true) carries real token counts
        // for this local generation -- no context-window lookup applies
        // here though (see contextWindowFor's doc comment: a local model's
        // window depends on the user's own Modelfile/quantization, which
        // this gateway has no way to know), so the UI shows raw counts for
        // Ollama tasks without a percentage.
        if (
          parsed.done &&
          onUsage &&
          typeof parsed.prompt_eval_count === "number" &&
          typeof parsed.eval_count === "number"
        ) {
          onUsage(
            { promptTokens: parsed.prompt_eval_count, completionTokens: parsed.eval_count },
            {
              prompt_eval_count: parsed.prompt_eval_count,
              eval_count: parsed.eval_count,
              load_duration: parsed.load_duration,
              prompt_eval_duration: parsed.prompt_eval_duration,
              eval_duration: parsed.eval_duration,
              total_duration: parsed.total_duration,
              ...(typeof parsed.size_vram === "number" ? { size_vram: parsed.size_vram } : {}),
            },
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sawText;
}
