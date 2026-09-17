# Phase 10 — Testing Engine

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` §15.

`verify.ts` (Phase 6) has only ever *run* a project's existing test script.
Nothing in this codebase generated one. Status: **done, live-verified
end-to-end** — same "evidence, not intention" discipline as Phases 6–9, and
this doc follows that same convention: it records what actually happened,
including the real bugs live verification surfaced and how each was fixed
(or, in one case, deliberately left as a documented limitation rather than
over-engineered away).

## Design: same root cause as Database and Architecture mode

A model asked to write a test with no real facts about a project's test
framework has nothing to go on but a guessed one — often the wrong
ecosystem entirely (a Jest test for a Python backend). And with no facts
about a project's *existing* test style, it has nothing to match but a
generic convention that may collide with, or simply not resemble, what's
already there. This is exactly the gap Database mode (Phase 8) and
Architecture mode (Phase 9) closed for schema and diagram generation: build
a dedicated, honest evidence bundle first, then ground the prompt in it.

## What shipped

- **`testingContext.ts`** (`apps/desktop-agent/src/testingContext.ts`, new,
  `GET /testing-evidence`): gathers two things, both honestly-empty when
  absent rather than guessed — `testFrameworks`, reusing Phase 7's own
  `detectProjectContext()` test-framework detection (never re-derived here,
  so it can't drift from what Build mode already sees), and up to two
  `existingTestFiles` samples (full content), found by filename convention
  (`test_*.py`, `*_test.py`, `*.test.ts(x)`, `*.spec.ts(x)`) so the model
  can match this project's own import layout, fixtures, and assertion style
  instead of introducing a competing one.
- **Testing mode** (`AgentMode` extended with `"testing"` in
  `packages/protocol/src/cloud.ts`): a new mode reusing the same propose →
  review → apply pipeline as build/spec/fix/database/architecture. Its
  system prompt (`promptShared.ts`) embeds the real `testingEvidence`
  bundle as JSON, states "THE #1 RULE" (only test functions/routes/classes
  actually shown in the file content, never an invented API), and branches
  explicitly on whether a framework was detected: none detected → say so
  plainly and omit the edits block entirely, never default to a "normal"
  choice like pytest or Jest; one detected but only a browser/e2e tool
  (Playwright/Cypress alone) → also decline, since that needs a running
  app to drive (Phase 12's job); one detected with real unit-test
  capability → write real tests, following an existing test file's style
  if one was shown, or an idiomatic per-framework default otherwise.
- **Build mode companion-test generation** (`buildModeTestingBlock()` in
  `promptShared.ts`, wired into BUILD mode's own prompt): the roadmap's
  literal ask — test generation as "part of the standard Build-mode output
  for new backend/frontend code" — implemented as a conditional instruction
  gated on the same evidence bundle Testing mode uses. No framework
  detected → explicit instruction not to invent one or add a test.
  Framework detected → for every *new* source file with real logic, also
  propose one companion test file in the same edits array.
- **`verify.ts`'s `detectPythonTestSteps`**: was already present as of this
  phase's start from earlier Phase 6/7 groundwork, but a real bug in it was
  found and fixed this phase (see below) — it scopes a Python test step to
  whichever candidate directory (`.`, `backend`, `server`, `api`) actually
  declares `pytest` as a dependency, and runs `python -m pytest -q` there.
- **Desktop UI**: a "Testing" mode button next to Architecture; a new
  Testing Evidence panel (`index.html` + `renderer.js`) with a "Check
  testing evidence" button rendering detected framework(s) and existing
  test file(s) found, mirroring the Database Consistency panel's style.

## Bug 1, live-verified: test files must be placed relative to the module under test, not the project root

First real generation (free OpenRouter model `inclusionai/ling-3.0-flash-vl:free`,
prompt: "Write tests for backend/main.py") proposed `tests/test_main.py` at
the **GreenThumbGarden project root**. Looked correct until actually run:

```
$ cd backend && .venv/bin/python3 -m pytest -q
no tests ran in 0.01s
```

Root cause: `detectPythonTestSteps` runs `pytest` with `cwd` set to
whichever directory actually declares `pytest` (here, `backend/`, where
`requirements.txt` and the `.venv` live) — a `tests/` directory at the
project root is invisible to that invocation. The original prompt
instruction said "use a `tests/test_<module>.py` convention" but never
said *relative to what directory*. Fixed by sharpening that instruction to
explicitly anchor it to the module-under-test's own directory, with a
concrete example ("testing `backend/main.py` means creating
`backend/tests/test_main.py`, NEVER a `tests/` directory at the project
root"). Rebuilt, relaunched, re-ran the same prompt — this time it
correctly proposed `backend/tests/test_main.py`.

## Bug 2, live-verified: a generated test must match the target file's own import convention, not an assumed package layout

With placement fixed, the regenerated test imported:

```python
from backend.main import app, get_session
from backend.models import Product
```

Applying and running it:

```
ModuleNotFoundError: No module named 'backend'
```

Root cause: `main.py` itself uses plain sibling imports (`from database
import ...`) because this app runs it as `uvicorn main:app` from *inside*
`backend/` — not as an installed package. `python -m pytest` invoked with
`cwd=backend/` puts `backend/` itself on `sys.path`, not its parent, so a
package-qualified `backend.main` import can never resolve. Confirmed the
fix by hand first (rewriting the two import lines to `from main import
app, get_session` / `from models import Product`) — pytest then collected
and ran the suite. Then closed the gap properly in the prompt: added an
explicit instruction to match the target file's own import style exactly
("if the target file itself uses plain top-level sibling imports... your
test must import it the same plain way too... NEVER `from backend.main
import app`"). Rebuilt, relaunched, and ran a **fresh** Testing-mode
generation against a different file (`database.py`) — the model correctly
proposed bare `from database import create_db_and_tables, get_session` /
`from models import Product`, unprompted, on the first try.

## A pre-existing bug in the test fixture project itself, surfaced by the generated test

With imports fixed, the suite still failed — a *different*, genuinely
pre-existing bug, unrelated to Testing Engine or the generated test:

```
sqlalchemy.exc.NoReferencedTableError: Foreign key associated with column
'order_items.product_id' could not find table 'products'
```

`GreenThumbGarden/backend/models.py`'s `Product` class had no explicit
`__tablename__`, so SQLModel auto-derived `"product"` (singular) — but
`OrderItem.product_id`'s foreign key string hardcoded `"products.id"`
(plural). This mismatch existed before this phase touched anything; it had
simply never been exercised, because nothing had ever called
`SQLModel.metadata.create_all()` against the full three-model set in one
place before. Fixed with a one-line addition to the fixture project
(`__tablename__ = "products"` on `Product`, matching `Order`'s existing
explicit-tablename convention) — not a MobiusX code change, a fixture-data
fix, but worth recording: **the Testing Engine's generated test caught a
real latent schema bug** in the project it was testing.

## A known, honestly-documented limitation: SQLite in-memory pooling

Even with both fixes above, the very first full run still failed —
`sqlite3.OperationalError: no such table: products`. Cause: the test
fixture created `sqlite:///:memory:` without `poolclass=StaticPool`, so
SQLAlchemy opened a *second*, separate, empty in-memory database for the
actual query connection. This is a well-known SQLAlchemy+pytest+SQLite
testing idiom (`from sqlalchemy.pool import StaticPool`,
`connect_args={"check_same_thread": False}`), not a project-evidence
question — no amount of grounding in *this project's* real facts tells a
model that idiom; it's general testing know-how the underlying model
either has or doesn't. Fixed by hand in the one file for this
demonstration, and **deliberately not added as a special-cased prompt
rule** — the fix-once-then-copy behavior already confirmed this
propagates for free (see next section), and hard-coding every possible
framework-specific testing gotcha into the prompt would fight the "ground
in real project facts, don't pre-load framework trivia" design this whole
phase is built on. Recorded here as a real, honest limitation: generated
test *correctness* still depends partly on the underlying model's general
engineering competence, which the evidence bundle cannot substitute for.

## Live evidence: the combined fix, verified clean

Fresh Testing-mode generation against `database.py` (no manual
intervention this time) — model's own summary:

> "I'm testing `database.py`'s two functions — `create_db_and_tables`
> (idempotency and that it actually creates tables usable via the ORM) and
> `get_session` (that it yields a real `Session` and supports CRUD). I
> follow the project's existing pytest conventions from
> `backend/tests/test_main.py`: same imports, same `StaticPool` +
> in-memory SQLite fixture pattern, and monkeypatching `database.engine`
> to isolate tests from the file-based `sqlite.db`."

— explicitly citing the *style-matching* mechanism, not just the
import-convention rule. Applied, then:

```
$ .venv/bin/python3 -m pytest -q
10 passed, 4 warnings in 1.90s
```

Final combined suite across all three generated test files
(`test_main.py`, `test_database.py`, `test_pricing.py` — the last from the
Build-mode check below):

```
$ .venv/bin/python3 -m pytest -q
21 passed, 4 warnings in 1.57s
```

Used the app's own **Run verification** button (not just manual terminal
`pytest`) to confirm `detectPythonTestSteps` surfaces this end-to-end
through the real Verify UI: **"✓ Verification passed — 1/1 step(s) passed
— Test (pytest, backend/) 3270ms, exit 0."**

## Live evidence: Build mode's companion-test behavior, and a confirmed-working existing safety net

Submitted a Build-mode request ("Add a new `backend/pricing.py` module
with `apply_discount(price, percent)`...") against the same project, now
that pytest is a detected framework. First attempt produced only a prose
plan with no edits block (a known free-model compliance gap, already
documented for build mode generally — not new to this phase); a
more-explicit follow-up produced real edits: `backend/pricing.py`
(create), `backend/main.py` (create — see below), and
`backend/tests/test_pricing.py` (create) — confirming
`buildModeTestingBlock()` correctly triggers a companion test alongside a
new source file with real logic, unprompted, exactly as the roadmap asks.

`backend/main.py` was proposed as `"create"` even though it already
exists, because only `database.py` was open/in full context for that
request — a pre-existing Build-mode/`relevantFiles`-selection limitation,
not something this phase introduced. This was a good opportunity to
confirm an existing safety net actually works under a real misfire:
Apply showed **"skipped — file already exists — refusing to overwrite"**
for `main.py`, while `pricing.py` and `tests/test_pricing.py` applied
cleanly (2/3). Running verification confirmed the companion test passes:
**"✓ Verification passed — 1/1 step(s) passed — Test (pytest, backend/)
3393ms, exit 0."**

## Live evidence: honest declines (from this same live session, before the above)

Also confirmed directly, with a real free OpenRouter model against this
same project: Testing mode declines to invent tests for a file it wasn't
shown the content of, and separately declines to invent a test framework
when `testingEvidence.testFrameworks` is empty — omitting the edits block
entirely and saying so in prose, rather than defaulting to a "normal"
choice like pytest. Same "never guess, say so" pattern already established
and re-verified in Phases 7–9.

## Full workspace check

`@mobiusx/protocol`, `@mobiusx/desktop-agent`, `@mobiusx/cloud-agent-gateway`
all build with zero TypeScript errors. Test suites: desktop-agent 39/41
pass (1 pre-existing, unrelated `terminalWs.test.ts` node-pty failure, 1
expected self-skip — both pre-dating this phase); cloud-agent-gateway
45/49 pass (4 pre-existing, live-API-dependent `registry.test.ts` failures
from provider model-list drift, confirmed unchanged from Phases 7–8, not a
regression). One real bug fixed along the way: `detectPythonTestSteps`'s
pytest-detection regex (`/^\s*pytest/im`) only matched a `requirements.txt`
/ Poetry-table-style declaration at the start of a line, missing PEP 621's
array form (`dependencies = ["fastapi", "pytest>=8.0"]`) — found via a
real (not pre-existing) failing test, fixed to
`/^\s*pytest\b|["']pytest\b/im`.

## Scope not built this phase (tracked, not forgotten)

- The SQLite `StaticPool` gotcha (and testing idioms like it, for other
  frameworks) is not specially prompted for — see the honest limitation
  section above. A stronger model, or a small library of framework-
  specific fixture snippets surfaced only when relevant, are both
  plausible future increments.
- Browser/e2e test generation (Playwright/Cypress) is explicitly declined,
  not attempted — needs a running application to drive, which is roadmap
  Phase 12's job.
- No coverage-threshold or mutation-testing feedback loop yet — this phase
  generates tests, it doesn't yet judge whether they're *good* tests beyond
  the prompt's own "no placeholder assertions" instruction.
- Build mode's `relevantFiles` selection can still propose `"create"` for
  a file that exists but wasn't shown in full this request (see the
  `main.py` case above) — the existing create-must-not-exist guard in
  `fsOps.ts` correctly prevents data loss when this happens, but the
  proposal itself is still noise a user has to notice and skip. A future
  increment could have the gateway drop such edits server-side instead of
  relying on the desktop agent's runtime check alone.
