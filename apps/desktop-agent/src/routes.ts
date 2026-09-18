import { Router } from "express";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { appendAuditEntry, readAuditLog } from "@mobiusx/audit-log";
import type {
  AgentMode,
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
  ArchitectureEvidenceResponse,
  TestingEvidenceResponse,
  DevopsEvidenceResponse,
  ProposedEdit,
  VerifyResponse,
  BrowserValidationResponse,
  SteeringListResponse,
  SteeringWriteRequest,
  HooksConfigResponse,
  McpStatusResponse,
  McpToolCallRequest,
  McpToolCallResponse,
  KnowledgeSourcesResponse,
  KnowledgeIndexResponse,
  KnowledgeSearchResponse,
  ErrorIntelligenceReport,
  CheckpointListResponse,
  CheckpointRestoreResponse,
  DashboardResponse,
} from "@mobiusx/protocol";
import { applyEdits, buildSnapshot, readProjectFile, snapshotToNodes } from "./fsOps.js";
import { createCheckpoint, deleteCheckpoint, listCheckpoints, restoreCheckpoint } from "./checkpoints.js";
import { gatherDashboard } from "./dashboard.js";
import { getPreviewStatus, startPreview, stopPreview } from "./previewOps.js";
import { verifyProject } from "./verify.js";
import { runBrowserValidation } from "./browserOps.js";
import { computeCompletionReport } from "./completion.js";
import { detectProjectContext } from "./projectContext.js";
import { checkDatabaseConsistency } from "./dbOps.js";
import { gatherArchitectureEvidence } from "./architectureContext.js";
import { gatherTestingEvidence } from "./testingContext.js";
import { gatherDevopsEvidence } from "./devopsContext.js";
import { getSettings, updateSettings, type SettingsPatch } from "./settings.js";
import { gitDiff, gitLog, gitLogForPath, gitStatus, isGitRepo } from "./gitOps.js";
import { BUILTIN_POLICY, loadProjectPolicy } from "./policy.js";
import { buildSemanticIndex, searchSemanticIndex } from "./semanticOps.js";
import { projectState } from "./state.js";
import { deleteSteeringFile, listSteeringFiles, scaffoldDefaultSteering, writeSteeringFile } from "./steering.js";
import { loadProjectHooks, runHooksForEvent } from "./hooks.js";
import { callMcpTool, getMcpStatus } from "@mobiusx/mcp-client";
import { addKnowledgeSource, buildKnowledgeIndex, listKnowledgeSources, removeKnowledgeSource, searchKnowledge } from "./knowledgeOps.js";
import { runErrorIntelligence } from "./errorIntelligence.js";

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
      // Checkpoints / Rollback (roadmap Phase 15, source requirement §23):
      // snapshot every touched path's PRE-edit state before applyEdits
      // writes anything -- once it runs, the pre-edit content is gone.
      // See checkpoints.ts's doc comment for the full design.
      const checkpoint = await createCheckpoint(projectState.path, edits);
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

      // Project Memory/Steering + Hooks (roadmap Phase 16, source
      // requirement §25): a real "after-api-change" trigger point --
      // fires only for rules whose pathPattern matches at least one path
      // that was ACTUALLY applied just now (never a path that was merely
      // proposed and skipped). hookResults is omitted entirely (not [])
      // when this project has no hooks.json at all, so the response shape
      // itself tells the caller whether hooks are even configured.
      const appliedPaths = results.filter((r) => r.status === "applied").map((r) => r.path);
      let hookResults: ApplyEditsResponse["hookResults"];
      if (appliedPaths.length > 0) {
        const { rules } = await loadProjectHooks(projectState.path);
        if (rules.some((r) => r.event === "after-api-change")) {
          hookResults = await runHooksForEvent(projectState.path, "after-api-change", { changedPaths: appliedPaths });
        }
      }

      const body: ApplyEditsResponse = { results, checkpointId: checkpoint.id, ...(hookResults ? { hookResults } : {}) };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "apply-edits failed", detail: (err as Error).message });
    }
  });

  // Checkpoints / Rollback (roadmap Phase 15, source requirement §23) --
  // see checkpoints.ts's doc comment. Checkpoints themselves are created
  // automatically inside POST /fs/apply-edits above; these three routes
  // are the read/restore/delete surface over that same storage.
  router.get("/checkpoints", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const checkpoints = await listCheckpoints(projectState.path);
      const body: CheckpointListResponse = { checkpoints };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "failed to list checkpoints", detail: (err as Error).message });
    }
  });

  router.post("/checkpoints/:id/restore", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const { results, preRestoreCheckpointId } = await restoreCheckpoint(projectState.path, req.params.id);
      const body: CheckpointRestoreResponse = { results, preRestoreCheckpointId };
      res.json(body);
    } catch (err) {
      res.status(404).json({ error: "restore failed", detail: (err as Error).message });
    }
  });

  router.delete("/checkpoints/:id", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const ok = await deleteCheckpoint(projectState.path, req.params.id);
    if (!ok) {
      res.status(404).json({ error: "checkpoint not found" });
      return;
    }
    res.json({ deleted: true });
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

  // Dashboard (roadmap Phase 18, source §32/§33/§34) -- a presentation
  // layer over the completion report above plus a real, existing-only
  // artifact list. See dashboard.ts's doc comment for exactly what's
  // checked and why "agent activity feed" isn't duplicated here (the
  // shell filters the existing GET /audit feed client-side instead).
  router.get("/dashboard", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: DashboardResponse = await gatherDashboard(projectState.path, projectState.isGitRepo);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "dashboard failed", detail: (err as Error).message });
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

  // Architecture Generation (roadmap Phase 9, source requirement §7): the
  // grounding evidence bundle Architecture mode's prompt is built from --
  // exposed as its own route (not just baked silently into the prompt) so
  // the Artifacts view can show the user exactly what real facts a
  // generated diagram is standing on, the same transparency Project
  // Context and Database Consistency already give for their own domains.
  router.get("/architecture-evidence", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: ArchitectureEvidenceResponse = await gatherArchitectureEvidence(projectState.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "architecture evidence gathering failed", detail: (err as Error).message });
    }
  });

  // Testing Engine (roadmap Phase 10, source requirement §15): the
  // grounding evidence bundle Testing mode's prompt (and Build mode's
  // optional companion-test instruction) are built from -- see
  // testingContext.ts's doc comment for exactly what's gathered and what's
  // honestly reported empty instead of guessed. Exposed as its own route,
  // same transparency precedent as /project-context, /db/consistency, and
  // /architecture-evidence.
  router.get("/testing-evidence", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: TestingEvidenceResponse = await gatherTestingEvidence(projectState.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "testing evidence gathering failed", detail: (err as Error).message });
    }
  });

  // DevOps/Infrastructure Generation (roadmap Phase 14, source requirement
  // §21): the grounding evidence bundle DevOps mode's prompt is built from
  // -- see devopsContext.ts's doc comment for exactly what's gathered.
  // Exposed as its own route, same transparency precedent as
  // /architecture-evidence and /testing-evidence.
  router.get("/devops-evidence", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: DevopsEvidenceResponse = await gatherDevopsEvidence(projectState.path);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "devops evidence gathering failed", detail: (err as Error).message });
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

  // Browser / Application Validation (roadmap Phase 12, source requirement
  // §18): drives the already-running preview with a real headless browser
  // -- see browserOps.ts's doc comment. Requires /preview/start to have
  // been called first and to have reported a running frontend URL; when it
  // hasn't, this honestly reports overall: "no-preview-running" rather
  // than an error, the same "no-verification-available" pattern /verify
  // already uses for "nothing to check yet".
  router.post("/browser-validate", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: BrowserValidationResponse = await runBrowserValidation(projectState.path);
      if (result.overall !== "no-preview-running") {
        const passedCount = result.steps.filter((s) => s.status === "passed").length;
        void appendAuditEntry({
          source: "desktop-agent",
          category: "browser-validation",
          severity: result.overall === "passed" ? "info" : "warning",
          summary: `Browser validation ${result.overall} (${passedCount}/${result.steps.length} step(s) passed) in ${projectState.path}`,
          detail: {
            projectPath: projectState.path,
            previewUrl: result.previewUrl,
            overall: result.overall,
            steps: result.steps.map((s) => ({ label: s.label, status: s.status, url: s.url })),
          },
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "browser validation failed", detail: (err as Error).message });
    }
  });

  // Error Intelligence + Debugger v2 (roadmap Phase 13, source requirement
  // §19/§20): extends the Phase 2 static Debug view into full-stack
  // tracing + root-cause classification -- see errorIntelligence.ts's doc
  // comment. Reuses runBrowserValidation (so it honestly reports
  // "no-preview-running" the same way /browser-validate does) plus
  // gatherArchitectureEvidence's real routes/database evidence to
  // correlate against, never inventing a trace path that isn't backed by
  // an actual matched route, ORM entity, or captured backend log line.
  router.post("/debug/error-intelligence", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      const result: ErrorIntelligenceReport = await runErrorIntelligence(projectState.path);
      if (result.overall !== "no-preview-running") {
        void appendAuditEntry({
          source: "desktop-agent",
          category: "error-intelligence",
          severity: result.overall === "errors-found" ? "warning" : "info",
          summary: `Error intelligence: ${result.overall} (${result.traces.length} trace(s)) in ${projectState.path}`,
          detail: {
            projectPath: projectState.path,
            previewUrl: result.previewUrl,
            overall: result.overall,
            traces: result.traces.map((t) => ({ stepLabel: t.stepLabel, url: t.url, category: t.category, confidence: t.confidence })),
          },
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "error intelligence failed", detail: (err as Error).message });
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

  // Project Memory/Steering (roadmap Phase 16, source requirement §24/§25)
  // -- see steering.ts's doc comment. Files are plain markdown the user
  // (or an explicit save from here) authors under .mobiusx/steering/;
  // nothing here is ever generated silently.
  router.get("/steering", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const files = await listSteeringFiles(projectState.path);
    const body: SteeringListResponse = { files, dir: join(projectState.path, ".mobiusx", "steering") };
    res.json(body);
  });

  router.put("/steering", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const { name, content } = req.body as SteeringWriteRequest;
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]+$/.test(name) || typeof content !== "string") {
      res.status(400).json({ error: "name (letters/numbers/hyphen/underscore only) and content (string) are required" });
      return;
    }
    try {
      const file = await writeSteeringFile(projectState.path, name, content);
      res.json(file);
    } catch (err) {
      res.status(500).json({ error: "failed to write steering file", detail: (err as Error).message });
    }
  });

  router.delete("/steering/:name", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    try {
      await deleteSteeringFile(projectState.path, req.params.name);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: "failed to delete steering file", detail: (err as Error).message });
    }
  });

  router.post("/steering/scaffold", async (_req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const written = await scaffoldDefaultSteering(projectState.path);
    res.json({ written });
  });

  // Event-driven hooks (roadmap Phase 16, source requirement §25's second
  // half) -- see hooks.ts's doc comment. Read-only here (same convention
  // as GET /policy above): .mobiusx/hooks.json is hand-authored, this just
  // surfaces what's configured and any parse error honestly, plus a
  // manual "run now" for the Settings panel to test a hook without
  // needing a real apply-edits or git commit to trigger it.
  router.get("/hooks", async (_req, res) => {
    const { rules, path, error } = await loadProjectHooks(projectState.path);
    const body: HooksConfigResponse = { rules, path, error };
    res.json(body);
  });

  router.post("/hooks/run", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const event = req.body?.event;
    if (event !== "before-commit" && event !== "after-api-change") {
      res.status(400).json({ error: 'event must be "before-commit" or "after-api-change"' });
      return;
    }
    try {
      const results = await runHooksForEvent(projectState.path, event);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: "hook run failed", detail: (err as Error).message });
    }
  });

  // Broader MCP tool support (source requirement §28) -- see
  // @mobiusx/mcp-client's doc comment for .mobiusx/mcp.json's shape and
  // the real stdio connection this establishes. GET connects to (or
  // reuses a cached connection to) every enabled configured server and
  // reports genuine per-server status -- never a fabricated "connected".
  router.get("/mcp/status", async (_req, res) => {
    try {
      const servers = await getMcpStatus(projectState.path);
      const body: McpStatusResponse = { servers };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "mcp status failed", detail: (err as Error).message });
    }
  });

  // Manual tool-call, for testing a configured server from the Settings
  // panel without needing a full Build/Fix task to trigger it (the real
  // task-time calling path is apps/cloud-agent-gateway's anthropicRunner.ts).
  router.post("/mcp/tools/call", async (req, res) => {
    if (!projectState.path) {
      res.status(409).json({ error: "no project open" });
      return;
    }
    const { tool, arguments: args } = req.body as McpToolCallRequest;
    if (typeof tool !== "string" || !tool) {
      res.status(400).json({ error: "tool is required" });
      return;
    }
    try {
      const result = await callMcpTool(projectState.path, tool, (args as Record<string, unknown>) ?? {});
      void appendAuditEntry({
        source: "desktop-agent",
        category: "mcp-tool-call",
        severity: result.isError ? "warning" : "info",
        summary: `MCP tool call ${tool}: ${result.isError ? "error" : "ok"}`,
        detail: { tool, isError: result.isError, projectPath: projectState.path },
      });
      const body: McpToolCallResponse = { tool, isError: result.isError, content: result.content };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "mcp tool call failed", detail: (err as Error).message });
    }
  });

  // Enterprise Knowledge / Global Intelligence local substitute (roadmap
  // Phase 17, source requirement §29/§30) -- see knowledgeOps.ts's doc
  // comment. Deliberately GLOBAL (no project needs to be open) -- sources
  // are folders on the user's machine, indexed once, searchable from any
  // project's AI Assistant panel.
  router.get("/knowledge/sources", async (_req, res) => {
    const sources = await listKnowledgeSources();
    const body: KnowledgeSourcesResponse = { sources };
    res.json(body);
  });

  router.post("/knowledge/sources", async (req, res) => {
    const { label, path } = req.body as { label?: string; path?: string };
    if (typeof path !== "string" || !path) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const source = await addKnowledgeSource(typeof label === "string" ? label : "", resolvePath(path));
      res.json(source);
    } catch (err) {
      res.status(400).json({ error: "failed to add knowledge source", detail: (err as Error).message });
    }
  });

  router.delete("/knowledge/sources/:id", async (req, res) => {
    await removeKnowledgeSource(req.params.id);
    res.json({ ok: true });
  });

  router.post("/knowledge/index", async (req, res) => {
    const sourceId = typeof req.body?.sourceId === "string" ? req.body.sourceId : undefined;
    try {
      const results = await buildKnowledgeIndex(sourceId);
      for (const r of results) {
        void appendAuditEntry({
          source: "desktop-agent",
          category: "knowledge-index",
          severity: "info",
          summary: `Indexed knowledge source ${r.sourceId}: ${r.filesIndexed}/${r.filesConsidered} file(s), ${r.chunksIndexed} chunk(s)`,
          detail: { ...r },
        });
      }
      const body: KnowledgeIndexResponse = { results };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "knowledge index build failed", detail: (err as Error).message });
    }
  });

  router.get("/knowledge/search", async (req, res) => {
    const q = String(req.query.q ?? "");
    const k = Math.min(Math.max(Number(req.query.k) || 5, 1), 20);
    if (!q.trim()) {
      res.json({ hits: [], durationMs: 0 });
      return;
    }
    try {
      const result = await searchKnowledge(q, k);
      const body: KnowledgeSearchResponse = result;
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "knowledge search failed", detail: (err as Error).message });
    }
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
    const KNOWN_PROVIDERS = ["demo", "anthropic", "openrouter", "groq", "ollama"];
    if (patch.defaultModel !== undefined && patch.defaultModel !== null) {
      const dm = patch.defaultModel as { provider?: unknown; model?: unknown };
      if (typeof dm.provider !== "string" || !KNOWN_PROVIDERS.includes(dm.provider) || typeof dm.model !== "string" || !dm.model) {
        res.status(400).json({ error: "defaultModel must be null or {provider, model} with a known provider and non-empty model id" });
        return;
      }
    }
    // modelRouting (roadmap Phase 11, source §27): per-mode merge -- see
    // @mobiusx/agent-settings's SettingsPatch doc comment. Each key must be
    // a real AgentMode; each value must be null (clear that mode's rule) or
    // a well-formed {provider, model} pair, exactly like defaultModel above.
    if (patch.modelRouting !== undefined) {
      const KNOWN_MODES: AgentMode[] = ["ask", "plan", "build", "spec", "fix", "database", "architecture", "testing"];
      const routing = patch.modelRouting as Record<string, unknown>;
      for (const [mode, selection] of Object.entries(routing)) {
        if (!KNOWN_MODES.includes(mode as AgentMode)) {
          res.status(400).json({ error: `modelRouting has an unknown mode "${mode}"` });
          return;
        }
        if (selection === null) continue;
        const sel = selection as { provider?: unknown; model?: unknown };
        if (typeof sel.provider !== "string" || !KNOWN_PROVIDERS.includes(sel.provider) || typeof sel.model !== "string" || !sel.model) {
          res.status(400).json({ error: `modelRouting.${mode} must be null or {provider, model} with a known provider and non-empty model id` });
          return;
        }
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
