import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITS_MARKER, parseBuildResponse, parseReview, anthropicRunner } from "../src/runners/anthropicRunner.js";
import type { RunnerInput } from "../src/runners/types.js";
import type { TaskEvent } from "@mobiusx/protocol";

// Keep the mocked Anthropic request counts deterministic even if the host's
// real MobiusX settings opt into automatic memory extraction.
process.env.MOBIUSX_DISABLE_MEMORY_EXTRACTION = "1";

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

function baseInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return { taskId: "t1", mode: "build", prompt: "test prompt", ...overrides };
}

test("parses prose + a valid create edit with no relevantFiles shown at all", () => {
  const text = [
    "I'll add a new helper file.",
    EDITS_MARKER,
    '```json',
    '{"edits": [{"path": "src/helper.ts", "action": "create", "content": "export const x = 1;\\n"}]}',
    '```',
  ].join("\n");
  const { prose, edits, droppedCount } = parseBuildResponse(text, baseInput());
  assert.equal(prose, "I'll add a new helper file.");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].action, "create");
  assert.equal(edits[0].path, "src/helper.ts");
  assert.equal(droppedCount, 0);
});

test("allows modify only for a path the model was shown in full", () => {
  const input = baseInput({
    projectContext: {
      relevantFiles: [
        { relPath: "src/a.ts", snippet: "...", content: "export const a = 1;\n" },
        { relPath: "src/b.ts", snippet: "..." }, // snippet-only, no full content
      ],
    },
  });
  const text = [
    "Updating both files.",
    EDITS_MARKER,
    "```json",
    JSON.stringify({
      edits: [
        { path: "src/a.ts", action: "modify", content: "export const a = 2;\n" },
        { path: "src/b.ts", action: "modify", content: "export const b = 2;\n" },
      ],
    }),
    "```",
  ].join("\n");
  const { edits, droppedCount } = parseBuildResponse(text, input);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, "src/a.ts");
  assert.equal(droppedCount, 1); // src/b.ts modify was dropped — not shown in full
});

test("drops an edit whose path tries to escape the project", () => {
  const text = [
    "ok",
    EDITS_MARKER,
    "```json",
    JSON.stringify({ edits: [{ path: "../../etc/passwd", action: "create", content: "x" }] }),
    "```",
  ].join("\n");
  const { edits, droppedCount } = parseBuildResponse(text, baseInput());
  assert.equal(edits.length, 0);
  assert.equal(droppedCount, 1);
});

test("no marker present: whole text becomes prose, no edits, nothing dropped", () => {
  const text = "Here's my analysis of the bug, no code change needed.";
  const { prose, edits, droppedCount } = parseBuildResponse(text, baseInput());
  assert.equal(prose, text);
  assert.equal(edits.length, 0);
  assert.equal(droppedCount, 0);
});

test("malformed JSON after the marker falls back to prose-only, no crash", () => {
  const text = ["Some prose.", EDITS_MARKER, "```json", "{not valid json", "```"].join("\n");
  const { prose, edits, droppedCount } = parseBuildResponse(text, baseInput());
  assert.equal(prose, "Some prose.");
  assert.equal(edits.length, 0);
  assert.equal(droppedCount, 0);
});

test("an edit missing required fields is dropped, valid ones still returned", () => {
  const text = [
    "prose",
    EDITS_MARKER,
    "```json",
    JSON.stringify({
      edits: [
        { path: "x.ts", action: "create", content: "ok" },
        { path: "y.ts", action: "create" }, // missing content
        { action: "create", content: "z" }, // missing path
        { path: "z.ts", action: "delete", content: "nope" }, // invalid action
      ],
    }),
    "```",
  ].join("\n");
  const { edits, droppedCount } = parseBuildResponse(text, baseInput());
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, "x.ts");
  assert.equal(droppedCount, 3);
});


test("parseReview accepts a well-formed verdict JSON, fenced or not", () => {
  const fenced = '```json\n{"verdict": "approve", "summary": "Looks correct."}\n```';
  assert.deepEqual(parseReview(fenced), { verdict: "approve", summary: "Looks correct." });

  const bare = '{"verdict": "concerns", "summary": "Missing input validation."}';
  assert.deepEqual(parseReview(bare), { verdict: "concerns", summary: "Missing input validation." });
});

test("parseReview defaults to concerns (never approve) on malformed input, rather than crashing", () => {
  const review = parseReview("not json at all");
  assert.equal(review.verdict, "concerns");
  assert.match(review.summary, /could not be parsed/);
});

test("parseReview defaults to concerns when the verdict field is missing or invalid", () => {
  assert.equal(parseReview('{"summary": "no verdict field"}').verdict, "concerns");
  assert.equal(parseReview('{"verdict": "maybe", "summary": "invalid enum value"}').verdict, "concerns");
});

test("build mode requests the structured-edit output budget while chat modes remain smaller", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
  let capturedBody: { max_tokens?: number } = {};
  t.mock.method(globalThis, "fetch", async (_url: string, opts: { body?: string }) => {
    capturedBody = JSON.parse((opts?.body as string) ?? "{}");
    return new Response(
      sseStream([sseDataLine({ choices: [{ delta: { content: "" } }] }), "data: [DONE]\n\n", sseDataLine({ type: "message_stop" })]),
      { status: 200 },
    );
  });
  const events: TaskEvent[] = [];
  await anthropicRunner.run({ taskId: "t1", mode: "build", prompt: "build me an app" }, (e) => events.push(e));
  assert.equal(capturedBody.max_tokens, 64000);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

test("ask mode keeps the smaller, cheaper chat budget, not the build-mode one", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
  let capturedBody: { max_tokens?: number } = {};
  t.mock.method(globalThis, "fetch", async (_url: string, opts: { body?: string }) => {
    capturedBody = JSON.parse((opts?.body as string) ?? "{}");
    return new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 });
  });
  const events: TaskEvent[] = [];
  await anthropicRunner.run({ taskId: "t1", mode: "ask", prompt: "what does this file do?" }, (e) => events.push(e));
  assert.equal(capturedBody.max_tokens, 4096);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

// Real Anthropic Messages-API SSE event shape (content_block_delta /
// text_delta), matching what streamSse() in anthropicRunner.ts actually
// parses -- unlike the OpenAI-shaped `choices[].delta.content` lines the
// max_tokens test above uses (fine there since that test never reads the
// streamed text, only the request body).
function anthropicTextChunk(text: string): string {
  return sseDataLine({ type: "content_block_delta", delta: { type: "text_delta", text } });
}

// End-to-end regression test for the live bug this session found and
// fixed: a build-mode response whose JSON never finishes parsing (the
// classic max_tokens-mid-JSON cutoff) used to be silently discarded with
// zero edits and zero explanation. This proves the full fix, not just
// parseBuildResponse's flag -- first fetch call returns exactly that
// truncated shape, the runner must notice (parseFailed), retry with a
// second real fetch call, and this time produce real edits with no
// failure message in the output.
test("anthropicRunner retries once and recovers real edits when the first response's JSON is truncated mid-stream", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount++;
    if (callCount === 1) {
      // Marker present, JSON opens and then just stops -- no closing
      // fence/brace, exactly what hitting max_tokens mid-response produces.
      const truncated = [
        "I'll build the full gardening site now.",
        EDITS_MARKER,
        "```json",
        '{"edits": [{"path": "frontend/src/app/page.tsx", "action": "create", "content": "export default function Home() {\\n  return <div>Welcome to the gard',
      ].join("\n");
      return new Response(sseStream([anthropicTextChunk(truncated), "data: [DONE]\n\n"]), { status: 200 });
    }
    // The retry: a complete, well-formed response.
    const complete = [
      "Here's the complete site.",
      EDITS_MARKER,
      "```json",
      '{"edits": [{"path": "frontend/src/app/page.tsx", "action": "create", "content": "export default function Home() { return <div>Welcome</div>; }\\n"}]}',
      "```",
    ].join("\n");
    return new Response(sseStream([anthropicTextChunk(complete), "data: [DONE]\n\n"]), { status: 200 });
  });
  const events: TaskEvent[] = [];
  await anthropicRunner.run({ taskId: "t1", mode: "build", prompt: "build me a gardening site" }, (e) => events.push(e));

  // 3 calls: the original attempt, the retry, and the normal second-pass
  // Reviewer persona call. Keep optional automatic memory disabled in test
  // settings so a user's local preference cannot change this call count.
  assert.equal(callCount, 3, "expected the retry call plus the normal post-edits reviewer call");
  const editsEvent = events.find((e) => e.type === "edits") as { type: "edits"; edits: { path: string }[] } | undefined;
  assert.ok(editsEvent, "expected a real edits event after the retry recovered");
  assert.equal(editsEvent!.edits.length, 1);
  assert.equal(editsEvent!.edits[0].path, "frontend/src/app/page.tsx");
  const outputText = events
    .filter((e): e is { type: "output"; delta: string } => e.type === "output")
    .map((e) => e.delta)
    .join("");
  assert.doesNotMatch(outputText, /didn't parse/, "a successful retry must not still report a parse failure");

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});

test("anthropicRunner reports an honest parse-failure message (not silence) when even the retry's JSON fails to parse", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
  const truncated = [
    "Building now.",
    EDITS_MARKER,
    "```json",
    '{"edits": [{"path": "a.ts", "action": "create", "content": "const a = 1',
  ].join("\n");
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    callCount++;
    return new Response(sseStream([anthropicTextChunk(truncated), "data: [DONE]\n\n"]), { status: 200 });
  });
  const events: TaskEvent[] = [];
  await anthropicRunner.run({ taskId: "t1", mode: "build", prompt: "build me an app" }, (e) => events.push(e));

  assert.equal(callCount, 2, "expected one retry attempt even though it also failed");
  const editsEvent = events.find((e) => e.type === "edits");
  assert.equal(editsEvent, undefined, "no edits should be emitted when both attempts fail to parse");
  const outputText = events
    .filter((e): e is { type: "output"; delta: string } => e.type === "output")
    .map((e) => e.delta)
    .join("");
  assert.match(outputText, /didn't parse/, "a genuinely unrecoverable parse failure must be reported, never silent");
  assert.match(outputText, /even after asking again/, "should acknowledge the retry was attempted");

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
});
