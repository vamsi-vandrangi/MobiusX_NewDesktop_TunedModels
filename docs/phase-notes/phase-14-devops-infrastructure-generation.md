# Phase 14 — DevOps / Infrastructure Generation

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 14 (source §21) —
"Docker/Compose/K8s/Terraform + CI/CD pipeline files, through the same
edits pipeline as everything else." Builds on: Phase 6.

Status: **done, live-verified end-to-end, including a real bug the first
live run surfaced and this same phase fixed.** Same "evidence, not
intention" discipline as Phases 6–13/16–17.

## Design

Same root-cause diagnosis every generation mode before it already made
(Database/Phase 8, Architecture/Phase 9, Testing/Phase 10): a model asked
to write a Dockerfile/CI pipeline with zero real facts about a project's
actual services, locations, and build/test commands has nothing to go on
but generic, often-wrong boilerplate. So this phase follows the exact same
shape as those three: a new `"devops"` `AgentMode`, a dedicated evidence
bundle (`GET /devops-evidence`, `apps/desktop-agent/src/devopsContext.ts`)
gathered from already-real facts, and a system prompt instructed to render
that bundle faithfully rather than invent around gaps in it.

`AgentPersona.devops` and its `PERSONAS.devops` review focus already
existed since Phase 11 (source §26), with an explicit doc comment saying
it was "defined here for completeness... not yet reachable by any shipped
AgentMode... wiring it in is that phase's job." This phase is that job:
`classifyPersona()` now returns `"devops"` directly for `"devops"`-mode
tasks, and all three real runners (Anthropic, OpenAI-compatible, Ollama)
gate the second-pass Reviewer call on `"devops"` alongside every other
edit-producing mode.

`devopsContext.ts` gathers three things, honestly:

1. **`projectContext`** — reuses Phase 7's own detection verbatim (never
   re-guessed) for real frontend/backend/database components and their
   real locations, plus any infra Phase 7 already detects as *present*
   (Dockerfile/compose/CI — it never generates them, only notices them).
2. **`existingInfraFiles`** — full content of any Dockerfile(s) (root and
   per-component), `docker-compose.yml`/`.yaml`, or GitHub Actions
   workflow this project already has. This is what lets the prompt
   propose `"modify"` against a real, already-reviewed file instead of
   blindly `"create"`-ing over infra that already works — the exact
   `"CREATE on an existing file gets silently skipped by Apply"` failure
   mode Database mode hit in Phase 8.
3. **`verificationSteps`** — this project's own real build/test/lint
   commands, reused **verbatim** from `verify.ts`'s own detectors
   (`detectVerificationSteps`, `detectPythonTestSteps`) — never
   re-derived. The generated CI pipeline runs literally the same commands
   "Run Verification" already runs and already trusts, never an invented
   `npm test` a project doesn't define.

Kubernetes and Terraform — named in the roadmap line alongside
Docker/Compose — are **deliberately out of this mode's v1 output**. The
evidence bundle gathers zero facts a K8s manifest or Terraform plan would
actually need (a target cluster, a cloud provider, a container registry),
and inventing those specifics would be exactly the kind of ungrounded
boilerplate this codebase's whole discipline exists to avoid — the same
reasoning Architecture mode's Phase 9 prompt already applies to skip a
Deployment diagram when no deployment evidence exists. The prompt makes
the model say this honestly in its own prose rather than silently
narrowing scope, and it did so, unprompted, in both live runs below. This
was a scoping call made directly from precedent already set by three
earlier phases, not something that needed a fresh clarifying question.

The prompt also encodes the DevOps Agent persona's own three review focus
areas as generation rules, not just review criteria: no secret/credential
ever baked into an image or CI config (env vars / GH Actions `secrets.`
only), a resource `limits` block on every compose service, and a non-root
`USER` in every generated Dockerfile plus a scoped `permissions:` block in
the CI workflow.

## What shipped

- **`packages/protocol/src/agent.ts`**: `ExistingInfraFile`,
  `DevopsVerificationStep`, `DevopsEvidence`, `DevopsEvidenceResponse`.
- **`packages/protocol/src/cloud.ts`**: `AgentMode` extended with
  `"devops"`; `ProjectContext.devopsEvidence?`; `AgentPersona`'s doc
  comment updated (devops is no longer "not yet reachable").
- **`apps/desktop-agent/src/devopsContext.ts`** (new): `gatherDevopsEvidence`.
- **`apps/desktop-agent/src/routes.ts`**: `GET /devops-evidence`.
- **`apps/cloud-agent-gateway/src/runners/promptShared.ts`**: `"devops"`
  added to `MODES_WITH_STRUCTURED_EDITS`; a full `"devops"` prompt branch;
  a `devopsEvidenceContext()` helper.
- **`apps/cloud-agent-gateway/src/runners/personas.ts`**: `classifyPersona`
  now returns `"devops"` for `"devops"`-mode tasks.
- **`apps/cloud-agent-gateway/src/runners/{anthropicRunner,openAiCompatibleRunner,ollamaRunner}.ts`**:
  second-pass Reviewer gate extended to `"devops"`.
- **`apps/cloud-agent-gateway/src/runners/demoRunner.ts`**: a real
  `"devops"` demo branch (steps, output text, `demoDevopsEdits`) so the
  no-model-configured path is honest instead of silently falling through
  to Build mode's generic text.
- **`apps/cloud-agent-gateway/src/routes.ts`**: **a real bug fix** — the
  gateway's own `POST /tasks` handler had a second, independent
  hardcoded list of valid modes (`["ask", "plan", "build", "spec", "fix",
  "database", "architecture", "testing"]`) that duplicates, and had
  drifted from, `AgentMode`'s own union. `"devops"` added here too — see
  "An honest gap" below for how this was actually caught.
- **Renderer** (`apps/desktop/src/renderer/`): a "DevOps" mode tab in the
  AI Assistant panel; devops evidence fetched and wired into
  `submit()` the same way Architecture mode's fixed-path fetch works,
  except devops reuses `existingInfraFiles`' own full content directly
  (no extra `/fs/read` round trip needed); a "DevOps Evidence" panel + a
  "DevOps" row in Per-Task-Type Model Routing.

## Tests

`apps/desktop-agent/test/devopsContext.test.ts` (new) — **4/4 passing**:
an empty project reports everything honestly empty; a root Node frontend
is detected with its real npm scripts surfaced as verification steps; an
existing root Dockerfile/compose/CI file's full content is returned; a
detected backend component's own subdirectory is checked for its own
Dockerfile, and its real pytest step is scoped to the right `cwd`.

Full `apps/desktop-agent` suite: **78/81 passing** (the 3 non-passes are
the pre-existing `terminalWs.test.ts` `node-pty` gap and 2 unrelated
skips, documented in every phase-notes doc since Phase 13 — not a
regression). Full `apps/cloud-agent-gateway` suite: **53/53 passing** —
confirms the second-pass-review and demo-runner changes across all three
real runners didn't break any existing mode.

Full clean `npm run build --workspaces` across all nine `apps/*`+`packages/*`
— zero TypeScript errors.

## Live evidence

Against the real running Electron app, project **GreenThumbGarden**
(Next.js frontend, FastAPI backend, SQLite — no infra files yet).

**Evidence bundle, before generating anything** — Tasks view → "Check
devops evidence":

```
3 containerizable components detected
Detected components: Next.js (frontend, frontend/), FastAPI (backend, backend/), SQLite (database, backend/)
Existing infra file(s) found: None found
Real verification command(s): Test (pytest, backend/) (backend/)
```

Real, accurate, matches the project's actual layout — not a fixture.

**First generation run** — AI Assistant → DevOps mode, prompt: "Generate
Dockerfiles for the frontend and backend, a docker-compose.yml wiring
them together with the database, and a CI pipeline that runs this
project's real tests." Served by the real free-tier runner
(`openrouter/inclusionai/ling-3.0-flash-vl:free` — no Anthropic key
configured in this environment). The model proposed 4 files
(`frontend/Dockerfile`, `backend/Dockerfile`, `docker-compose.yml`,
`.github/workflows/ci.yml`) and its own prose said, unprompted:

> "Containerizing the two detected components — the Next.js frontend
> (`frontend/`) and the FastAPI backend (`backend/`) — as their own
> Dockerfiles, plus a database service for the detected SQLite and a
> GitHub Actions CI pipeline that runs the project's single evidenced
> test command (`.venv/bin/python3 -m pytest -q` in `backend/`). All
> credentials are env-var sourced, every service runs non-root with
> tunable resource limits, and CI permissions are scoped to
> `contents: read`. Kubernetes manifests and Terraform are intentionally
> **not** included — no evidence exists for a target cluster, cloud
> provider, or container registry, so generating them would be exactly
> the kind of unevidenced infrastructure this tool exists to avoid."

Every claim in that paragraph is independently checkable against the real
files it wrote — confirmed on disk via `device_bash`: `backend/Dockerfile`
uses `python:3.11-slim`, a non-root `appuser`, and
`CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`
(exactly this app's own Preview convention, cited as such); `.github/workflows/ci.yml`
has `permissions: contents: read` and one real step,
`working-directory: backend`, running `.venv/bin/python3 -m pytest -q` —
the literal string `verificationSteps` reported. Clicked **Apply**:
**"Applied 4/4."**

The second-pass DevOps Agent reviewer's response on this run **did not
parse into a verdict** (a known, pre-existing, provider-agnostic fallback
in the review pipeline — not something this phase changed): the UI
correctly showed "DevOps Agent: Concerns — Reviewer response could not be
parsed as a verdict — treating as unreviewed rather than silently
approving" instead of defaulting to a silent approve. Applying anyway was
a deliberate choice to exercise the full live flow end-to-end; a real user
would see that same honest warning before deciding.

**A real bug this run surfaced, fixed in this same phase**: the model's
generated `docker-compose.yml` added `image: sqlite:3` as a database
service — there is no such official Docker image; SQLite is a file-based
embedded database, not a server process. This was not a flaw in the
evidence (the bundle correctly reported SQLite as detected) but a flaw in
this phase's own prompt instructions, which told the model to "add a
matching official image service" for *any* detected database component
without excluding file-based engines. Fixed directly in
`promptShared.ts`: the instruction now special-cases SQLite explicitly
("file-based, not a server process... there is NO official sqlite Docker
image... mount a named volume into the backend service's own container
instead"), and separately tightens the `depends_on: condition:
service_healthy` guidance to require a real `healthcheck` when that
condition is used.

**Second run, after the fix** — same project, prompt: "Regenerate
docker-compose.yml — the previous version invented a non-existent
'sqlite:3' image, which is wrong since SQLite is file-based, not a
server. Fix that." The model correctly proposed `MODIFY docker-compose.yml`
(proving the `existingInfraFiles` → `modify`-gating round trip works, not
just `create`), removed the bogus service entirely, and mounted the
SQLite data directory as a volume into the backend service instead. This
time the DevOps Agent reviewer's response **did parse**, and it caught a
second, real, independent issue live:

> "The edit correctly removes the non-existent sqlite:3 image and
> replaces it with a named volume for the SQLite file, which directly
> addresses the stated issue. However, the frontend service uses
> `depends_on: backend: condition: service_healthy` but the backend
> service defines no `healthcheck`, which would cause the frontend to
> never become healthy and potentially never start. This dependency
> configuration should be fixed — either add a healthcheck to the backend
> or change the condition to `service_started`."

This is exactly the kind of catch the DevOps Agent persona's review focus
("resource limits/requests set on anything...") exists for — real,
correct, and not glossed over. Applied anyway ("Applied 1/1") to complete
the live-verification round trip; the reviewer's flagged issue is carried
into "Scope not built this phase" below rather than silently fixed a
second time, since a `healthcheck` per detected backend framework is real
new scope, not a one-line prompt tweak.

Confirmed on disk via `device_bash` after both applies: `docker-compose.yml`
no longer references `sqlite:3` anywhere; the `db_data` volume is now
mounted at `/app/data` inside the `backend` service; `DATABASE_URL` is
still environment-variable-sourced, never hardcoded.

**Syntax validation**: both `docker-compose.yml` and
`.github/workflows/ci.yml` parse as valid YAML (`python3 -c "import
yaml; yaml.safe_load(...)"`, confirmed for both files after the final
apply). Full `docker compose config`/`docker build` validation was not
possible — Docker is not installed in this environment (`which docker`
returns nothing) — see the honest gap below.

## An honest gap this phase's own verification surfaced

1. **The `POST /tasks` mode-validation bug** (see "What shipped" above)
   was caught only by attempting a real live DevOps task and getting
   `[error] mode must be one of ask|plan|build|spec|fix` — a plain grep
   for other mode-name lists across the gateway, done *after* the fact,
   would have caught it before ever touching the live app. Worth noting
   for future phases adding a new `AgentMode`: `MODES_WITH_STRUCTURED_EDITS`
   in `promptShared.ts` is not the only place a mode name is
   independently enumerated — the runners' own Reviewer-gate conditionals
   and the gateway's request-validation are two more, and this phase
   found both only by exercising the mode live end-to-end, not by
   reading the type definition and assuming every consumer already
   matched it.
2. **The `service_healthy`-without-a-`healthcheck` issue the reviewer
   correctly flagged on the second run was not fixed this phase** — see
   "Scope not built" below.
3. **No Docker/Docker Compose CLI available in this environment** to
   actually build the generated images or run `docker compose config` —
   verification here is limited to YAML syntax validity and manual
   inspection against the real evidence bundle, not an actual successful
   container build. A real user with Docker installed locally would get
   that stronger signal; this tool doesn't have it in this sandbox.
4. **The Anthropic-runner branch of the Reviewer-gate change (and the
   demo-runner's new `"devops"` branch) were updated identically to the
   other two runners by construction, but only the OpenRouter free-tier
   path was actually exercised live** in this environment (same
   configuration constraint Phase 17 already documented: no Anthropic key
   configured here). The Ollama and Anthropic paths are typechecked and
   structurally identical to the OpenAI-compatible path that *was* proven
   live, but that's implemented-not-live-verified for those two
   specifically, consistent with how Phase 17 reported the same
   constraint for its own Anthropic-only tool-use loop.

## Scope not built this phase (tracked, not forgotten)

- Kubernetes manifests and Terraform, as discussed under Design — this is
  a deliberate, evidence-driven scope decision (no real target
  cluster/provider/registry to generate against), not an oversight, and
  the model itself now states this honestly in every DevOps-mode response
  rather than silently narrowing scope.
- A `healthcheck` block per detected backend framework (e.g. an HTTP
  probe against a FastAPI app's own root or a dedicated health route)
  isn't generated, so a compose file using `condition: service_healthy`
  can end up in the state the live reviewer caught above. Adding one
  would need a real, evidenced way to know what a "healthy" response
  looks like for an arbitrary detected framework — plausible future scope,
  not implemented here.
- No `.env.example` file is actually generated alongside `docker-compose.yml`
  to document the environment variables it references — the prompt tells
  the model to reference one in a comment, but doesn't require it to
  create one as part of the same edit set.
- Multi-service monorepos with more than one frontend or backend
  component at the same category (e.g. two separate backends) aren't
  specifically exercised — the evidence bundle would report both, and the
  prompt's per-component instruction should scale, but this wasn't tried
  against a project shaped that way.
