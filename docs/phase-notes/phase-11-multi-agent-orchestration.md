# Phase 11 — Multi-Agent Orchestration

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` §38 (source requirements
§26, §27; builds on Phase 3's runner registry + Reviewer-agent precedent).

> Formalizes the existing single Reviewer-agent second pass (PRD §11/§46)
> into named agent personas (Architecture/Database/Backend/Frontend/API/
> Testing/DevOps/Documentation/Debugger) with distinct system prompts and,
> per §27, per-task-type model routing — real role separation, not
> necessarily separate concurrent processes on day one.

Status: **done, live-verified end-to-end** against the real running app and
the real GreenThumbGarden fixture project, using real free models (no
Anthropic key configured in this environment — see "Why this had to reach
every runner" below). Same discipline as Phases 6–10: this doc records what
actually happened, including one review call that live-verification caught
failing to parse (handled exactly as designed, not silently).

## What existed before this phase

A single, generic "Code Reviewer Agent" second pass (`anthropicRunner.ts`'s
`reviewEdits`) ran after build/fix/database/architecture/testing-mode
edits, on Anthropic only — the newer free-model runners (openrouter/groq
via `openAiCompatibleRunner.ts`, and `ollamaRunner.ts`) each emitted a
"doesn't run the second-pass Reviewer agent yet — that's currently
Anthropic-only" note instead, a real documented scope cut since Phase 3.
Spec mode was excluded from review entirely. Model selection
(`registry.ts#resolveRunner`) had two levers: a per-task override, and one
overall `settings.defaultModel` — no way to route a specific task *type* to
a specific model.

## Why this had to reach every runner, not just formalize Anthropic's

This environment has no `ANTHROPIC_API_KEY` configured — every live
verification this whole session has used free OpenRouter/Groq models. A
persona system reachable only from `anthropicRunner.ts` could never be
live-verified here, breaking this session's own "verify against a real
running model, not just a design" discipline. So Phase 11's persona review
logic was built once, in a new shared module, and wired into all four
runners (anthropic, the openrouter/groq factory, ollama, and the demo
runner) rather than only the one that already had a review pass.

## Design

- **`AgentPersona`** (`packages/protocol/src/cloud.ts`, new type): the
  roadmap's 9 named personas — `architecture | database | backend |
  frontend | api | testing | devops | documentation | debugger`.
  `EditReview` gained an optional `persona?: AgentPersona` field (optional
  so an older client/runner response without it still parses).
- **`apps/cloud-agent-gateway/src/runners/personas.ts`** (new, shared by
  every runner): `PERSONAS` (each persona's label + a short focus
  checklist, written from real bugs this session already found live —
  e.g. the Database persona's checklist explicitly calls out "a foreign
  key pointing at a table name that doesn't exist in this same edit set,"
  the exact Phase 10 GreenThumbGarden `Product`/`products` bug; the
  Testing persona's checklist calls out import-convention mismatches, the
  other real bug Phase 10 found live); `classifyPersona(mode, edits)` —
  direct mode→persona mapping for database/architecture/testing/fix
  (→debugger)/spec (→documentation), and for **build** mode (which can
  touch any kind of file) a path/extension heuristic voting across the
  proposed edits' paths into backend/frontend/api; `personaReviewSystemPrompt(persona)`;
  `parseReview()` (moved here from `anthropicRunner.ts`, re-exported from
  there so the existing test import keeps working); and
  `runPersonaReview(mode, input, edits, emit, callModel)` — the shared
  step-emission/error-handling orchestration every runner now calls with
  its own thin non-streamed `callModel` closure.
- **`devops` is defined but never reached** — no shipped `AgentMode`
  produces DevOps/infrastructure edits yet (that's roadmap Phase 14).
  Listed for completeness against the roadmap's persona list, not invented
  early against nothing real to review.
- **Spec mode now gets reviewed too** (a deliberate expansion, not scope
  creep): the review-trigger condition in every runner now includes
  `"spec"` alongside build/fix/database/architecture/testing, specifically
  so the new Documentation persona has a real, reachable mode — a
  generated requirements spec is exactly the kind of artifact a
  Documentation-focused reviewer should check (every `REQ-NNN` has a
  matching acceptance criterion and JSON-twin entry, nothing invented
  beyond what the user asked).
- **`AgentSettings.modelRouting?: Partial<Record<AgentMode, ModelSelection>>`**
  (`packages/protocol/src/agent.ts`, new field): a standing per-mode model
  choice. `registry.ts#resolveRunner` gained a required third `mode`
  parameter and now resolves priority **per-task override →
  `modelRouting[mode]` → `defaultModel` → automatic** — required, not
  optional, specifically so a call site can't silently forget to pass it.
  `@mobiusx/agent-settings`'s `SettingsPatch.modelRouting` is a **per-mode
  merge** (`{mode: null}` clears just that mode's rule; a mode absent from
  the patch is left untouched) — verified directly (see "Live evidence"
  below), not just asserted.

## What shipped

- `packages/protocol/src/{cloud,agent}.ts` — `AgentPersona`, `EditReview.persona`, `AgentSettings.modelRouting`.
- `apps/cloud-agent-gateway/src/runners/personas.ts` — new, described above.
- `apps/cloud-agent-gateway/src/runners/anthropicRunner.ts` — `reviewEdits`/`reviewSystemPrompt`/`parseReview` replaced by a call into `personas.ts` plus a thin `callAnthropicNonStreamed` closure; review trigger extended to spec mode.
- `apps/cloud-agent-gateway/src/runners/openAiCompatibleRunner.ts` — the old "doesn't run the second-pass Reviewer agent yet" note replaced with a real `runPersonaReview` call (`callOpenAiCompatibleNonStreamed`, `stream: false` against the same `/chat/completions` endpoint, using the SAME model that produced the edits — not an arbitrary first-in-list model).
- `apps/cloud-agent-gateway/src/runners/ollamaRunner.ts` — same treatment via Ollama's own `/api/chat` with `stream: false`.
- `apps/cloud-agent-gateway/src/runners/demoRunner.ts` — its scripted review now attaches `persona: classifyPersona(...)` too, so a demo user previews which persona would review a given task type, and spec mode's demo edit now also gets a scripted review.
- `apps/cloud-agent-gateway/src/runners/registry.ts`, `taskEngine.ts` — `mode`-aware `resolveRunner`.
- `packages/agent-settings/src/index.ts` — `modelRouting` validated/merged (`sanitizeModelRouting`, per-mode merge in `updateSettings`).
- `apps/desktop-agent/src/routes.ts` — PUT `/settings` validates `modelRouting` the same way it already validated `defaultModel`.
- `apps/desktop/src/renderer/{index.html,renderer.js,styles.css}` — a new Settings → Application Settings → "Per-Task-Type Model Routing" section (one dropdown per `AgentMode`, reusing the existing `populateModelSelect`, now given an `autoLabel` override so "Use default" — not "Auto" — correctly describes what clearing a per-mode rule does); the Reviewer verdict banner (`renderReviewBannerHtml`) and the Tasks overview's "Changes" stat now show the persona's label (`PERSONA_LABELS`, mirrored by hand from `personas.ts` since `renderer.js` is a plain script) instead of a generic "Reviewer".

## Test suite: added coverage, and a real pre-existing drift fixed along the way

`apps/cloud-agent-gateway/test/registry.test.ts` (already being edited for
the new `mode` parameter and 3 new `modelRouting` tests) turned out to have
4 pre-existing failures unrelated to this phase: Groq's free lineup moved
from `llama-3.3-70b-versatile` to `openai/gpt-oss-120b`/`-20b`, and
OpenRouter's moved from three `:free` models down to one
(`inclusionai/ling-3.0-flash-vl:free`) — both changes are already
documented in `groqRunner.ts`/`openrouterRunner.ts`'s own module comments,
the test file just hadn't been updated to match. Since this phase was
already touching every hardcoded model id in this exact file for the new
`modelRouting` tests, the stale ids/counts were corrected in the same edit
rather than left broken alongside new, passing tests — `apps/cloud-agent-gateway/test/*.test.ts`
now passes **53/53** (was 21 tests / 4 failing before this phase touched
the file; full suite across all runner test files also went from
50/2-failing to 53/0-failing once two more tests — `openAiCompatibleRunner.test.ts`'s
build-mode review test and `taskEngine.test.ts`'s spec-mode review test —
were updated to assert the new, intended behavior instead of the old
scope-cut behavior they were written against).

`apps/desktop-agent`'s test suite: **39 pass, 1 skip (no local pytest), 1
fail** — the fail is the pre-existing `terminalWs.test.ts` `node-pty`
native-module failure from earlier phases, confirmed unrelated (same
failure signature, no code in this phase touches the terminal).

## Live evidence: `modelRouting` per-mode merge (unit-level, direct)

Ran directly against the real `@mobiusx/agent-settings` package (not
mocked):

```
initial: {"terminalApprovalMode":"off"}
after setting architecture route: {"terminalApprovalMode":"off","modelRouting":{"architecture":{"provider":"groq","model":"openai/gpt-oss-120b"}}}
after ALSO setting testing route: {...,"modelRouting":{"architecture":{...},"testing":{"provider":"openrouter","model":"inclusionai/ling-3.0-flash-vl:free"}}}
after clearing architecture route only: {...,"modelRouting":{"testing":{"provider":"openrouter","model":"inclusionai/ling-3.0-flash-vl:free"}}}
after clearing testing route too (modelRouting key should disappear): {"terminalApprovalMode":"off"}
```

Confirms: setting one mode's rule never touches another's; clearing a
single mode leaves the rest; clearing the last one removes the
`modelRouting` key entirely (not an empty object).

## Live evidence: real running app, real free models, real GreenThumbGarden project

Relaunched the actual Electron app (quit + reopened via
`start-mobiusx.command`) after rebuilding `protocol`, `agent-settings`,
`cloud-agent-gateway`, and `desktop-agent` (the Electron main process
spawns both as child processes from their built `dist/index.js`).

**Settings → Per-Task-Type Model Routing** rendered all 8 mode rows
correctly; set **Database → GPT-OSS 120B (free tier via Groq)** while
leaving Default AI Model on OpenRouter's Ling 3.0 Flash VL (a *different*
provider) — a Refresh (fresh `GET /settings` from disk) still showed the
Groq selection, confirming it persisted, not just a local dropdown state.

**Database-mode task**, model left on "Auto" (so it had to exercise
`modelRouting`, not a per-task override) — prompt: *"Add a 'notes' text
column to the Product table so a gardener can jot a short care note for
each plant."* Result:

```
[runner: groq / openai/gpt-oss-120b]
```

— Groq, not OpenRouter (the Default AI Model) and not automatic selection
landing on Groq by coincidence: `defaultModel` was explicitly set to
OpenRouter's Ling model, so if `modelRouting["database"]` had NOT been
honored, resolution would have stopped at `defaultModel` and used
OpenRouter. Getting Groq instead is direct evidence `modelRouting[mode]`
took priority over `defaultModel`, exactly as designed. The review step
read **"Running second-pass review (Database Agent)"**, and the rendered
banner:

> ✓ **Database Agent: Approve** — The migration adds a non-destructive
> notes TEXT column matching the new Optional[str] field in the Product
> model, with consistent table names and no FK issues. No security or
> rollback concerns arise.

That FK/table-name-consistency language is the Database persona's own
focus checklist in action, on a real live model call. Clicked Apply (2/2
files applied) and confirmed the written files directly on disk:

```python
# backend/models.py
notes: Optional[str] = None
```
```sql
-- db/migrations/001_add_product_notes.sql
ALTER TABLE products ADD COLUMN notes TEXT;
```

Correct table name (`products`, plural — the exact class of mismatch Phase
10 found as a real bug), non-destructive `ADD COLUMN`, matching the
model's nullable field.

**Spec-mode task** (previously never reviewed at all) — prompt: *"Write a
short requirements spec for letting a gardener mark a plant as 'needs
watering' from the plant list."* No `modelRouting` rule exists for
`"spec"`, so this had to fall through to `defaultModel` — confirmed:

```
[runner: openrouter / inclusionai/ling-3.0-flash-vl:free]
```

The review step correctly read **"Running second-pass review (Documentation
Agent)"** — the new persona, reachable for the first time this phase. The
rendered banner:

> ⚠ **Documentation Agent: Concerns** — Reviewer response could not be
> parsed as a verdict — treating as unreviewed rather than silently
> approving.

This is an honest result, not a bug: Ling 3.0 Flash VL is already
documented elsewhere in this codebase (`openrouterRunner.ts`'s own module
comment) as an unverified "hybrid instant/reasoning model" that may not
reliably produce plain text output — here its review call didn't return
something `parseReview` could parse as `{verdict, summary}`, and the
system did exactly what it's designed to do in that case: report
`"concerns"` with an honest explanation rather than silently treating the
unparseable response as an approval. The spec itself still generated
correctly (an 8-requirement `REQ-NNN` breakdown with acceptance criteria),
and Documentation-persona routing worked — the failure is in the review
model's output reliability, a known, already-documented characteristic of
this specific free model, not in this phase's code.

## Scope not built this phase (tracked, not forgotten)

- **Separate concurrent agent processes.** The roadmap entry is explicit
  that this isn't required on day one ("real role separation, not
  necessarily separate concurrent processes") — this phase changes WHICH
  identity and focus-area prompt one review call uses, not how many model
  calls run per task.
- **DevOps persona wiring.** Defined in `AgentPersona`/`PERSONAS` for
  completeness against the roadmap's 9-persona list, but genuinely
  unreachable — no shipped `AgentMode` produces infrastructure edits
  (roadmap Phase 14, DevOps/Infrastructure Generation). Wiring a persona
  in ahead of the mode that would use it means guessing its real review
  focus against nothing to review; that's Phase 14's job.
- **Build-mode persona classification is a path/extension heuristic**, not
  static analysis of file content — a backend file that happens to live
  under a path matching a frontend convention (or vice versa) would be
  misclassified. Documented in `personas.ts#classifyBuildPersona`'s doc
  comment; the review's substance doesn't depend on getting the persona
  label exactly right, so this is a labeling nicety, not a correctness
  gap.
