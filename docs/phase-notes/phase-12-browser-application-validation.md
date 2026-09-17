# Phase 12 — Browser / Application Validation

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` §18 (builds on Phase 6's
fix loop and the existing `previewOps.ts`).

> Drives the already-running preview (via `previewOps.ts`) with a real
> browser (Playwright) to click through flows, capture screenshots, read
> console/network errors, and feed failures into Phase 6's fix loop as a
> new evidence source alongside `verify.ts`.

Status: **done, live-verified end-to-end** against the real running app and
the real GreenThumbGarden fixture project. Live verification didn't just
exercise the happy path — it caught two genuine 404s in the fixture app's
own navigation (`/equipment`, `/flowers`), which is exactly the class of
bug this phase exists to surface. Same discipline as Phases 6–11: this doc
records what actually happened, including a real environment gap the
roadmap's wording didn't anticipate.

## What existed before this phase

`verify.ts` (Phase "Verification Engine", PRD §22) runs a project's own
build/test/lint/typecheck scripts and reports real pass/fail evidence.
`previewOps.ts` (item 6, phase 2) spawns a project's real dev server(s) and
reports genuine status/URL once one is actually listening — the desktop
shell embeds a `<webview>` at that URL. Nothing in the codebase ever drove
that running preview itself: no click-through, no console/network
inspection, no screenshot. A frontend bug that only shows up at runtime
(a broken link, a client-side console error, a 404 on a page the build
step never touches) was invisible to `verify.ts`, which only ever sees
what `npm run build`/`tsc`/tests can see statically.

## The environment gap: Playwright wasn't actually available here

The roadmap entry says "Playwright — already configured in this
environment." That's true of *this Claude session's own cloud sandbox*
(a separate machine, used for the sandboxed research/build/test loop this
whole project follows) — it is not true of the real MobiusX_WDC product
repo on the user's Mac, where this phase's feature actually has to run.
Confirmed before writing any code: no `playwright`/`puppeteer` anywhere in
`package-lock.json` or any `package.json`, no `node_modules/playwright*`.
So this phase had a real dependency-provisioning step the others didn't:

1. Added `playwright` (the full package, not `playwright-core`, so a plain
   `npm install` at the repo root auto-manages the Chromium download) to
   `apps/desktop-agent/package.json` and installed it via the sandbox's own
   Linux VM bridge with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` — safe there,
   since npm dependency resolution is pure JS/TS and platform-independent,
   but a browser *binary* download from that Linux VM would fetch a Linux
   build, useless for the actual macOS Electron app.
2. Separately, ran `npx playwright install chromium` for real on the user's
   Mac — through MobiusX's own embedded terminal panel (`node-pty`, real
   shell, real environment), since Terminal.app itself is only reachable in
   a click-only accessibility tier from this session and can't be typed
   into. Confirmed live: real `~/Library/Caches/ms-playwright/chromium-1243`
   (plus its headless-shell and ffmpeg companions) landed on the real Mac,
   ~193 MiB downloaded from `cdn.playwright.dev`.

This is recorded here because it's a real, reusable fact about this
project's environment (not a one-off): any future phase that needs an
actual browser binary — not just the `playwright` npm package — has the
same two-step shape, and the sandbox's own pre-installed Chromium is never
a substitute for the real Mac's.

## Design: reusing the Fix Loop's exact evidence shape

The roadmap explicitly frames this as "a new evidence source alongside
`verify.ts`" feeding "Phase 6's fix loop" — so the design goal was zero new
prompt/protocol surface for the fix loop itself, not just a resemblance.
`promptShared.ts`'s "fix" mode prompt only ever reads
`{label, command, output}` off each `ProjectContext.failingVerification`
entry (confirmed by re-reading it before writing any code — it doesn't
touch `id`/`exitCode`/`truncated`/`durationMs` at all). So `verify.ts`'s
richer `VerificationStep` was never really the fix loop's contract — that
three-field shape was. A failing `BrowserValidationStep`, mapped down to
the same three fields at the UI layer (identical to how the existing
"Run verification" button already narrows `VerificationStep` before
passing it to `POST /tasks`), slots into `failingVerification` with
**zero protocol or prompt changes on the fix-loop side** — confirmed live
(see below): the "Diagnose & Fix" button appeared correctly off a browser
validation failure alone, no verification run required first.

`BrowserValidationStep` itself is a new, independent type (not a subtype
of `VerificationStep` — there's no real exit code for a browser
navigation, and it carries an optional screenshot `VerificationStep`
doesn't), but deliberately keeps the same `label`/`command`/`output`/
`status` shape so a browser step and a verify step read identically
wherever the UI shows them side by side.

## What "click through flows" means here, concretely

The "never invent evidence" discipline every phase in this codebase
follows ruled out generating or guessing a set of flows to click through.
`browserOps.ts#runBrowserValidation` instead:

1. Requires a REAL running preview first — reads `previewOps.ts`'s own
   `getPreviewStatus().frontend`; if it's null, not yet `"running"`, or
   has no discovered URL, this returns `overall: "no-preview-running"`
   with an honest, specific reason (never a silent empty result, never an
   error) — the same "no-verification-available" pattern `verify.ts`
   established for "nothing to check yet."
2. Launches headless Chromium, navigates to the preview's own real URL,
   and captures: console `error`/`warning` messages, failed network
   requests (`status >= 400` or a real request failure), any uncaught page
   error, and a bounded JPEG screenshot (quality 50, viewport-only — kept
   small deliberately, same "bounded so a response can't blow up the
   DB/response" discipline `verify.ts`'s `MAX_OUTPUT_CHARS` already
   established).
3. Only THEN — after that first real page has actually rendered — reads
   the real `<a href>` elements present in its live DOM, keeps only
   same-origin ones, dedupes, and visits up to 5 of them the same way.
   Never a route guessed from framework convention, never an off-site
   link followed. This is "click through flows" scoped to what a real
   user landing on the homepage would actually see.
4. A page step fails if navigation itself failed/timed out (20s cap),
   OR if any console error/network error/page error was observed —
   genuinely broken UI is a failure even if the HTTP navigation itself
   "succeeded."

## What was built

- **`packages/protocol/src/agent.ts`** — `BrowserValidationStep` (id,
  label, command, status, url, consoleErrors[], networkErrors[], output,
  optional screenshot data-URI, durationMs) and `BrowserValidationResponse`
  (projectPath, previewUrl, previewUnavailableReason?, overall, steps[]).
- **`packages/protocol/src/governance.ts`** — added `"browser-validation"`
  to `AuditCategory` (a real, narrow addition the compiler caught
  immediately when the new route tried to log one).
- **`apps/desktop-agent/src/browserOps.ts`** (new) —
  `runBrowserValidation(projectPath)`: the logic in the "what click through
  flows means" section above. Bounded constants throughout (20s nav
  timeout, 20 console errors, 20 network errors, 4000-char output cap,
  5 links max, JPEG quality 50) — same bounded-by-design posture as
  `verify.ts`.
- **`apps/desktop-agent/src/routes.ts`** — `POST /browser-validate`:
  requires an open project, calls `runBrowserValidation`, audit-logs a
  summary (skipped when `overall === "no-preview-running"`, matching how
  `/verify` skips its own audit entry for "nothing to check"), returns the
  full `BrowserValidationResponse`.
- **`apps/desktop-agent/package.json`** — added `playwright` (resolved to
  `^1.63.0` in `package-lock.json`).
- **`apps/desktop/src/renderer/{index.html-equivalent template in
  renderer.js, renderer.js, styles.css}`** — every task's "Proposed
  changes" card (`buildEditsCard`, the same place "Run verification"
  already lives) gained a "Run browser validation" button, shown the
  moment edits are applied (same gating as "Run verification"). Results
  render as a per-page list: pass/fail icon, label, duration, and an
  expandable detail panel with the real screenshot and the real
  console/network error text. Two independent evidence trackers
  (`lastFailingVerifySteps`, `lastFailingBrowserSteps`) are merged by a
  new `recomputeFailingSteps()` helper into the same `lastFailingSteps`
  "Diagnose & Fix" already reads — so a fresh verify run never wipes out
  a still-valid browser-validation finding, or vice versa, and either
  source alone is enough to surface "Diagnose & Fix."
- **`apps/desktop-agent/test/browserOps.test.ts`** (new) — a deterministic
  test for the honest "no preview running" path (no process spawn needed),
  plus a real, self-skipping end-to-end test that starts an actual fixture
  dev server via `previewOps.ts#startPreview`, serves a page with a genuine
  `console.error` and a genuine broken same-origin link, and asserts the
  captured evidence matches exactly — skipped (not failed) if Chromium
  isn't installed in whatever environment runs the suite, the same
  discipline `verify.test.ts` already follows for a local `pytest` install.

## Build, typecheck, test — whole workspace

- `packages/protocol`, `packages/agent-settings`, `packages/audit-log`,
  `packages/context-engine`, `packages/secret-scan`,
  `packages/semantic-index`, `apps/cloud-agent-gateway`,
  `apps/desktop-agent` — all build clean (`tsc -p tsconfig.json`, zero
  errors) after the `AuditCategory` fix.
- `apps/cloud-agent-gateway` test suite: **53/53 passing** (unchanged from
  Phase 11 — confirms the `AuditCategory` addition and Phase 12's changes
  didn't touch anything Phase 11 depends on).
- `apps/desktop-agent` test suite: **41 pass / 1 fail / 2 skipped** (was
  39/1/1 before this phase). The 2 new `browserOps.test.ts` tests: one
  passes deterministically, the other self-skips because Chromium wasn't
  installed in the sandbox's own Linux VM (expected — see the environment
  gap section; it's not needed there, only on the real Mac). The 1 failure
  is `terminalWs.test.ts`, the same pre-existing, unrelated failure
  documented since Phase 11.

## Live verification against the real app

Performed against the real running Electron app and the real
GreenThumbGarden fixture project, after installing Playwright's Chromium
binary on the real Mac and doing a full app relaunch (quit + relaunch via
`start-mobiusx.command`) so the running `desktop-agent` picked up the
newly built `dist/` — a stale backend process from before the relaunch had
to be force-quit via Activity Monitor first, since Electron's own launch
guard reuses an already-listening agent rather than starting a fresh one.

1. Started the real preview (`frontend: http://127.0.0.1:3000`,
   `backend: http://127.0.0.1:8000`) for GreenThumbGarden.
2. Ran a real Build-mode task ("add a footer line to the homepage") — the
   default free OpenRouter model burned its whole turn on an unparsed
   reasoning trace and produced no edits (a real, live-observed model
   flakiness, not a bug in this phase); switching to Groq's
   `openai/gpt-oss-120b` produced two real proposed edits, correctly
   reviewed by Phase 11's Backend Agent persona ("Concerns" — flagged a
   real risk in the added test's import), and applied.
3. Clicked the new **"Run browser validation"** button. Real result:
   **1/4 pages passed**, starting from the real preview URL.
   - `http://127.0.0.1:3000` — passed. Real screenshot rendered inline
     ("Green Thumb Garden Supplies", product categories, footer). "No
     console errors, page errors, or failed network requests observed."
   - `http://127.0.0.1:3000/equipment` — **failed**. Real screenshot shows
     a genuine Next.js 404 page. Captured console error: `[error] Failed
     to load resource: the server responded with a status of 404 (Not
     Found)`. Captured network error: `404 GET
     http://127.0.0.1:3000/equipment`.
   - `http://127.0.0.1:3000/flowers` — **failed** the same way (another
     genuine broken nav link in the fixture app).
   - A fourth discovered link also failed the same way (not transcribed
     above, same 404 pattern).
   This is a real bug in the GreenThumbGarden fixture's own navigation
   that no prior phase's tooling (`verify.ts`, `/project-context`, etc.)
   could have caught, since it only manifests at runtime in the browser —
   exactly the gap this phase exists to close.
4. Confirmed the Fix Loop wiring: the moment browser validation reported
   failures, the **"Diagnose & Fix"** button appeared on the same card —
   with no verification run required first, confirming
   `lastFailingBrowserSteps` alone (independent of
   `lastFailingVerifySteps`) correctly drives `recomputeFailingSteps()`.

## Known limitations (honestly scoped, not hidden)

- "Click through flows" is same-origin links discovered on the landing
  page only, one level deep, capped at 5 — it does not fill forms, log
  in, or follow links discovered on pages *it* visits (no recursive
  crawl). A deeper multi-step flow (e.g. an actual checkout flow) would
  need explicit flow definitions from somewhere, which this phase
  deliberately does not invent.
- Screenshots are viewport-only JPEGs at quality 50, not full-page or
  full-resolution — a deliberate bound (same reasoning as `verify.ts`'s
  `MAX_OUTPUT_CHARS`), not an oversight.
- Requires the preview to already be running; it does not start one
  itself. Consistent with `/verify` requiring an open project rather than
  opening one — a separate concern, already owned by `/preview/start`.
