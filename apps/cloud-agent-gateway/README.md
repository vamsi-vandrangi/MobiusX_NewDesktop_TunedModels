# @mobiusx/cloud-agent-gateway

**This is a local reference implementation of the desktop↔cloud task contract (Phase 3) — it is not MobiusX's real production Cloud backend.** It exists so the desktop shell's AI Assistant panel and Tasks view have something real to call, and so the task lifecycle (create → stream progress → persist → resume) is proven out end-to-end rather than mocked in the UI.

It ships with **no credentials and no assumed model**. Out of the box it runs the `demo` runner — deterministic, scripted steps that clearly label every output as non-model-generated. If you set both `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in its environment, it switches to the `anthropic` runner and makes a real (non-streaming) call to Anthropic's Messages API instead. Which runner served a task is always reported back as `TaskSummary.runner` — never hidden.

"Build" mode deliberately never modifies files automatically, with either runner — it only drafts a description of the proposed change, consistent with the human-approval step in docs/ARCHITECTURE.md §8.

## Running

```
npm run build -w apps/cloud-agent-gateway
npm run start -w apps/cloud-agent-gateway
# or, for a real model:
ANTHROPIC_API_KEY=sk-... ANTHROPIC_MODEL=claude-... npm run start -w apps/cloud-agent-gateway
```

Prints `MOBIUSX_CLOUD_READY {"port":...,"token":...}` on stdout once listening — this is how the Electron main process (which spawns it automatically) discovers it, the same pattern `apps/desktop-agent` uses.

## Data

Tasks persist to `~/.mobiusx/cloud-agent-gateway/tasks.json` (override with `MOBIUSX_CLOUD_DATA_DIR`) — deliberately outside any project repo, since tasks aren't scoped to one project.

## Swapping in the real backend later

Point the desktop shell at a different base URL that implements this same contract (`packages/protocol/src/cloud.ts`), or adapt this contract to match the real backend's once that integration is scoped — see docs/ARCHITECTURE.md §12.

## Known gaps

- Output is delivered as one chunk when the runner finishes, not token-by-token streaming (the WebSocket transport supports it; the Anthropic runner doesn't request `stream: true` yet).
- No task cancellation endpoint yet.
- No auth beyond a per-process bearer token (fine for "one local desktop app talking to one locally-spawned process"; not how a real multi-user cloud service would authenticate).
