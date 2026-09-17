# Phase 13 — Error Intelligence + Debugger v2

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 13 (source §19,
§20), "Extends the existing static Debug view (Phase 2) into full-stack
tracing (browser → frontend → API → backend → DB) with root-cause
classification, now that Phase 12 produces the trace evidence to
classify." Builds on Phase 2, Phase 12.

Status: **done, live-verified end-to-end** — same "evidence, not
intention" discipline as Phases 6–12. This doc is that evidence.

## Design: correlation, not new instrumentation

The roadmap's own wording is the scope: Phase 12 already *produces* the
trace evidence (real browser console/network/screenshot capture against
the running preview); this phase's job is to classify it, not to build a
new evidence source. That framing matters because a literal "full-stack
tracing" system — injecting correlation IDs and request logging into an
arbitrary generated FastAPI/Express/Next.js backend so a single request
could be followed end to end — is a fundamentally different, far more
invasive piece of work this app has no mechanism for: `previewOps.ts`
only ever spawns a project's dev server as an opaque child process (`npm
run dev` / `uvicorn ... --reload`), never instruments its code. Building
that would mean generating and injecting logging middleware into every
supported framework — a real feature, but not this one, and not
something that could be done honestly without changing what a "preview"
is in this app.

What real evidence already exists to correlate, once Phase 12 has run:

- **Browser layer**: `BrowserValidationStep`'s `consoleErrors`,
  `networkErrors`, `screenshot` — genuine captured symptoms.
- **API layer**: Phase 9's `gatherArchitectureEvidence().routes` — every
  real `DetectedRoute` this project's own backend/API code declares, with
  file+line evidence.
- **Backend layer**: `previewOps.ts`'s `PreviewServiceState.log` — the
  running backend process's own real, capped stdout/stderr, already
  captured for the Workspace preview panel but never previously read
  back programmatically by anything else.
- **Database layer**: Phase 8's `database.ormEntities`/`relationships`
  (also inside the same `ArchitectureEvidence` bundle) — real ORM model
  names and table mappings to check a traceback against.

So "full-stack tracing" here means: take one browser-observed failure,
and walk it down through these four real evidence sources as far as they
actually connect — never further, and never inventing a link between
layers that isn't backed by an actual matched route, a real traceback, or
a file that was confirmed to exist on disk.

## Root-cause classification

A small, fixed set of categories, each reachable only through a specific,
cited evidence combination (`apps/desktop-agent/src/errorIntelligence.ts`'s
`classifyStep`):

- **`backend-unreachable`** — a real connection-level network failure
  (`FAILED ... (net::ERR_CONNECTION_REFUSED)` etc.), cross-checked against
  the backend preview's own real process status.
- **`route-not-implemented`** — an HTTP-status error whose request path
  matches no real `DetectedRoute` (method+path, with FastAPI `{id}` /
  Express `:id` / Next `[id]` param segments handled) — cites the closest
  known routes for context rather than a bare "not found."
- **`backend-error-db-layer`** — a 5xx on a *matched* route where a real,
  freshly-captured traceback in the backend's own log mentions a known
  ORM entity/table name or a DB-library signal (SQLAlchemy, SQLModel,
  psycopg, etc.).
- **`backend-error-logic`** — a 5xx on a matched route with a traceback
  that doesn't mention the database layer (or, at medium confidence, no
  traceback was found in the log at all to attribute a cause).
- **`client-error`** — a 4xx on a route that genuinely IS implemented —
  reported as real evidence, explicitly not assumed to be a bug (a 404
  for one specific product ID, a 401, etc. can be entirely correct
  behavior).
- **`frontend-runtime-error`** — a console/page error with no network
  failure; high confidence when the error text cites a project file
  confirmed to exist on disk (`resolveFrontendHint`'s `existsSync` check
  — never cites a path from unverified text), medium otherwise.
- **`unclassified`** — a legitimate, honest outcome when real evidence
  was captured but matches none of the above — never force-fit into the
  nearest-sounding bucket, the same discipline Architecture mode uses for
  an empty diagram section.

One `ErrorTrace` per failing `BrowserValidationStep`. When a step has
both a network error and a console error, the network-level evidence
wins the classification (more specific, closer to cause) — documented in
the module rather than silently dropping the console evidence from what
gets gathered.

## What shipped

- **`packages/protocol/src/agent.ts`**: `TraceEvidence`, `RootCauseCategory`,
  `ErrorTrace`, `ErrorIntelligenceReport`.
- **`packages/protocol/src/governance.ts`**: `AuditCategory` extended with
  `"error-intelligence"`.
- **`apps/desktop-agent/src/errorIntelligence.ts`** (new): a pure
  `classifyStep(step, evidence, backendLog)` classifier (no I/O — fully
  unit-testable without Playwright or a real preview) plus the
  `runErrorIntelligence(projectPath)` orchestrator that gathers real
  evidence (`runBrowserValidation` + `gatherArchitectureEvidence` in
  parallel, then the backend's live log) and classifies every failing
  step. Also exports `extractRecentBackendTraceback` (walks a capped
  process log backwards for the freshest Python traceback or Node stack
  trace).
- **Route**: `POST /debug/error-intelligence` — mirrors `/browser-validate`'s
  honesty convention (`overall: "no-preview-running"` with a real reason,
  never a fabricated result), audit-logs every non-empty run under the
  new `"error-intelligence"` category.
- **Renderer**: a new "Error Intelligence" section appended to the
  existing static Debug view (`view-debug`) — a "Run full-stack trace"
  button, a summary line, and one card per `ErrorTrace` showing its
  category badge, confidence, reasoning, and the full evidence chain
  (browser → frontend → api → backend → database, each entry showing its
  real `source:line` as a clickable jump into the file when present).

No changes were made to the existing Diagnose & Fix / Fix-mode wiring —
Phase 12 already fully wired browser-validation failures into that loop
(`lastFailingBrowserSteps` in `renderer.js`); this phase is additive to
the Debug view specifically, matching the roadmap's own attribution of
Phase 13 to "the Debug view," not the fix loop.

## Tests

`apps/desktop-agent/test/errorIntelligence.test.ts` — **12/12 passing**,
covering every classification branch with constructed evidence fixtures:
a passed step with no errors (returns `null`); a connection-level
failure → `backend-unreachable`; a 404 with no matching route →
`route-not-implemented` (citing the real closest routes); a 500 on a
matched route with a DB-referencing traceback → `backend-error-db-layer`
(citing the real ORM entity); the same with a non-DB traceback →
`backend-error-logic`; the same with no traceback found → still
`backend-error-logic`, at medium confidence; a 404 on a *matched* route →
`client-error`, not `route-not-implemented`; a console error citing a
real on-disk file → `frontend-runtime-error` at high confidence; the same
with no resolvable file → medium confidence; a failed step with no
console/network evidence at all → honestly `unclassified`;
`extractRecentBackendTraceback`'s freshest-match and no-match cases; and
`runErrorIntelligence`'s own honest `no-preview-running` path (reusing
the exact same real-environment discipline `browserOps.test.ts` already
established for that case).

Full `apps/desktop-agent` suite re-run: **76/77 passing** — the one
failure (`terminalWs.test.ts`) is the pre-existing, already-documented
`node-pty` native-binary gap specific to this session's Linux `device_bash`
environment (no `linux-x64` prebuild exists), unrelated to this phase's
changes and confirmed to pass on the real macOS Electron app. Full
`npm run build --workspaces` across all nine packages: zero TypeScript
errors.

## Live evidence

Rebuilt the full workspace, quit and relaunched the real MobiusX Desktop
Electron app (via Finder → double-click `start-mobiusx.command`, the
same relaunch procedure used throughout this project) so the running
desktop-agent picked up the new route and the renderer picked up the new
Debug view section. Opened `GreenThumbGarden`.

**Honest empty state first**: clicked "Run full-stack trace" before
starting a preview — got exactly the same honest
`"No preview has been started for this project — click Start Preview
first."` message `/browser-validate` already gives, confirming the new
route shares that discipline rather than erroring or fabricating a
result.

**Real trace, real bug**: started the real preview (frontend `npm run
dev` on `127.0.0.1:3000`, backend `uvicorn` on `127.0.0.1:8000`,
confirmed by the Workspace preview panel showing the actual running
Green Thumb Garden Supplies homepage) and clicked "Run full-stack trace
again". Result: **"3 traceable error(s) found"** — all three classified
as **Route not implemented**, high confidence:

- `GET /equipment` → 404. Evidence chain: browser (`[error] Failed to
  load resource: the server responded with a status of 404 (Not Found)`,
  `404 GET http://127.0.0.1:3000/equipment`) → api (`No backend route
  matches GET /equipment. Closest known routes: GET /, GET /products, GET
  /products/{product_id}.`)
- `GET /flowers` → 404, same shape.
- `GET /pots` → 404, same shape.

This is not a manufactured test case — it's the exact real, pre-existing
gap this project's own `.mobiusx/steering/architecture.md` (written
during Phase 16's live verification, before this phase existed) already
documents: *"Category pages (equipment/flowers/pots) must exist as real
files under `frontend/pages/` before the homepage links to them — this
was a real bug caught by Phase 12 browser validation."* Phase 13's
classifier independently rediscovered and correctly attributed the same
real, still-unfixed issue, citing the real closest routes rather than
just reporting "404" — a genuinely useful root-cause hint a developer
could act on immediately.

Confirmed via the real Audit Log (not just the UI):

```
17/09/2026, 22:57:32  desktop-agent  error-intelligence
Error intelligence: errors-found (3 trace(s)) in /Users/vamsimohan/Documents/Vamsi/RAG SaaS/CredenceX_WDC/Test Projects/GreenThumbGarden
```

## An honest gap this phase's own verification surfaced

GreenThumbGarden's only currently-live real bug exercises exactly one
category (`route-not-implemented`) end-to-end through the full running
app. The other five categories (`backend-unreachable`,
`backend-error-db-layer`, `backend-error-logic`, `client-error`,
`frontend-runtime-error`) are exercised by the 12 passing unit tests
against constructed evidence fixtures, but **not** independently
confirmed against a real running preview in this session, since doing so
would mean deliberately breaking a working test project (e.g. killing
the backend mid-run, or introducing a real Python exception) purely to
manufacture evidence — a step not taken here in order to leave
GreenThumbGarden in the same real, usable state other phases' live
verification depends on. Recorded plainly rather than implied to be
fully proven live: the classification *logic* for those five categories
is tested and correct; only the *end-to-end wiring* for the
route-not-implemented path has real, running-app confirmation this
session. Future verification could safely exercise
`backend-unreachable` (stop the backend mid-validation) and
`backend-error-logic`/`backend-error-db-layer` (temporarily add a
guaranteed-throwing test route) without touching any of the project's
real, kept code.

## Scope not built this phase (tracked, not forgotten)

- No re-classification trigger tied to Diagnose & Fix — a natural next
  increment would let a classified `ErrorTrace`'s reasoning and evidence
  feed directly into the Fix-mode prompt (today Fix mode still receives
  only the raw `BrowserValidationStep` text Phase 12 already wired up),
  giving the model a pre-computed root-cause hint instead of re-deriving
  it from raw console/network text itself.
- No persistence of past traces — every run is fresh, same as
  `/browser-validate` and `/verify`; no history of "this route has 404'd
  three times this week."
- Route matching handles FastAPI/Express/Next.js param conventions but
  not more exotic routing (e.g. optional segments, catch-all routes) —
  an unmatched real route in those cases would honestly fall through to
  `route-not-implemented` rather than a false match, which is the safer
  failure direction but not perfectly precise.
- Traceback extraction is regex-based (a literal "Traceback (most recent
  call last):" line, or a generic `at ... (...:N:N)` JS stack frame) — a
  backend logging framework that formats exceptions differently (e.g.
  structured JSON logs) wouldn't be recognized, and the classifier
  honestly falls back to medium-confidence `backend-error-logic` rather
  than guessing.
