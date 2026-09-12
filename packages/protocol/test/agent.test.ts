import { test } from "node:test";
import assert from "node:assert/strict";
import type { HealthResponse, TerminalClientMessage } from "../src/index.js";

test("HealthResponse shape is usable as a plain object literal", () => {
  const h: HealthResponse = { status: "ok", version: "0.0.1", activeProject: null };
  assert.equal(h.status, "ok");
});

test("TerminalClientMessage discriminates on type", () => {
  const msg: TerminalClientMessage = { type: "exec", id: "1", command: "echo hi" };
  assert.equal(msg.type, "exec");
  if (msg.type === "exec") {
    assert.equal(msg.command, "echo hi");
  }
});
