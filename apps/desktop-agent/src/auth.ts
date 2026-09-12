import type { NextFunction, Request, Response } from "express";

export function makeAuthMiddleware(token: string) {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (provided !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/** Same check, used by the WebSocket upgrade path (no Express req/res there). */
export function isTokenValid(token: string, provided: string | null): boolean {
  return provided !== null && provided === token;
}
