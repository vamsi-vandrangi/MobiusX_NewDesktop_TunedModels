import { Router } from "express";
import { createHash } from "node:crypto";
import { activeCheckpointArtifacts, buildArtifactOwnershipManifest } from "./artifactOwnership.js";
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  CreateThreadRequest,
  CreateThreadResponse,
  HistoryTurn,
  ListModelsResponse,
  ListTasksResponse,
  ListThreadsResponse,
  ModelSelection,
  RenameThreadRequest,
  ThreadDetailResponse,
  TranscribeAvailabilityResponse,
  TranscribeRequest,
  TranscribeResponse,
} from "@mobiusx/protocol";
import { createThread, deleteThread, getTask, getThread, listTasks, listTasksByThread, listThreads, renameThread } from "./store.js";
import { cancelTask, startTask } from "./taskEngine.js";
import { listAllModels } from "./runners/registry.js";
import { diagnoseOllama } from "./runners/ollamaRunner.js";
import { transcribeAudio, voiceAvailable, voiceUnavailableReason } from "./voice.js";

export function buildRouter(): Router {
  const router = Router();

  router.post("/tasks", async (req, res) => {
    const body = req.body as Partial<CreateTaskRequest>;
    if (!body.mode || !["ask", "plan", "build", "spec", "fix", "database", "architecture", "testing", "devops", "auth"].includes(body.mode)) {
      res.status(400).json({ error: "mode must be one of ask|plan|build|spec|fix|database|architecture|testing|devops|auth" });
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
    // Optional thread association (Pillar 3 — conversation threads). Loosely
    // validated the same way as model/history above: a well-formed string
    // is accepted here, and an unknown/stale id is handled gracefully by
    // touchThread() inside startTask() (a silent no-op) rather than failing
    // task creation over a thread-bookkeeping problem.
    let threadId: string | undefined;
    if (body.threadId !== undefined) {
      if (typeof body.threadId !== "string" || !body.threadId) {
        res.status(400).json({ error: "threadId, if provided, must be a non-empty string" });
        return;
      }
      threadId = body.threadId;
    }
    const task = await startTask({ mode: body.mode, prompt: body.prompt, projectContext: body.projectContext, archMode: body.archMode, model, autoCloud: body.autoCloud === true, history, threadId });
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

  router.post("/tasks/:id/resume", async (req, res) => {
    const previous = await getTask(req.params.id);
    const checkpoint = previous?.generationCheckpoint;
    if (!previous || !checkpoint) {
      res.status(404).json({ error: "no durable generation checkpoint is available for this task" });
      return;
    }
    if (previous.status === "running" || previous.status === "queued") {
      res.status(409).json({ error: "the task is still active" });
      return;
    }
    if (previous.mode !== "build" || createHash("sha256").update(previous.prompt).digest("hex") !== checkpoint.requirementsHash) {
      res.status(409).json({ error: "checkpoint requirements do not match the original Build task" });
      return;
    }
    let activeArtifacts: typeof checkpoint.artifacts;
    try {
      activeArtifacts = activeCheckpointArtifacts(checkpoint);
      const ownership = buildArtifactOwnershipManifest(checkpoint);
      if (checkpoint.artifactOwnership) {
        const storedPaths = checkpoint.artifactOwnership.active.map((record) => `${record.path}:${record.sha256}`).sort();
        const currentPaths = ownership.active.map((record) => `${record.path}:${record.sha256}`).sort();
        if (JSON.stringify(storedPaths) !== JSON.stringify(currentPaths)) throw new Error("ownership manifest does not match active artifact content");
      }
    } catch (error) {
      res.status(409).json({ error: `checkpoint artifact ownership validation failed: ${(error as Error).message}` });
      return;
    }
    for (const artifact of activeArtifacts) {
      const path = artifact.path.replaceAll("\\", "/");
      if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..") || createHash("sha256").update(artifact.content).digest("hex") !== artifact.sha256) {
        res.status(409).json({ error: `checkpoint artifact failed path or checksum verification: ${artifact.path}` });
        return;
      }
    }
    const suppliedContext = req.body?.projectContext as CreateTaskRequest["projectContext"] | undefined;
    if ((suppliedContext?.projectPath ?? undefined) !== checkpoint.projectPath) {
      res.status(409).json({ error: "workspace path changed; refresh the project context before resuming" });
      return;
    }
    const suppliedFiles = new Map((suppliedContext?.relevantFiles ?? []).map((file) => [file.relPath.replaceAll("\\", "/"), file]));
    for (const base of checkpoint.baseFiles) {
      const current = suppliedFiles.get(base.path);
      if (!current || createHash("sha256").update(current.content ?? current.snippet).digest("hex") !== base.sha256) {
        res.status(409).json({ error: `workspace changed since the checkpoint: ${base.path}` });
        return;
      }
    }
    const mergedFiles = new Map(suppliedFiles);
    const originalWorkspacePaths = new Set(checkpoint.baseFiles.map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
    for (const artifact of activeArtifacts) {
      // Keep the caller's verified original bytes for files that existed
      // before generation. The pipeline replays checkpoint edits over this
      // base; replacing it here would make a resumed modify look like its own
      // stale output and break safe rewind/action validation.
      if (originalWorkspacePaths.has(artifact.path.replaceAll("\\", "/").toLowerCase())) continue;
      mergedFiles.set(artifact.path, { relPath: artifact.path, snippet: artifact.content.slice(0, 600), content: artifact.content });
    }
    try {
      const task = await startTask({
        mode: "build",
        prompt: previous.prompt,
        projectContext: { ...suppliedContext, projectPath: checkpoint.projectPath, relevantFiles: [...mergedFiles.values()] },
        model: { provider: previous.runner as ModelSelection["provider"], model: previous.model ?? checkpoint.modelId },
        autoCloud: false,
        threadId: previous.threadId,
      }, checkpoint);
      res.status(202).json({ task });
    } catch (error) {
      res.status(409).json({ error: (error as Error).message });
    }
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

  // Conversation threads (Pillar 3). A thread is created lazily by the
  // desktop client — the first message sent in a "New Chat" panel, not
  // eagerly on app launch — so POST /threads is deliberately cheap and
  // side-effect-free beyond writing the one record (see store.ts#createThread).
  router.post("/threads", async (req, res) => {
    const body = req.body as Partial<CreateThreadRequest>;
    if (body.title !== undefined && typeof body.title !== "string") {
      res.status(400).json({ error: "title, if provided, must be a string" });
      return;
    }
    const thread = await createThread(body.title);
    const response: CreateThreadResponse = { thread };
    res.status(201).json(response);
  });

  router.get("/threads", async (_req, res) => {
    const response: ListThreadsResponse = { threads: await listThreads() };
    res.json(response);
  });

  // Thread + its full task history, in creation order — what a desktop
  // panel rehydrates historyTurns/the feed from when the user reopens an
  // existing thread (see renderer.js's resetConversation/loadThread).
  router.get("/threads/:id", async (req, res) => {
    const thread = await getThread(req.params.id);
    if (!thread) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    const tasks = await listTasksByThread(req.params.id);
    const response: ThreadDetailResponse = { thread, tasks };
    res.json(response);
  });

  router.post("/threads/:id/rename", async (req, res) => {
    const body = req.body as Partial<RenameThreadRequest>;
    if (!body.title || typeof body.title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const thread = await renameThread(req.params.id, body.title);
    if (!thread) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    const response: CreateThreadResponse = { thread };
    res.json(response);
  });

  router.delete("/threads/:id", async (req, res) => {
    const existed = await getThread(req.params.id);
    if (!existed) {
      res.status(404).json({ error: "thread not found" });
      return;
    }
    await deleteThread(req.params.id);
    // Deliberately NOT deleting the thread's own tasks (tasks.json) — a
    // deleted thread just stops showing up in the thread list; its tasks
    // remain real, retrievable records (GET /tasks/:id still works), the
    // same "soft" relationship a deleted email thread has to the messages
    // in it. Listed here so this choice is visible at the call site, not
    // buried only in store.ts.
    res.status(204).send();
  });

  // Multi-model support: the full model catalog (every provider this
  // gateway knows about, including ones not currently usable — see
  // ModelOption's doc comment) for the desktop shell's Settings default and
  // per-task pickers.
  router.get("/models", async (_req, res) => {
    const response: ListModelsResponse = { models: await listAllModels() };
    res.json(response);
  });

  // Local model diagnostics run inside the gateway process, not the
  // renderer or this tool host. This makes container/host namespace
  // mismatches and Laya-only failures visible without sending source code
  // to a hosted provider or changing Ollama's bind address.
  router.get("/ollama/diagnostics", async (req, res) => {
    const selectedModel = typeof req.query.model === "string" ? req.query.model : undefined;
    res.json(await diagnoseOllama(selectedModel));
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
