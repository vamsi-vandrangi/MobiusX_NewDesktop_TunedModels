# Phase 17 — Enterprise Knowledge / Global Intelligence (local substitute) + Broader MCP Tool Support

Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 17 (source §29,
§30) — "Same scope as the existing (unbuilt) Phase 4... currently the
biggest single gap; genuinely blocked on MobiusX Cloud's EK/GI surfaces
existing to integrate against." Also folds in §28 (broader MCP tool
support), which the roadmap explicitly does not itemize as its own phase
("treated as capabilities added incrementally... to avoid
over-fragmenting the plan").

Status: **done, live-verified, honestly scoped.** Neither §29/§30 nor §28
can be built as originally specified inside this project's own rules —
§29/§30 name a real "MobiusX Cloud" Enterprise Knowledge/Global
Intelligence backend that does not exist anywhere to integrate against,
and this project's whole discipline is to never fake a connection to
something that isn't there. Rather than stub these out as inert UI or
skip them, the scoping decision (confirmed with the project owner before
implementation) was to build **real, working, honestly-labeled local
substitutes**: a genuine local knowledge base for §29/§30, and a genuine
local MCP client — configured the same way Claude Desktop/Claude Code
configure MCP servers — for §28, wired all the way into Build/Fix tasks
rather than stopping at "connect and list."

## Design: Knowledge (§29/§30)

The real capability §29/§30 are reaching for — relevant organizational
knowledge grounding generation prompts — doesn't require MobiusX Cloud to
exist; it requires *some* indexed corpus of real docs and a retrieval step
wired into prompt construction. So: point the feature at a real folder of
markdown (this repo's own `docs/`, an exported wiki, ADRs, READMEs —
anything text/markdown), index it locally, and inject the top-matching
snippets into `ProjectContext.knowledgeContext` the same way real code
already grounds Build mode via semantic search. Deliberately **global,
not scoped to one project** — real organizational knowledge spans
projects, so `~/.mobiusx/knowledge-sources.json` and
`~/.mobiusx/knowledge/<sourceId>/vectors.json` live alongside the existing
global `~/.mobiusx/settings.json`, not under any one project's `.mobiusx/`.

Reuses `@mobiusx/semantic-index`'s pure `HashingEmbeddingProvider` and
`cosineSimilarity` functions (the same embedding technique already
grounds code search) but deliberately does **not** reuse its tree-sitter
code chunker (markdown isn't a supported language there) or its
path-obfuscating `VectorStore` (knowledge docs have no code-privacy design
to preserve — a doc chunk's own file path and heading are exactly what
should surface in a hit). Instead: a dedicated heading-scoped markdown
chunker and a flat JSON store holding chunk text directly.

Search is **real lexical/hashing similarity, not neural semantic search**
— the Knowledge view says so explicitly, so nobody mistakes "same
embedding technique code search uses" for paraphrase-level understanding.
Like `semantic-index`'s own `queryIndex`, `searchKnowledge` has **no
similarity threshold** — it always returns the closest top-k results,
however weak the match, matching this codebase's existing, intentional
design choice rather than inventing a new one.

## Design: MCP (§28 — full client, wired into tasks)

Two levels were possible: "connect + list" (prove the protocol works,
show discovered tools in Settings) or "full client: wired into tasks"
(the model can actually call those tools mid-task). The project owner
chose the fuller scope. `.mobiusx/mcp.json` uses the **exact
`{"mcpServers": {...}}` shape** Claude Desktop and Claude Code already
use, specifically so a config a developer already has for either of those
tools is copy-paste compatible — no new config format to learn.
`packages/mcp-client` wraps the real `@modelcontextprotocol/sdk`
(`Client`/`StdioClientTransport`) with a connection cache, tool
discovery, `callMcpTool`, and `toAnthropicToolDefs` (namespacing each
tool as `"<serverName>__<toolName>"` to disambiguate identically-named
tools across servers).

Tool-calling is wired into **the Anthropic runner only, and only for
Build/Fix modes** — an explicit, documented scope boundary, not a silent
limitation: this codebase's free-model runners (OpenRouter/Groq/Ollama)
have no tool-use convention wired up yet (see
`apps/cloud-agent-gateway/README.md`'s note on the free-model gap), and
Ask/Plan/Spec never write files so there's nothing for a tool call to
usefully condition. The Anthropic runner's non-streamed multi-turn
tool-use loop (`runToolUseLoop` in `anthropicRunner.ts`) was written from
scratch against the raw Messages API (`fetch`, no SDK — matching this
codebase's existing pattern for its only other Anthropic call site),
handling `stop_reason: "tool_use"`, `tool_use`/`tool_result` content
blocks, and a hard `MAX_TOOL_ITERATIONS = 6` cap so a model that keeps
calling tools can't loop forever — the cap is honest and enforced, not
aspirational.

## What shipped

- **`apps/desktop-agent/src/knowledgeOps.ts`** (new): global sources file
  I/O, `chunkMarkdown` (heading-scoped), `walkFiles` (recursive,
  ignore-list-aware), `buildKnowledgeIndex`, `searchKnowledge`.
- **Routes**: `GET/POST /knowledge/sources`, `DELETE
  /knowledge/sources/:id`, `POST /knowledge/index`, `GET
  /knowledge/search`.
- **`packages/protocol`**: `KnowledgeSource`, `KnowledgeSourcesResponse`,
  `KnowledgeIndexStats`, `KnowledgeIndexResponse`, `KnowledgeSearchHit`,
  `KnowledgeSearchResponse`; `ProjectContext.knowledgeContext?`.
- **`packages/mcp-client`** (new package): `loadMcpConfig`,
  `connectionCache`/`getOrConnect`, `getMcpStatus`, `listAllTools`,
  `callMcpTool`, `toAnthropicToolDefs`.
- **Routes**: `GET /mcp/status`, `POST /mcp/tools/call`.
- **`apps/cloud-agent-gateway/src/runners/anthropicRunner.ts`**: computes
  `mcpTools` for build/fix mode, branches to `runToolUseLoop` when any
  are configured, otherwise the original streaming path is completely
  unchanged.
- **Renderer**: a real Knowledge nav view (sources list with
  Build-index/Remove, add-source form, search box + results with
  source/heading/score); "MCP Tools" and expanded "Hooks"/"Project
  Steering" sections in Application Settings; `fetchKnowledgeContext()`
  called alongside `fetchSteeringContext()` when submitting an AI
  Assistant request, feeding real snippets into `projectContext`.

## Tests

`apps/desktop-agent/test/knowledgeOps.test.ts` — **7/7 passing** (markdown
chunking, add/list/remove a source, build an index, search returns
top-k hits, and — the one deliberately-corrected assertion this phase —
confirming `searchKnowledge` has no similarity floor by checking a
removed source's hits are gone by `sourceId`, not by asserting an empty
result set, since other indexed sources still return their own top-k
matches).

`packages/mcp-client/test/loadMcpConfig.test.ts` — **6/6 passing**: no
file, malformed JSON, a valid config, disabled-server filtering, and the
Anthropic tool-definition mapping.

Re-run today alongside a full clean `npm run build --workspaces` across
all nine `apps/*`+`packages/*` packages — zero TypeScript errors.

## Live evidence: Knowledge

Against the real running app (GreenThumbGarden open), added a real
knowledge source pointing at this repo's own `docs/` folder
(`/Users/vamsimohan/Documents/Vamsi/RAG SaaS/CredenceX_WDC/docs`, labeled
"MobiusX Docs") and clicked **Build index**. Confirmed via the real Audit
Log (not just a UI toast):

```
17/09/2026, 22:22:48  desktop-agent  knowledge-index
Indexed knowledge source 7121cd53-dddd-4731-a467-9319cd7d83db: 10/10 file(s), 126 chunk(s)
```

Then ran a real search for **"roadmap phase"** against the live UI and
got back real, relevant, correctly-scored hits — not placeholder text:

```
MobiusX Docs — phase-notes/phase-7-project-understanding-spec-engine.md § Phase 7 — Project Understanding + Specification Engine   score 0.477
# Phase 7 — Project Understanding + Specification Engine
Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 7 (source requirements
doc §5, §6).
Status: **done, live-verified end-to-end** — same "evidence, not intention"
discipline as Phase 6. This doc is that evidence.

MobiusX Docs — phase-notes/phase-9-architecture-generation.md § Phase 9 — Architecture Generation   score 0.433
# Phase 9 — Architecture Generation
Roadmap: `docs/AI_ENGINEERING_PLATFORM_ROADMAP.md` Phase 9.
Trigger for this phase: a beta tester reported that generated architecture
diagrams were "very basic level." Status: **done, live-verified end-to-end**
...
```

Both hits are genuine chunks from this repo's real phase-notes files, with
the real heading path and a real, differentiated relevance score (0.477
vs. 0.433) — confirming the index/search round trip works against real
content, not a fixture.

## Live evidence: MCP

Created a minimal, real MCP stdio server for testing
(`Test Projects/mcp-test-server/server.mjs`, using the same
`@modelcontextprotocol/sdk` `Server`/`StdioServerTransport` this app's
client talks to) exposing one `echo` tool. Configured
`Test Projects/GreenThumbGarden/.mobiusx/mcp.json`:

```json
{ "mcpServers": { "echo-test": { "command": "node",
    "args": ["../mcp-test-server/server.mjs"] } } }
```

Settings → MCP Tools shows, from the real running desktop-agent (not a
static fixture): **`echo-test` — connected**, tool `echo` listed
underneath — a real stdio child process spawned, a real
`ListToolsRequestSchema` round trip completed.

## An honest gap this phase's own verification surfaced

The Anthropic tool-**call** path inside a live Build/Fix task
(`runToolUseLoop` actually invoking `echo` mid-task) was **not**
end-to-end live-verified in this environment: Settings' Default AI Model
dropdown only offers free-tier models here (`Ling 3.0 Flash VL` via
OpenRouter, `GPT-OSS 120B` via Groq) — no Anthropic API key is configured
in this instance, so there is no live path to actually exercise
`anthropicRunner.ts`'s new branch against a real Anthropic call. What
*was* verified live: the MCP connection and tool-discovery path (above,
exercised by the same `packages/mcp-client` code the Anthropic runner
calls into via `getMcpStatus`/`listAllTools`), and the tool-definition
mapping unit test (`toAnthropicToolDefs`) confirming the shape handed to
the Messages API is correct. The multi-turn loop itself
(`stop_reason: "tool_use"` → `callMcpTool` → feed `tool_result` back →
continue) is implemented and typechecked but its live, model-driven
behavior against a real Anthropic key is the one piece of this segment's
work recorded here as **implemented, not live-verified**, rather than
silently presented as fully proven. Verifying it needs either an
Anthropic key configured in this environment or the same test run in an
environment that has one.

## Scope not built this phase (tracked, not forgotten)

- MCP tool-calling is Anthropic-runner-only; extending it to the free-tier
  runners needs a tool-use convention for each of their APIs first (a
  separate, non-trivial piece of work, not a quick follow-on).
- Knowledge search is lexical/hashing similarity, explicitly not neural
  semantic search — a real embeddings API (OpenAI/Voyage/local model)
  would improve match quality but was out of scope for a "real local
  substitute," which prioritized working end-to-end over search quality.
- No knowledge-source re-indexing on file change (manual "Build index"
  only) — same manual-refresh, v1-conservative choice already made for
  Database Consistency, Project Context, and the Architecture Artifacts
  view.
- §29/§30 as *originally* specified (integrating against MobiusX Cloud's
  own EK/GI surfaces) remains genuinely blocked on those surfaces
  existing — this phase closes the local-substitute gap, not the
  original spec, and says so rather than quietly reinterpreting the
  requirement as done.
