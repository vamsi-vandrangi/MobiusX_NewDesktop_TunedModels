# @mobiusx/cloud-agent-gateway

**This is a local reference implementation of the desktop↔cloud task contract (Phase 3) — it is not MobiusX's real production Cloud backend.** It exists so the desktop shell's AI Assistant panel and Tasks view have something real to call, and so the task lifecycle (create → stream progress → persist → resume) is proven out end-to-end rather than mocked in the UI.

It ships with **no credentials and no assumed model**. Out of the box it runs the `demo` runner — deterministic, scripted steps that clearly label every output as non-model-generated. If you set both `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in its environment, it switches to the `anthropic` runner and streams a real answer token-by-token from Anthropic's Messages API instead (`stream: true`, forwarded to the client over the `/tasks/:id/stream` WebSocket as it arrives — not buffered until the model finishes). Which runner served a task is always reported back as `TaskSummary.runner` — never hidden.

Any task — either runner — can be cancelled mid-flight via `POST /tasks/:id/cancel`. This aborts the runner's actual in-flight work (the Anthropic HTTP request itself for `anthropic`, the scripted timer for `demo`) via a shared `AbortSignal`, not just a UI-side "stop showing this." A cancelled task settles into `status: "cancelled"` — a distinct terminal state from `"failed"`, so the UI and any caller can tell "the user stopped this" apart from "this broke."

"Build" mode never modifies files *itself*, with either runner — this gateway has no disk access at all. Instead it proposes full-file-content edits as structured `ProposedEdit[]` (never a diff/patch — always the complete new file body): the `demo` runner always proposes one clearly-labeled placeholder edit (a `MOBIUSX_DEMO_EDIT.md` that says exactly what it is) so the propose → review → apply pipeline is testable with no model configured, and the `anthropic` runner instructs the model to end its response with a structured JSON block (see `runners/anthropicRunner.ts`'s `EDITS_MARKER`/`parseBuildResponse`) which is parsed leniently and validated — a "modify" is only honored for a path the model was shown in *full* content for, never one it only saw a search snippet of. Either way, these are only ever *proposals*: nothing is written to disk until the user reviews them in the desktop shell and clicks Apply, which calls `apps/desktop-agent`'s `POST /fs/apply-edits` — the human-approval step in docs/ARCHITECTURE.md §8.

**"Spec" mode** is a fourth mode alongside `ask`/`plan`/`build`, for Requirements Engineering. It reuses this exact same edit/review/apply machinery (`MODES_WITH_STRUCTURED_EDITS` in `anthropicRunner.ts` covers both `build` and `spec`) rather than a separate structured-data system, since a generated spec is mechanically just one new markdown file: the model is instructed to produce a fixed section structure (Overview, Functional/Non-Functional Requirements, Constraints & Assumptions, Risks, Gherkin-fenced Acceptance Criteria) under `.mobiusx/specs/<kebab-case-name>.md`, with an explicit "Open Questions" section as the place ambiguity goes instead of the model quietly inventing requirements. The `demo` runner proposes one clearly-labeled placeholder spec (`demo-spec.md`) with that same structure.

**A second-pass Reviewer agent** runs after `build`-mode edits are emitted (never for `spec` or `plan` — see `reviewEdits()` in `anthropicRunner.ts`): a genuine second, independent, non-streaming Anthropic API call with its own "Code Reviewer Agent" system prompt, given the original prompt and the full proposed edits' content, returning `{verdict: "approve" | "concerns", summary}`. `parseReview()` (exported for testing) parses the response leniently but **defaults to `"concerns"`** — never a silent `"approve"` — on any JSON-parse failure or missing/invalid `verdict` field, and the calling code emits an honest `"concerns"` review rather than dropping the review outright if the API call itself fails. The `demo` runner emits a scripted `"approve"` review after its placeholder edit so the reviewer UI (an approve/concerns banner in the desktop shell) is exercisable with no model configured.

**Phase 5:** before any task's `projectContext.relevantFiles` snippets *or full file content* reach a runner, `@mobiusx/secret-scan`'s `scanAndRedact` scans them for secret-shaped text (AWS keys, API keys, PEM private key blocks, hardcoded password assignments, JWTs, GitHub/Slack tokens) and redacts matches in place — so a hardcoded credential that Phase 2's semantic search happens to surface never reaches the Anthropic API call, or the demo runner's echoed context. Redactions are recorded as the task's first step (visible in the AI Assistant panel and Tasks view) and written to the shared audit log (`@mobiusx/audit-log`, `~/.mobiusx/audit.jsonl`). It's a regex scanner, not a real secret-detection engine — no entropy scoring, no provider validation — treat it as a floor, not a guarantee. `apps/desktop-agent` runs the same package's detect-only `scanForSecrets` on generated edit content before writing anything to disk (see its own README) — defense in depth against the model echoing/hallucinating secret-shaped content into generated code.

## Running

```
npm run build -w apps/cloud-agent-gateway
npm run start -w apps/cloud-agent-gateway
# or, for a real model:
ANTHROPIC_API_KEY=sk-... ANTHROPIC_MODEL=claude-... npm run start -w apps/cloud-agent-gateway
```

Prints `MOBIUSX_CLOUD_READY {"port":...,"token":...}` on stdout once listening — this is how the Electron main process (which spawns it automatically) discovers it, the same pattern `apps/desktop-agent` uses.

### Configuring a real model for the desktop app

Exporting `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` in your shell only reaches the gateway when you launch it (or `apps/desktop`) from that same shell — running the Electron app from Finder/Spotlight instead of a terminal doesn't inherit those exports at all. For that case, copy `.env.example` to `.env` in this directory and fill in your own key and model:

```
cp apps/cloud-agent-gateway/.env.example apps/cloud-agent-gateway/.env
# then edit apps/cloud-agent-gateway/.env yourself and fill in the two values
```

`src/index.ts` loads it via Node's built-in `process.loadEnvFile()` on startup — a missing `.env` is silently a no-op (still the demo runner, still "no credentials, no assumed model" by default), and a real shell export always takes precedence over the file if both are present. `.env` is already gitignored so your key never gets committed; `.env.example` itself carries no real values.

## Data

Tasks persist to `~/.mobiusx/cloud-agent-gateway/tasks.json` (override with `MOBIUSX_CLOUD_DATA_DIR`) — deliberately outside any project repo, since tasks aren't scoped to one project.

## Swapping in the real backend later

Point the desktop shell at a different base URL that implements this same contract (`packages/protocol/src/cloud.ts`), or adapt this contract to match the real backend's once that integration is scoped — see docs/ARCHITECTURE.md §12.

## Known gaps

- No auth beyond a per-process bearer token (fine for "one local desktop app talking to one locally-spawned process"; not how a real multi-user cloud service would authenticate).
- Cancellation is in-memory only (`taskEngine.ts`'s `AbortController` map) — it doesn't survive a gateway process restart. A task still "running" per `tasks.json` after a restart can no longer be cancelled by id (there's no controller left to abort); it will simply never reach a terminal state until the process that owned it is gone. This mirrors demoRunner/anthropicRunner having no persisted "resume from where I left off" behavior either.
- The secret scanner is regex-only (see above) — no entropy scoring, no provider-specific validation, and it only covers `relevantFiles` snippets/content, not the prompt text itself or (for the anthropic runner) the model's own output before it's split into prose/edits.
- Build-mode and spec-mode edit parsing (`parseBuildResponse`) is a simple marker + fenced-JSON convention this gateway instructs the model to follow — it's not a guaranteed structured-output mode of the underlying API, so a model that ignores the instruction just yields prose with no edits (graceful, not a crash) rather than a parse failure.
- The reviewer agent is one extra model call with a distinct prompt, not an orchestrated multi-agent workflow — it has no tools, no ability to request changes and re-check them, and no state beyond that single call.
