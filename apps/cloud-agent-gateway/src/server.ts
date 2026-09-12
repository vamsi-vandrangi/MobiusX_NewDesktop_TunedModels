import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { HealthResponse } from "@mobiusx/protocol";
import { isAnthropicConfigured } from "./runners/anthropicRunner.js";
import { makeAuthMiddleware, isTokenValid } from "./auth.js";
import { buildRouter } from "./routes.js";
import { getTask } from "./store.js";
import { subscribe } from "./wsHub.js";

const VERSION = "0.0.1";

export function createGatewayServer(token: string): { app: Express; server: Server } {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/health", (_req, res) => {
    const body: HealthResponse & { runner: string } = {
      status: "ok",
      version: VERSION,
      activeProject: null,
      runner: isAnthropicConfigured() ? "anthropic" : "demo",
    };
    res.json(body);
  });

  app.use(makeAuthMiddleware(token), buildRouter());

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url || !req.url.startsWith("/tasks/")) return;
    const match = req.url.match(/^\/tasks\/([^/]+)\/stream/);
    if (!match) return;
    const url = new URL(req.url, "http://localhost");
    const provided = url.searchParams.get("token");
    if (!isTokenValid(token, provided)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const taskId = match[1];
      subscribe(taskId, ws);
      // Replay current state immediately so a client connecting after the
      // task already made progress isn't stuck showing nothing.
      void getTask(taskId).then((task) => {
        if (task && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "status", status: task.status }));
          for (const step of task.steps) ws.send(JSON.stringify({ type: "step", step }));
          if (task.output) ws.send(JSON.stringify({ type: "output", delta: task.output }));
          if (task.status === "completed" || task.status === "failed") ws.send(JSON.stringify({ type: "done" }));
        }
      });
    });
  });

  return { app, server };
}
