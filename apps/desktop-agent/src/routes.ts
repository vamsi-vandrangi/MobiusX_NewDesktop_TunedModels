import { Router } from "express";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { appendAuditEntry, readAuditLog } from "@mobiusx/audit-log";
import type {
  AgentSettings,
  ApplyEditsRequest,
  ApplyEditsResponse,
  AuditLogResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  EffectivePolicyResponse,
  FsTreeResponse,
  GitDiffRequest,
  OpenProjectRequest,
  OpenProjectResponse,
  PreviewStartResponse,
  PreviewStatusResponse,
  ProjectCompletionResponse,
  ProjectContextResponse,
  DatabaseConsistencyResponse,
  ProposedEdit,
  VerifyResponse,
} from "@mobiusx/protocol";
import { applyEdits, buildSnapshot, readProjectFile, snapshotToNodes } from "./fsOps.js";
import { getPreviewStatus, startPreview, stopPreview } from "./previewOps.js";
import { verifyProject } from "./verify.js";
import { computeCompletionReport } from "./completion.js";
import { detectProjectContext } from "./projectContext.js";
import { checkDatabaseConsistency } from "./dbOps.js";
import { getSettings, updateSettings, type SettingsPatch } from "./settings.js";
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

    stopPreview(); // switching projects -- don't leave the previous project's dev server(s) running
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

  // "New Project" (item 6, phase 1): creates an empty folder on the user's
  // own machine inside a parent directory they picked via the native folder
  // dialog, then opens it exactly like /project/open. Deliberately narrow:
  // it only ever creates/opens an EMPTY project, never touches an existing
  // non-empty folder or file — scaffolding the actual code is a normal
  // Build-mode task against this now-open (empty) project, reusing the
  // existing propose -> review -> apply pipeline rather than a new one.
  router.post("/project/create", async (req, res) => {
    const { parentPath, name } = req.body as CreateProjectRequest;
    if (!parentPath || typeof parentPath !== "string") {
      res.status(400).json({ error: "parentPath is required" });
      return;
    }
    if (!name || typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      res.status(400).json({
        error: "name is required, must start with a letter or number, and may only contain letters, numbers, dots, dashes, and underscores",
      });
      return;
    }

    const parentAbs = resolvePath(parentPath);
    try {
      const parentSt = await stat(parentAbs);
      if (!parentSt.isDirectory()) {
        res.status(400).json({ error: "parentPath is not a directory" });
        return;
      }
    } catch {
      res.status(404).json({ error: "parentPath does not exist" });
      return;
    }

    const abs = join(parentAbs, name);
    try {
      const existing = await stat(abs).catch(() => null);
      if (existing) {
        if (!existing.isDirectory()) {
          res.status(400).json({ error: "a file already exists with that name" });
          return;
        }
        const entries = await readdir(abs);
        if (entries.length > 0) {
          res.status(400).json({ error: "a non-empty folder already exists with that name" });
          return;
        }
        // Exists and is empty — reuse it rather than erroring, so a user who
        // already made the folder in Finder isn't blocked.
      } else {
        await mkdir(abs);
      }
    } catch (err) {
      res.status(500).json({ error: "failed to create project folder", detail: (err as Error).message });
      return;
    }

    stopPreview(); // switching projects -- don't leave the previous project's dev server(s) running
    const snapshot = await buildSnapshot(abs);
    const gitRepo = await isGitRepo(abs);
    projectState.path = abs;
    projectState.snapshot = snapshot;
    projectState.isGitRepo = gitRepo;
    projectState.semanticIndexBuilt = false;

    void appendAuditEntry({
      source: "desktop-agent",
      category: "project-created",
      severity: "info",
      summary: `Created new project folder at ${abs}`,
      detail: { path: abs },
    });

    const body: CreateProjectResponse = {
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

  // Project Completion Contract (roadmap Phase 6, source requirement §31):
  // a real, computed report of what's actually verifiable about the open
  // project right now — see completion.ts's doc comment for exactly which
  // criteria are measured vs honestly reported "not_configured". Also
  // written to .mobiusx/PROJECT_COMPLETION.json as a real artifact.
  router.get("/completion", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: ProjectCompletionResponse = await computeCompletionReport(projectState.path, projectState.isGitRepo);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "completion report failed", detail: (err as Error).message });
    }
  });

  // Project Understanding Engine (roadmap Phase 7, source requirement §5):
  // a real, evidence-based tech-stack detection pass -- see
  // projectContext.ts's doc comment for exactly what's scanned and how a
  // component gets reported. Also written to .mobiusx/PROJECT_CONTEXT.md +
  // .mobiusx/project-context.json as real artifacts.
  router.get("/project-context", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: ProjectContextResponse = await detectProjectContext(projectState.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "project context detection failed", detail: (err as Error).message });
    }
  });

  // Database Engineering (roadmap Phase 8, source requirement §8): a real
  // cross-check between this project's SQL schema/migration source(s) and
  // its ORM model file(s) -- see dbOps.ts's doc comment for exactly what's
  // parsed and what's honestly reported as not detected instead of guessed.
  router.get("/db/consistency", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: DatabaseConsistencyResponse = await checkDatabaseConsistency(projectState.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "database consistency check failed", detail: (err as Error).message });
    }
  });

  // Live Preview (item 6, phase 2): starts real dev server(s) for the open
  // project (see previewOps.ts's detectFrontend/detectBackend for exactly
  // what's checked) and reports their genuine status/URL back to the shell,
  // which embeds a <webview> pointed at the frontend's URL once it's
  // running. Nothing here is simulated -- a project with neither a
  // frontend "dev" script nor a recognizable FastAPI backend gets an
  // honest {frontend: null, backend: null}, not a fabricated preview.
  router.post("/preview/start", (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const body: PreviewStartResponse = startPreview(projectState.path);
    void appendAuditEntry({
      source: "desktop-agent",
      category: "preview-started",
      severity: "info",
      summary: `Preview started for ${projectState.path} (frontend: ${body.detected.frontend}, backend: ${body.detected.backend})`,
      detail: { projectPath: projectState.path, detected: body.detected },
    });
    res.json(body);
  });

  router.get("/preview/status", (_req, res) => {
    const body: PreviewStatusResponse = getPreviewStatus();
    res.json(body);
  });

  router.post("/preview/stop", (_req, res) => {
    stopPreview();
    res.json({ ok: true });
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
    const patch = req.body as SettingsPatch;
    if (patch.terminalApprovalMode !== undefined && patch.terminalApprovalMode !== "off" && patch.terminalApprovalMode !== "guarded") {
      res.status(400).json({ error: "terminalApprovalMode must be 'off' or 'guarded'" });
      return;
    }
    // Autonomous Build/Test/Fix Loop (roadmap Phase 6) autonomy level — see AgentSettings.fixLoopMode's doc comment.
    if (patch.fixLoopMode !== undefined && patch.fixLoopMode !== "manual" && patch.fixLoopMode !== "auto") {
      res.status(400).json({ error: "fixLoopMode must be 'manual' or 'auto'" });
      return;
    }
    // defaultModel (multi-model support): null explicitly clears the standing
    // default (see @mobiusx/agent-settings's SettingsPatch doc comment) --
    // anything else must be a well-formed {provider, model} pair.
    if (patch.defaultModel !== undefined && patch.defaultModel !== null) {
      const KNOWN_PROVIDERS = ["demo", "anthropic", "openrouter", "groq", "ollama"];
      const dm = patch.defaultModel as { provider?: unknown; model?: unknown };
      if (typeof dm.provider !== "string" || !KNOWN_PROVIDERS.includes(dm.provider) || typeof dm.model !== "string" || !dm.model) {
        res.status(400).json({ error: "defaultModel must be null or {provider, model} with a known provider and non-empty model id" });
        return;
      }
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
