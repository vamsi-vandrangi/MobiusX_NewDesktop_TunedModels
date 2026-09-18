# Phase 22 — Auto Fix-Loop mode (§16)

Phase 6's own phase-notes doc, under "Scope not built this phase," said
plainly: *"'Auto' fix-loop mode that chains Apply → Verify → Diagnose
cycles without a click each time (`AgentSettings.fixLoopMode`). Current
behavior is intentionally 'manual'."* The setting (`"manual" | "auto"`)
had existed in the type system, PATCH validation, and settings
persistence since Phase 6 — nothing ever read the value, and there was
no Settings UI control to set it.

## Design

Entirely additive on top of the existing, already-live-verified manual
flow, by design, to avoid any risk of regressing it. The user's own
first "Diagnose & Fix" click is unchanged. What "auto" adds is
everything after that: once a fix task's edits render, `autoChainFix()`
drives the SAME Apply / Run verification / Diagnose & Fix buttons a
manual user would click — real DOM `.click()` calls, polling each
button's own pre-existing "done" signal (its text leaving its "…ing"
busy state) — so the auto path and a manual user are indistinguishable
to the rest of the app: same API calls, same rendered evidence, same
recursive `buildEditsCard` structure at every level. Capped at
`MAX_AUTO_FIX_ITERATIONS = 3`; a genuinely unfixable failure reports
"stopped after 3 attempt(s)" rather than looping forever.

Settings are fetched fresh on every Diagnose & Fix click (never cached),
so a mid-session Settings change takes effect on the very next cycle
without a reconnect.

## What shipped

- `apps/desktop/src/renderer/renderer.js` — `waitForButtonSettled`,
  `appendAutoFixBanner`, `autoChainFix` (new); the existing Diagnose &
  Fix handler now fetches current settings after appending a fix task's
  nested edits card and starts the auto-chain when `fixLoopMode ===
  "auto"`.
- `apps/desktop/src/renderer/index.html` — a new "Autonomous Fix Loop"
  Settings section (Manual/Auto radio), matching Terminal Approval's own
  visual pattern.
- `apps/desktop/src/renderer/renderer.js` — `loadFixLoopModeSettings`
  wired into `loadSettings()`.

## Live evidence

This is the phase with the highest execution risk in this batch (client-
side async DOM orchestration, never previously exercised), so it was
tested end-to-end against a real failure, not just a passing case.

1. **Settings control confirmed live and functional**: Application
   Settings → Autonomous Fix Loop now shows the Manual/Auto radio
   (previously nonexistent). Selecting "Auto" showed "Saved — applies to
   your next Diagnose & Fix click," and a `PATCH /settings` call
   persisted it (confirmed via the Audit Log's own timestamped entries
   below).
2. **A genuine failure, not a staged one**: opened the `FixLoopTest`
   project (an existing fixture built earlier in this session
   specifically for this purpose; its README states the intended bug).
   The bug had already been fixed by earlier work this session, so a
   real failure was reintroduced directly on disk (`math.js`'s `add()`
   changed from `a + b` to `a - b`) and confirmed failing with `node
   test.js` before touching the app at all (`AssertionError: add(2, 3)
   should be 5, got -1`).
3. **Triggering the chain**: submitted an unrelated, harmless Build task
   (a README comment) to get a task card with Apply/Run-verification
   buttons, applied it, clicked "Run verification" — real failure, "✗
   Verification failed — 0/1 step(s) passed — Test (npm run test)."
   Clicked **"Diagnose & Fix" exactly once.**
4. **What happened with zero further clicks**: a Fix-mode task ran
   (Debugger Agent persona — pre-existing persona classification, not
   part of this phase). It proposed a `MODIFY` to `math.js`. The
   Debugger Agent's review returned "Concerns" — honestly stating it
   "cannot verify this change actually addresses the root cause... no
   diff showing what was broken originally... this cannot be confirmed
   as a correct fix" (it had no visibility into the original broken
   state, a real and reasonable limitation, not a bug). The auto-chain
   applied the edit anyway (Apply is not gated by review verdict — the
   same behavior a manual user gets), automatically re-ran verification,
   which passed ("✓ Test (npm run test), 990ms, exit 0"), and rendered
   **"✓ Auto fix loop succeeded after 1 attempt(s)."**
5. **Confirmed via the real audit log** (all real timestamps, ~25
   seconds end-to-end):
   - `09:02:23` `applied-edits` — 0/1 (the harmless README task)
   - `09:02:33` `verification` — failed (0/1)
   - `09:02:47` `applied-edits` — 1/1 (the auto-chain's math.js fix)
   - `09:02:47` `checkpoint-created` — `math.js`
   - `09:02:48` `verification` — passed (1/1)
6. **Confirmed on the real filesystem**: `math.js`'s `add()` is restored
   to `return a + b;`, and `npm test` genuinely prints "All tests
   passed."

## Scope not built

- Client-orchestrated (real DOM clicks + polling on existing buttons),
  not a rewrite of `buildEditsCard`'s internals into extractable named
  functions — lower-risk given the manual flow's own long live-verified
  history, but means the auto-chain has no unit test of its own
  (DOM-dependent); correctness was verified by tracing the recursion by
  hand and by the live GUI test above, including a genuine failure path.
- The reviewer's "Concerns" verdict does not block the auto-chain from
  applying — matching existing manual-flow behavior (a human can also
  Apply after Concerns), but worth noting since "Auto" removes the human
  who might otherwise pause and read the reviewer's objection first.
