import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { TerminalClientMessage, TerminalServerMessage } from "@mobiusx/protocol";
import { isTokenValid } from "./auth.js";
import { projectState } from "./state.js";

/**
 * v0 terminal: request/response command execution, not a full interactive PTY.
 * A real PTY (node-pty) needs native compilation (node-gyp + platform build
 * tools) which this Phase 1 slice deliberately avoids — same tradeoff noted
 * for the VS Code fork's native build step in the mobiusx-ide project.
 * Tracked as a follow-up, not a silent limitation.
 */
export function attachTerminalServer(server: import("node:http").Server, token: string): void {
  const wss = new WebSocketServer({ noServer: true });
  const running = new Map<string, ChildProcessWithoutNullStreams>();

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

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      let msg: TerminalClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.type === "cancel") {
        const child = running.get(msg.id);
        child?.kill();
        return;
      }

      if (msg.type === "exec") {
        const cwd = msg.cwd ?? projectState.path ?? process.cwd();
        const child = spawn("bash", ["-lc", msg.command], { cwd });
        running.set(msg.id, child);

        child.stdout.on("data", (d) => {
          send(ws, { type: "stdout", id: msg.id, chunk: d.toString("utf8") });
        });
        child.stderr.on("data", (d) => {
          send(ws, { type: "stderr", id: msg.id, chunk: d.toString("utf8") });
        });
        child.on("error", (err) => {
          send(ws, { type: "error", id: msg.id, message: err.message });
          running.delete(msg.id);
        });
        child.on("close", (code) => {
          send(ws, { type: "exit", id: msg.id, code });
          running.delete(msg.id);
        });
      }
    });

    ws.on("close", () => {
      for (const child of running.values()) child.kill();
      running.clear();
    });
  });
}

function send(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
