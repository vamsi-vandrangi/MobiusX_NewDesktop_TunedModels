/**
 * Desktop <-> Local Agent contract (HTTP + WebSocket).
 *
 * The Local Agent Service (apps/desktop-agent) runs on 127.0.0.1 only and is
 * paired with the Electron shell via a per-launch bearer token (see
 * AgentHandshake). Nothing here is exposed to the network.
 */

import type { PolicyMatch } from "./governance.js";
import type { ModelSelection, ProposedEdit } from "./cloud.js";

export interface AgentHandshake {
  /** Port the agent is listening on (loopback only). */
  port: number;
  /** Bearer token the shell must send as `Authorization: Bearer <token>`. */
  token: string;
}

export interface HealthResponse {
  status: "ok";
  version: string;
  activeProject: string | null;
}

export interface OpenProjectRequest {
  path: string;
}

export interface OpenProjectResponse {
  path: string;
  isGitRepo: boolean;
  fileCount: number;
}

/**
 * Creates a brand-new, empty project folder on disk (inside an existing
 * parent directory the user picked via the native folder dialog) and opens
 * it as the active project — the "New Project" flow. `name` becomes the new
 * folder's name; it's validated server-side (letters/numbers/dots/dashes/
 * underscores only, must start with a letter or number) so it can never
 * contain a path separator or resolve outside parentPath. If a folder with
 * that name already exists and is empty, it's reused rather than rejected
 * (lets a user recover from "created the folder in Finder first"); a
 * non-empty existing folder or an existing file at that path is rejected —
 * this endpoint only ever creates/opens an EMPTY project, never overwrites
 * one. Response shape deliberately mirrors OpenProjectResponse (fileCount
 * is always 0 for a truly new folder) so the renderer can treat "created" and
 * "opened" the same way from here on.
 */
export interface CreateProjectRequest {
  parentPath: string;
  name: string;
}

export interface CreateProjectResponse {
  path: string;
  isGitRepo: boolean;
  fileCount: number;
}

/**
 * Live Preview (item 6, phase 2): the desktop agent spawning a real dev
 * server for the open project (never a browser-only mock) and reporting its
 * actual status/URL/log back to the shell. "frontend"/"backend" mirror the
 * two halves previewOps.ts's detectFrontend/detectBackend look for; either
 * can be null when this project genuinely doesn't have that half (e.g. a
 * frontend-only repo has no backend entry to report on) -- never fabricated
 * as "not started" when there was nothing to start in the first place.
 */

/**
 * "installing" (Sept 2026, explicit user request): a project whose
 * dependencies (node_modules / a .venv with the right packages) aren't on
 * disk yet gets them installed automatically before its real dev server
 * ever spawns -- see previewOps.ts's frontendInstallSteps/
 * backendInstallSteps/startServiceWithInstall. The service reports this
 * status for the whole install phase, with the install command(s)' real
 * output streaming into the same `log` the dev server itself uses once it
 * starts -- never silently rolled into "starting".
 */
export type PreviewServiceKind = "frontend" | "backend";
export type PreviewServiceStatusValue = "installing" | "starting" | "running" | "exited" | "failed";

export interface PreviewServiceState {
  kind: PreviewServiceKind;
  /** Absolute path to the directory the dev server was started in. */
  cwd: string;
  /** The exact command that was run, e.g. "npm run dev" -- never hidden from the user. */
  command: string;
  status: PreviewServiceStatusValue;
  port: number | null;
  url: string | null;
  /** Recent stdout/stderr lines, capped -- real process output, not a summary. */
  log: string[];
  exitCode: number | null;
  startedAt: string;
}

export interface PreviewStartResponse {
  frontend: PreviewServiceState | null;
  backend: PreviewServiceState | null;
  /** What was actually found in the project, independent of whether it started cleanly. */
  detected: { frontend: boolean; backend: boolean };
}

export interface PreviewStatusResponse {
  frontend: PreviewServiceState | null;
  backend: PreviewServiceState | null;
}

export interface FsNode {
  name: string;
  path: string; // relative to project root
  type: "file" | "dir";
  size?: number;
}

export interface FsTreeResponse {
  root: string;
  nodes: FsNode[];
}

export interface FsReadResponse {
  path: string;
  content: string;
  truncated: boolean;
}

export interface GitStatusEntry {
  path: string;
  index: string; // porcelain v1 staged status code
  worktree: string; // porcelain v1 unstaged status code
}

export interface GitStatusResponse {
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitLogResponse {
  entries: GitLogEntry[];
}

export interface GitDiffRequest {
  path: string;
  staged?: boolean;
}

export interface GitDiffResponse {
  path: string;
  diff: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

/**
 * Body of POST /fs/apply-edits — the ONLY path by which generated code ever
 * reaches disk, and only ever in response to the user clicking "Apply" on a
 * reviewed set of ProposedEdit entries (see cloud.ts). The desktop agent
 * re-validates every edit itself (path-traversal guard, modify-must-exist /
 * create-must-not-exist, a flag-only secret scan) rather than trusting that
 * the caller already did — see apps/desktop-agent/src/fsOps.ts#applyEdits.
 */
export interface ApplyEditsRequest {
  edits: ProposedEdit[];
}

export interface AppliedEditResult {
  path: string;
  action: "modify" | "create";
  status: "applied" | "skipped";
  /** Present when status is "skipped" — e.g. "file already exists" for a create, "file not found" for a modify, "path escapes project root", or "possible secret-shaped content — review manually". */
  reason?: string;
}

export interface ApplyEditsResponse {
  results: AppliedEditResult[];
}

/**
 * GET/PUT /settings — desktop-agent-wide, single-user configuration (PRD
 * §34-35, "Approval Engine" / configurable autonomy levels), also shared
 * (read-only) with apps/cloud-agent-gateway for `defaultModel` — see
 * packages/agent-settings, the small shared package both apps use to read
 * and write the same `~/.mobiusx/settings.json` file so a single Settings
 * screen change is visible to both processes without needing IPC between
 * them. Kept deliberately small: a handful of real, working controls
 * rather than a menu of settings that don't do anything yet.
 */
export interface AgentSettings {
  /**
   * Terminal command-guard autonomy level. "off" (default) is today's
   * reactive-only behavior — a flagged command still runs, interrupted
   * only best-effort after the fact (see policy.ts). "guarded" holds a
   * flagged line's terminating keystroke and requires an explicit
   * Approve/Reject (see the new TerminalClientMessage variants below)
   * before it ever reaches the shell — see terminalWs.ts for exactly
   * what "hold" means and its limits. Read once per terminal
   * connection: changing this takes effect on the NEXT terminal
   * connection, not retroactively on one already open.
   */
  terminalApprovalMode: "off" | "guarded";
  /**
   * Standing default model for AI Assistant tasks (multi-model support —
   * Llama/Qwen2.5-Coder/DeepSeek via OpenRouter or Groq, or a local Ollama
   * install, alongside Anthropic). Absent means "let the gateway choose
   * automatically" (see apps/cloud-agent-gateway/src/runners/registry.ts).
   * A per-task selection in the AI Assistant panel overrides this for that
   * one task without changing the standing default. Set via PUT /settings
   * on the desktop agent — the cloud gateway only ever reads this file, it
   * never writes to it.
   */
  defaultModel?: ModelSelection;
  /**
   * Autonomy level for the Autonomous Build/Test/Fix Loop (roadmap Phase 6,
   * source requirement §16). Mirrors terminalApprovalMode's off/guarded
   * shape rather than inventing a new autonomy model: "manual" (the
   * implicit default when this field is absent) means each Diagnose & Fix
   * cycle's proposed edits still require an explicit Apply click, same as
   * any other task's edits. "auto" lets the desktop shell apply a fix
   * task's edits automatically and immediately re-verify, repeating up to
   * a small capped number of iterations before it stops and reports an
   * honest "still failing after N attempts" rather than looping forever.
   * Absent (not defaulted to "manual" in storage) so an older
   * settings.json with no opinion on this behaves exactly like today's
   * fully-manual flow without needing a migration.
   */
  fixLoopMode?: "manual" | "auto";
}

/**
 * Body/response of POST /verify — "Verification Engine" (PRD §22): runs
 * the OPEN PROJECT's own verification scripts (from its package.json —
 * never commands the AI invents) and reports real pass/fail evidence, not
 * a claim. This is deliberately narrow for v1: root package.json `scripts`
 * only (a known limitation for monorepos — see
 * apps/desktop-agent/src/verify.ts#detectVerificationSteps), run via
 * `npm run <script>`, each with a bounded timeout and bounded captured
 * output. No request body is needed — it always verifies whichever
 * project is currently open (see projectState in desktop-agent).
 */
export interface VerificationStep {
  id: string;
  /** Human label, e.g. "Build (npm run build)". */
  label: string;
  /** The exact command that was run. */
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
  /** Combined stdout+stderr, bounded — see `truncated`. */
  output: string;
  truncated: boolean;
  durationMs: number;
}

export interface VerifyResponse {
  projectPath: string;
  /** "no-verification-available" means no known script (build/test/typecheck/lint) was found in package.json — not a failure, just nothing to run. */
  overall: "passed" | "failed" | "no-verification-available";
  steps: VerificationStep[];
}

/** One line item in a Project Completion Report — see ProjectCompletionReport below. */
export interface ProjectCompletionCriterion {
  /** Stable id, e.g. "verify:Build (npm run build)", "git_initialized", "auth_verified". */
  id: string;
  label: string;
  /**
   * "not_configured" means this capability isn't implemented/measured by
   * this codebase yet — see apps/desktop-agent/src/completion.ts's doc
   * comment. Never reported as a fabricated "pass" just because nothing
   * checks it yet.
   */
  status: "pass" | "fail" | "not_configured";
  detail?: string;
}

/**
 * Project Completion Contract (roadmap Phase 6, source requirement §31): a
 * real, computed report of what's actually verifiable about the open
 * project right now — never a claim that code was generated, always
 * evidence that it works. Computed by
 * apps/desktop-agent/src/completion.ts#computeCompletionReport and served
 * by GET /completion; also written to
 * `<project>/.mobiusx/PROJECT_COMPLETION.json` on every call so it's a
 * real, inspectable artifact, not just an API response.
 *
 * completionPercent is computed over MEASURED criteria only (pass+fail) —
 * "not_configured" criteria are excluded from the denominator entirely, so
 * an unimplemented capability can never silently drag the percentage down
 * (or, worse, be counted as passing) just because this build doesn't
 * measure it yet.
 */
export interface ProjectCompletionReport {
  projectPath: string;
  generatedAt: string;
  /** "unknown" only when there is nothing measurable at all yet (e.g. a brand-new, empty project with no package.json). */
  overall: "not_started" | "in_progress" | "verified" | "unknown";
  completionPercent: number;
  criteria: ProjectCompletionCriterion[];
}

/** Body of GET /completion — currently identical to ProjectCompletionReport; kept as a distinct alias so the route's response type can evolve (e.g. gain fields) independently of the on-disk artifact's shape later. */
export type ProjectCompletionResponse = ProjectCompletionReport;

/**
 * Project Understanding Engine (roadmap Phase 7, source requirement §5): a
 * category of the project's tech stack this codebase knows how to look
 * for. Kept as a closed union (not a free-form string) so a category with
 * zero detected components can still be reported honestly as "looked at,
 * found nothing" via ProjectContextReport.unknownCategories, the same
 * not_configured-not-omitted discipline ProjectCompletionReport uses.
 */
export type ProjectContextCategory = "frontend" | "backend" | "database" | "orm" | "auth" | "testFramework" | "infra";

/** One real, evidence-backed tech-stack detection — see ProjectContextReport below. */
export interface DetectedComponent {
  category: ProjectContextCategory;
  /** Human-readable name, e.g. "Next.js", "FastAPI", "SQLite". */
  name: string;
  /** Project-relative directory this was detected in ("." for the project root). */
  location: string;
  /** What on disk actually triggered this — a dependency name + version, a file path, or a matched connection-string pattern. Never a guess without a cited source. */
  evidence: string;
}

/**
 * Project Understanding Engine (roadmap Phase 7, source requirement §5): a
 * real, computed snapshot of what this project's tech stack actually is —
 * detected from on-disk evidence (package.json dependencies,
 * requirements.txt/pyproject.toml, Dockerfiles, connection strings), never
 * inferred from a project's name or the user's original prompt. Scans the
 * project root plus the same short list of common monorepo subdirectories
 * previewOps.ts already uses (frontend/backend/client/server/etc.), since
 * many generated projects (see GreenThumbGarden) have no root
 * package.json at all.
 *
 * unknownCategories lists every category this run genuinely found no
 * evidence for — kept distinct from "category absent from `components`"
 * so the UI/caller can tell "checked, found nothing" apart from "this
 * report predates that category existing" (the same honesty discipline as
 * ProjectCompletionCriterion's not_configured status).
 *
 * Also written to `<project>/.mobiusx/PROJECT_CONTEXT.md` (human-readable)
 * and `<project>/.mobiusx/project-context.json` (this exact shape) on
 * every call, best-effort — see projectContext.ts.
 */
export interface ProjectContextReport {
  projectPath: string;
  generatedAt: string;
  components: DetectedComponent[];
  unknownCategories: ProjectContextCategory[];
}

/** Body of GET /project-context. */
export type ProjectContextResponse = ProjectContextReport;

/**
 * Database Engineering (roadmap Phase 8, source requirement §8): one
 * table found in a schema/migration source (a `CREATE TABLE` statement),
 * or one entity found in an ORM model file — see DatabaseConsistencyReport
 * below. Kept as two separate arrays (schemaTables / ormEntities) rather
 * than merged, so a mismatch in either direction is visible: a table with
 * no matching model, or a model with no matching table.
 */
export interface DatabaseSchemaTable {
  name: string;
  /** File the CREATE TABLE (or equivalent) was found in, project-relative. */
  source: string;
  /** 1-indexed line within `source`. */
  line: number;
}

export interface DatabaseOrmEntity {
  /** The ORM class name, e.g. "User". */
  name: string;
  /** The table name this entity actually maps to (explicit __tablename__/table_name, or the ORM's own default-casing convention applied to `name` when none is given). */
  tableName: string;
  source: string;
  line: number;
}

/** One requirement gap or mismatch between the schema and the ORM models — see DatabaseConsistencyReport.mismatches. */
export interface DatabaseConsistencyMismatch {
  kind: "table_without_model" | "model_without_table";
  tableName: string;
  detail: string;
}

/**
 * One real foreign-key relationship found on either side of the
 * schema/ORM boundary (roadmap Phase 9, source requirement §7: the ER
 * diagram must draw real relationships, never invented ones). `from`/`to`
 * are table names exactly as declared at the source — this is a literal
 * transcription of a `REFERENCES table(col)` / `foreign_key="table.col"`
 * value, not a resolved/validated edge (see dbOps.ts's Phase 8 phase-notes
 * for why FK-target validation is intentionally out of scope here: a
 * relationship can point at a table name that doesn't actually exist, and
 * this type still records it faithfully rather than silently dropping or
 * "fixing" it).
 */
export interface DatabaseRelationship {
  from: string;
  to: string;
  /** e.g. "product_id -> id" — the real column pair, as declared. */
  via: string;
  source: string;
  line: number;
}

/**
 * Database Engineering (roadmap Phase 8, source requirement §8): a real,
 * computed cross-check between a project's schema/migration source(s) and
 * its ORM model file(s) — the "domain-model -> ER -> schema -> ORM ->
 * API consistency check" the source requirement asks for, scoped for v1 to
 * schema<->ORM (the two ends this codebase can parse without a real SQL/AST
 * parser — see dbOps.ts's doc comment for exactly what's supported and
 * what's honestly reported as not_configured instead of guessed).
 *
 * overall is "unknown" only when no schema source AND no ORM model file
 * was found at all (nothing to check yet, not a claim that it's fine).
 */
export interface DatabaseConsistencyReport {
  projectPath: string;
  generatedAt: string;
  /** The ORM/dialect convention this scan actually understood, e.g. "SQLModel/SQLAlchemy (Python)" — or null when nothing recognizable was found. Never a guess; see dbOps.ts. */
  ormDetected: string | null;
  schemaTables: DatabaseSchemaTable[];
  ormEntities: DatabaseOrmEntity[];
  mismatches: DatabaseConsistencyMismatch[];
  /** Real FK relationships found on the schema side and/or the ORM side, deduplicated by (from, via, to). Empty when none were found — never fabricated for a diagram's sake. */
  relationships: DatabaseRelationship[];
  overall: "consistent" | "mismatches_found" | "unknown";
}

/** Body of GET /db/consistency. */
export type DatabaseConsistencyResponse = DatabaseConsistencyReport;

/**
 * Architecture Generation (roadmap Phase 9, source requirement §7): one
 * real HTTP route/handler found in the project's own backend or API-route
 * code -- never an invented endpoint. `method` is the real HTTP verb
 * ("GET"/"POST"/...), or "HANDLER" when a file-based route (e.g. a
 * Next.js Pages Router API file) was found but the verb couldn't be
 * determined without executing it -- reported honestly rather than
 * guessed. Feeds the Sequence and Component diagrams: a diagram may only
 * show a request flow that traces back to one of these.
 */
export interface DetectedRoute {
  method: string;
  path: string;
  source: string;
  line: number;
}

/**
 * One real third-party service SDK/dependency found in the project
 * (Stripe, Twilio, Redis, OpenAI, ...) -- feeds the System Context
 * diagram's external systems. A project with none detected gets an empty
 * array, never an invented "External API" placeholder box.
 */
export interface DetectedExternalIntegration {
  name: string;
  evidence: string;
}

/**
 * The full evidence bundle Architecture mode's prompt is grounded in --
 * assembled once per generation request from Phase 7's project-context
 * detection, Phase 8's database consistency check, plus two new,
 * equally evidence-only detectors (routes, external integrations). This
 * is the mechanism behind Phase 9's core design goal: the model's job is
 * to faithfully render this evidence as Mermaid diagrams and prose, not
 * to invent architecture from a one-line prompt -- see
 * docs/phase-notes/phase-9-architecture-generation.md for why "basic,
 * generic diagrams" is a grounding problem, not a prompting-style
 * problem, and how this bundle addresses it directly.
 */
export interface ArchitectureEvidence {
  projectPath: string;
  generatedAt: string;
  projectContext: ProjectContextReport;
  database: DatabaseConsistencyReport;
  routes: DetectedRoute[];
  externalIntegrations: DetectedExternalIntegration[];
  /** Real CORS allow_origins / dev-server URLs found linking a detected frontend to a detected backend, e.g. "http://localhost:3000" -- used to label the real protocol/port on a Container diagram edge instead of a generic unlabeled arrow. Empty when none found. */
  frontendBackendLinks: string[];
}

/** Body of GET /architecture-evidence. */
export type ArchitectureEvidenceResponse = ArchitectureEvidence;

/**
 * Messages sent from the renderer, over the /terminal WebSocket, to the
 * agent. A real PTY session (see apps/desktop-agent/src/terminalWs.ts) is
 * raw byte pass-through, not request/response commands: "input" carries
 * exactly what the user typed (including control characters — Ctrl+C,
 * arrow keys, etc. arrive as their usual escape sequences), and "resize"
 * keeps the PTY's own notion of terminal size in sync with the panel so
 * full-screen programs (vim, htop, a REPL) render correctly.
 *
 * "approve"/"reject" only mean anything while AgentSettings.terminalApprovalMode
 * is "guarded" AND the server has a held command awaiting a decision (a
 * "policy" message arrived with requiresApproval: true) — see
 * terminalWs.ts. Sent with no other payload since there is at most one
 * pending decision per connection.
 */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "approve" }
  | { type: "reject" };

/** Messages sent from the agent back to the renderer over /terminal. */
export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal?: number }
  | { type: "error"; message: string }
  /**
   * A submitted command line matched a Phase 5 command-guard rule (see
   * apps/desktop-agent/src/policy.ts). When `requiresApproval` is absent
   * or false (the "off" autonomy level, or guard-matches that aren't
   * gated), this is purely informational — sent alongside a best-effort
   * interrupt, the command may already be running. When `requiresApproval`
   * is true (the "guarded" autonomy level), the command's terminating
   * keystroke has been HELD, not yet sent to the shell — the renderer
   * must send back "approve" or "reject" for it to be resolved.
   */
  | { type: "policy"; matches: PolicyMatch[]; requiresApproval?: boolean };
