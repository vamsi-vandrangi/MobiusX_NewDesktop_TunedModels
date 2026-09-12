import { test } from "node:test";
import assert from "node:assert/strict";
import type { HealthResponse, TerminalClientMessage } from "../src/index.js";

test("HealthResponse shape is usable as a plain object literal", () => {
  const h: HealthResponse = { status: "ok", version: "0.0.1", activeProject: null };
  assert.equal(h.status, "ok");
});

test("TerminalClientMessage discriminates on type", () => {
  const msg: TerminalClientMessage = { type: "input", data: "echo hi\n" };
  assert.equal(msg.type, "input");
  if (msg.type === "input") {
    assert.equal(msg.data, "echo hi\n");
  }

  const resize: TerminalClientMessage = { type: "resize", cols: 80, rows: 24 };
  assert.equal(resize.type, "resize");
  if (resize.type === "resize") {
    assert.equal(resize.cols, 80);
    assert.equal(resize.rows, 24);
  }
});
