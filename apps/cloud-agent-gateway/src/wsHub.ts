import type { WebSocket } from "ws";
import type { TaskEvent } from "@mobiusx/protocol";

const subscribers = new Map<string, Set<WebSocket>>();

export function subscribe(taskId: string, ws: WebSocket): void {
  if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
  subscribers.get(taskId)!.add(ws);
  ws.on("close", () => unsubscribe(taskId, ws));
}

export function unsubscribe(taskId: string, ws: WebSocket): void {
  subscribers.get(taskId)?.delete(ws);
}

export function broadcast(taskId: string, event: TaskEvent): void {
  const sockets = subscribers.get(taskId);
  if (!sockets) return;
  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}
