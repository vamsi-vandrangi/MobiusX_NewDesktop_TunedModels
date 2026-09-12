import type { NextFunction, Request, Response } from "express";

/**
 * Loopback-only local reference service, so a bearer token is enough here.
 * A real deployed MobiusX Cloud would authenticate the actual signed-in
 * user (OAuth/session), not a per-process token — noted so this isn't
 * mistaken for how production auth should work.
 */
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

export function isTokenValid(token: string, provided: string | null): boolean {
  return provided !== null && provided === token;
}
