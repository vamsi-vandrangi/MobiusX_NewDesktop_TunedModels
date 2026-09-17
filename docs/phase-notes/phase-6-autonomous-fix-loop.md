# Phase 6 — Autonomous Build/Test/Fix Loop + Project Completion Contract

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` §16 (Autonomous Build/Test/Fix
Loop) and source requirements doc §31 (Project Completion Contract).

Status: **done, live-verified end-to-end** — not just "code written." Per this
repo's own convention (stated in the roadmap doc): a phase is done "when it's
been exercised against a real generated project... with evidence, not
intention." This doc is that evidence.

## What shipped

- **Verification Engine** (`apps/desktop-agent/src/verify.ts`, pre-existing):
  detects `typecheck`/`build`/`lint`/`test` scripts in the open project's root
  `package.json` and actually runs them, reporting pass/fail/timed-out per step
  with real output. Documented v1 limitation: only the ROOT `package.json` is
  read, so monorepo-style projects with no root scripts (e.g. GreenThumbGarden's
  separate frontend/backend) report "no verification available" rather than a
  false pass — honest, not a bug.
- **Diagnose & Fix button**: appears only when a real verification run fails.
  Clicking it builds a `mode: "fix"` task grounded in
  `ProjectContext.failingVerification` (the actual failing step labels +
  output), streams it through the same propose → review → apply pipeline as
  any other task, and renders the proposed edit as a nested edits card so the
  user can Apply → Run verification again → Diagnose & Fix again, chaining as
  many cycles as the failure needs. (`apps/desktop/src/renderer/renderer.js`,
  `diagnoseBtn` handler.)
- **Project Completion Contract** (`apps/desktop-agent/src/completion.ts`,
  `GET /completion`): computes a real report of what's actually verifiable
  about the open project right now — re-runs verification, checks git-init and
  README presence, and honestly reports `not_configured` (not a fabricated
  pass) for criteria this codebase doesn't measure yet: auth verification,
  e2e/browser tests, a real security scan, deployment. Writes the report to
  `<project>/.mobiusx/PROJECT_COMPLETION.json` as a durable artifact. A new
  **Project Completion Contract** panel was added to the Tasks view this
  session (`index.html` + `renderer.js` + `styles.css`) with a "Check
  completion" button, since no UI previously called this endpoint.

## Two real bugs found and fixed during live verification

Both were found by actually clicking through the flow against a real model,
not by code review, and both are UI-layer bugs in `renderer.js` — the backend
(`verify.ts`, `completion.ts`, `promptShared.ts`, `fsOps.ts`) was correct
throughout.

### Bug 1 — race condition made a genuinely correct fix look like "no fix"

`diagnoseBtn`'s click handler polled task detail, then called `streamTask()`
which resolves as soon as its WebSocket receives a `"done"` message — but
`"done"` could arrive while an earlier `onEdits`/`onStatus` callback's own
`refresh()` GET was still in flight. The handler then read `detail` before
that GET landed, so a task that (per the Tasks view) clearly had 1 proposed
edit rendered "No concrete fix was proposed" here. Fixed by adding one
guaranteed-fresh `cloudApi()` fetch immediately after `streamTask()` resolves,
since "done" means the task is terminal server-side regardless of which
refresh happened to finish last.

### Bug 2 (root cause of every prior "no fix" and every wrong "create") —
### fix-mode tasks never got full file content

`findRelevantFiles(query, mode)` only fetched full file content via `/fs/read`
when `mode === "build"`; `"fix"` mode always got snippet-only hits. But
`promptShared.ts`'s fix-mode prompt only allows action `"modify"` for a path
the model was shown FULL content for, and otherwise instructs it to only ever
`"create"` — which `fsOps.ts#applyEdits` then correctly refuses for a path
that already exists ("file already exists — refusing to overwrite a create").

This was confirmed live against **3 different real models**
(`groq/openai/gpt-oss-120b` twice, `openrouter/inclusionai/ling-3.0-flash-vl:free`):
every single one either declined to propose any edit (citing "the file
already exists" in its own reasoning) or proposed a correct fix mislabeled
`"create"`, which Apply then silently skipped — deterministically, for every
model, not model flakiness. Fixed by extending the same full-content fetch to
`"fix"` mode.

## Live evidence: the loop actually converges

A minimal test project was created specifically to exercise this (existing
test projects like GreenThumbGarden have no root `package.json`, so they can't
drive the Verification Engine at all):

`Test Projects/FixLoopTest/` — `add(a, b)` in `math.js` deliberately returns
`a - b`; `test.js` asserts `add(2, 3) === 5`.

Sequence, all performed against the real running app (not simulated):

1. Build-mode task added a correct `multiply(a, b)` function — applied
   cleanly.
2. **Run verification** → real failure: `npm run test` exit 1,
   `AssertionError: add(2, 3) should be 5, got -1`.
3. **Diagnose & Fix** appeared (only because of the real failure above).
   First three attempts (pre-fix) reproduced Bugs 1 and 2 exactly as
   described. After applying both fixes and reloading the app, a fourth
   attempt (`openrouter/inclusionai/ling-3.0-flash-vl:free`) produced a
   correct `MODIFY math.js` diff:
   ```diff
   -  // BUG: this subtracts instead of adding.
   -  return a - b;
   +  return a + b;
   ```
4. **Applied** the fix (2/2 files — `math.js` and `test.js`, which the same
   fix task had also updated with an additional assertion).
5. **Run verification again** → `✓ Verification passed — 1/1 step(s) passed`,
   `Test (npm run test)` exit 0, 834ms.
6. Independently confirmed outside the UI via `device_bash`:
   ```
   $ npm test
   > node test.js
   All tests passed.
   EXIT:0
   ```

This is the concrete proof the loop converges: propose → apply → verify →
(on failure) diagnose & fix → apply → verify → pass, with two real bugs found
and fixed along the way rather than assumed away.

## Live evidence: Project Completion Contract

`GET /completion` exercised against FixLoopTest via the new UI panel:

```
Verified — 100% of measured criteria pass
✓ Test (npm run test)
○ Frontend preview running        Not started this session — click Start Preview.
○ Backend preview running         Not started this session — click Start Preview.
✓ Git repository initialized
✓ README present
○ Authentication / authorization verified   ... see roadmap Phase 8+.
○ End-to-end (browser) tests passing        ... see roadmap Phase 12.
○ Security scan clean                       ... see roadmap Phase 14.
○ Deployment verified                       ... see roadmap Phase 14.
```

Confirmed written to `.mobiusx/PROJECT_COMPLETION.json` on disk (matches the
UI exactly). Note the report correctly reports `overall: "verified"` /
`100%` while still being honest that 6 of 9 criteria are `not_configured` —
`completionPercent` is scoped to *measured* criteria only, by design (see
`completion.ts`'s doc comment), never inflated by criteria nothing checks yet.

## Scope not built this phase (tracked, not forgotten)

- "Auto" fix-loop mode that chains Apply → Verify → Diagnose cycles without a
  click each time (`AgentSettings.fixLoopMode`). Current behavior is
  intentionally "manual": each cycle requires an explicit Apply.
- Real auth verification, e2e/browser test running, SAST/dependency scanning,
  and deployment verification for the Completion Contract — these are later
  roadmap phases (8+, 12, 14) and are honestly reported `not_configured`
  rather than faked.
