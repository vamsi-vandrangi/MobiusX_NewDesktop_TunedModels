# Phase 23 — Config/env-file generation (§13)

The roadmap claimed §13 was "already partially covered by Phase 6's env
handling." It wasn't: `previewOps.ts`'s `env: process.env` just passes
the current process's own environment to a spawned dev server, and
`projectContext.ts` only ever *reads* `.env`/`.env.example` to sniff a
database URL. Nothing generated one.

## Design

Same "evidence, not invention" discipline as every generation mode:
`envFileOps.ts` scans the project's own real source for actual
environment-variable reads — `process.env.X` / `process.env['X']` /
`import.meta.env.X` (JS/TS), `os.environ.get("X")` /
`os.environ["X"]` / `os.getenv("X")` (Python) — and reports exactly the
variable names the code itself already depends on, each with the real
file that reads it. `.env.example` generation from that is purely
mechanical: one placeholder line per genuinely missing reference,
appended under a labeled comment block. An existing `.env.example`'s
already-set lines are parsed and never touched, overwritten, or
duplicated — this only ever ADDS a missing key.

## What shipped

- `packages/protocol/src/agent.ts` — `EnvVarReference`,
  `EnvFileGenerateResponse`.
- `apps/desktop-agent/src/envFileOps.ts` (new) —
  `detectReferencedEnvVars`, `generateEnvExample`.
- `apps/desktop-agent/src/routes.ts` — `GET /env-vars` (read-only),
  `POST /env-file/generate` (writes/updates `.env.example`, logs an
  `applied-edits` audit entry when it actually adds anything).
- `apps/desktop/src/renderer/{index.html,renderer.js}` — an
  "Environment Variables" panel: "Check env vars" and "Update
  .env.example".

## Live evidence

Checked on GreenThumbGarden: "Check env vars" returned "No process.env /
os.environ / os.getenv references found in this project's source." This
looked at first like it might be a detection gap, so it was verified
directly against the real filesystem rather than accepted at face value:
a recursive grep across the project's real source (excluding
`backend/.venv`, `frontend/node_modules`, and `frontend/.next`) for
every pattern the scanner looks for turned up **zero** matches — the
only hits anywhere in the tree were inside `backend/.venv`'s own
installed third-party packages and `frontend/.next`'s compiled build
output, both of which the scanner's own `SKIP_DIRS` correctly excludes.
Further confirmed `backend/main.py`, `database.py`, `models.py`, and
`pricing.py` contain no settings/config module at all (the project uses
a hardcoded SQLite file). So "no references found" is a **correct**
detection for this project, not a silent failure — good evidence the
scanner isn't just failing quietly. (The write path itself — "never
overwrite an existing line, only add missing keys" — remains covered by
`envFileOps.test.ts`'s 5 unit tests, since no real test project in this
session's fixtures happened to declare any config-driven env vars.)

## Scope not built

- Detects direct `process.env`/`os.environ`/`os.getenv` reads only, not
  framework-mediated config (e.g. Python's `pydantic-settings
  BaseSettings`, `python-decouple`, or a JS config-loader library that
  wraps `process.env` internally). A project using one of those exclusively
  would also correctly report "none found" even though it does have
  env-driven config — a real boundary worth documenting rather than a bug,
  since detecting it would mean parsing arbitrary third-party library
  semantics rather than a project's own source.
- Deliberately a direct, mechanical write (like Steering files, Phase 16)
  rather than routed through the AI edits-review pipeline: detecting a
  literal `os.getenv("X")` call and adding `X=` to a file is
  deterministic extraction, not a judgment call, and the file only ever
  gets additions, never a rewritten or removed line.
