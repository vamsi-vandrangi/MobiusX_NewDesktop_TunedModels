# Phase 15 — Checkpoints / Rollback

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 15 (source §23) —
"A real restore-point mechanism. Called out as its own phase rather than a
Phase 6 prerequisite because Phase 6 ships safely without it (manual-mode
approval + `audit-log` is the interim safety net) — but every autonomous
phase after this one benefits from it, so it's prioritized early rather
than deferred indefinitely." Builds on: `audit-log` ("already tracks what
changed; this phase adds 'and can undo it'").

Status: **done, live-verified end-to-end**, including a restore that was
itself restored, proving the "undo is itself undoable" property against a
real applied edit rather than only in a unit test. Same "evidence, not
intention" discipline as every prior phase.

## Design

`docs/roadmap/` is an empty directory in this repo — the roadmap table's
own cell text above is the fullest available spec, same as it was for
Phase 13/14. Three pieces of real evidence, read directly from the
codebase before writing anything, shaped every decision below:

1. **`packages/audit-log/src/index.ts`** already exists and already
   records that something changed (`appendAuditEntry`/`readAuditLog`,
   append-only JSONL at `~/.mobiusx/audit.jsonl`) — but it stores only
   lightweight summary/detail metadata, never file content. It cannot be
   the restore mechanism itself; it can only be extended with new
   category values so a checkpoint event is visible in the same feed as
   everything else.
2. **`apps/desktop-agent/src/gitOps.ts`** already has `isGitRepo(cwd)`,
   checked before every git-dependent feature in this codebase. Its mere
   existence establishes that an open project is *not* guaranteed to be a
   git repo — ruling out a git-only checkpoint mechanism as the sole v1
   approach, since that would leave exactly the non-git projects this
   phase is supposed to make safer with no safety net at all.
3. **`apps/desktop-agent/src/fsOps.ts`'s `applyEdits`** is the single
   place in this whole codebase where AI-generated content ever reaches
   disk (its own doc comment says so), and it captures zero pre-edit
   content before overwriting a file. This is the one correct hook point:
   a checkpoint has to be taken *before* this function runs, because once
   it runs the pre-edit content is gone.

So: a dedicated, git-independent, project-local snapshot mechanism,
following the exact `.mobiusx/` convention steering (Phase 16) and specs
(Phase 7) already established for project-local generated state:

```
.mobiusx/checkpoints/<id>/manifest.json   -- id, createdAt, label, entries[]
.mobiusx/checkpoints/<id>/files/<relPath> -- pre-edit content (only where captured)
```

`createCheckpoint(projectRoot, edits, label?)` in the new
`apps/desktop-agent/src/checkpoints.ts` is called from
`POST /fs/apply-edits` in `routes.ts`, immediately before `applyEdits`
itself runs. It reuses `fsOps.ts`'s own `resolveWithinProject` (the exact
path-traversal guard reads/writes already use) and the newly-exported
`pathExists`, rather than re-implementing either — the same
never-duplicate-a-security-check discipline every prior phase in this
session has followed. A checkpoint always covers the **whole** batch it
was taken for, including `"create"` entries with nothing to snapshot, so
"restore this checkpoint" has one honest, consistent meaning: undo this
entire apply, not just its destructive half. `ApplyEditsResponse` now
always carries a `checkpointId`, so a future UI could deep-link "here's
what I just did, want to undo it?" directly from the apply result itself
(not built yet — see Scope not built).

**Restore is itself always undoable.** Before `restoreCheckpoint` writes
back or deletes anything, it takes *another* checkpoint of whatever is
*currently* on disk at those same paths — computed fresh from the real
filesystem, never copied from the checkpoint being restored. This matters
concretely: if the checkpoint being restored recorded a path as
`"create"` (nothing to snapshot), but that file has since been hand-edited
by the user, the pre-restore snapshot still correctly treats it as a
`"modify"` and captures the hand-edit, because it re-derives
`action`/`hadPreviousContent` from `pathExists()` at restore time, not
from the original manifest. This is deliberately unit-tested (see Tests)
and was also proven live (see Live evidence) — it's the one place this
phase's design went a level deeper than "just replay the original
entries," because the naive version would have silently discarded a
hand-edit made between apply and restore.

Restore itself is **blunt and honestly documented**, matching the posture
Phase 16 already set for hooks ("reactive, not preventive"): it overwrites
or deletes whatever is at each path right now, with no smarter merge. A
path already absent when restore runs is reported `"skipped"`, not an
error, since there's honestly nothing to undo there.

No automatic pruning in v1 — the same conservative, manual-only posture
this codebase already applies to knowledge-source re-indexing (Phase 17).
`DELETE /checkpoints/:id` is the real escape hatch rather than a
fabricated retention policy nobody asked for.

**UI placement**: the existing "Changes" view already shows git
status/diffs/log for the open project — the closest existing concept to
"here's what changed, and what to do about it." A new "Checkpoints"
section was added directly below it rather than inventing a new nav item,
since checkpoints are explicitly the non-git-dependent counterpart to that
same git-status information, and a user reviewing recent changes is
exactly who needs "undo this" one scroll away.

## What shipped

- `packages/protocol/src/agent.ts`: `CheckpointEntry`, `CheckpointSummary`,
  `Checkpoint`, `CheckpointListResponse`, `CheckpointRestoreResult`,
  `CheckpointRestoreResponse`; `ApplyEditsResponse` gained a required
  `checkpointId: string`.
- `packages/protocol/src/governance.ts`: `AuditCategory` extended with
  `"checkpoint-created"` and `"checkpoint-restored"`.
- `apps/desktop-agent/src/fsOps.ts`: `pathExists` exported (previously
  module-private) so `checkpoints.ts` reuses the exact same existence
  check `applyEdits` itself uses, rather than a second implementation.
- `apps/desktop-agent/src/checkpoints.ts` (new): `createCheckpoint`,
  `listCheckpoints`, `readCheckpoint`, `restoreCheckpoint`,
  `deleteCheckpoint`.
- `apps/desktop-agent/src/routes.ts`: `POST /fs/apply-edits` now takes a
  checkpoint before calling `applyEdits` and returns its id; three new
  routes — `GET /checkpoints`, `POST /checkpoints/:id/restore`,
  `DELETE /checkpoints/:id`.
- `apps/desktop/src/renderer/index.html` + `renderer.js` + `styles.css`: a
  "Checkpoints" section in the Changes view — list (label, timestamp, file
  count), Restore and Delete per row, an inline status line for
  restore/delete results, wired into the same `loadGit()` nav-switch
  trigger via a new `loadCheckpoints()`.

## Tests

`apps/desktop-agent/test/checkpoints.test.ts` (new, 9 tests, all real
temp-directory filesystem behavior, no mocking):

- pre-edit content is snapshotted for a `"modify"` of an existing file;
- a `"create"` records `hadPreviousContent: false` and stores nothing;
- a path that escapes the project root is skipped, not thrown;
- `listCheckpoints` sorts newest-first and tolerates zero checkpoints;
- `restoreCheckpoint` writes back a modify, deletes a create, and returns
  a `preRestoreCheckpointId`;
- **the hand-edit case**: a checkpoint originally recording a `"create"`,
  restored after the file was hand-edited post-apply, produces a
  pre-restore snapshot that correctly captures the hand-edit as a
  `"modify"` — proving the restore-time re-derivation logic, not just the
  simple replay path;
- an already-absent path restores as `"skipped"` with a real reason, not
  an error;
- restoring an unknown id throws rather than silently no-op'ing;
- `deleteCheckpoint` removes the directory and reports `false` (not an
  error) for an unknown id.

Full `apps/desktop-agent` suite: **87/90 passing** (1 failure is the same
pre-existing `test/terminalWs.test.ts` gap documented in Phase 14's notes,
unrelated to this phase; 2 skipped are the same pre-existing
environment-dependent Python/pytest skips). `apps/cloud-agent-gateway`
suite: **53/53 passing** (untouched this phase — run to confirm nothing
transitively broke). Both workspaces build clean with `tsc`.

## Live evidence

Verified against the real running MobiusX.ai desktop app (rebuilt
`desktop-agent`, app relaunched to pick it up) and the real
`Test Projects/GreenThumbGarden` fixture project used throughout this
session:

1. Opened GreenThumbGarden, went to Changes → Checkpoints: rendered "No
   checkpoints yet" correctly for a project with none.
2. Ran a real Build-mode request through the AI Assistant panel (Demo
   runner — deterministic, always available without a configured model
   key) and clicked Apply on its proposed `CREATE MOBIUSX_DEMO_EDIT.md`.
   The Checkpoints panel immediately showed a new entry: "1 file(s):
   MOBIUSX_DEMO_EDIT.md". Confirmed on disk:
   `.mobiusx/checkpoints/dd1fa969.../manifest.json` with
   `{"path":"MOBIUSX_DEMO_EDIT.md","action":"create","hadPreviousContent":false}`,
   and the real file present at the project root.
3. Clicked **Restore** on that checkpoint. `MOBIUSX_DEMO_EDIT.md` was
   confirmed deleted from disk. The Checkpoints panel immediately showed a
   *new* checkpoint, "Before restoring checkpoint dd1fa969" — the
   automatic pre-restore safety snapshot. Confirmed on disk: its manifest
   recorded `{"action":"modify","hadPreviousContent":true}` for that same
   path (correctly re-derived from the file's state *at restore time*,
   not copied from the original `"create"` entry), and
   `files/MOBIUSX_DEMO_EDIT.md` under that new checkpoint held the file's
   full real content — proving the restore-is-itself-undoable property
   against a real applied edit, not just the unit test.
4. Confirmed `/Test Projects/` is gitignored at the repo root, so none of
   this live-verification's on-disk artifacts (the demo file, the
   `.mobiusx/checkpoints/` directories) leak into this commit.

One real friction point worth recording honestly: picking up the rebuilt
`desktop-agent` required a full app restart (`npm start` doesn't
hot-reload a spawned child service), and an in-session attempt to restart
it via the app's own embedded terminal failed to bring the app back up —
it had to be restarted by hand. Not a defect in this phase's code, but a
real gap in this session's own tooling for verifying backend changes
without a person present to relaunch the app.

## An honest gap

Restore has no confirmation step in the UI — clicking Restore acts
immediately. This mirrors an existing pattern in this codebase (Delete on
a steering file is also immediate, no confirm dialog anywhere in this
renderer), and the automatic pre-restore safety checkpoint means a wrong
click is always itself undoable — but it's still a real UX gap worth
naming rather than silently declaring "safe enough."

A second: checkpoints accumulate with no automatic pruning and no size
cap. A very large file edited repeatedly would grow `.mobiusx/checkpoints/`
without bound until a user manually deletes old entries. Acceptable for a
v1 safety net (the same tradeoff Phase 17 made for knowledge re-indexing),
but a real project running many AI-applied edits over weeks would
eventually want either a retention policy or a total-size warning.

## Scope not built

- **Manual "create checkpoint now"** — deferred. Automatic
  per-`apply-edits` checkpointing already covers every edit-producing mode
  (build/fix/database/architecture/testing/devops/spec), which satisfies
  "every autonomous phase after this one benefits from it" without a
  manual trigger. A manual checkpoint (e.g. "before I let autonomous mode
  run unattended") is a reasonable future addition but wasn't asked for by
  any concrete evidence gathered this phase.
- **Retention/pruning policy** — see honest gap above; `DELETE
  /checkpoints/:id` is the v1 manual escape hatch.
- **Deep-linking from a specific apply result to its checkpoint** — the
  `checkpointId` now returned by `POST /fs/apply-edits` makes this
  possible, but no UI consumes it yet; today a user finds a checkpoint by
  browsing the Changes view's list, not by clicking "undo this" on the
  chat message that produced it.
- **Cross-checkpoint diffing** — the "Show diff"-style view git changes
  already gets isn't offered for a checkpoint's stored content vs. the
  current file; restoring is all-or-nothing per path, not reviewable
  file-by-file before committing to it.
