# Phase 25 — X-Debug & Fix: paste-a-ticket investigation, grounded in this project's own evidence

Not a roadmap-numbered phase — Vamsi asked directly: "Introduce a X-Debug
& Fix feature that debugs and fixes the production/development code.
Developer can directly copy the JIRA/Service Desk ticket." Preceded by a
50-section "BUILD PROMPT — MOBIUSX X-DEBUG" spec audit (delivered as a
standalone gap-analysis report, not a code change) whose central honest
finding was that no such feature existed yet, named or otherwise.
Scoped with the user before building (`AskUserQuestion`): he picked
"paste ticket text" over live Jira/Service-Desk API integration, and
"extend and rebrand the existing Debug view" over a brand-new nav item.

Status: **done, live-verified end-to-end** — same "evidence, not
invention" discipline as Phases 6–13, 22, 24. This doc is that evidence.

## Design: reuse the Phase 13 evidence chain, don't invent a parallel one

The spec audit's own §49 (and this repo's established convention) says
reuse over duplication. X-Debug & Fix is not a new investigation engine —
it is a new *entry point* into the exact evidence sources Phase 13's
Error Intelligence already correlates, just starting from pasted text
instead of a live browser failure:

- `packages/protocol/src/agent.ts`'s `TraceEvidence.layer` union gains a
  `"ticket"` member alongside `"browser" | "frontend" | "api" |
  "backend" | "database"` — the originating symptom layer for a ticket
  investigation, distinct from `"browser"` because a ticket is text the
  user supplied, not something this app observed itself. Verified safe
  by grep: no exhaustive `.layer ===` switch anywhere in the codebase
  would silently mis-handle a new member.
- `apps/desktop-agent/src/ticketOps.ts` (new) reuses, unmodified,
  `errorIntelligence.ts`'s `gatherArchitectureEvidence` (Phase 9 routes +
  Phase 8 ORM entities), `extractRecentBackendTraceback` /
  `backendTracebackMentionsDb` (now exported) (Phase 12's live preview
  log), `findMatchingRoute` / `pathsMatch` (now exported) (Phase 13's own
  route-matching), plus the pre-existing `searchSemanticIndex` /
  `buildSemanticIndex` and `searchKnowledge` for relevant-files and
  Enterprise Knowledge hits. Nothing about how evidence is gathered or
  matched was reinvented.

## Ticket parsing and classification

`parseTicketText(rawText, projectPath)` extracts, all via regex over
freeform pasted text, never assuming a specific tracker's format:
ticket ID (`GTG-104`-shaped), title (a `Summary:`/`Title:`/`Subject:`
label line, else the first non-empty line), a mentioned route (`GET
/equipment`, or a bare path inferred as the request target), an HTTP
status code (only when it appears near error-ish context words — see
Errors below), a pasted traceback block, and a file:line mention
verified with `existsSync` against the real project tree so a
hallucinated-sounding path is never cited as evidence.

`classifyTicket(ticket, evidence, backendLog)` branches, in order, on
what was actually extracted — never guesses a root cause the evidence
doesn't support:

1. a pasted traceback → `backend-error-db-layer` or `backend-error-logic`
   (high confidence, mirrors Phase 13's own traceback classification);
2. a mentioned route that matches no real `DetectedRoute` →
   `route-not-implemented` (high confidence, cites the closest known
   routes for context);
3. a matched route + 5xx + a live backend log traceback available →
   db/logic category with `livePreviewCorroboration: true` (high);
4. a matched route + 5xx, no live log → `backend-error-logic` (medium);
5. a matched route + 4xx → `client-error` (medium, explicitly not
   assumed to be a bug);
6. **`insufficient-evidence`** (new category, added to
   `TicketRootCauseCategory = RootCauseCategory | "insufficient-evidence"`
   in `packages/protocol/src/debug.ts`) — the honest fallback when a
   pasted ticket lacks structured signal, naming exactly which of the
   four possible signals (endpoint/URL, status/error, traceback,
   file/line) is missing rather than force-fitting into the nearest
   category. Same discipline as Phase 13's `unclassified`.

`investigateTicket()` assembles the full report — ticket, category,
confidence, reasoning, evidence chain, semantic-search relevant files,
Enterprise Knowledge hits — served from a new
`POST /debug/ticket-investigate` route (`apps/desktop-agent/src/
routes.ts`), audited via a new `"ticket-investigation"` `AuditCategory`
(`packages/protocol/src/governance.ts`).

## What shipped

- **Backend**: `ticketOps.ts` (parsing + classification + report
  assembly), the new route, the three protocol type additions, and
  `errorIntelligence.ts` exporting three functions it already had
  (`findMatchingRoute`, `pathsMatch`, `backendTracebackMentionsDb`) so
  `ticketOps.ts` could reuse them instead of reimplementing.
- **Frontend**: the Debug nav item and view rebranded "X-Debug & Fix"
  (`index.html`), with a new "Investigate a ticket" panel above the
  pre-existing static-search UI (now labeled "Static code search" for
  clarity, left otherwise unchanged) and the untouched Error Intelligence
  section below it. `renderer.js` adds the investigate flow
  (`runTicketInvestigation`, `renderTicketInvestigation`,
  `renderEvidenceChain`) and a `generateFixFromTicket` handler that is a
  near-exact mirror of the pre-existing Error-Intelligence "Diagnose &
  Fix" handler: builds a composite prompt from the raw ticket + the
  investigation's category/reasoning/cited evidence, calls the same
  `findRelevantFiles`/`fetchSteeringContext`/`cloudApi`/`streamTask`
  pipeline, and renders the result through the same `buildEditsCard` the
  rest of the app already uses for Build/Fix/Database task results — so
  ticket-driven fixes get the same checklist, Apply, verification, and
  lazy Diagnose & Fix as every other fix in this app, for free.
- **Styling**: `.ticket-live-badge`, a `.ticket-investigate-box` block,
  and an `insufficient-evidence` category color, reusing the existing
  dark-theme palette established by Error Intelligence's own badges —
  no new colors invented.

## Tests

`apps/desktop-agent/test/ticketOps.test.ts` — 14 tests: `parseTicketText`
(ticket-ID extraction, `Summary:`-label title, first-line-fallback title,
route-with-verb extraction, bare-path extraction, status-code
context-sensitivity, traceback extraction, `existsSync`-verified file
mention) and `classifyTicket` (all 5 real categories plus the
`insufficient-evidence` fallback, including `livePreviewCorroboration`
both true and false).

One test caught a genuine design flaw, not a test bug: `STATUS_CONTEXT_RE`
was originally `/error|status|code|fail|exception|http|response/i`, and
the test ticket "GET /orders/42 returns a 404 when the order was
deleted." matched none of those words — natural ticket phrasing
("returns a 404") doesn't say "error" or "status." Broadened to
`/error|status|code|fail|exception|http|respon|return|getting|gives?\b
|seeing/i`, rebuilt, reran — 14/14 passing.

Full monorepo build clean (`protocol`, `desktop-agent`,
`cloud-agent-gateway`, 6 other packages). Pre-existing suites unaffected:
gateway 53/53, desktop-agent 132/135 with the same pre-existing
unrelated `node-pty` native-binary gap in `terminalWs.test.ts` specific
to the Linux build environment (not a regression — confirmed via `grep
-B3 "^not ok"` before and after).

## Live evidence

Run against the real running MobiusX Desktop app (relaunched via
`start-mobiusx.command` to pick up the new build) with the GreenThumbGarden
fixture project open — the same project whose real, still-unfixed 404s
(`/equipment`, `/flowers`, `/pots` have no backend route; only `GET /`,
`GET /products`, `GET /products/{product_id}` exist) Phase 13's own live
verification had already documented.

1. **Nav + view render** — clicked "X-Debug & Fix"; screenshot confirmed
   the rebranded header, scope note (explicitly: no live Jira/Service-Desk
   integration, no cross-service tracing), ticket textarea, and the
   static-search section below it, unchanged.
2. **Investigation, real ticket** — pasted a realistic ticket (`GTG-104`,
   "Equipment category page returns 404," a Summary line, repro steps
   with `GET /equipment`, "get a 404 Not Found error"). Clicked
   "Investigate ticket." Result: ticket ID `GTG-104` extracted correctly,
   category **`route-not-implemented`**, confidence **high** — exactly
   the predicted outcome, citing the real closest known routes (`POST
   /login, GET /, GET /products, POST /products, GET
   /products/{product_id}`). The relevant-files section (semantic search
   over the ticket text) returned real backend files
   (`backend/tests/test_database.py`, `backend/main.py`,
   `backend/database.py`, ranked by match score) and the Enterprise
   Knowledge section surfaced real hits from this repo's own
   `docs/phase-notes/phase-12-...md` and `phase-8-...md`.
3. **Generate Fix, model-reliability finding** — clicked "Generate Fix."
   The app's Default AI Model was still set to `Ling 3.0 Flash VL (free
   via OpenRouter)`, the same free model Phase 24's live verification
   had already flagged as unreliable ("visibly rambling, unterminated
   chain-of-thought"). Here it produced a coherent one-paragraph plan but
   **no concrete edits** — a real, reproduced instance of that
   documented issue, not a bug in this feature. Switched Default AI
   Model to `GPT-OSS 20B (free tier via Groq)` in Settings → Application
   Settings (the same model Phase 24 fell back to) and clicked "Generate
   Fix again."
4. **Generate Fix, real result** — produced a genuine 3-file proposal
   (`CREATE frontend/pages/equipment.tsx`, `flowers.tsx`, `pots.tsx`),
   rendered through the shared `buildEditsCard` with its checklist
   (Apply changes / Run verification). The review pass (Phase 22's
   "Debugger Agent") caught a real, correct issue before apply: the
   generated pages use `useEffect`/`useState` but Next.js pages are
   server components by default, so they need a `"use client"` directive
   — exactly the kind of review this pipeline exists to do.
5. **Apply → Verify → Diagnose & Fix, full loop** — clicked Apply: all 3
   files applied (checklist ticked). Clicked "Run verification": failed
   — `✗ Test (pytest, backend/) — 0/1 step(s) passed`, and "Diagnose &
   Fix" appeared lazily on the checklist exactly as Phase 24 built it to.
   Inspected the failure output: `ImportError: cannot import name
   'Notification' from 'models'` in `backend/tests/test_homepage.py` and
   `test_main.py` — this is **pre-existing drift in the GreenThumbGarden
   fixture** left over from Phase 8's own live-verification session
   (which exercised Database mode against this same project), unrelated
   to the three frontend files this fix touched. Clicked "Diagnose &
   Fix" anyway to complete the loop test: it produced a nested 1-file
   proposal, which its own Debugger Agent review correctly flagged as
   insufficient ("only monkeypatches the engine after imports... doesn't
   address how the database schema is created or seeded"). Did not apply
   the nested proposal — the point of this step was to prove the loop
   wires together and self-reviews honestly, not to repair unrelated
   fixture state.

The verification failure and the reviewer's two concerns are exactly the
kind of honest, evidence-grounded outcomes this app is built to surface
rather than paper over — a model that skips `"use client"` and a stale
test fixture are both real, and both got caught before being silently
accepted.

## Scope not built

- No live Jira/Service-Desk API integration — nothing is fetched by
  ticket ID and nothing is written back. This was the user's own
  explicit choice when scoped.
- No cross-service distributed tracing — investigation is grounded in
  this one project's own detected routes, ORM entities, and running
  preview log, the same boundary Phase 13 already documents.
- `insufficient-evidence` is an intentionally honest dead end, not a
  fallback that guesses — a ticket with no route, status, traceback, or
  file mention gets told exactly what's missing, never a fabricated
  category.
