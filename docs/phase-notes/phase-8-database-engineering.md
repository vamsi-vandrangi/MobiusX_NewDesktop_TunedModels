# Phase 8 — Database Engineering

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 8.

Status: **done, live-verified end-to-end** — same "evidence, not intention"
discipline as Phases 6 and 7. This doc is that evidence.

## What shipped

- **Database mode** (`AgentMode` extended with `"database"` in
  `packages/protocol/src/cloud.ts`): a new mode in the AI Assistant panel
  (both the Workspace-embedded assistant and the standalone AI Assistant
  view) that reuses the exact same propose → review → apply pipeline as
  build/spec/fix. Its system prompt (`promptShared.ts`) asks the model to
  summarize the domain model it's introducing, detect and follow the
  project's existing schema/ORM convention rather than inventing a new
  one, default to PostgreSQL/plain SQL when no existing convention is
  found (with that choice disclosed in the response), flag any destructive
  operation explicitly, and — like fix mode — is only allowed to propose
  `"modify"` for a path it was actually shown in full content
  (`dbFullContentPaths`), never a path it only saw a snippet of.
- **Database Consistency Check** (`apps/desktop-agent/src/dbOps.ts`,
  `GET /db/consistency`): a real, evidence-based cross-check between
  `CREATE TABLE` statements found under any `db/`, `database/`, or
  `migrations/` directory (depth-limited walk) and SQLModel/SQLAlchemy
  Python ORM classes (`class Foo(SQLModel, table=True)` /
  `__tablename__ = "..."`, replicating SQLModel's real default of
  lowercasing the class name with no pluralization when no explicit
  tablename is given). Reports `table_without_model` / `model_without_table`
  mismatches with the exact evidence (file + line) behind each side, and
  is honest about what it can't judge: `overall: "unknown"` when only one
  side of the comparison exists (no schema files, or no ORM files found),
  never a fabricated verdict. A new **Database Consistency** panel in the
  Tasks view (next to the existing Project Completion Contract panel)
  surfaces this on demand via a "Check consistency" button.

## A real bug found and fixed during live verification

The first live GUI run told the full story of why this matters. Asked
Database mode to "Add an orders table so customers can place orders for
products. Follow the existing SQLModel convention in backend/models.py"
against `Test Projects/GreenThumbGarden` (a real FastAPI + SQLModel
project whose only model is a 4-line `Product` class), the model came
back proposing **`CREATE backend/models.py`** — even though the file
already exists — with a diff that didn't contain the existing `Product`
class at all. Applying this would have been silently refused by
`fsOps.ts#applyEdits` ("file already exists — refusing to overwrite a
create"), the same failure mode already documented for fix mode.

Root cause, confirmed via the Debug view's own search UI: the semantic
index for this project had **6,240 indexed chunks**, almost all of them
vendored library code from `backend/.venv/lib/python3.14/site-packages/`
(sqlalchemy, pytest, pip, click, ...). Searching the exact prompt text —
which explicitly named `backend/models.py` — returned only `.venv`
internals in the top-3 hits (`0.40 match` each), because
`packages/context-engine/src/types.ts`'s `DEFAULT_IGNORE` set, which every
directory walk in the codebase (`reconcile()`, and therefore the semantic
indexer, the Explorer's file count, everything) filters against, never
excluded Python virtualenvs. The real `backend/models.py` never made it
into the k=3 results, so `findRelevantFiles`'s content-fetch gate never
fetched its full content, so the model was never shown it, so — per the
prompt's own instructions (`dbFullContentPaths`) — "create" was the only
action left available to propose. Not a model quality problem; the
prompt's own rules left no other option once the real file was invisible.

This is a pre-existing Phase-0 gap, not something introduced by Database
mode, but Database mode is what exposed it live (a Python project with a
committed `.venv` is exactly the shape build/fix/spec hadn't been
exercised against yet). Fixed by adding `.venv`, `venv`, `__pycache__`,
`.pytest_cache`, `.mypy_cache`, and `.tox` to `DEFAULT_IGNORE`
(`packages/context-engine/src/types.ts`) — exact directory-name matches
only, matching how the walker already works (no glob support). This fixes
the underlying indexing/context-fetch pipeline for **every** mode
(build/fix/spec/database), not just Database mode.

Live re-verification after the fix, same project, same prompt:

```
Before: GreenThumbGarden (2662 files, git) — Debug search: "Index built
        just now (6240 chunks, ...)" — top hits all backend/.venv/...
After:  GreenThumbGarden (17 files, git)   — Debug search: "Index built
        just now (9 chunks, ...)" — #1 hit: backend/models.py:1-9,
        full real Product model content, 0.25 match
```

context-engine's own test suite (5/5) and cloud-agent-gateway's (45/4,
the same pre-existing env-dependent `registry.test.ts` failures confirmed
unrelated to this work in Phase 7) both still pass after the fix, and
both packages plus `semantic-index` and `desktop-agent` rebuilt clean
with `tsc`.

## Live evidence: Database mode, end-to-end, post-fix

Same request re-run through the real AI Assistant (openrouter,
`inclusionai/ling-3.0-flash-vl:free`) against GreenThumbGarden. Result:
"Proposed changes — 3 files":

- **MODIFY `backend/models.py`** — diff confirmed the existing `Product`
  class preserved byte-for-byte (all five fields intact), with a new
  `Order` and `OrderItem` class appended, correctly using
  `Field`/`SQLModel`/`Relationship` with `foreign_key=...` — the exact
  convention already present in the file, as instructed.
- **CREATE `db/schema.sql`** — plain PostgreSQL DDL for all three tables
  (correctly disclosed as the default choice, since no existing schema
  file was found), explicitly noted as additive-only with no destructive
  operations.
- **CREATE `db/migrations/001_add_orders.sql`** — a matching forward
  migration for the two new tables.

Clicked Apply: **Applied 3/3**. Confirmed on disk via `device_bash` that
all three files exactly match what was previewed in the diff — no
silent divergence between preview and applied content.

## A genuine model-output bug, and what it shows about the checker's real scope

The applied output contains a real bug of its own, useful to document
honestly rather than paper over: `db/schema.sql` creates the products
table as `product` (singular — correctly matching SQLModel's real default
convention for a class with no explicit `__tablename__`), but
`OrderItem.product_id` uses `foreign_key="products.id"` (plural) in
`models.py`, and the matching `REFERENCES products(id)` in both
`db/schema.sql` and the migration — a foreign key pointing at a table
name that doesn't exist. This is exactly the kind of mistake the response
itself disclosed as a live risk: "openrouter doesn't run the second-pass
Reviewer agent yet ... review these edits carefully yourself before
applying" (`apps/cloud-agent-gateway/README.md`'s Known gaps).

Running **Check consistency** afterward reported **"Consistent"**, and
that verdict is correct, not a miss — because it's honestly outside what
this checker was built to catch:

```
SCHEMA TABLES  orders (db/migrations/001_add_orders.sql:2),
               order_items (db/migrations/001_add_orders.sql:10),
               product (db/schema.sql:2), orders (db/schema.sql:10),
               order_items (db/schema.sql:18)
ORM ENTITIES   Product -> "product" (backend/models.py:5),
               Order -> "orders" (backend/models.py:12),
               OrderItem -> "order_items" (backend/models.py:21)
ORM CONVENTION RECOGNIZED   SQLModel/SQLAlchemy (Python)
```

Every table that exists has a matching ORM class with the same table
name, and vice versa — the table-existence cross-check Phase 8 set out to
build is genuinely intact, and it says so accurately. The `products` vs
`product` bug lives one level deeper, inside a `REFERENCES`/`foreign_key`
*value* rather than in a table's own name — a distinct, narrower category
of check (foreign-key-target validation) that `dbOps.ts` doesn't attempt
and never claimed to. Recorded below as scope for a later phase rather
than silently left for someone to assume was covered.

## Scope not built this phase (tracked, not forgotten)

- Foreign-key-target validation (does every `REFERENCES`/`foreign_key=`
  value actually resolve to a real table?) — a real gap this phase's own
  live verification surfaced, not merely theoretical. Natural next
  increment for `dbOps.ts`.
- No auto-refresh of Database Consistency when files change — manual
  "Check consistency" click, the same v1-conservative choice as
  Verification Engine and Project Context.
- Only SQLModel/SQLAlchemy (Python) ORM detection — no Prisma, TypeORM,
  Drizzle, or plain-JS ORM support yet, so a JS/TS backend project will
  honestly report `overall: "unknown"` rather than a false convention
  match.
- No actual migration execution/dry-run against a real database — Database
  mode and the consistency checker both work entirely from static file
  content, consistent with the rest of this platform's "static code
  intelligence, not live systems" scope (Debug view's own disclosed
  boundary).
