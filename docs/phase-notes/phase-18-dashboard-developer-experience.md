# Phase 18 — Dashboard / Developer Experience polish

Roadmap line (source §32/§33/§34): "The single 'what do you want to build'
entry point and a live per-project health dashboard (build/test/security
status, artifact list, agent activity feed). Deliberately last — it's a
presentation layer over Phases 6–17's real signals."

## Design

Two things were asked for: a single entry point, and a live dashboard.

**The single entry point already exists.** The Home view's ask-box
("Ask anything, or describe what you want to build...") has been the
one place to start Ask/Plan/Build/Spec work since earlier phases. Phase 18
does not duplicate it — it adds the dashboard next to it, on the same
Home view, so opening a project surfaces both in one place.

**The dashboard is presentation over existing signals, not new detection
logic**, by design:

- **Build/test/security** reuses `GET /completion` (the Project Completion
  Contract, Phase 6) verbatim. No new pass/fail logic was written — the
  dashboard calls the same endpoint the Verify panel already trusts, and
  renders the same criteria list.
- **Artifact list** is the one genuinely new piece: a fixed candidate-path
  scanner (`apps/desktop-agent/src/dashboard.ts`) that checks whether
  specific files a generation mode is known to produce actually exist on
  disk, and reports the ones that do. It is deliberately a *scanner*, not
  a registry write — nothing marks a file as "the dashboard artifact for
  X" at generation time; the dashboard rediscovers reality on every call.
- **Agent activity feed** reuses `GET /audit` (existing audit log), filtered
  client-side to entries whose `detail.projectPath` matches the currently
  open project, most-recent-first, capped to 8.

Shown only when a project is open (`currentProjectPath` is set); hidden
entirely on a bare Home view with no project, since there is nothing to
report.

## What shipped

- **`packages/protocol/src/agent.ts`** — `DashboardArtifact` (path, label,
  category, optional sizeBytes/modifiedAt) and `DashboardResponse`
  (projectPath, generatedAt, completion, artifacts[]) types. The
  `category` union (`architecture | context | completion | steering |
  devops | spec | config`) was widened mid-phase after a live filesystem
  cross-check found two real conventions the first pass had missed (see
  "An honest gap" below).
- **`apps/desktop-agent/src/dashboard.ts`** (new) — `gatherDashboard()`:
  - Calls `computeCompletionReport()` (Phase 6, unmodified) for the
    build/test/security panel.
  - Checks a fixed list of candidate paths for existence and, for any that
    exist, records their size and mtime: `docs/architecture/HLD.md`,
    `docs/architecture/LLD.md`, `.mobiusx/PROJECT_CONTEXT.md`,
    `.mobiusx/PROJECT_COMPLETION.json`, `.mobiusx/hooks.json`,
    `.mobiusx/mcp.json`, `Dockerfile`, `docker-compose.yml`/`.yaml`,
    `.github/workflows/ci.yml`/`.yaml`.
  - Reuses `listSteeringFiles()` (Phase 16) and includes only steering
    files with non-empty content.
  - Scans `.mobiusx/specs/*.md` (Spec mode's real output convention,
    defined in the cloud-agent-gateway's prompt text, not a dedicated
    module) and lists each one found.
- **`apps/desktop-agent/src/completion.ts`** — no new logic; three stale
  `not_configured` detail strings were corrected (see below).
- **`apps/desktop-agent/src/routes.ts`** — `GET /dashboard`: 409 if no
  project open, otherwise calls `gatherDashboard(projectState.path,
  projectState.isGitRepo)` and returns the result.
- **`apps/desktop/src/renderer/{index.html,renderer.js,styles.css}`** —
  a "Project health" section on the Home view: three columns
  (build/test/security, artifacts, recent agent activity), a manual
  Refresh button, and a `loadDashboard()` call wired into `showView()`
  so it loads whenever Home is shown with a project open.
  `renderCompletionReport()` was refactored to accept a target element
  (it previously always wrote to the Verify panel's own element) so the
  dashboard and the Verify panel can share the same rendering code.
- **`apps/desktop-agent/test/dashboard.test.ts`** (new) — 5 tests.

### An honest correction along the way

`completion.ts` had three `not_configured` criteria whose `detail` text
had gone stale — they described Phase 12 (Browser/Application Validation)
and Phase 14 (DevOps generation) as "not yet implemented" when both now
exist. Since the dashboard surfaces this exact text to the user for the
first time in a prominent panel, the stale wording would have been
actively misleading. Corrected to state what actually exists today and
why each criterion is still honestly `not_configured` (e2e tests exist
but aren't cached/run automatically; DevOps can *propose* infra files but
doesn't deploy or verify a live deployment). Live-verified the corrected
text renders exactly as written.

## Tests

`apps/desktop-agent`: 92/95 passing (1 pre-existing unrelated failure in
`terminalWs.test.ts`, 2 skipped — real pytest/tooling not present in this
environment; both pre-date this phase). `dashboard.test.ts` itself: 5/5
passing, covering:

1. A brand-new project reports exactly one artifact
   (`.mobiusx/PROJECT_COMPLETION.json`) — because `computeCompletionReport`
   writes that file as a real side effect before the artifact scan runs,
   so `[]` would have been the wrong expectation.
2. Real architecture docs, project context, and a Dockerfile that exist on
   disk are detected with correct category, size, and mtime; a candidate
   that doesn't exist (`LLD.md`) is correctly absent.
3. A non-empty steering file is listed; an empty one is skipped.
4. `.mobiusx/specs/*.md` files are listed as `spec` artifacts; a sibling
   `.json` file with the same slug is correctly ignored.
5. `isGitRepo` passes through honestly to the underlying completion
   report's `git_initialized` criterion in both directions.

`packages/protocol` and `apps/desktop-agent` both typecheck clean
(`tsc --noEmit`). `apps/desktop/src/renderer/renderer.js` passed
`node --check`.

## Live evidence

Verified against the real running Electron app on GreenThumbGarden
(`/Users/vamsimohan/Documents/Vamsi/RAG SaaS/CredenceX_WDC/Test
Projects/GreenThumbGarden`), across two app restarts (see "An honest
gap" below for why two):

- **Restart 1** (after the initial implementation): opened GreenThumbGarden,
  navigated to Home, confirmed the "Project health — GREENTHUMBGARDEN"
  section renders with all three columns populated: completion showing
  "Verified — 100% of measured criteria pass" with the corrected
  `not_configured` detail text for auth/e2e/security-scan/deployment;
  artifacts showing HLD, LLD, Project Context, Completion Report, Hooks
  config, Docker Compose, CI Pipeline, and all four steering files; recent
  activity showing the real checkpoint-restored/checkpoint-created/
  applied-edits entries from Phase 15's own live verification.
- **Filesystem cross-check**: while that build was still running, listed
  `.mobiusx/` on the real project directory directly and found
  `mcp.json` and a `specs/` directory with real content
  (`shopping-cart-checkout.md`/`.json`) that the running dashboard was
  NOT showing — the gap described below.
- **Fix + rebuild**: widened the category union, added the specs scan and
  `mcp.json` candidate, added a passing unit test, rebuilt
  `@mobiusx/protocol` and `apps/desktop-agent` clean. Confirmed via
  `grep` on the compiled `dist/dashboard.js` that the new build actually
  contained the specs-scanning code before asking for a restart.
- **Restart 2**: re-opened GreenThumbGarden. Confirmed both previously-missing
  artifacts now appear: "MCP config" → `.mobiusx/mcp.json` (between Hooks
  config and Docker Compose), and "Spec: shopping-cart-checkout" →
  `.mobiusx/specs/shopping-cart-checkout.md` (after the steering entries).
  Screenshots captured at each step confirm the exact rendered text and
  paths.

## An honest gap

The first implementation of the artifact scanner was built from grepping
only `apps/desktop-agent/src/*.ts` for `.mobiusx/specs`, found nothing, and
concluded (wrongly) that Spec mode has no fixed on-disk output convention
— so specs were deliberately left out, with a doc comment explaining the
exclusion. That was an incomplete search, not a real absence: Spec mode's
`.mobiusx/specs/<slug>.md` + `<slug>.json` convention is real, it's just
defined in the cloud-agent-gateway's prompt text
(`apps/cloud-agent-gateway/src/runners/promptShared.ts`) rather than a
desktop-agent module, and a real file from earlier Phase 7 testing
(`shopping-cart-checkout.md`) was sitting on disk the whole time. Caught
only by cross-checking the live dashboard's output against `ls
.mobiusx/` on the actual project directory — a reminder that "grep the
module that should own this" is not the same check as "look at what's
actually on disk." The `.mobiusx/mcp.json` (Phase 17) omission was found
the same way, in the same pass.

Two required an app restart to verify live because the desktop-agent is a
long-running Node child process — code changes on disk don't take effect
until it's relaunched. Both restarts hit the same `ELECTRON_RUN_AS_NODE`
inheritance bug documented in Phase 15's notes (the embedded terminal
panel is a descendant of the desktop-agent process itself, so relaunching
Electron from within it inherits an env var that makes the new instance
try to run as plain Node and crash before `app.setName()`). Both times
were resolved by asking the user to restart from their own terminal
instead, which doesn't carry that env var.

## Scope not built

- The dashboard's artifact list is a fixed candidate-path scanner, not a
  general "list everything generated this session" view — a mode that
  writes to a path not on the candidate list (or to a dynamic path, e.g.
  per-run output) won't show up. This mirrors how each mode's own output
  convention was discovered piecemeal across phases; there is no central
  registry of "artifact-producing paths" a new mode could register into.
- No trend/history view — the dashboard reports current state only, not
  "how completion changed over the last N runs." The audit log has the
  raw history but the dashboard doesn't chart it.
- No per-artifact preview or open-in-editor action from the dashboard
  panel itself — artifacts are listed with their path but clicking one
  doesn't yet jump to it in the Workspace file tree.
- The activity feed's `projectPath` filter is an exact string match
  against `currentProjectPath`; it will not surface activity logged
  under a different-but-equivalent path spelling (e.g. a symlink or a
  trailing slash difference), matching how the rest of the app already
  keys project identity.
