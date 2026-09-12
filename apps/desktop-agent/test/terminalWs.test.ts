import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// terminalWs.ts imports the real "node-pty" native module, which ships
// prebuilt binaries only for darwin/win32 (see the root README's
// cross-platform-binary gotcha) — it can't load on a machine with no
// matching prebuild. This test drives the real WebSocket protocol
// end-to-end (hold/approve/reject/off-mode) against the real terminalWs.ts
// and settings.ts code, with only the PTY spawn itself swapped for an
// in-memory fake that echoes back whatever it's written to — the same
// fake-module-swap technique used for this feature's manual smoke tests
// during development, automated here instead of run by hand. Nothing in
// terminalWs.ts itself is touched or mocked.

const settingsDir = await mkdtemp(join(tmpdir(), "mobiusx-settings-"));
process.env.MOBIUSX_SETTINGS_DIR = settingsDir;

const { createAgentServer } = await import("../src/server.js");
const { updateSettings } = await import("../src/settings.js");

const TIMEOUT_MS = 4000;

async function startServer(): Promise<{ port: number; token: string; close: () => Promise<void> }> {
  const token = "test-token";
  const { server } = createAgentServer(token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function connect(port: number, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/terminal?token=${token}`);
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

/**
 * attachTerminalServer's "connection" handler does a couple of awaited
 * filesystem reads (getSettings, loadProjectPolicy) before it attaches its
 * "message" listener. The WS handshake itself completes before those
 * finish, so a client that sends input immediately on "open" can race
 * ahead of the listener and have its first message silently dropped -- a
 * pre-existing property of the real server, not something introduced by
 * this test. A real xterm.js client never sends this fast in practice;
 * this helper just gives the server's setup time to finish before the
 * test starts sending, the same way a live terminal naturally would.
 */
function settleAfterOpen(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

/**
 * A single "off"/"guarded" input can make the server emit several WS
 * messages back-to-back in one synchronous burst (e.g. an echoed output
 * frame immediately followed by a policy frame). They can arrive at the
 * client in the same underlying socket read and get dispatched by `ws`
 * synchronously, all before any `await`-deferred continuation gets a
 * chance to attach a fresh listener for the next one -- so waiting with a
 * bare `ws.once("message", ...)` re-armed between awaits can silently
 * drop messages. A persistent listener that queues everything it sees,
 * with `next()` draining the queue first, has no such race.
 */
function messageInbox(ws: WebSocket): { next: () => Promise<any> } {
  const queue: any[] = [];
  const waiters: Array<(msg: any) => void> = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    next(): Promise<any> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onMessage);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error("timed out waiting for a message"));
        }, TIMEOUT_MS);
        const onMessage = (msg: any) => {
          clearTimeout(timer);
          resolve(msg);
        };
        waiters.push(onMessage);
      });
    },
  };
}

/** Asserts the server does NOT send anything within a short window. */
function assertNoMessage(ws: WebSocket, withinMs = 300): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), withinMs);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      reject(new Error(`expected no message, got ${raw.toString("utf8")}`));
    });
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

/** Sends each character of `line` as its own "input" message and drains
 * the fake pty's per-character echo from `inbox`, matching how a real
 * terminal client sends one WS message per keystroke. */
async function typeLine(ws: WebSocket, inbox: { next: () => Promise<any> }, line: string): Promise<void> {
  for (const ch of line) {
    send(ws, { type: "input", data: ch });
    const echo = await inbox.next();
    assert.equal(echo.type, "output");
    assert.equal(echo.data, ch);
  }
}

test("guarded mode: a flagged line is held, requiresApproval is signalled, and approve forwards it", async () => {
  await updateSettings({ terminalApprovalMode: "guarded" });
  const srv = await startServer();
  try {
    const ws = connect(srv.port, srv.token);
    await waitForOpen(ws);
    await settleAfterOpen();
    const inbox = messageInbox(ws);

    await typeLine(ws, inbox, "rm -rf /");

    send(ws, { type: "input", data: "\r" });
    const held = await inbox.next();

    assert.equal(held.type, "policy");
    assert.equal(held.requiresApproval, true);
    assert.ok(held.matches.some((m: any) => m.ruleId === "rm-rf-root"), JSON.stringify(held));

    // While a decision is pending, further input is ignored outright -- no
    // message, no crash, and definitely no silent forwarding to the pty.
    send(ws, { type: "input", data: "x" });
    await assertNoMessage(ws);

    send(ws, { type: "approve" });
    const echoed = await inbox.next();
    assert.equal(echoed.type, "output");
    assert.equal(echoed.data, "\r"); // the fake pty echoes back exactly what was written to it

    ws.close();
  } finally {
    await srv.close();
  }
});

test("guarded mode: reject discards the held line and clears it with Ctrl+U instead of forwarding it", async () => {
  await updateSettings({ terminalApprovalMode: "guarded" });
  const srv = await startServer();
  try {
    const ws = connect(srv.port, srv.token);
    await waitForOpen(ws);
    await settleAfterOpen();
    const inbox = messageInbox(ws);

    await typeLine(ws, inbox, "git push --force origin main");

    send(ws, { type: "input", data: "\r" });
    const held = await inbox.next();
    assert.equal(held.requiresApproval, true);

    send(ws, { type: "reject" });
    const echoed = await inbox.next();
    assert.equal(echoed.type, "output");
    // \x15 is Ctrl+U -- the held "\r" itself must never reach the pty.
    assert.equal(echoed.data, "\x15");

    ws.close();
  } finally {
    await srv.close();
  }
});

test("off mode (default): unchanged reactive behavior — the flagged line still reaches the pty, then a Ctrl+C follows", async () => {
  await updateSettings({ terminalApprovalMode: "off" });
  const srv = await startServer();
  try {
    const ws = connect(srv.port, srv.token);
    await waitForOpen(ws);
    await settleAfterOpen();
    const inbox = messageInbox(ws);

    await typeLine(ws, inbox, "rm -rf /");

    // In "off" mode the completing Enter is written through unconditionally
    // FIRST (echoed by the fake pty), THEN reacted to: a "policy" message,
    // followed by a best-effort Ctrl+C (also echoed) -- the pre-existing
    // Phase 5 behavior, deliberately left untouched by this feature.
    send(ws, { type: "input", data: "\r" });

    const enterEcho = await inbox.next();
    assert.equal(enterEcho.type, "output");
    assert.equal(enterEcho.data, "\r");

    const policyMsg = await inbox.next();
    assert.equal(policyMsg.type, "policy");
    assert.equal(policyMsg.requiresApproval, undefined);

    const ctrlC = await inbox.next();
    assert.equal(ctrlC.type, "output");
    assert.equal(ctrlC.data, "\x03");

    ws.close();
  } finally {
    await srv.close();
  }
});
