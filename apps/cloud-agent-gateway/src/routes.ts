import { Router } from "express";
import type { CreateTaskRequest, CreateTaskResponse, ListTasksResponse } from "@mobiusx/protocol";
import { getTask, listTasks } from "./store.js";
import { startTask } from "./taskEngine.js";

export function buildRouter(): Router {
  const router = Router();

  router.post("/tasks", async (req, res) => {
    const body = req.body as Partial<CreateTaskRequest>;
    if (!body.mode || !["ask", "plan", "build"].includes(body.mode)) {
      res.status(400).json({ error: "mode must be one of ask|plan|build" });
      return;
    }
    if (!body.prompt || typeof body.prompt !== "string") {
      res.status(400).json({ error: "prompt is required" });
      return;
    }
    const task = await startTask({ mode: body.mode, prompt: body.prompt, projectContext: body.projectContext });
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

  return router;
}
