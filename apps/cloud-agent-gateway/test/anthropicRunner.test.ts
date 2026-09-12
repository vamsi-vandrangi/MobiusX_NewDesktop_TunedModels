import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITS_MARKER, parseBuildResponse } from "../src/runners/anthropicRunner.js";
import type { RunnerInput } from "../src/runners/types.js";

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
