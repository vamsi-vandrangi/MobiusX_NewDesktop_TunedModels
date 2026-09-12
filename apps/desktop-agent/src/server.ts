import express, { type Express } from "express";
import { createServer, type Server } from "node:http";
import type { HealthResponse } from "@mobiusx/protocol";
import { makeAuthMiddleware } from "./auth.js";
import { buildRouter } from "./routes.js";
import { attachTerminalServer } from "./terminalWs.js";
import { projectState } from "./state.js";

const VERSION = "0.0.1";

export function createAgentServer(token: string): { app: Express; server: Server } {
  const app = express();
  app.use(express.json());

  // Loopback-only local service — permissive CORS is fine, the bearer token is the real gate.
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

  // Intentionally unauthenticated: lets the shell poll readiness the instant
  // the process is up, without waiting on anything else.
  app.get("/health", (_req, res) => {
    const body: HealthResponse = { status: "ok", version: VERSION, activeProject: projectState.path };
    res.json(body);
  });

  app.use(makeAuthMiddleware(token), buildRouter());

  const server = createServer(app);
  attachTerminalServer(server, token);

  return { app, server };
}
