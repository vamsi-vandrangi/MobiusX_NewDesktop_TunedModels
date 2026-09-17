import { Router } from "express";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  HistoryTurn,
  ListModelsResponse,
  ListTasksResponse,
  ModelSelection,
  TranscribeAvailabilityResponse,
  TranscribeRequest,
  TranscribeResponse,
} from "@mobiusx/protocol";
import { getTask, listTasks } from "./store.js";
import { cancelTask, startTask } from "./taskEngine.js";
import { listAllModels } from "./runners/registry.js";
import { transcribeAudio, voiceAvailable, voiceUnavailableReason } from "./voice.js";

export function buildRouter(): Router {
  const router = Router();

  router.post("/tasks", async (req, res) => {
    const body = req.body as Partial<CreateTaskRequest>;
    if (!body.mode || !["ask", "plan", "build", "spec", "fix", "database", "architecture", "testing", "devops"].includes(body.mode)) {
      res.status(400).json({ error: "mode must be one of ask|plan|build|spec|fix|database|architecture|testing|devops" });
      return;
    }
    if (!body.prompt || typeof body.prompt !== "string") {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    // Multi-model support: an optional per-task model override. Loosely
    // validated here (well-formed shape only) — whether it's actually
    // usable right now is resolveRunner's job, and an unusable choice
    // degrades to an honest fallback rather than a request-time error, so
    // a stale/unavailable selection doesn't just break task creation.
    let model: ModelSelection | undefined;
    if (body.model !== undefined) {
      const m = body.model as { provider?: unknown; model?: unknown };
      if (typeof m.provider !== "string" || typeof m.model !== "string" || !m.model) {
        res.status(400).json({ error: "model, if provided, must be {provider: string, model: string}" });
        return;
      }
      model = { provider: m.provider as ModelSelection["provider"], model: m.model };
    }
    // History-carrying follow-ups (PRD gap: "history isn't maintained" — a
    // task is otherwise a fresh, contextless request every time). Loosely
    // validated shape-wise, same spirit as `model` above; capped here too,
    // defensively, even though the client (renderer.js) already caps what
    // it sends — see promptShared.ts#historyMessages for the second,
    // per-runner cap that actually bounds what reaches a model.
    let history: HistoryTurn[] | undefined;
    if (body.history !== undefined) {
      if (!Array.isArray(body.history)) {
        res.status(400).json({ error: "history, if provided, must be an array" });
        return;
      }
      const cleaned: HistoryTurn[] = [];
      for (const raw of body.history as unknown[]) {
        const h = raw as { role?: unknown; content?: unknown };
        if ((h.role !== "user" && h.role !== "assistant") || typeof h.content !== "string") {
          res.status(400).json({ error: 'each history entry must be {role: "user"|"assistant", content: string}' });
          return;
        }
        cleaned.push({ role: h.role, content: h.content });
      }
      const MAX_HISTORY_TURNS = 20;
      history = cleaned.slice(-MAX_HISTORY_TURNS);
    }
    const task = await startTask({ mode: body.mode, prompt: body.prompt, projectContext: body.projectContext, model, history });
    const response: CreateTaskResponse = { task };
    res.status(201).json(response);
  });

  router.get("/tasks", async (_req, res) => {
    const response: ListTasksResponse = { tasks: await listTasks() };
    res.json(response);
  });

  router.get("/tasks/:id", async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(task);
  });

  router.post("/tasks/:id/cancel", async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    if (task.status !== "queued" && task.status !== "running") {
      res.status(409).json({ error: `task is already ${task.status}, nothing to cancel` });
      return;
    }
    const cancelled = cancelTask(req.params.id);
    if (!cancelled) {
      // Finished between the getTask() check above and here — inherently racy, and fine to report as a no-op.
      res.status(409).json({ error: "task is no longer running" });
      return;
    }
    res.status(202).json({ ok: true });
  });

  // Multi-model support: the full model catalog (every provider this
  // gateway knows about, including ones not currently usable — see
  // ModelOption's doc comment) for the desktop shell's Settings default and
  // per-task pickers.
  router.get("/models", async (_req, res) => {
    const response: ListModelsResponse = { models: await listAllModels() };
    res.json(response);
  });

  // Voice input (AI Assistant add-on): lets the renderer show/enable its
  // mic button only when a transcription call will actually succeed,
  // rather than the user discovering GROQ_API_KEY is unset only after
  // recording something -- same honest-availability pattern GET /models
  // already uses for each ModelOption.
  router.get("/transcribe/status", (_req, res) => {
    const available = voiceAvailable();
    const response: TranscribeAvailabilityResponse = available ? { available } : { available, reason: voiceUnavailableReason() };
    res.json(response);
  });

  router.post("/transcribe", async (req, res) => {
    const body = req.body as Partial<TranscribeRequest>;
    if (!body.audio || typeof body.audio !== "string") {
      res.status(400).json({ error: "audio (base64 string) is required" });
      return;
    }
    if (!body.mimeType || typeof body.mimeType !== "string") {
      res.status(400).json({ error: "mimeType is required" });
      return;
    }
    try {
      const response: TranscribeResponse = await transcribeAudio(body.audio, body.mimeType);
      res.json(response);
    } catch (err) {
      const message = (err as Error).message;
      // requires GROQ_API_KEY -> the feature just isn't configured (503,
      // "unavailable"); anything else is a real upstream/transport failure
      // (502, "bad gateway") -- distinguished so the renderer can show a
      // "set up voice input" message instead of a generic error for the
      // former.
      const status = message.startsWith("requires GROQ_API_KEY") ? 503 : 502;
      res.status(status).json({ error: message });
    }
  });

  return router;
}
