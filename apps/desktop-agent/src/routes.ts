import { Router } from "express";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { appendAuditEntry, readAuditLog } from "@mobiusx/audit-log";
import type {
  AgentSettings,
  ApplyEditsRequest,
  ApplyEditsResponse,
  AuditLogResponse,
  EffectivePolicyResponse,
  FsTreeResponse,
  GitDiffRequest,
  OpenProjectRequest,
  OpenProjectResponse,
  ProposedEdit,
  VerifyResponse,
} from "@mobiusx/protocol";
import { applyEdits, buildSnapshot, readProjectFile, snapshotToNodes } from "./fsOps.js";
import { verifyProject } from "./verify.js";
import { getSettings, updateSettings } from "./settings.js";
import { gitDiff, gitLog, gitLogForPath, gitStatus, isGitRepo } from "./gitOps.js";
import { BUILTIN_POLICY, loadProjectPolicy } from "./policy.js";
import { buildSemanticIndex, searchSemanticIndex } from "./semanticOps.js";
import { projectState } from "./state.js";

export function buildRouter(): Router {
  const router = Router();

  router.post("/project/open", async (req, res) => {
    const { path } = req.body as OpenProjectRequest;
    if (!path || typeof path !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const abs = resolvePath(path);
    try {
      const st = await stat(abs);
      if (!st.isDirectory()) {
        res.status(400).json({ error: "path is not a directory" });
        return;
      }
    } catch {
      res.status(404).json({ error: "path does not exist" });
      return;
    }

    const snapshot = await buildSnapshot(abs);
    const gitRepo = await isGitRepo(abs);
    projectState.path = abs;
    projectState.snapshot = snapshot;
    projectState.isGitRepo = gitRepo;
    projectState.semanticIndexBuilt = false;

    const body: OpenProjectResponse = {
      path: abs,
      isGitRepo: gitRepo,
      fileCount: Object.values(snapshot.nodes).filter((n) => n.type === "file").length,
    };
    res.json(body);
  });

  router.get("/fs/tree", (_req, res) => {
    if (!projectState.path || !projectState.snapshot) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const body: FsTreeResponse = { root: projectState.path, nodes: snapshotToNodes(projectState.snapshot) };
    res.json(body);
  });

  router.get("/fs/read", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const relPath = String(req.query.path ?? "");
    try {
      const body = await readProjectFile(projectState.path, relPath);
      res.json(body);
    } catch (err) {
      res.status(400).json({ error: "read failed", detail: (err as Error).message });
    }
  });

  // The only endpoint that ever writes AI-generated content to disk — see
  // fsOps.ts#applyEdits's doc comment for the full safety contract (path
  // containment, modify-must-exist / create-must-not-exist, a flag-only
  // secret scan). The desktop shell only calls this after the user reviews
  // a task's proposed edits and clicks Apply — nothing upstream of this
  // route enforces that; it's a UI-level gate, which is why this route
  // re-validates everything itself rather than trusting the caller.
  router.post("/fs/apply-edits", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const { edits } = req.body as ApplyEditsRequest;
    if (!Array.isArray(edits) || edits.length === 0) {
      res.status(400).json({ error: "edits must be a non-empty array" });
      return;
    }
    const valid = edits.every(
      (e): e is ProposedEdit =>
        e &&
        typeof e.path === "string" &&
        e.path.length > 0 &&
        (e.action === "modify" || e.action === "create") &&
        typeof e.content === "string",
    );
    if (!valid) {
      res.status(400).json({ error: "each edit needs path (string), action ('modify'|'create'), content (string)" });
      return;
    }

    try {
      const results = await applyEdits(projectState.path, edits);
      const appliedCount = results.filter((r) => r.status === "applied").length;
      const skippedCount = results.length - appliedCount;
      void appendAuditEntry({
        source: "desktop-agent",
        category: "applied-edits",
        severity: skippedCount > 0 ? "warning" : "info",
        summary: `Applied ${appliedCount}/${results.length} proposed edit(s) in ${projectState.path}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}`,
        detail: { projectPath: projectState.path, results },
      });
      const body: ApplyEditsResponse = { results };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "apply-edits failed", detail: (err as Error).message });
    }
  });

  // Verification Engine (PRD §22): runs the open project's own build/test/
  // lint/typecheck npm scripts and reports real pass/fail evidence — never
  // just trusting an AI's claim that a change works. See verify.ts's doc
  // comment for the v1 scope (root package.json scripts only).
  router.post("/verify", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: VerifyResponse = await verifyProject(projectState.path);
      if (result.overall !== "no-verification-available") {
        const passedCount = result.steps.filter((s) => s.status === "passed").length;
        void appendAuditEntry({
          source: "desktop-agent",
          category: "verification",
          severity: result.overall === "passed" ? "info" : "warning",
          summary: `Verification ${result.overall} (${passedCount}/${result.steps.length} step(s) passed) in ${projectState.path}`,
          detail: { projectPath: projectState.path, overall: result.overall, steps: result.steps.map((s) => ({ label: s.label, status: s.status, exitCode: s.exitCode })) },
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "verify failed", detail: (err as Error).message });
    }
  });

  router.get("/git/status", async (_req, res) => {
    if (!projectState.path || !projectState.isGitRepo) {
      res.status(409).json({ error: "no git repo open" });
      return;
    }
    try {
      res.json(await gitStatus(projectState.path));
    } catch (err) {
      res.status(500).json({ error: "git status failed", detail: (err as Error).message });
    }
  });

  router.get("/git/log", async (req, res) => {
    if (!projectState.path || !projectState.isGitRepo) {
      res.status(409).json({ error: "no git repo open" });
      return;
    }
    const limit = Number(req.query.limit ?? 50);
    try {
      res.json(await gitLog(projectState.path, limit));
    } catch (err) {
      res.status(500).json({ error: "git log failed", detail: (err as Error).message });
    }
  });

  router.get("/git/diff", async (req, res) => {
    if (!projectState.path || !projectState.isGitRepo) {
      res.status(409).json({ error: "no git repo open" });
      return;
    }
    const { path, staged } = req.query as unknown as GitDiffRequest;
    if (!path) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      res.json(await gitDiff(projectState.path, path, staged === true || staged === ("true" as unknown as boolean)));
    } catch (err) {
      res.status(500).json({ error: "git diff failed", detail: (err as Error).message });
    }
  });

  router.post("/debug/index", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const stats = await buildSemanticIndex(projectState.path);
      projectState.semanticIndexBuilt = true;
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "index build failed", detail: (err as Error).message });
    }
  });

  router.get("/debug/search", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    const k = Number(req.query.k ?? 8);
    try {
      let indexedJustNow = false;
      if (!projectState.semanticIndexBuilt) {
        await buildSemanticIndex(projectState.path);
        projectState.semanticIndexBuilt = true;
        indexedJustNow = true;
      }
      const result = await searchSemanticIndex(projectState.path, query, k);
      res.json({ ...result, indexedJustNow });
    } catch (err) {
      res.status(500).json({ error: "search failed", detail: (err as Error).message });
    }
  });

  router.get("/debug/history", async (req, res) => {
    if (!projectState.path || !projectState.isGitRepo) {
      res.status(409).json({ error: "no git repo open" });
      return;
    }
    const relPath = String(req.query.path ?? "");
    if (!relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const { entries } = await gitLogForPath(projectState.path, relPath, Number(req.query.limit ?? 10));
      res.json({ path: relPath, entries });
    } catch (err) {
      res.status(500).json({ error: "history failed", detail: (err as Error).message });
    }
  });

  // Phase 5 (local-reference slice): surfaces the terminal command guard's
  // effective ruleset and the shared audit log. See policy.ts's doc comment
  // for the "advisory, not a sandbox" framing this UI needs to carry through.
  router.get("/policy", async (_req, res) => {
    const { rules, path, error } = await loadProjectPolicy(projectState.path);
    const body: EffectivePolicyResponse = {
      builtIn: BUILTIN_POLICY,
      project: rules,
      projectPolicyPath: path,
      projectPolicyError: error,
    };
    res.json(body);
  });

  // Approval Engine (PRD §34-35): the one real, working autonomy-level
  // control this repo ships today — see AgentSettings's doc comment.
  router.get("/settings", async (_req, res) => {
    const body: AgentSettings = await getSettings();
    res.json(body);
  });

  router.put("/settings", async (req, res) => {
    const patch = req.body as Partial<AgentSettings>;
    if (patch.terminalApprovalMode !== undefined && patch.terminalApprovalMode !== "off" && patch.terminalApprovalMode !== "guarded") {
      res.status(400).json({ error: "terminalApprovalMode must be 'off' or 'guarded'" });
      return;
    }
    const body: AgentSettings = await updateSettings(patch);
    res.json(body);
  });

  router.get("/audit", async (req, res) => {
    const limit = Number(req.query.limit ?? 100);
    const body: AuditLogResponse = { entries: await readAuditLog(Number.isFinite(limit) ? limit : 100) };
    res.json(body);
  });

  return router;
}
