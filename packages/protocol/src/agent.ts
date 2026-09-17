/**
 * Desktop <-> Local Agent contract (HTTP + WebSocket).
 *
 * The Local Agent Service (apps/desktop-agent) runs on 127.0.0.1 only and is
 * paired with the Electron shell via a per-launch bearer token (see
 * AgentHandshake). Nothing here is exposed to the network.
 */

import type { PolicyMatch } from "./governance.js";
import type { AgentMode, ModelSelection, ProposedEdit } from "./cloud.js";

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
  /** Present only when at least one "after-api-change" hook fired for this apply (see HookRule below) -- absent, not [], when no hooks were configured at all. */
  hookResults?: HookRunResult[];
}

/**
 * Project Memory/Steering + Hooks (roadmap Phase 16, source requirement
 * §24/§25). A steering file is a plain markdown file under
 * `.mobiusx/steering/` that the user (or the agent, on request) writes
 * once -- real architecture/security/api-standards/testing conventions
 * for THIS project -- and every subsequent AI Assistant request in any
 * mode is grounded in it automatically (see ProjectContext.steeringContext
 * in cloud.ts and promptShared.ts#steeringContextBlock). Never generated
 * or guessed by this app; only ever written because the user (or an
 * explicit agent-authored save) put it there.
 */
export interface SteeringFile {
  /** Filename without the .mobiusx/steering/ prefix or .md extension, e.g. "architecture". */
  name: string;
  /** Absolute path on disk. */
  path: string;
  content: string;
  updatedAt: string;
}

export interface SteeringListResponse {
  files: SteeringFile[];
  /** Absolute path to .mobiusx/steering/, or null if no project is open. */
  dir: string | null;
}

export interface SteeringWriteRequest {
  /** Safe filename stem -- letters, numbers, hyphen, underscore only, no extension/slashes. */
  name: string;
  content: string;
}

/**
 * Event-driven hooks (roadmap Phase 16, source requirement §25's second
 * half). A project opts in by hand-writing `.mobiusx/hooks.json` --
 * same one-way-ratchet honesty as policy.ts's `.mobiusx/policy.json`
 * (a malformed file is ignored in full, never partially applied, and the
 * parse error is surfaced rather than swallowed). Two real trigger points
 * exist today, both wired into machinery this codebase already runs
 * rather than a new background scheduler:
 *  - "after-api-change": evaluated right after POST /fs/apply-edits
 *    writes real files to disk (see fsOps.ts#applyEdits) -- a rule whose
 *    `pathPattern` regex matches at least one just-applied path's relPath
 *    fires, e.g. regenerating an OpenAPI spec after a routes file changes.
 *  - "before-commit": evaluated reactively in the embedded terminal (see
 *    terminalWs.ts) the moment a submitted line matches `git commit` --
 *    the same "reactive, not preventive" honesty policy.ts's own doc
 *    comment already establishes for this PTY (a real interactive
 *    terminal can't be transparently gated before the shell sees a
 *    keystroke without breaking arrow-key history/tab completion). A
 *    failing before-commit hook gets the same best-effort Ctrl+C
 *    policy.ts uses for a flagged destructive command.
 */
export type HookEvent = "before-commit" | "after-api-change";

export interface HookRule {
  id: string;
  event: HookEvent;
  /** Full shell command line, run with the project root as cwd (e.g. "npm test", "npm run docs:openapi"). */
  command: string;
  description?: string;
  /**
   * Only meaningful for "after-api-change": a regex (source string, same
   * survives-JSON convention as PolicyRule.pattern) tested against every
   * relPath that POST /fs/apply-edits just actually applied. Absent means
   * the rule fires on ANY applied edit, not scoped to API files.
   */
  pathPattern?: string;
}

export interface HooksConfigResponse {
  rules: HookRule[];
  /** Absolute path to the project's .mobiusx/hooks.json, or null if none is open/none exists. */
  path: string | null;
  /** Set when a hooks file exists but couldn't be used (malformed JSON, bad regex, wrong shape) -- the file is ignored entirely rather than partially applied, and this says why. */
  error: string | null;
}

export interface HookRunResult {
  ruleId: string;
  event: HookEvent;
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  output: string;
  durationMs: number;
}

/**
 * Broader MCP tool support (source requirement §28 -- folded into this
 * build rather than a standalone roadmap phase, per
 * docs/AI_ENGINEERING_PLATFORM_ROADMAP.md's own footnote). A project opts
 * in by hand-writing `.mobiusx/mcp.json` -- same shape convention Claude
 * Desktop/Claude Code use for MCP server config, so an existing config is
 * often just copy-pasteable -- and each `enabled` server is spawned over
 * stdio (the real Model Context Protocol, via @modelcontextprotocol/sdk)
 * by @mobiusx/mcp-client, shared by both apps/desktop-agent (Settings UI:
 * connect/list tools) and apps/cloud-agent-gateway (actually calling a
 * tool mid-task -- see anthropicRunner.ts's tool-use loop).
 */
export interface McpServerConfig {
  /** Unique key within .mobiusx/mcp.json -- also the namespace prefix for this server's tools (e.g. "filesystem__read_file"). */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface McpConfigResponse {
  servers: McpServerConfig[];
  path: string | null;
  error: string | null;
}

export interface McpToolInfo {
  /** Namespaced as "<serverName>__<toolName>" -- what a model's tool-use call and POST /mcp/tools/call both use. */
  name: string;
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  error?: string;
  tools: McpToolInfo[];
}

export interface McpStatusResponse {
  servers: McpServerStatus[];
}

export interface McpToolCallRequest {
  /** Namespaced "<serverName>__<toolName>". */
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpToolCallResponse {
  tool: string;
  isError: boolean;
  /** Flattened text content from the MCP tool result -- images/other content types are summarized, never dropped silently (see mcp-client's doc comment). */
  content: string;
}

/**
 * Enterprise Knowledge / Global Intelligence local substitute (roadmap
 * Phase 17, source requirement §29/§30). MobiusX Cloud's real EK/GI
 * backends don't exist to integrate against yet (see the roadmap's own
 * "genuinely blocked" note) -- rather than fake a connection to a system
 * that isn't there, this is a REAL, fully local knowledge base: the user
 * adds one or more folders of their own docs (an internal wiki export,
 * README collection, ADRs, coding standards -- anything markdown/text),
 * this app indexes them (@mobiusx/semantic-index's embedding math, reused
 * -- see knowledgeOps.ts), and relevant snippets are retrieved into
 * generation prompts the same way relevantFiles already grounds Build
 * mode in real code (see ProjectContext.knowledgeContext in cloud.ts).
 * Deliberately GLOBAL (stored under ~/.mobiusx/knowledge/, not a single
 * project's .mobiusx/) since real enterprise knowledge spans projects --
 * the one real differentiator from Phase 2's per-project code index.
 */
export interface KnowledgeSource {
  id: string;
  label: string;
  /** Absolute path to a folder on disk. */
  path: string;
  addedAt: string;
}

export interface KnowledgeSourcesResponse {
  sources: KnowledgeSource[];
}

export interface KnowledgeIndexStats {
  sourceId: string;
  filesConsidered: number;
  filesIndexed: number;
  chunksIndexed: number;
  totalChunksInStore: number;
  durationMs: number;
}

export interface KnowledgeIndexResponse {
  results: KnowledgeIndexStats[];
}

export interface KnowledgeSearchHit {
  sourceId: string;
  sourceLabel: string;
  relPath: string;
  heading: string | null;
  snippet: string;
  score: number;
}

export interface KnowledgeSearchResponse {
  hits: KnowledgeSearchHit[];
  durationMs: number;
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
  /**
   * Per-task-type model routing (roadmap Phase 11, source §27): a standing
   * choice of which model handles a given AgentMode, distinct from BOTH the
   * single overall `defaultModel` above and a one-off per-task override in
   * the AI Assistant panel. Resolution order (see
   * apps/cloud-agent-gateway/src/runners/registry.ts#resolveRunner): a
   * per-task override always wins first; then, for that task's specific
   * mode, this map; then `defaultModel`; then automatic selection. Absent
   * entirely, or missing a given mode's key, means "no routing rule for
   * this mode" — falls through to `defaultModel`/automatic exactly as
   * before this phase, so an older settings.json with no opinion on this
   * needs no migration. Example use: always send "architecture" mode's
   * larger evidence-bundle prompts to a stronger model while leaving
   * routine "ask" queries on a faster/cheaper one.
   */
  modelRouting?: Partial<Record<AgentMode, ModelSelection>>;
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

/**
 * Body/response of POST /browser-validate — "Browser / Application
 * Validation" (roadmap Phase 12, source requirement §18): drives the
 * ALREADY-RUNNING preview (see previewOps.ts / POST /preview/start) with a
 * real headless browser (apps/desktop-agent/src/browserOps.ts) and reports
 * genuine evidence -- console errors, failed network requests, and a
 * screenshot -- never a simulated result. Deliberately independent of
 * VerificationStep (a browser navigation has no exit code, and carries an
 * optional screenshot VerificationStep doesn't) but intentionally KEEPS
 * the same {label, command, output} shape that FailingVerificationStep
 * needs, so a failing browser step can feed the exact same Fix Loop
 * (ProjectContext.failingVerification) that verify.ts's results already
 * do, with zero further protocol changes -- see promptShared.ts's "fix"
 * mode prompt, which only ever reads label/command/output off each entry.
 */
export interface BrowserValidationStep {
  id: string;
  /** Human label, e.g. "Open http://localhost:5173/" or "Open http://localhost:5173/pricing". */
  label: string;
  /** What was actually driven — never a command line, since this isn't a spawned process. */
  command: string;
  status: "passed" | "failed" | "timed_out";
  /** The real URL this step navigated to — always the frontend preview's own discovered URL or a same-origin link found in its rendered DOM, never invented. */
  url: string;
  /** Console `error`/`warning` messages captured from the real page (bounded count). */
  consoleErrors: string[];
  /** Failed same-page network requests captured (HTTP >=400 or a real request failure), bounded count. */
  networkErrors: string[];
  /** Human-readable combination of any navigation/page error plus consoleErrors/networkErrors -- this is what's embedded verbatim into the Fix Loop prompt when this step fails, exactly as VerificationStep.output already is. */
  output: string;
  /** Bounded-size JPEG screenshot at the end of this step, as a data: URI. Omitted only when capture itself failed. */
  screenshot?: string;
  durationMs: number;
}

export interface BrowserValidationResponse {
  projectPath: string;
  /** The frontend preview URL validation started from, or null when no preview was running yet -- see previewUnavailableReason for why. */
  previewUrl: string | null;
  /** Set only when previewUrl is null — an honest reason, never a silently empty result. */
  previewUnavailableReason?: string;
  overall: "passed" | "failed" | "no-preview-running";
  steps: BrowserValidationStep[];
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
 * Error Intelligence + Debugger v2 (roadmap Phase 13, source requirement
 * §19/§20): one real fact in a browser-observed failure's trace chain,
 * ordered browser -> frontend -> api -> backend -> database. Every field
 * here cites something that was actually observed or actually found in
 * this project's own files -- never a guess about what "probably"
 * happened. `source`/`line` are present only when the evidence is a real
 * file location (a matched DetectedRoute, an ORM entity, a regex-
 * extracted frontend stack-trace hint that was verified to exist on
 * disk); a raw captured error string (console text, a network status
 * line, a preview log excerpt) has neither.
 */
export interface TraceEvidence {
  layer: "browser" | "frontend" | "api" | "backend" | "database";
  label: string;
  detail: string;
  source?: string;
  line?: number;
}

/**
 * A small, fixed set of root-cause buckets -- every one of them is
 * reachable only by a specific, cited combination of real evidence (see
 * errorIntelligence.ts's classifyStep doc comment for exactly which).
 * "unclassified" is a legitimate, honest outcome, not a bug: it means
 * real evidence was captured but didn't match any of the other
 * categories' required evidence combination -- reported as such rather
 * than force-fit into the nearest-sounding bucket.
 */
export type RootCauseCategory =
  | "frontend-runtime-error"
  | "backend-unreachable"
  | "route-not-implemented"
  | "backend-error-db-layer"
  | "backend-error-logic"
  | "client-error"
  | "unclassified";

/**
 * One browser-observed failure (from a single BrowserValidationStep),
 * traced as far down the real stack as actual evidence allows and
 * classified into a RootCauseCategory. `reasoning` is generated
 * deterministically from the fields already present in `evidence` --
 * never a separate model call -- so every sentence in it can be checked
 * against a concrete evidence entry, the same "evidence over invention"
 * discipline as ArchitectureEvidence and DatabaseConsistencyReport.
 */
export interface ErrorTrace {
  id: string;
  stepLabel: string;
  url: string;
  category: RootCauseCategory;
  confidence: "high" | "medium" | "low";
  evidence: TraceEvidence[];
  reasoning: string;
}

/**
 * Body of POST /debug/error-intelligence. Extends Phase 2's static Debug
 * view (semantic search + git history) into the full-stack tracing +
 * root-cause classification the roadmap's Phase 13 entry asks for, built
 * entirely from evidence two earlier phases already produce: Phase 12's
 * runBrowserValidation (the browser-layer symptoms) and Phase 9's
 * gatherArchitectureEvidence (the real routes + database evidence to
 * trace those symptoms down into). No new runtime instrumentation is
 * injected into the user's project -- this correlates evidence that
 * already exists rather than adding request tracing to arbitrary
 * generated FastAPI/Express/Next.js backends, which this desktop app has
 * no mechanism to do (previewOps.ts only spawns those processes as
 * opaque child processes).
 */
export interface ErrorIntelligenceReport {
  projectPath: string;
  generatedAt: string;
  previewUrl: string | null;
  /** Mirrors BrowserValidationResponse.overall's "no-preview-running" case honestly -- tracing requires the same running preview browser validation itself requires. */
  overall: "no-preview-running" | "no-errors-observed" | "errors-found";
  previewUnavailableReason?: string;
  traces: ErrorTrace[];
}

/**
 * Testing Engine (roadmap Phase 10, source requirement §15): a real
 * existing test file this project already has -- gathered so Testing
 * mode's prompt can show the model a REAL example of this project's own
 * test framework idioms, import layout, and assertion style rather than
 * inventing a generic one, the same "evidence over invention" discipline
 * ArchitectureEvidence's routes/relationships fields already use. `[]` on
 * TestingEvidence.existingTestFiles means honestly what it says -- this
 * project has no test files yet -- not that none were looked for.
 */
export interface ExistingTestFileSample {
  relPath: string;
  content: string;
}

/**
 * The evidence bundle Testing mode's prompt (and Build mode's optional
 * companion-test instruction) is grounded in -- gathered by
 * apps/desktop-agent/src/testingContext.ts. `testFrameworks` reuses Phase
 * 7's own project-context detection (DetectedComponent entries with
 * category "testFramework") rather than re-guessing a framework from
 * scratch -- if this project has no test framework installed for the
 * language being tested, `testFrameworks` is honestly empty and the
 * prompt is instructed to say so and propose nothing, never invent one
 * (e.g. assume Jest for a project with no JS test dependency at all).
 */
export interface TestingEvidence {
  projectPath: string;
  generatedAt: string;
  testFrameworks: DetectedComponent[];
  /** Up to a small handful of this project's own existing test files, full content -- see ExistingTestFileSample's doc comment. */
  existingTestFiles: ExistingTestFileSample[];
}

/** Body of GET /testing-evidence. */
export type TestingEvidenceResponse = TestingEvidence;

/**
 * DevOps/Infrastructure Generation (roadmap Phase 14, source requirement
 * §21): one existing infra artifact this project already has on disk
 * (a Dockerfile, docker-compose.yml/.yaml, or a GitHub Actions workflow
 * file), full content -- gathered so DevOps mode's prompt can propose a
 * "modify" against a real, already-reviewed file instead of blindly
 * "create"-ing over it (the exact same "CREATE on an existing file gets
 * silently skipped by Apply" failure mode Database mode hit in Phase 8,
 * and the same evidence-over-invention discipline ExistingTestFileSample
 * already established for Testing mode). `[]` on
 * DevopsEvidence.existingInfraFiles means honestly what it says -- no
 * infra files exist here yet -- not that none were looked for.
 */
export interface ExistingInfraFile {
  relPath: string;
  content: string;
}

/**
 * DevOps/Infrastructure Generation (roadmap Phase 14): one of this
 * project's OWN real build/test/lint commands, exactly as verify.ts's own
 * detectors (detectVerificationSteps/detectPythonTestSteps) compute them
 * for "Run Verification" -- reused here verbatim, never re-derived or
 * re-guessed, so the CI pipeline this mode generates runs literally the
 * same commands this app already runs and already trusts. `cwd` is
 * project-relative ("." for the project root), matching the directory the
 * real command actually runs in (a Python backend's pytest suite runs
 * inside its own subdirectory, not the project root -- see
 * detectPythonTestSteps).
 */
export interface DevopsVerificationStep {
  label: string;
  command: string;
  cwd: string;
}

/**
 * The evidence bundle DevOps mode's prompt (roadmap Phase 14, source
 * requirement §21 -- "Docker/Compose/K8s/Terraform + CI/CD pipeline
 * files, through the same edits pipeline as everything else," builds on
 * Phase 6) is grounded in -- gathered by
 * apps/desktop-agent/src/devopsContext.ts. Follows the exact same
 * root-cause diagnosis every generation mode before it has already made
 * (Database/Phase 8, Architecture/Phase 9, Testing/Phase 10): a model
 * asked to write a Dockerfile/CI pipeline with zero real facts about this
 * project's actual services, ports, and build/test commands has nothing
 * to go on but generic, often-wrong boilerplate (a Dockerfile that COPYs
 * the wrong directory, a CI workflow that runs "npm test" a project
 * doesn't define). `projectContext` reuses Phase 7's own detection
 * (frontend/backend components + locations, and any infra ALREADY
 * detected there -- see ProjectContextCategory's "infra" case) rather
 * than re-guessing the stack; `existingInfraFiles` and `verificationSteps`
 * are this phase's own two additions, described above.
 */
export interface DevopsEvidence {
  projectPath: string;
  generatedAt: string;
  projectContext: ProjectContextReport;
  existingInfraFiles: ExistingInfraFile[];
  verificationSteps: DevopsVerificationStep[];
}

/** Body of GET /devops-evidence. */
export type DevopsEvidenceResponse = DevopsEvidence;

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
  | { type: "policy"; matches: PolicyMatch[]; requiresApproval?: boolean }
  /**
   * A completed terminal line matched `git commit` and this project has
   * at least one enabled "before-commit" hook (see HookRule above). Sent
   * AFTER the hook(s) already ran (this is reactive, same caveat as
   * "policy" above) -- `blocked: true` means at least one hook failed and
   * a best-effort Ctrl+C was already sent; `blocked: false` means every
   * configured before-commit hook passed and the commit was left alone.
   */
  | { type: "hook"; event: HookEvent; results: HookRunResult[]; blocked: boolean };
