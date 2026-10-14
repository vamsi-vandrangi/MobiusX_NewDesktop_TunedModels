import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync } from "node:fs";
import { delimiter as pathDelimiter } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";
import { appendAuditEntry } from "@mobiusx/audit-log";
import type { PolicyMatch, TerminalClientMessage, TerminalServerMessage } from "@mobiusx/protocol";
import { isTokenValid } from "./auth.js";
import { projectState, type RemoteMeta } from "./state.js";
import { LineTracker } from "./lineTracker.js";
import { BUILTIN_POLICY, evaluateLine, loadProjectPolicy } from "./policy.js";
import { getSettings } from "./settings.js";
import { loadProjectHooks, runHooksForEvent } from "./hooks.js";
import { getActiveAuthMeta } from "./remoteConnection.js";

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
 *
 * Phase D ("Connect via SSH"): when projectState.isRemote is true, this
 * spawns the system `ssh` binary instead of a local shell (see
 * buildSshArgs below) -- still a real node-pty PTY underneath, so
 * everything above (full-screen programs, the command guard, hooks) keeps
 * working completely unmodified; only WHAT gets spawned changes. A
 * password-auth connection with no saved secret simply shows `ssh`'s own
 * password prompt as normal terminal output, exactly like typing `ssh
 * user@host` in a real terminal -- no special-casing needed, because this
 * already is a real interactive PTY talking to a real process.
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
    // Used below for the pty.spawn cwd on a LOCAL terminal, and throughout
    // this function for policy/audit-log context either way -- for a
    // remote (Phase D) terminal this is the remote path, which is the
    // right thing to show in a log line even though the `ssh` process
    // itself spawns with the local process's own cwd (see the remote
    // branch below).
    const cwd = projectState.path ?? process.cwd();
    const settings = await getSettings();
    const guarded = settings.terminalApprovalMode === "guarded";
    let pendingApproval: { chunk: string; line: string; matches: PolicyMatch[] } | null = null;

    let ptyProcess: pty.IPty;
    try {
      if (projectState.isRemote && projectState.remote) {
        const sshArgs = buildSshArgs(projectState.remote, projectState.path ?? undefined);
        ptyProcess = pty.spawn(resolveSshBinary(), sshArgs, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: process.cwd(), // irrelevant to the REMOTE shell's directory -- that's handled by the `cd ...` baked into sshArgs below
          env: withAugmentedPath(process.env),
        });
      } else {
        const shell = defaultShell();
        ptyProcess = pty.spawn(shell.command, shell.args, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd,
          env: withAugmentedPath(process.env),
        });
      }
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

/**
 * Hardening for a packaged macOS app launched via Finder (double-click), as
 * opposed to from a Terminal shell: it inherits a minimal launchd-provided
 * environment whose PATH can omit /usr/bin, which would make a bare "ssh"
 * fail PATH-based lookup. This was the FIRST (incorrect) diagnosis of a
 * real Phase D "posix_spawnp failed." bug — the actual cause turned out to
 * be node-pty's native spawn-helper binary shipping without its executable
 * bit after this project's packaging install (see apps/desktop-agent/
 * scripts/fix-node-pty-perms.js for the full story and the real fix), which
 * breaks the LOCAL shell branch below exactly as much as this remote one —
 * a pure PATH problem would have no reason to affect both. Proven wrong by
 * SFTP (pure JS, no native exec) working fine the entire time this was
 * broken, and confirmed directly by checking the shipped file's mode bits.
 * Kept anyway as cheap, genuinely-harmless defense in depth against an
 * actually-impoverished PATH, which remains a real (if no longer the only)
 * possible failure mode for a Finder-launched app.
 */
function resolveSshBinary(): string {
  const candidates = ["/usr/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "ssh"; // last resort: hope PATH resolution works after all
}

/**
 * Defensive belt-and-suspenders alongside resolveSshBinary(): ensures the
 * standard system binary directories are always present in the env handed
 * to pty.spawn, for both the local-shell and remote-ssh branches, so any
 * OTHER bare command this file (or a future change to it) ever spawns
 * doesn't silently inherit the same impoverished-PATH failure mode.
 */
function withAugmentedPath(env: NodeJS.ProcessEnv): Record<string, string> {
  if (process.platform === "win32") return env as Record<string, string>;
  const required = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"];
  const current = (env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  for (const dir of required) {
    if (!current.includes(dir)) current.push(dir);
  }
  return { ...env, PATH: current.join(pathDelimiter) } as Record<string, string>;
}

/**
 * Builds the system `ssh` binary's argv for a Phase D remote terminal.
 * `-tt` forces real pty allocation on the REMOTE end even though a command
 * is being passed (full-screen programs like vim/htop need this exactly
 * like the local path's own doc comment already explains for the LOCAL
 * pty); the trailing command string lands the session in `remotePath`
 * before handing off to the user's remote login shell interactively, the
 * same "cd into it, then exec the real shell" trick a human would type by
 * hand. Key-auth's identity file path is read from the active remote
 * connection's own metadata (getActiveAuthMeta()), not from
 * projectState.remote -- that struct only ever carries UI-relevant
 * host/port/username/label, never auth details (see state.ts's doc
 * comment), matching the same split projectState.path/snapshot already
 * keeps between "what's open" and "how it was opened".
 */
function buildSshArgs(remote: RemoteMeta, remotePath?: string): string[] {
  const args: string[] = ["-tt"];
  if (remote.port && remote.port !== 22) args.push("-p", String(remote.port));
  const authMeta = getActiveAuthMeta();
  if (authMeta?.authMethod === "key" && authMeta.identityPath) args.push("-i", authMeta.identityPath);
  args.push(`${remote.username}@${remote.host}`);
  if (remotePath) args.push(`cd ${shellQuoteRemote(remotePath)} && exec "$SHELL" -l`);
  return args;
}

function shellQuoteRemote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
