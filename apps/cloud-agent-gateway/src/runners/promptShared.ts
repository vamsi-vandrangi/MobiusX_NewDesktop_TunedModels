import type { ProposedEdit } from "@mobiusx/protocol";
import type { RunnerInput } from "./types.js";

/**
 * Prompting and structured-edit-parsing logic shared by every "chat-style"
 * runner (anthropic, openrouter, groq, ollama) — originally lived only in
 * anthropicRunner.ts, extracted here once more providers needed the exact
 * same system prompts and the exact same build/spec-mode edits convention,
 * so behavior can't drift between providers just because one runner's copy
 * got tweaked and another's didn't. anthropicRunner.ts re-exports
 * EDITS_MARKER/parseBuildResponse from here so existing imports of those
 * names keep working unchanged.
 */

/** Marks the boundary between the model's human-readable summary and the machine-readable edits JSON block in a build/spec-mode response. Never shown to the user. */
export const EDITS_MARKER = "===MOBIUSX_EDITS===";

/** Modes whose response is buffered and parsed for a structured ProposedEdit[] block, rather than streamed live token-by-token. */
export const MODES_WITH_STRUCTURED_EDITS = new Set<RunnerInput["mode"]>(["build", "spec", "fix", "database", "architecture", "testing"]);

/**
 * Splits a build-mode response into its human-readable prose and its
 * proposed edits, and validates every edit against the one safety
 * invariant this gateway can actually check without disk access: a
 * "modify" is only honored if the model was shown that path's FULL
 * content (not just a search snippet) earlier in this same request — see
 * ProjectContext.relevantFiles in @mobiusx/protocol. "create" can't be
 * validated here (the gateway never has a real file listing) — the
 * desktop agent enforces create-must-not-exist itself before writing
 * anything (see apps/desktop-agent/src/fsOps.ts#applyEdits). Parsing is
 * deliberately lenient: if the marker or JSON is missing or malformed,
 * this returns the raw text as prose and an empty edits list rather than
 * throwing — a build-mode task that didn't produce a parseable proposal
 * should still show its reasoning, not fail outright. This matters even
 * more now that not every provider is Anthropic-quality at reliably
 * following the marker convention — a model that ignores it degrades to
 * plain prose, not a crash.
 */
/**
 * Defends against a real, observed failure mode: a free/open-weight model
 * (confirmed live: openai/gpt-oss-120b via Groq, generating a FastAPI
 * backend) can double-escape backslashes when JSON-encoding multi-line file
 * content -- writing the four characters backslash-backslash-n instead of
 * backslash-n for a line break. JSON.parse decodes that correctly per spec
 * into a literal two-character "\n" string (backslash then n) -- so the bug
 * isn't in JSON.parse or in our parsing, the model's JSON was already wrong
 * -- but the result, written verbatim to disk, is a file with literal
 * backslash-n text instead of real line breaks. Confirmed live: the
 * resulting requirements.txt failed `pip install -r` with
 * "Invalid requirement: 'fastapi\\nuvicorn...'".
 *
 * Heuristic, applied only when it's very unlikely to misfire: repair ONLY
 * when the content has zero real newlines (a correctly-escaped multi-line
 * file always has some after a correct JSON.parse) AND contains at least
 * one literal backslash-n run. Legitimate single-line content that merely
 * mentions the text "\n" is rare enough, and multi-line source/config
 * files this fixes are common enough, that this trade-off is worth it.
 */
function repairOverEscapedContent(content: string): string {
  if (content.includes("\n")) return content;
  if (!/\\n/.test(content)) return content;
  return content.replace(/\\(n|t|r|"|\\)/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return _;
    }
  });
}

export function parseBuildResponse(
  fullText: string,
  input: RunnerInput,
): { prose: string; edits: ProposedEdit[]; droppedCount: number } {
  const markerIdx = fullText.indexOf(EDITS_MARKER);
  if (markerIdx === -1) return { prose: fullText, edits: [], droppedCount: 0 };

  const prose = fullText.slice(0, markerIdx).trim();
  const rest = fullText.slice(markerIdx + EDITS_MARKER.length);

  // Strip a ```json ... ``` (or bare ``` ... ```) fence if present; otherwise use the raw remainder.
  const fenceMatch = rest.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : rest).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { prose, edits: [], droppedCount: 0 };
  }

  const rawEdits =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { edits?: unknown }).edits)
      ? (parsed as { edits: unknown[] }).edits
      : [];

  const modifiableRelPaths = new Set(
    (input.projectContext?.relevantFiles ?? []).filter((f) => f.content !== undefined).map((f) => f.relPath),
  );

  const edits: ProposedEdit[] = [];
  let droppedCount = 0;
  for (const raw of rawEdits) {
    if (!raw || typeof raw !== "object") {
      droppedCount++;
      continue;
    }
    const e = raw as { path?: unknown; action?: unknown; content?: unknown };
    if (typeof e.path !== "string" || !e.path || typeof e.content !== "string") {
      droppedCount++;
      continue;
    }
    if (e.action !== "modify" && e.action !== "create") {
      droppedCount++;
      continue;
    }
    // Cheap sanity check — the desktop agent's resolveWithinProject is the real guard,
    // but there's no reason to even propose something this obviously wrong.
    if (e.path.startsWith("/") || e.path.split("/").includes("..")) {
      droppedCount++;
      continue;
    }
    if (e.action === "modify" && !modifiableRelPaths.has(e.path)) {
      droppedCount++;
      continue;
    }
    edits.push({ path: e.path, action: e.action, content: repairOverEscapedContent(e.content) });
  }

  return { prose, edits, droppedCount };
}

export function systemPromptFor(input: RunnerInput): string {
  if (input.mode === "ask") {
    return (
      "You are the MobiusX Desktop AI Assistant, answering a developer's question." + relevantFilesContext(input, false)
    );
  }
  if (input.mode === "plan") {
    return (
      "You are the MobiusX Desktop AI Assistant. Draft a concrete, numbered implementation plan — do not write full code." +
      relevantFilesContext(input, false)
    );
  }
  if (input.mode === "spec") {
    // Project Understanding + Specification Engine (roadmap Phase 7,
    // source requirement §6): acceptance criteria are no longer just
    // Given/When/Then prose -- each one gets a stable REQ-NNN id (numbered
    // continuously across BOTH functional and non-functional requirements,
    // in the order they appear in the markdown doc) and a second,
    // machine-readable JSON twin is emitted alongside the markdown, so the
    // UI can render a real checklist instead of parsing prose. The
    // markdown doc remains the human-facing artifact; the JSON is never
    // meant to be read standalone.
    return [
      "You are the MobiusX Desktop AI Assistant in SPEC mode — a Requirements Engineering assistant (not a coder in this mode).",
      "Given the user's natural-language request, write a structured requirements specification as a single markdown document with EXACTLY these sections, in this order: '## Overview', '## Functional Requirements' (numbered), '## Non-Functional Requirements' (numbered), '## Constraints & Assumptions', '## Risks', '## Acceptance Criteria'.",
      "EVERY requirement in '## Functional Requirements' and '## Non-Functional Requirements' must be prefixed with a stable id in the form 'REQ-001', 'REQ-002', ... — numbered continuously across both sections in the order they appear (do not restart numbering for non-functional requirements). Example line: '1. **REQ-001** — The system shall let a user reset their password via emailed link.'",
      "In '## Acceptance Criteria', write one Given/When/Then scenario per requirement, each labeled with the SAME REQ-NNN id it tests, e.g. '**REQ-001** — Given a registered user on the login page, When they click \"Forgot password\" and submit their email, Then a reset link is emailed within 60 seconds.' Every REQ-NNN from the requirements sections must have at least one acceptance criterion; never introduce a REQ-NNN id in this section that wasn't defined above.",
      "If the request is ambiguous or missing information a real spec would need, do not guess silently — add those as explicit open questions under a '## Open Questions' section instead of inventing requirements the user never stated.",
      "First, write a one-to-two-sentence prose summary of what you're specifying.",
      `Then, on its own line, output exactly ${EDITS_MARKER} followed by a single fenced json code block with this exact shape (TWO edits — the markdown doc AND its structured JSON twin, both required):`,
      '{"edits": [' +
        '{"path": ".mobiusx/specs/<kebab-case-slug>.md", "action": "create", "content": "the complete markdown spec document"}, ' +
        '{"path": ".mobiusx/specs/<kebab-case-slug>.json", "action": "create", "content": "{\\"feature\\": \\"short title\\", \\"slug\\": \\"<kebab-case-slug>\\", \\"requirements\\": [{\\"id\\": \\"REQ-001\\", \\"category\\": \\"functional\\", \\"statement\\": \\"the requirement text, no id prefix\\", \\"acceptanceCriteria\\": [{\\"given\\": \\"...\\", \\"when\\": \\"...\\", \\"then\\": \\"...\\"}]}], \\"openQuestions\\": []}"}' +
      ']}',
      "Each requirement's \"category\" must be exactly the string \"functional\" or \"non-functional\" (never both, and never any other value). Use the exact same <kebab-case-slug> for both files' paths. The .json file's \"content\" is itself a JSON string (escaped exactly as shown) containing every REQ-NNN from the markdown doc with its category, statement, and acceptance criteria — this must stay in exact sync with the markdown; never list a REQ-NNN in one file but not the other. Choose a short, descriptive kebab-case slug for the filename based on the feature being specified (e.g. \"subscription-management\"). Always use action \"create\" for both files — never \"modify\" in this mode.",
      relevantFilesContext(input, false),
    ].join("\n");
  }

  if (input.mode === "fix") {
    // Autonomous Build/Test/Fix Loop (roadmap Phase 6, source requirement
    // §16): reuses the exact same edits format/parsing as BUILD mode
    // (parseBuildResponse doesn't branch on mode at all) -- the only real
    // difference is what grounds the prompt: real captured verification
    // failure output (ProjectContext.failingVerification) instead of a
    // user's free-form feature request, and an explicit instruction to
    // change as little as possible.
    const fixFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    const failing = input.projectContext?.failingVerification ?? [];
    const evidence =
      failing.length > 0
        ? `\n\nReal verification evidence -- these step(s) FAILED just now when this project's own build/test/lint/typecheck scripts were run (see POST /verify):\n${failing
            .map((s) => `--- ${s.label} (${s.command}) ---\n${s.output}`)
            .join("\n\n")}`
        : "\n\nNo specific failing-step evidence was attached to this task -- diagnose from the project context below as best you can, and say so plainly in your summary.";

    return [
      "You are the MobiusX Desktop AI Assistant in FIX mode (Autonomous Build/Test/Fix Loop, roadmap Phase 6) -- diagnosing and repairing a REAL verification failure, not responding to a free-form feature request.",
      "Your job is to propose the MINIMAL set of file edits that fix the failing step(s) below. Do not refactor, rename, reformat, or \"improve\" anything unrelated to the failure -- a fix that changes more than it needs to makes the next verification pass harder to trust, not easier.",
      "If the evidence below is insufficient to diagnose a real fix (e.g. the output doesn't point at a specific file or line), say so plainly in your prose summary and propose your best-supported hypothesis rather than guessing silently.",
      "CRITICAL OUTPUT FORMAT -- follow this exactly, even for a multi-file fix:",
      "1. First write a brief prose summary (2-4 sentences) of what was failing and what you're changing to fix it. Do NOT describe individual files in prose, and do NOT put any file's contents in a markdown code fence in this summary.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing EVERY file you\'re creating or changing, as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path.ts", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      'Do not split files across multiple json blocks, and do not write any file\'s content anywhere except inside this one "edits" array (not in prose, not in a separate markdown code fence).',
      '"content" must be the entire new file content, never a diff, patch, or partial snippet -- even for a one-line fix, return the COMPLETE file with that line changed.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n (a single backslash followed by n). Do NOT double it to \\\\n (two backslashes) -- that writes literal backslash-n text into the file instead of a real line break.",
      fixFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${fixFullContentPaths.join(", ")}. Do not use "modify" for any other path.`
        : 'You were not shown the full content of any existing file, so do not use action "modify" at all -- only "create" a genuinely new path, and only if the fix genuinely requires one (rare for a fix).',
      'Only use action "create" for a path you are confident does not already exist in this project.',
      `Omit the ${EDITS_MARKER} marker and JSON block ONLY if you cannot propose any concrete fix from the evidence given.`,
      evidence,
      relevantFilesContext(input, true),
    ].join("\n");
  }

  if (input.mode === "database") {
    // Database Engineering (roadmap Phase 8, source requirement §8):
    // schema/migration/ORM-model generation as its own reviewable
    // artifact class -- reuses the exact same propose-edits/review/apply
    // pipeline as "build" (see MODES_WITH_STRUCTURED_EDITS above), but the
    // prompt is specifically scoped to database artifacts and, critically,
    // instructed to follow whatever real ORM/DB convention the project
    // already uses (evidenced by relevantFiles below) rather than
    // inventing a new one -- the same "never guess, only react to what's
    // actually there" principle previewOps.ts and projectContext.ts use.
    // GET /db/consistency (dbOps.ts) checks the result afterward for real
    // schema<->ORM agreement rather than trusting the model's own claim.
    const dbFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    return [
      "You are the MobiusX Desktop AI Assistant in DATABASE mode (Database Engineering, roadmap Phase 8) -- proposing a schema, its forward migration, and ORM model changes as ONE coherent set, not scattered files inside a generic build request.",
      "First, inspect the files shown to you below (if any) for an EXISTING database/ORM convention already used in this project -- an ORM's model classes (e.g. SQLModel/SQLAlchemy/Prisma/Sequelize/TypeORM/Mongoose), an existing schema file, or a migrations directory. If you find one, follow that exact convention and file layout. If you find none, default to plain SQL DDL for PostgreSQL under \"db/schema.sql\" and a matching forward migration under \"db/migrations/<NNN>_<slug>.sql\" (zero-padded 3-digit NNN, incrementing from the highest existing migration number you were shown, or 001 if none) -- and say so explicitly in your prose summary (e.g. \"No existing ORM or schema convention was found, so this assumes plain PostgreSQL.\"). Never silently switch technology away from what the project already evidently uses.",
      "Every table you add or change in the schema/migration MUST have a corresponding entry in the ORM model file when this project uses an ORM -- never update one layer and leave the other stale. State the entities and their relationships in one to two prose sentences (a brief domain model) before the file list, so the schema's intent is reviewable on its own, not just its SQL.",
      "If the request requires a destructive operation (DROP TABLE, DROP COLUMN, TRUNCATE, a non-additive column type change), say so explicitly and plainly in your prose summary as a risk -- this codebase has no migration rollback/checkpoint mechanism yet (see roadmap Phase 15), so a destructive migration cannot be undone automatically once applied.",
      "CRITICAL OUTPUT FORMAT -- follow this exactly, even for a multi-file schema change:",
      "1. First write a brief prose summary (2-5 sentences): the domain model/entities, which convention you followed or assumed, and any destructive-operation risk. Do NOT put any file's contents in a markdown code fence in this summary.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing every file being created or changed (schema + migration + ORM model(s), as applicable), as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content, never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n. Do NOT double it to \\\\n.",
      dbFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${dbFullContentPaths.join(", ")}. Do not use "modify" for any other path -- propose a new migration file instead of editing an already-applied one.`
        : 'You were not shown the full content of any existing file, so prefer action "create" for new schema/migration/model files; only use "modify" for a path you are highly confident exists and whose current content you can safely infer is being fully replaced (rare -- prefer a new migration file when in doubt).',
      'Only use action "create" for a path you are confident does not already exist in this project.',
      relevantFilesContext(input, true),
    ].join("\n");
  }

  if (input.mode === "architecture") {
    // Architecture Generation (roadmap Phase 9, source requirement §7).
    //
    // Direct trigger: a beta tester reported generated architecture
    // diagrams were "very basic level." The root cause diagnosed here is
    // the same one Database mode hit in Phase 8 -- a model asked to draw
    // an architecture diagram from a one-line prompt and no real project
    // facts has nothing to draw but generic "Frontend -> Backend ->
    // Database" boxes, because that's the only information it has. A
    // better-worded prompt cannot fix a missing-facts problem. So this
    // mode's grounding is fundamentally different from every other mode:
    // instead of semantic-search snippets (relevantFiles), it is handed a
    // single pre-computed, evidence-cited bundle -- architectureEvidence,
    // gathered by apps/desktop-agent/src/architectureContext.ts from the
    // project's REAL detected tech stack, schema/ORM relationships, HTTP
    // routes, and external integrations -- and instructed to render that
    // bundle faithfully rather than invent around gaps in it. Where the
    // evidence is genuinely empty (no external integrations detected, no
    // infra/deployment files found), the instructions below require an
    // honest prose note in the generated doc instead of a fabricated box,
    // mirroring the "unknown"/"not_configured" honesty pattern already
    // used by projectContext.ts and dbOps.ts.
    const evidence = input.projectContext?.architectureEvidence;
    const architectureFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    return [
      "You are the MobiusX Desktop AI Assistant in ARCHITECTURE mode (Architecture Generation, roadmap Phase 9) -- producing a High-Level Design doc and a Low-Level Design doc, each with real Mermaid diagrams grounded strictly in the evidence bundle below, not generic or invented architecture.",
      "",
      "THE #1 RULE, non-negotiable: every box, arrow, table, route, and external system you draw MUST trace back to a specific field in the JSON evidence bundle below. Do not add a generic \"Load Balancer\", \"Cache\", \"Message Queue\", \"Auth Service\", or any other component that isn't actually evidenced -- these are exactly the kind of boilerplate-textbook boxes a beta tester flagged as \"very basic level\" and low quality. If the evidence bundle doesn't show it, it doesn't go in the diagram.",
      "",
      evidence
        ? architectureEvidenceContext(evidence)
        : "No pre-computed architecture evidence was available for this project (this should not normally happen -- treat it as a signal to produce only the most minimal, honestly-labeled diagrams, explicitly noting in prose that evidence gathering did not run).",
      "",
      "DIAGRAM REQUIREMENTS -- use Mermaid's plain flowchart/erDiagram/sequenceDiagram syntax (flowchart TD with labeled subgraphs for System Context/Container/Component levels), NOT the experimental C4Context/C4Container syntax, which renders unreliably in this app's Mermaid version:",
      "",
      "In docs/architecture/HLD.md:",
      '1. "System Context" diagram (```mermaid flowchart TD```): the system as one box, a "User" actor, and one box per entry in externalIntegrations (label each edge with that integration\'s evidenced purpose, e.g. its name). If externalIntegrations is empty, draw only the User -> System edge and add a one-sentence honest note: "No external third-party integrations were detected in this project\'s dependencies."',
      '2. "Container" diagram (```mermaid flowchart TD```): one box per entry in projectContext.components (using each component\'s real name/category/location), plus a box for the database if database.schemaTables or database.ormEntities is non-empty. Draw an edge between frontend and backend components labeled with the real protocol/origin from frontendBackendLinks when present (e.g. "HTTPS, CORS: http://localhost:3000"); if frontendBackendLinks is empty, label the edge "HTTP (origin not detected)" rather than inventing a specific one.',
      "3. A short prose paragraph identifying the real detected tech stack (frameworks/languages from projectContext.components) and stating plainly any part of the standard stack (auth, caching, deployment/infra) that was NOT detected, rather than omitting it silently.",
      "",
      "In docs/architecture/LLD.md:",
      '1. "Component" diagram (```mermaid flowchart TD```): break the backend component down into groups of its real routes from the routes array, grouped by common path prefix (e.g. all "/products*" routes as one component). Do not invent internal modules/services beyond what the routes evidence supports.',
      '2. "Sequence" diagram (```mermaid sequenceDiagram```): pick ONE real, representative route from the routes array (prefer a POST/PUT if any exist) and trace an actual request through User -> Frontend -> Backend -> Database (only include the Database participant if this route\'s handler plausibly touches persisted data, i.e. the project has database evidence at all). Use the route\'s real method and path as the message label. If routes is empty, skip this diagram and say explicitly in prose: "No HTTP routes were detected, so no request sequence could be traced."',
      '3. "ER" diagram (```mermaid erDiagram```): built strictly from database.relationships (for the FK-derived edges, labeled with each relationship\'s real `via` column pair) and database.schemaTables / database.ormEntities for the entities themselves. If both are empty, skip this diagram and state plainly: "No database schema or ORM entities were detected in this project."',
      '4. "Deployment" diagram: only include this diagram if the evidence bundle shows concrete infrastructure/deployment facts (it currently does not gather any -- this phase\'s evidence bundle has no infra signal). Since no deployment evidence is gathered yet, DO NOT draw a Deployment diagram -- instead write one honest sentence: "Deployment/infrastructure evidence is not yet gathered by this tool, so no Deployment diagram is included rather than guessing at hosting details."',
      "",
      "CRITICAL OUTPUT FORMAT -- follow this exactly:",
      "1. First write a brief prose summary (2-4 sentences) of the real system this documents, referencing the actual detected stack -- not a generic description that could apply to any project.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing BOTH files (docs/architecture/HLD.md and docs/architecture/LLD.md), as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "docs/architecture/HLD.md", "action": "modify" | "create", "content": "COMPLETE new file content"}, {"path": "docs/architecture/LLD.md", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content (including its Mermaid code fences as literal ```mermaid blocks inside the markdown), never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n. Do NOT double it to \\\\n.",
      architectureFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${architectureFullContentPaths.join(", ")}. Do not use "modify" for any other path.`
        : 'You were not shown the full content of an existing docs/architecture/HLD.md or docs/architecture/LLD.md, so use action "create" for both -- this most likely means neither file exists yet in this project.',
      relevantFilesContext(input, true),
    ].join("\n");
  }


  if (input.mode === "testing") {
    // Testing Engine (roadmap Phase 10, source requirement §15).
    //
    // verify.ts (Phase 6) only ever RAN a project's tests -- nothing in
    // this codebase generated them. Same root-cause diagnosis as Database
    // (Phase 8) and Architecture (Phase 9): a model asked to write tests
    // with zero real facts about this project's test framework has
    // nothing to go on but a guessed one, often the wrong ecosystem
    // entirely (e.g. a Jest test for a Python backend). This mode is
    // grounded in a dedicated evidence bundle (GET /testing-evidence, see
    // apps/desktop-agent/src/testingContext.ts) -- this project's REAL
    // detected test framework(s) (reusing Phase 7's own detection, never
    // re-guessed) and, when one exists, a real existing test file to
    // match style against -- PLUS the actual target file(s) to test,
    // shown below via the normal relevantFiles mechanism (the same
    // grounding build/fix already use), so tests are written against
    // real, visible code, never an imagined API.
    const testingEvidence = input.projectContext?.testingEvidence;
    const testingFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    return [
      "You are the MobiusX Desktop AI Assistant in TESTING mode (Testing Engine, roadmap Phase 10) -- writing real, runnable test file(s) for the code shown to you below.",
      "",
      "THE #1 RULE, non-negotiable: only write tests against functions, classes, routes, or exports that ACTUALLY APPEAR in the file content shown to you below -- never invent a function, parameter, or return shape you weren't shown. If you can't see what a piece of code does, test its actually-visible behavior, don't guess at intent beyond that.",
      "",
      testingEvidence
        ? testingEvidenceContext(testingEvidence)
        : "No pre-computed testing evidence bundle was available for this project (this should not normally happen) -- treat it as a signal to be extra conservative about which framework you assume, and say so plainly in your summary.",
      "",
      !testingEvidence || testingEvidence.testFrameworks.length === 0
        ? 'No test framework was detected anywhere in this project (see the evidence above). Do NOT invent one -- do not assume Jest/Vitest/Mocha for JavaScript or pytest/unittest for Python just because that would be a normal default elsewhere. Say so plainly in your prose summary (e.g. which package/dependency would need to be added, if you can tell from the file(s) shown) and OMIT the EDITS_MARKER + JSON block entirely -- there is nothing correct to propose without a real framework to target.'
        : "A test framework WAS detected above for at least part of this project. Only write tests in a framework/language pairing the evidence above actually supports (e.g. don't write a Jest test for Python code just because Jest was detected for this project's frontend) -- if the specific file(s) shown to you below are in a language/ecosystem with NO detected framework, say so plainly and omit the edits block for those files rather than guessing.",
      "If a real existing test file sample was shown to you above, follow its exact style: the same framework idioms, import layout, fixture/setup pattern, and assertion style -- extend this project's own convention, don't introduce a competing one.",
      "If NO existing test file sample was shown above (this project has no test files yet), use the detected framework's standard idiomatic convention instead: for pytest, a new file at <same-directory-as-the-module-under-test>/tests/test_<module>.py -- e.g. testing backend/main.py means creating backend/tests/test_main.py, NEVER a tests/ directory at the project root when the module under test lives in a subdirectory (a project-root tests/ directory is invisible to pytest when it is run from that subdirectory, which is where this project's pytest dependency and virtualenv actually live) -- or a sibling test_<name>.py directly next to the file under test if no tests/ directory exists yet either way. For a FastAPI app, use fastapi.testclient.TestClient against the real app instance shown to you, not a mocked one. For Jest/Vitest, a co-located <name>.test.ts(x) beside the file under test, or under __tests__/ if that directory already exists. For Mocha, a matching test/<name>.test.js file.",
      "When your test imports the module under test, match that module's OWN import style EXACTLY as shown in the file content above -- never assume a package layout the project doesn't actually have. Concretely for Python: if the target file itself uses plain top-level sibling imports (e.g. main.py contains \"from database import ...\", not \"from backend.database import ...\"), your test must import it the same plain way too -- \"from main import app\", NEVER \"from backend.main import app\" -- a package-qualified import like that only resolves if the project is actually installed/run as a package, which a FastAPI backend launched as \"uvicorn main:app\" from inside its own directory (and pytest invoked the same way, from that same directory) never is. The same principle applies to JS/TS: match the target file's own relative-import depth and module resolution style -- don't invent a path alias or absolute import it doesn't already use itself.",
      "If the ONLY test framework detected for this project's language is a browser/e2e tool (Playwright, Cypress) with no unit-test-capable framework alongside it, say so plainly and omit the edits block -- browser-driven test generation needs a running application to drive, which is roadmap Phase 12's job, not this mode's.",
      "Cover the real, meaningful behavior of the code shown to you: at minimum one passing-case test and one edge-case/error-case test per exported function, route, or class method that has real logic. Skip trivial getters or pure re-exports. Do not write a test that only asserts a function exists or returns non-null with no real check of its actual behavior -- that kind of test is exactly the low-value placeholder this phase exists to avoid.",
      "",
      "CRITICAL OUTPUT FORMAT -- follow this exactly:",
      "1. First write a brief prose summary (2-4 sentences) of what you're testing and which framework/convention you followed (or, per the rules above, why you're proposing nothing).",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing every test file you\'re creating or changing, as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path/to/test_file", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content, never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n (a single backslash followed by n). Do NOT double it to \\\\n (two backslashes) -- that writes literal backslash-n text into the file instead of a real line break.",
      testingFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${testingFullContentPaths.join(", ")} -- this includes an existing test file if one was shown to you, which you should EXTEND rather than replace with something narrower. Do not use "modify" for any other path.`
        : 'You were not shown the full content of any existing test file for this code, so use action "create" for a new, sensibly-named test file path -- unless the evidence above already showed you an existing test file to extend.',
      `Per the rules above, omit the ${EDITS_MARKER} marker and JSON block entirely if no real test framework covers the file(s) you were asked to test.`,
      relevantFilesContext(input, true),
    ].join("\n");
  }

  const fullContentPaths = (input.projectContext?.relevantFiles ?? [])
    .filter((f) => f.content !== undefined)
    .map((f) => f.relPath);

  return [
    "You are the MobiusX Desktop AI Assistant in BUILD mode.",
    // Reinforced Sept 2026 after real evidence (openai/gpt-oss-120b via
    // Groq, asked to build a multi-file Next.js + FastAPI + SQLite app):
    // a model can be perfectly capable of proposing concrete file changes
    // and still not follow this custom marker+JSON convention on its
    // own -- it wrote a long, genuinely good multi-file answer as prose
    // with markdown code fences (tutorial-blog-post style, its default
    // training behavior for "build me X" prompts), never emitted
    // EDITS_MARKER at all, and so parseBuildResponse correctly found zero
    // edits -- not a parsing bug, a compliance gap. The instructions below
    // are now more explicit/repetitive about this being mandatory, not
    // optional, specifically for multi-file responses, since that's where
    // a model's natural "write it up like a tutorial" instinct seems to
    // compete hardest with the required format. Anthropic's Claude has not
    // shown this problem; free/open-weight models via Groq/OpenRouter are
    // the ones this is aimed at.
    "CRITICAL OUTPUT FORMAT — follow this exactly, even for a project with many files:",
    "1. First write a brief prose summary (2-4 sentences) of what you're building. Do NOT describe individual files in prose, and do NOT put any file's contents in a markdown code fence in this summary.",
    `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
    "3. Then exactly ONE fenced json code block containing EVERY file you're creating or changing — however many files the project needs — as entries in a single \"edits\" array, in this exact shape:",
    '{"edits": [{"path": "relative/path.ts", "action": "modify" | "create", "content": "COMPLETE new file content"}, {"path": "another/relative/path.py", "action": "create", "content": "COMPLETE new file content"}]}',
    "Do not split files across multiple json blocks, and do not write any file's content anywhere except inside this one \"edits\" array (not in prose, not in a separate markdown code fence). A 10-file project means 10 entries in this one array, not 10 separate code blocks in your response.",
    '"content" must be the entire new file content, never a diff, patch, or partial snippet.',
    "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n (a single backslash followed by n). Do NOT double it to \\\\n (two backslashes) -- that writes literal backslash-n text into the file instead of a real line break, and has been observed to corrupt files like requirements.txt.",
    // Reinforced Sept 2026 after real evidence (openai/gpt-oss-120b via
    // Groq, two separate Next.js + FastAPI + SQLite projects generated in
    // the same session): both times the model wrote backend/main.py using
    // package-relative imports ("from .database import ...", "from
    // .models import ..."). That's valid Python IF the app is ever run as
    // "python -m backend.main" from the project root, but this app (and
    // most real FastAPI tutorials/scaffolds) launches it as
    // "uvicorn main:app --reload" from *inside* backend/ -- which gives
    // main.py no package context at all, so a leading-dot import fails
    // immediately with "ImportError: attempted relative import with no
    // known parent package" the moment Start Preview runs it. This wasn't
    // a one-off; it's this model's default authoring habit for
    // multi-module FastAPI apps, so it's called out explicitly rather than
    // trusted to Python general knowledge.
    "If you are writing a Python/FastAPI backend split across multiple files in the same directory (e.g. main.py, models.py, database.py all directly under backend/), import sibling modules with PLAIN top-level names -- \"from database import ...\", \"from models import ...\" -- never with a leading dot (\"from .database import ...\"). This app runs the backend as \"uvicorn main:app\" from inside that directory, not as a Python package, so a dotted relative import will crash on startup with an ImportError.",
    "If that FastAPI backend will be called from a separately-hosted frontend (e.g. a Next.js dev server on a different port, as in a typical frontend/ + backend/ project layout), add CORS support in main.py -- import and add fastapi.middleware.cors.CORSMiddleware with allow_origins including at least \"http://localhost:3000\" (and ideally \"*\" for local dev) -- otherwise the browser will block every request the frontend makes to it.",
    buildModeTestingBlock(input.projectContext?.testingEvidence),
    fullContentPaths.length > 0
      ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${fullContentPaths.join(", ")}. Do not use "modify" for any other path.`
      : 'You were not shown the full content of any existing file, so do not use action "modify" at all — only "create" a genuinely new path.',
    'Only use action "create" for a path you are confident does not already exist in this project.',
    `Omit the ${EDITS_MARKER} marker and JSON block ONLY if you genuinely cannot propose any concrete file — e.g. the request is too ambiguous to act on. If you CAN write real file contents (as in most "build/add/create X" requests), you MUST use the format above — writing the same content as prose or markdown code fences instead is not an acceptable substitute, since only the json "edits" array actually gets applied to the user's project.`,
    relevantFilesContext(input, true),
  ].join("\n");
}

/**
 * Embeds the pre-computed architecture evidence bundle (gathered by
 * apps/desktop-agent/src/architectureContext.ts, GET /architecture-evidence)
 * as a structured JSON block in the prompt -- this IS architecture mode's
 * grounding mechanism, in place of relevantFilesContext's semantic-search
 * snippets. Deliberately dumps the real fields the diagram instructions
 * above reference by name (components, schemaTables, ormEntities,
 * relationships, routes, externalIntegrations, frontendBackendLinks) so
 * the model can quote them directly rather than paraphrase from prose.
 */
function architectureEvidenceContext(evidence: NonNullable<RunnerInput["projectContext"]>["architectureEvidence"]): string {
  return [
    "REAL PROJECT EVIDENCE (architecture-evidence bundle, gathered directly from this project's own files -- treat every field below as ground truth, not a suggestion):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

/**
 * Testing Engine (roadmap Phase 10, source requirement §15). Same
 * dump-the-real-bundle-as-JSON approach as architectureEvidenceContext
 * above -- the model quotes real detected test frameworks / existing test
 * file content directly rather than paraphrasing from prose.
 */
function testingEvidenceContext(evidence: NonNullable<RunnerInput["projectContext"]>["testingEvidence"]): string {
  return [
    "REAL TESTING EVIDENCE (testing-evidence bundle -- gathered directly from this project's own detected dependencies and existing test files, treat every field below as ground truth, not a suggestion):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

/**
 * BUILD mode's conditional companion-test instruction (roadmap Phase 10,
 * source requirement §15's literal ask: test generation as "part of the
 * standard Build-mode output for new backend/frontend code"). Gated on
 * the SAME testingEvidence bundle Testing mode uses -- if this project has
 * no detected test framework at all, this explicitly tells the model NOT
 * to invent one rather than staying silent (silence would leave a model
 * free to guess), matching this codebase's "never guess, say so" pattern.
 */
function buildModeTestingBlock(evidence: NonNullable<RunnerInput["projectContext"]>["testingEvidence"]): string {
  if (!evidence || evidence.testFrameworks.length === 0) {
    return "TEST GENERATION (roadmap Phase 10): no test framework was detected for this project, so do not invent one or add a companion test file for this request -- just build what was asked.";
  }
  const frameworks = evidence.testFrameworks.map((f) => `${f.name} (in ${f.location}/)`).join(", ");
  return [
    testingEvidenceContext(evidence),
    `TEST GENERATION (roadmap Phase 10): this project has a detected test framework -- ${frameworks}. For every NEW backend or frontend source file you create in this request that contains real logic (not pure config, docs, or a migration), ALSO propose one companion test file in the SAME edits array, in that framework's convention (matching this project's existing test style shown just above, if any) -- covering at least the file's main real behavior, not just that it exists. Do not skip this just because the request didn't explicitly mention tests. Only ever use a framework already detected above for the matching language -- never a different one, and never for a language/ecosystem this project has no detected framework for.`,
  ].join("\n\n");
}

export function relevantFilesContext(input: RunnerInput, distinguishFullContent: boolean): string {
  const files = input.projectContext?.relevantFiles ?? [];
  if (files.length === 0) {
    // Real, observed failure mode (Sept 2026: qwen/qwen3.8-27b, asked to
    // build a student admission app from scratch) -- an empty
    // relevantFiles[] on its own is ambiguous: it could mean "this project
    // has no files at all" (every proposed file is a safe "create") or
    // "this project has files, none matched the search" (real risk of
    // colliding with an existing path the model was never shown). Left
    // ambiguous, a careful model reasonably refused to propose anything at
    // all rather than guess which case it was in -- so say plainly which
    // one it is instead of leaving this prompt section blank either way.
    const indexedChunkCount = input.projectContext?.indexedChunkCount;
    if (indexedChunkCount === 0) {
      return `\n\nThis project currently has no indexed files at all -- it's empty (or effectively so). Every file you propose should use action "create"; there is nothing existing to collide with.`;
    }
    if (typeof indexedChunkCount === "number" && indexedChunkCount > 0) {
      return `\n\nNo existing files matched this request closely enough to show you, but this project does have other files you weren't shown. You may still propose "create" for new, sensibly-named paths that clearly wouldn't already exist (e.g. a new feature's own files) -- just don't assume the project is empty.`;
    }
    return "";
  }

  const withContent = files.filter((f) => f.content !== undefined);
  const snippetOnly = files.filter((f) => f.content === undefined);
  let out = "";
  if (withContent.length > 0) {
    out += `\n\nFull file contents you may modify:\n${withContent.map((f) => `--- ${f.relPath} ---\n${f.content}`).join("\n\n")}`;
  }
  if (snippetOnly.length > 0) {
    out += `\n\nOther relevant snippets (context only — you may NOT modify these, you weren't shown them in full):\n${snippetOnly.map((f) => `--- ${f.relPath} ---\n${f.snippet}`).join("\n\n")}`;
  }
  return out;
}

/** Defensive server-side caps on top of the client's own (see renderer.js) — a runner should never choke on / balloon a prompt from an unexpectedly long or wordy history array, whatever sent it. */
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS_PER_TURN = 4000;

/**
 * Converts RunnerInput.history (see HistoryTurn in @mobiusx/protocol) into
 * chat messages to prepend before the current prompt, for every chat-style
 * runner (anthropic/openrouter/groq/ollama). Without this, each task is a
 * fresh one-shot request with no memory of anything said earlier in the
 * same AI Assistant panel session — the exact "history isn't maintained"
 * gap this closes. Returns [] when there's no history to add, so callers
 * can always spread the result into a messages array unconditionally.
 */
export function historyMessages(input: RunnerInput): { role: "user" | "assistant"; content: string }[] {
  const history = input.history ?? [];
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role,
    content:
      turn.content.length > MAX_HISTORY_CHARS_PER_TURN
        ? turn.content.slice(0, MAX_HISTORY_CHARS_PER_TURN) + "…"
        : turn.content,
  }));
}

export function stepId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
