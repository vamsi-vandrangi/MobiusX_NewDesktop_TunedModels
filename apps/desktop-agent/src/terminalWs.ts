import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { appendAuditEntry } from "@mobiusx/audit-log";
import type { PolicyMatch, TerminalClientMessage, TerminalServerMessage } from "@mobiusx/protocol";
import { isTokenValid } from "./auth.js";
import { projectState } from "./state.js";
import { LineTracker } from "./lineTracker.js";
import { BUILTIN_POLICY, evaluateLine, loadProjectPolicy } from "./policy.js";
import { getSettings } from "./settings.js";
import { loadProjectHooks, runHooksForEvent } from "./hooks.js";

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
 * and (in the default "off" AgentSettings.terminalApprovalMode) followed
 * by a best-effort Ctrl+C. See policy.ts's doc comment for why this is
 * advisory, not a hard security boundary — that's an intrinsic consequence
 * of forwarding a real PTY's keystrokes live, not a shortcut taken here.
 *
 * Approval Engine: when terminalApprovalMode is "guarded", a flagged line
 * is caught BEFORE it reaches the shell instead of after. The chunk that
 * completes the line (in practice almost always just the Enter keystroke,
 * since everything typed before it was already forwarded live and is
 * already visible on screen) is held in a per-connection pendingApproval
 * slot rather than written to the pty, and a requiresApproval:true policy
 * message is sent instead. The client resolves it with an explicit
 * "approve" (the held chunk is written through) or "reject" (discarded,
 * and Ctrl+U clears the shell's line buffer, which holds exactly the
 * flagged text since its terminator was never sent). Further "input"
 * messages are ignored while a decision is outstanding, so a held command
 * can't be silently raced by more keystrokes. This inherits the same
 * "advisory, not a hard boundary" caveat as the reactive mode: a single
 * chunk that both types text and completes a flagged line in one write
 * (e.g. a multi-line paste) is held as a whole rather than split.
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
    const settings = await getSettings();
    const guarded = settings.terminalApprovalMode === "guarded";
    let pendingApproval: { chunk: string; line: string; matches: PolicyMatch[] } | null = null;

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
    const { rules: hookRules } = await loadProjectHooks(projectState.path);
    const hasBeforeCommitHooks = hookRules.some((r) => r.event === "before-commit");
    const commitLinePattern = /^\s*git\s+commit\b/;

    ptyProcess.onData((data) => send(ws, { type: "output", data }));
    ptyProcess.onExit(({ exitCode, signal }) => {
      send(ws, { type: "exit", code: exitCode, signal });
    });

    /**
     * Event-driven hooks (roadmap Phase 16, source requirement §25):
     * "before-commit" trigger. Necessarily reactive, same honesty caveat
     * policy.ts's own doc comment already establishes for this real PTY —
     * the line has already been forwarded to the shell by the time this
     * runs (see both call sites below), so this can only catch a
     * still-running/slow-starting `git commit` with a best-effort Ctrl+C,
     * never truly prevent one that completes instantly. Fires for BOTH
     * terminalApprovalMode values identically — hooks are a quality gate,
     * not the destructive-command safety policy.ts's guarded hold exists
     * for, so it deliberately isn't entangled with pendingApproval.
     */
    async function checkBeforeCommitHook(line: string): Promise<void> {
      if (!hasBeforeCommitHooks || !projectState.path || !commitLinePattern.test(line)) return;
      const results = await runHooksForEvent(projectState.path, "before-commit");
      if (results.length === 0) return;
      const blocked = results.some((r) => r.status === "failed");
      send(ws, { type: "hook", event: "before-commit", results, blocked });
      if (blocked) {
        // Best-effort interrupt, same mechanism as a flagged policy line.
        ptyProcess.write("\x03");
      }
    }

    ws.on("message", (raw) => {
      let msg: TerminalClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.type === "input") {
        if (pendingApproval) {
          // A decision is outstanding — ignore further keystrokes rather than
          // let new input interleave with a held, possibly-dangerous command.
          return;
        }

        if (guarded) {
          const completed = tracker.feed(msg.data);
          let flagged: { line: string; matches: PolicyMatch[] } | undefined;
          for (const line of completed) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const matches = evaluateLine(trimmed, policyRules);
            if (matches.length > 0) {
              flagged = { line: trimmed, matches };
              break;
            }
          }

          if (flagged) {
            pendingApproval = { chunk: msg.data, line: flagged.line, matches: flagged.matches };
            send(ws, { type: "policy", matches: flagged.matches, requiresApproval: true });
            void appendAuditEntry({
              source: "desktop-agent",
              category: "terminal-command-guard",
              severity: "warning",
              summary: `Command guard held for approval (${flagged.matches.map((m) => m.ruleId).join(", ")}): ${flagged.line}`,
              detail: { command: flagged.line, matches: flagged.matches, cwd, mode: "guarded" },
            });
            // Deliberately NOT written to the pty — this is the gate.
            return;
          }

          ptyProcess.write(msg.data);
          for (const line of completed) {
            const trimmed = line.trim();
            if (trimmed) void checkBeforeCommitHook(trimmed);
          }
          return;
        }

        // terminalApprovalMode "off" (default): unchanged from Phase 5 —
        // forward immediately, unconditionally, then react to any flagged
        // completed line with a best-effort Ctrl+C after the fact.
        ptyProcess.write(msg.data);

        for (const line of tracker.feed(msg.data)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          void checkBeforeCommitHook(trimmed);

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
      } else if (msg.type === "approve") {
        if (pendingApproval) {
          const { chunk, line, matches } = pendingApproval;
          pendingApproval = null;
          ptyProcess.write(chunk);
          void appendAuditEntry({
            source: "desktop-agent",
            category: "terminal-command-guard",
            severity: "info",
            summary: `Command guard hold approved by user: ${line}`,
            detail: { command: line, matches, cwd, decision: "approve" },
          });
        }
      } else if (msg.type === "reject") {
        if (pendingApproval) {
          const { line, matches } = pendingApproval;
          pendingApproval = null;
          // Ctrl+U clears the shell's current line buffer, which holds
          // exactly the flagged text since its terminating keystroke was
          // withheld rather than forwarded.
          ptyProcess.write("\x15");
          void appendAuditEntry({
            source: "desktop-agent",
            category: "terminal-command-guard",
            severity: "info",
            summary: `Command guard hold rejected by user: ${line}`,
            detail: { command: line, matches, cwd, decision: "reject" },
          });
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
