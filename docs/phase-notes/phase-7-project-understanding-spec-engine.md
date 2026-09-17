# Phase 7 — Project Understanding + Specification Engine

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 7 (source requirements
doc §5, §6).

Status: **done, live-verified end-to-end** — same "evidence, not intention"
discipline as Phase 6. This doc is that evidence.

## What shipped

- **Project Understanding Engine** (`apps/desktop-agent/src/projectContext.ts`,
  `GET /project-context`): real, evidence-based tech-stack detection —
  scans the project root plus the same short list of common monorepo
  subdirectories `previewOps.ts` already uses (frontend/backend/client/
  server/etc.), parses `package.json` dependencies, `requirements.txt` /
  `pyproject.toml`, and connection strings in common config files
  (`database.py`, `settings.py`, `.env`, ...) to detect frontend/backend
  frameworks, ORM, database, auth, test framework, and infra (Docker,
  Docker Compose, GitHub Actions). Every detected component carries its
  own evidence string (the exact dependency + version, or file + pattern,
  that triggered it) — never a guess from the project's name. Categories
  with nothing found are reported honestly via `unknownCategories`, the
  same not-fabricated discipline `ProjectCompletionReport` uses. Writes
  `.mobiusx/PROJECT_CONTEXT.md` (human-readable) and
  `.mobiusx/project-context.json` (machine-readable) on every call. A new
  **Project Context** panel was added above the Workspace view's file
  Explorer (collapsed by default, click to expand + Detect).
- **Structured Specification acceptance criteria** (source §6): Spec
  mode's prompt (`promptShared.ts`) now requires every functional and
  non-functional requirement to carry a stable `REQ-NNN` id, numbered
  continuously across both sections, with at least one Given/When/Then
  acceptance criterion per requirement tagged with the same id. Spec mode
  now emits **two** files per request instead of one: the existing
  human-facing markdown doc, plus a machine-readable JSON twin
  (`.mobiusx/specs/<slug>.json`) with the exact same requirements in
  structured form. `buildEditsCard` (the shared edits-review UI used by
  every mode) now detects a `.mobiusx/specs/*.json` edit among a task's
  proposed changes and renders a real REQ-NNN checklist — id, category
  badge, statement, and each acceptance criterion — instead of leaving the
  user to read raw JSON via "Show diff". The underlying file still applies
  exactly like any other edit; this is purely a friendlier view of the
  same data.

## A real bug found and fixed during live verification

While writing the JSON-twin example into the spec-mode prompt itself, the
first version used `"category": "functional" | "non-functional"` as the
literal example value — valid TypeScript union-type syntax, but not valid
JSON. Caught before ever reaching a real model by round-tripping the
actual prompt through `systemPromptFor()` with `tsx` and parsing the
embedded JSON examples (both the outer edits array and the inner
JSON-string content), which is also how the escaping (JSON content nested
inside a JSON edits array, itself embedded in a TS single-quoted string)
was confirmed correct rather than assumed. Fixed by using a single valid
example value (`"functional"`) plus an explicit instruction sentence
covering the two allowed values.

## Live evidence: Project Understanding Engine

Exercised against `Test Projects/GreenThumbGarden` — a real project with a
known stack (Next.js frontend in `frontend/`, FastAPI + SQLModel backend
in `backend/`, SQLite via `sqlite:///` in `backend/database.py`), and
deliberately chosen because it has no root `package.json` (the same
reason it was picked for Phase 6 — it can't be analyzed by anything that
only looks at the project root). Clicking **Detect** in the new Project
Context panel produced:

```
Frontend  Next.js (frontend/)
Backend   FastAPI (backend/)
Database  SQLite (backend/)
ORM       SQLModel (backend/)
Auth      Not detected
Test framework  Not detected
Infra     Not detected
```

Exactly matches the project's real stack. Confirmed the on-disk
`.mobiusx/project-context.json` matches the UI exactly, with real cited
evidence per component, e.g.:

```json
{ "category": "backend", "name": "FastAPI", "location": "backend",
  "evidence": "backend/requirements.txt: \"fastapi\"" },
{ "category": "database", "name": "SQLite", "location": "backend",
  "evidence": "backend/database.py: connection string matches /sqlite:\\/\\//" }
```

## Live evidence: Structured Specification acceptance criteria

Ran a real Spec-mode request against GreenThumbGarden — "Add a shopping
cart and checkout flow so customers can buy multiple gardening products in
one order" — via `openrouter/inclusionai/ling-3.0-flash-vl:free`. Result:
"Proposed changes — 2 files", a rendered checklist of 20 requirements
(REQ-001–REQ-016 functional, REQ-017–REQ-020 non-functional, numbered
continuously as required), each with its Given/When/Then criterion, plus
an Open Questions section (5 genuine open questions — guest checkout,
shipping validation rules, tax provider, split shipments, return policy —
not invented requirements). Clicked Apply (2/2 applied) and confirmed on
disk:

```
$ python3 -c "... json.load(...) ..."
feature: shopping cart and checkout flow
slug: shopping-cart-checkout
requirement count: 20
ids sequential REQ-001..REQ-020: True
categories used: {'non-functional', 'functional'}
requirements missing acceptance criteria: []
openQuestions count: 5

$ grep -o "REQ-[0-9]\{3\}" shopping-cart-checkout.md | sort -u | wc -l
20
```

The markdown doc and JSON twin stayed in exact sync (same 20 ids in both),
every requirement had at least one acceptance criterion, and the checklist
UI rendered correctly from the applied edit's content before Apply was
even clicked (confirming the client-side JSON.parse + render path works on
the model's raw, not-yet-applied output, not just the file after writing).

## Scope not built this phase (tracked, not forgotten)

- No auto-refresh of Project Context when files change — it's a manual
  "Detect" click, same v1-conservative choice as Verification Engine's
  detectVerificationSteps.
- No cross-check between a generated Spec's requirements and what Build
  mode actually implements later (e.g. flagging REQ-NNN ids no code change
  ever addressed) — that kind of traceability is a natural fit for a later
  phase once Phase 10's Testing Engine or Phase 13's Debugger v2 exist to
  hang it off of.
