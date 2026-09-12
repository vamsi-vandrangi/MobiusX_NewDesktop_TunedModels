import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { appendAuditEntry } from "@mobiusx/audit-log";
import type { TerminalClientMessage, TerminalServerMessage } from "@mobiusx/protocol";
import { isTokenValid } from "./auth.js";
import { projectState } from "./state.js";
import { LineTracker } from "./lineTracker.js";
import { BUILTIN_POLICY, evaluateLine, loadProjectPolicy } from "./policy.js";

/**
 * Real interactive PTY (node-pty), replacing Phase 1's command-exec
 * terminal. One PTY process per WebSocket connection, raw bytes flowing
 * both ways: keystrokes (including control characters — Ctrl+C, arrow-key
 * history, tab completion) go straight into the shell's stdin, and
 * whatever the shell writes back — its own prompt, ANSI colors, cursor
 * movement — goes straight back out. Full-screen programs (vim, htop, a
 * REPL) work correctly because this *is* a real terminal session, not a
 * simulated one; the desktop shell's xterm.js instance (renderer.js) is
 * what actually interprets the ANSI output.
 *
 * node-pty ships a native binary that must be compiled/fetched for the
 * machine running it — see the root README's "Known gotcha" section (the
 * same cross-platform-binary caveat already documented there for
 * Electron): a `node_modules/node-pty` built inside this bridge's Linux
 * environment will not run on the user's actual desktop OS.
 *
 * Phase 5 adds a best-effort command guard on top: every submitted line
 * is checked against BUILTIN_POLICY (+ any project .mobiusx/policy.json)
 * and, on a match, flagged to the client, logged to the shared audit log,
 * and followed by a best-effort Ctrl+C. See policy.ts's doc comment for
 * why this is advisory, not a hard security boundary — that's an
 * intrinsic consequence of forwarding a real PTY's keystrokes live, not a
 * shortcut taken here.
 */
export function attachTerminalServer(server: import("node:http").Server, token: string): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url || !req.url.startsWith("/terminal")) return;
    const url = new URL(req.url, "http://localhost");
    const provided = url.searchParams.get("token");
    if (!isTokenValid(token, provided)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws: WebSocket) => {
    const shell = defaultShell();
    const cwd = projectState.path ?? process.cwd();

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell.command, shell.args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      send(ws, { type: "error", message: `Failed to start terminal: ${(err as Error).message}` });
      ws.close();
      return;
    }

    const tracker = new LineTracker();
    // Loaded once per connection (a project opened after the terminal connects
    // won't retroactively apply — matches how cwd is also fixed at spawn time).
    const { rules: projectRules } = await loadProjectPolicy(projectState.path);
    const policyRules = [...BUILTIN_POLICY, ...projectRules];

    ptyProcess.onData((data) => send(ws, { type: "output", data }));
    ptyProcess.onExit(({ exitCode, signal }) => {
      send(ws, { type: "exit", code: exitCode, signal });
    });

    ws.on("message", (raw) => {
      let msg: TerminalClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.type === "input") {
        // Forward immediately, unconditionally — this is what preserves full
        // interactivity (arrow-key history, tab completion, Ctrl+C all working
        // exactly like a native terminal). The guard below is a reaction to
        // what was just sent, never a gate in front of it.
        ptyProcess.write(msg.data);

        for (const line of tracker.feed(msg.data)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const matches = evaluateLine(trimmed, policyRules);
          if (matches.length === 0) continue;

          send(ws, { type: "policy", matches });
          void appendAuditEntry({
            source: "desktop-agent",
            category: "terminal-command-guard",
            severity: "warning",
            summary: `Command guard flagged (${matches.map((m) => m.ruleId).join(", ")}): ${trimmed}`,
            detail: { command: trimmed, matches, cwd },
          });
          // Best-effort interrupt. Too late for something that completes
          // instantly; can still stop a long-running or slow-starting one.
          ptyProcess.write("\x03");
        }
      } else if (msg.type === "resize") {
        // Guard against a stale/garbage size crashing the underlying PTY ioctl.
        if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols > 0 && msg.rows > 0 && msg.cols < 1000 && msg.rows < 1000) {
          ptyProcess.resize(msg.cols, msg.rows);
        }
      }
    });

    ws.on("close", () => {
      ptyProcess.kill();
    });
  });
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: process.env.COMSPEC ?? "powershell.exe", args: [] };
  }
  // Login shell (-l) so the user's usual profile (PATH, nvm/rbenv, aliases,
  // etc.) loads, matching what opening a real terminal app would do.
  return { command: process.env.SHELL ?? "/bin/bash", args: ["-l"] };
}

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
