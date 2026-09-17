# Phase 16 — Project Memory/Steering + Hooks

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 16 (source §24, §25),
"Builds on: Phase 7."

Status: **done, live-verified end-to-end** — same "evidence, not intention"
discipline as Phases 6–12. This doc is that evidence.

## Design

§24/§25 ask for two related but distinct things: persistent engineering
conventions the AI actually reads before generating anything, and
event-driven hooks that react to real project events (an API change, a
commit). Both extend the existing `.mobiusx/` convention Phase 7's
`projectContext.ts` established, following the same per-project,
hand-authored, honestly-parsed pattern `policy.ts` already set for
`.mobiusx/policy.json` (`packages/agent-settings`'s global settings are a
different, span-projects concern — steering and hooks are project-local).

**Steering** (`.mobiusx/steering/*.md`) is deliberately unlike
`architectureEvidence`/`testingContext` — those are mode-specific and
computed; steering is hand-written prose the user maintains, and it is
consulted by *every* AI Assistant mode (Ask, Plan, Build, Spec, Fix,
Database, Architecture, Testing alike), because "our API responses always
use snake_case" or "never log request bodies" is relevant regardless of
which mode is generating. Nothing is ever generated silently — a steering
file only has content because a person wrote it there (the four default
templates scaffolded by "Create default templates" are empty prompts, not
invented conventions).

**Hooks** (`.mobiusx/hooks.json`) reuses the exact one-way-ratchet-honesty
parsing convention `policy.ts` established: a malformed file is ignored in
full (never partially applied), and the specific parse error is surfaced
via `GET /hooks` rather than swallowed. Two real trigger points, chosen
because they're the two points in this app's existing lifecycle where a
file or command already crosses a boundary worth gating:
- `after-api-change` fires from `POST /fs/apply-edits`, right after edits
  are written to disk, scoped by each rule's optional `pathPattern` against
  the real applied paths.
- `before-commit` fires from the embedded terminal the moment a typed line
  matches `/^\s*git\s+commit\b/`.

`before-commit` is necessarily **reactive, not preventive** — the same
honesty `policy.ts`'s own doc comment already establishes for this real
PTY: a genuine interactive terminal forwards keystrokes live (arrow-key
history, tab completion depend on that), so by the time a completed line
can be evaluated, it has already reached the shell. The best this can do
is run the hook immediately after and, if it fails, send a best-effort
Ctrl+C — which can interrupt a slow-starting or long-running `git commit`
but cannot undo one that completes instantly. This is documented in the
code and in the Settings UI, not glossed over.

## What shipped

- **`packages/protocol/src/agent.ts`**: `SteeringFile`, `SteeringListResponse`,
  `SteeringWriteRequest`, `HookEvent`, `HookRule`, `HooksConfigResponse`,
  `HookRunResult`; `ApplyEditsResponse.hookResults?`; `TerminalServerMessage`
  extended with a `"hook"` variant.
- **`apps/desktop-agent/src/steering.ts`**: `listSteeringFiles`,
  `writeSteeringFile` (name validated against `/^[A-Za-z0-9_-]+$/`),
  `deleteSteeringFile`, `scaffoldDefaultSteering` (skips files that already
  exist — never clobbers a customized one), `buildSteeringContext` (returns
  `undefined` when there's nothing non-empty to inject, so prompts aren't
  padded with empty boilerplate).
- **`apps/desktop-agent/src/hooks.ts`**: `loadProjectHooks`, `runOne` (spawn
  with `shell:true`, 60s timeout, 4000-char output cap — same trust boundary
  as `verify.ts` already running a project's own `package.json` scripts
  unquestioned), `runHooksForEvent` (sequential, not concurrent — a hook may
  depend on a prior hook's side effect; every run individually
  audit-logged under the new `"hook-run"` category).
- **Routes** (`apps/desktop-agent/src/routes.ts`): `GET/PUT /steering`,
  `DELETE /steering/:name`, `POST /steering/scaffold`; `GET /hooks`,
  `POST /hooks/run` (a manual test-run endpoint, independent of the two
  real trigger points, for exercising a hook without needing a real commit
  or edit); `POST /fs/apply-edits` now computes `appliedPaths` and
  conditionally runs `after-api-change` hooks, folding `hookResults` into
  the response only when hooks actually fired.
- **`apps/desktop-agent/src/terminalWs.ts`**: loads `hasBeforeCommitHooks`
  once per WebSocket connection (same "read once per connection" convention
  `terminalApprovalMode` already uses — a project opened after the terminal
  connects, or a hooks.json edited after connecting, doesn't retroactively
  apply until the terminal reconnects); `checkBeforeCommitHook(line)` wired
  into both the guarded-mode and off-mode input branches.
- **`apps/cloud-agent-gateway/src/runners/promptShared.ts`**: a new
  `steeringContextBlock()` helper, prepended to every mode's system prompt.
- **Renderer** (`apps/desktop/src/renderer/`): a "Project Steering" section
  and a "Hooks" section added to Application Settings (file list with
  Save/Delete, "Create default templates", add-file form; hook rule list
  with a parse-error banner when `.mobiusx/hooks.json` is malformed); a
  `"hook"` WebSocket message handler in the terminal that writes a colored
  pass/fail banner directly into the xterm pane; the Apply button's success
  handler renders `hookResults` inline under the applied file.

## Tests

`apps/desktop-agent/test/steering.test.ts` — **7/7 passing**:
listSteeringFiles on an empty/missing dir, write+read-back round trip, the
unsafe-name rejection, delete, scaffold-never-clobbers, and both
buildSteeringContext cases (empty → `undefined`, non-empty → combined and
labeled).

`apps/desktop-agent/test/hooks.test.ts` — **8/8 passing**: load with no
file / malformed JSON / valid file, `runHooksForEvent` for both events, a
failing command producing `status: "failed"`, and the `pathPattern`
scoping behavior for both the real-edit case (`changedPaths` supplied) and
the manual-test case (`changedPaths` omitted, so a scoped rule still runs).

Re-run today (not carried over from before compaction) with `npx tsx
--test`, alongside a full clean `npm run build --workspaces` across all
nine `apps/*`+`packages/*` — zero TypeScript errors.

## Live evidence: Steering

Against `Test Projects/GreenThumbGarden` (open project): clicked "Create
default templates" in Settings → four files appeared
(`api-standards.md`, `architecture.md`, `security.md`,
`testing-conventions.md`), each with the fallback prompt text, not
invented content. Edited `architecture.md` in the Settings textarea to a
real, project-specific sentence and clicked Save:

> "GreenThumbGarden is a Next.js pages-router frontend + FastAPI backend.
> Category pages (equipment/flowers/pots) must exist as real files under
> `frontend/pages/` before the homepage links to them — this was a real
> bug caught by Phase 12 browser validation."

Confirmed via `device_bash` reading the file directly on disk at
`.mobiusx/steering/architecture.md` that the saved content exactly matches
what was typed in the GUI — a real round trip through `PUT /steering` to
a real file, not a UI-only echo.

## Live evidence: `after-api-change` hook

`.mobiusx/hooks.json` in GreenThumbGarden configured with:

```json
{ "id": "note-api-change", "event": "after-api-change",
  "command": "echo after-api-change-hook-ran",
  "pathPattern": "backend/.*\\.py$" }
```

Ran a real AI Assistant Build-mode task against the real, running
Cloud Agent Gateway (free-tier `openrouter/inclusionai/ling-3.0-flash-vl:free`,
no Anthropic key configured in this environment — see the honest gap
noted in the Phase 17 doc for what that does and doesn't limit): prompt
"In backend/pricing.py, add a single-line module docstring comment at the
very top explaining the file's purpose. Do not change any other logic."
The model proposed a one-file `MODIFY` to `backend/pricing.py`; the
Backend Agent second-pass reviewer approved it ("No logic was changed, no
security concerns..."). Clicking **Apply** produced "Applied 1/1" and,
directly under it, the real hook-result chip: **"✓ note-api-change —
`echo after-api-change-hook-ran`"** — exactly the `.edits-hook-results`
rendering added this phase.

Confirmed on disk via `device_bash`:

```
$ head -2 backend/pricing.py
# Module: pricing logic (bulk discounts, totals, seasonal adjustments) for Green Thumb Garden Supplies.
"""Pricing logic for Green Thumb Garden Supplies."""
```

(The model added both a `#` comment and a docstring — harmless
redundancy the reviewer explicitly called out and approved rather than
silently accepting.) The `pathPattern` correctly matched the real changed
path (`backend/pricing.py` against `backend/.*\.py$`), so the hook fired
for a genuine Apply, not a manual test call.

## Live evidence: `before-commit` hook (reactive)

Same project, `.mobiusx/hooks.json`:

```json
{ "id": "note-before-commit", "event": "before-commit",
  "command": "echo before-commit-hook-ran" }
```

Typed `git commit --dry-run -m "test"` into the real embedded terminal
(`--dry-run` deliberately used so this live-verification step could not
itself create a real, unintended commit in the working repo). First
attempt produced no hook banner — real evidence of the "loaded once per
connection" caveat documented above: that terminal WebSocket connection
predated `.mobiusx/hooks.json` being written, so `hasBeforeCommitHooks`
had been computed as `false` for it. Used the Settings "Reconnect
Terminal" button (the same mechanism already built for
`terminalApprovalMode` changes) to open a fresh connection, then repeated
the same `git commit --dry-run` command. This time, scrolling the
terminal's own scrollback shows the hook message arrived and rendered
**before** the shell's own dry-run output (the hook's `echo` completes
faster than git's own status computation):

```
[before-commit hook] passed: ✓ note-before-commit
On branch main
Your branch is ahead of 'origin/main' by 8 commits.
...
```

rendered with the real green-background styling from the WebSocket
message handler, not a static fixture. Cross-confirmed independently via
the Audit Log (`GET /audit`, not the terminal at all):

```
17/09/2026, 22:26:12  desktop-agent  hook-run
Hook "note-before-commit" (before-commit) passed: echo before-commit-hook-ran
```

— a real, separately-timestamped record from the `appendAuditEntry` call
inside `runHooksForEvent`, matching the terminal-rendered banner's own
timing.

## An honest gap this phase's own verification surfaced

The first `before-commit` attempt silently doing nothing (no banner, no
audit entry) is not a bug in the trigger logic itself — `runHooksForEvent`
and the terminal's completed-line detection both worked correctly once
the connection was current — but it is a real, user-facing rough edge:
nothing in the terminal panel tells the person that hook rules were
loaded for a *stale* connection versus the current `.mobiusx/hooks.json`.
The Settings page does say "Changing this only affects the terminal's
*next* connection; use 'Reconnect Terminal'" for `terminalApprovalMode`,
but that same caveat isn't surfaced anywhere for a freshly-edited
`hooks.json` while a terminal is already open. Documented here rather
than silently worked around — a future increment could either watch
`.mobiusx/hooks.json` for changes and prompt "Reconnect Terminal?", or
reload hook rules per-command instead of per-connection (a small
performance cost — one extra file read per typed line — probably worth
paying for correctness).

`POST /hooks/run` (the manual test endpoint) was built but never wired to
a UI button — the Settings Hooks section lists rules read-only. It was
exercised implicitly via the two live triggers above rather than through
its own dedicated control; adding a "Run now" button per rule is a small,
clearly-scoped follow-up.

## Scope not built this phase (tracked, not forgotten)

- Only two trigger points exist (`after-api-change`, `before-commit`).
  The roadmap line's own example — "before-commit → quality gate" — is
  satisfied, but a richer set (after-test-pass, on-preview-start, etc.)
  would need real trigger points in the codebase to hang off of first.
- No hot-reload of `.mobiusx/hooks.json` for an already-open terminal
  connection (see the honest gap above).
- Steering files are plain prose with no structure/validation — a future
  increment could parse specific conventions (e.g. a naming-convention
  section) into something more than a text blob injected into prompts,
  but that risks over-engineering a feature whose entire value is "real
  conventions a human actually wrote."
