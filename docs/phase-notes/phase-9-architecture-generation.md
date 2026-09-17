# Phase 9 — Architecture Generation

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 9.

Trigger for this phase: a beta tester reported that generated architecture
diagrams were "very basic level." Status: **done, live-verified end-to-end**
— same "evidence, not intention" discipline as Phases 6–8. This doc is that
evidence, including an honest gap this phase's own verification surfaced.

## Design: why diagrams were basic, and what actually fixes it

Investigating the complaint rather than just rewriting the prompt: a model
asked to draw an architecture diagram from a one-line request and no real
project facts has nothing to draw *but* generic "Frontend -> Backend ->
Database" boxes, because that's the only information it has. A more
elaborate prompt with no new facts behind it cannot fix a missing-facts
problem — this is the same root cause Database mode hit in Phase 8 for
schema generation. So this phase's real work is a dedicated evidence-
gathering layer, not prompt engineering alone.

## What shipped

- **`DatabaseRelationship` extraction** (`apps/desktop-agent/src/dbOps.ts`):
  `checkDatabaseConsistency()` now also extracts real FK relationships —
  `REFERENCES` in schema SQL and `foreign_key=` in SQLModel/SQLAlchemy
  classes — deduplicated by `(from, via, to)`, each with file+line evidence,
  for ER diagrams to draw real relationships instead of guessed ones.
- **`architectureContext.ts`** (`apps/desktop-agent/src/architectureContext.ts`,
  new, `GET /architecture-evidence`): gathers real HTTP routes (FastAPI
  `@app.get(...)`/Express `router.post(...)` decorators, plus Next.js
  file-based API routes under `pages/api/` and `app/**/api/**/route.ts`),
  real external integrations (a curated signal list — Stripe, Twilio,
  OpenAI, AWS, Redis, etc. — matched against `package.json`/
  `requirements.txt`, never guessed), and real frontend↔backend links
  (CORS `allow_origins` values). Combined with Phase 7's `projectContext`
  and Phase 8's `database` report into one `ArchitectureEvidence` bundle.
- **Architecture mode** (`AgentMode` extended with `"architecture"` in
  `packages/protocol/src/cloud.ts`): a new mode in the AI Assistant panel
  reusing the same propose → review → apply pipeline as build/spec/fix/
  database. Its system prompt (`promptShared.ts`) is fundamentally
  different from every other mode's grounding: instead of semantic-search
  snippets, it embeds the *entire* `architectureEvidence` bundle as a JSON
  block and instructs the model to render it faithfully — an explicit
  "THE #1 RULE" against inventing unevidenced components (no "Load
  Balancer"/"Auth Service"/"Cache" boxes unless the evidence shows one) —
  and to write an honest prose note, not a fabricated diagram, wherever a
  diagram type's supporting evidence is empty (no external integrations →
  say so in System Context; no routes → skip Sequence and say so; no
  schema/ORM entities → skip ER and say so; no infra evidence gathered at
  all yet → Deployment is never drawn, always an honest sentence instead).
  Output contract: exactly `docs/architecture/HLD.md` (System Context +
  Container diagrams) and `docs/architecture/LLD.md` (Component + Sequence
  + ER + Deployment-note), using plain `flowchart TD`/`sequenceDiagram`/
  `erDiagram` Mermaid syntax rather than the brittle, experimental
  `C4Context`/`C4Container` syntax.
- **Real Mermaid rendering** (`apps/desktop/src/renderer/index.html`,
  `renderer.js`, `styles.css`): `mermaid` and `marked` installed and loaded
  via the app's existing no-bundler `<script src="../../../../node_modules/...">`
  pattern (same as `@xterm/xterm`). The placeholder **Artifacts** nav view
  now fetches `docs/architecture/HLD.md`/`LLD.md` for the open project (if
  either exists) and renders them with `marked`, intercepting ` ```mermaid `
  fences via a custom renderer hook and rendering each with
  `mermaid.render()` into real SVG — a failed diagram shows the error plus
  its raw source rather than silently vanishing. An "Architecture" mode
  button was added next to "Database" in the AI Assistant panel (same
  component powers both the Workspace-embedded and standalone views, so
  one addition covers both). Architecture mode's own content-fetch gate
  (`fetchArchitectureRelevantFiles`) deliberately does **not** use semantic
  search: it fetches the two fixed, well-known paths directly via
  `/fs/read` so a regenerate request can correctly propose `"modify"`
  instead of repeating Phase 8's "CREATE on an existing file gets silently
  skipped by Apply" bug.

## Live evidence: the evidence-grounding fix works

Real AI Assistant, Architecture mode, against `Test Projects/GreenThumbGarden`
(FastAPI + SQLModel + SQLite backend, Next.js frontend), prompt: "Generate
the architecture documentation for this project." Tried across **3 different
real, free-tier models** (openrouter `inclusionai/ling-3.0-flash-vl:free`,
groq `openai/gpt-oss-120b`, groq `openai/gpt-oss-20b`), 5 total generations.
Every single one produced specific, evidenced prose — not one fell back to
generic boilerplate:

> "GreenThumbGarden is a compact full-stack application: a **Next.js 13.5.6**
> frontend communicates with a **FastAPI** backend, which persists data to
> **SQLite** via the **SQLModel ORM**. Frontend-to-backend traffic flows
> over HTTPS with CORS enabled for `http://localhost:3000`, and the only
> detected endpoints are three `/products` routes. Authentication, caching,
> and deployment/infrastructure were not detected — auth, testFramework,
> and infra are flagged as unknown categories — so they are deliberately
> omitted rather than invented." (openrouter/ling-3.0-flash-vl:free)

> "...persisting data in SQLite through a SQLModel ORM that exposes three
> product routes and a **product/orders/order_items schema**. No external
> third-party integrations were detected..." (same model, second run —
> correctly cites the real schema tables too, not just routes)

> "The codebase defines product-related HTTP endpoints but does not include
> any detected authentication, caching, or deployment infrastructure
> components." (groq/openai/gpt-oss-120b)

Every response independently cited the same real facts — exact framework
names and version, the real route count, the real CORS origin, the real
schema table names — and every response correctly declined to invent an
auth service, cache, or message queue, stating plainly that those categories
were "not detected"/"unknown" instead. This is the direct, measurable fix
for the beta tester's "very basic level" complaint: the model is no longer
drawing from nothing, it's drawing from this project's real, cited facts.

## An honest gap this phase's own verification surfaced

None of those 5 real-model generations ever emitted the required
`===MOBIUSX_EDITS===` + JSON block, even after two follow-up prompts asking
explicitly and then very explicitly ("Output ONLY: ... Nothing else") for
it — each one produced good prose and then either continued describing the
docs or stopped, never applying (`getBuildStatusNote`'s honest fallback
message: "No file changes were proposed... try again, be more explicit, or
switch models"). This is the same free-model format-compliance gap already
documented for build mode (see `promptShared.ts`'s Sept 2026 comment on
`openai/gpt-oss-120b` via Groq), but **more pronounced** for architecture
mode — plausibly because its prompt is substantially larger (the full JSON
evidence bundle, plus six diagram-specific instructions, plus a two-file
output requirement) than build mode's single-file asks. Recorded here
honestly rather than silently retried until it happened to work: this is
real evidence about free-tier model reliability for this specific mode, not
a flaw in the grounding design itself — the prose quality above shows the
grounding is doing its job; getting that grounded content into the
structured edit format reliably is a separate, now-documented problem for
a future increment (a stronger paid model, or a shorter/chunked prompt
that asks for one file at a time).

## Live evidence: Apply + Mermaid rendering pipeline (Demo mode)

To verify the rendering pipeline itself independent of the free-model
compliance gap above, ran Architecture mode in **Demo mode** (deterministic,
no API cost) against the same project. Result: "Proposed changes — 2
files" (`docs/architecture/HLD.md`, `docs/architecture/LLD.md`), a demo
reviewer "Approve" banner, then **Applied 2/2** — confirmed on disk via
`device_bash` that both files exactly match the previewed diff (29 and 35
lines respectively).

Switched to the **Artifacts** view and confirmed, by screenshot, real
rendering — not placeholder text:
- System Context: a `User` node with an arrow into a `This System` node,
  rendered as an actual SVG flowchart box-and-arrow diagram.
- Container: `Frontend` →(`HTTP`)→ `Backend` → a cylinder-shaped `Database`
  node — Mermaid's real database shape syntax rendering correctly.
- Sequence: a proper sequence diagram with three lifelines (`User`,
  `Frontend`, `Backend`) and two labeled message arrows.
- ER and Deployment sections: correctly rendered as **plain honest prose**,
  not diagrams — Demo mode's content deliberately omits these to avoid
  implying a fake schema or fake infrastructure is real, and the Artifacts
  view rendered that prose exactly as authored rather than trying to force
  a diagram out of nothing.

This confirms the full pipeline — evidence gathering → prompt → structured
edits → Apply → `/fs/read` → `marked` → Mermaid `.render()` → SVG in the
Artifacts view — works end-to-end, and that the app's honesty conventions
(an empty section stays prose, never a fabricated diagram) survive all the
way through to what the user actually sees on screen.

## Scope not built this phase (tracked, not forgotten)

- No deployment/infrastructure evidence gathering yet (no Dockerfile/
  docker-compose/Kubernetes manifest detection) — `architectureContext.ts`
  has no signal for this, so Deployment diagrams are never drawn; the
  prompt is explicit that this is a real gap, not a place to guess.
- The free-model structured-edit compliance gap above is unresolved —
  next increment could try a shorter, single-file-at-a-time architecture
  prompt, or document that Architecture mode is best used with a
  stronger-compliance model (Anthropic/paid) until resolved.
- No auto-refresh of the Artifacts view when the underlying docs change —
  same manual-refresh v1-conservative choice as Database Consistency and
  Project Context.
- Only two fixed diagram-bearing files (`HLD.md`/`LLD.md`) — no support
  yet for per-component deep-dive docs or a diagram index/table of
  contents across multiple generated documents.
