# MobiusX_WDC

MobiusX Desktop — the desktop application surface of the MobiusX.ai Enterprise AI Engineering & Intelligence Platform.

MobiusX is Web + Desktop + Cloud Agents + CLI, not a web-to-desktop replacement. This repo builds the desktop surface: a workspace shell focused on Engineering Studio and X-Coder, with local repository access, git, terminal, and a local agent that talks to MobiusX Cloud for everything else (Enterprise Knowledge, Global Intelligence, RAG, model routing).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture: surface responsibilities, the local/cloud agent split, how this relates to the existing MobiusX IDE (VS Code fork) project, tech stack decisions, repo layout, and the phased roadmap.

## Status — Phase 1 (in progress)

Working, tested vertical slice:

- `packages/context-engine`, `packages/semantic-index` — vendored from the MobiusX IDE project (Merkle indexer, Tree-sitter semantic chunking). 22 tests passing, unmodified from source.
- `packages/protocol` — shared desktop↔agent HTTP/WS contracts.
- `apps/desktop-agent` — Local Agent Service (Express + ws, loopback-only, bearer-token auth): project open (via context-engine), file tree, file read, git status/log/diff, and a **real interactive terminal** — `node-pty` on the agent side, one PTY process per WebSocket connection, raw keystrokes/ANSI both ways. Smoke-tested end to end against this repo itself.
- `apps/desktop` — Electron shell v0 (no bundler): spawns the agent, workspace nav, file tree, git panel, an `xterm.js`-rendered terminal panel wired to that real PTY, and a UI restyled to match the MobiusX Desktop prototype (sidebar IA, top bar, tabbed editor, AI Assistant panel).
- `Debug` view — Phase 2 static slice: local semantic-ish code search (`@mobiusx/semantic-index`) correlated with per-file git history. Explicitly not live cross-system trace/log analysis (see docs/ARCHITECTURE.md §5.3/§12) — that needs real observability data and MobiusX Cloud (Phase 3).
- `apps/cloud-agent-gateway` — Phase 3 local reference implementation of the desktop↔cloud task contract: real task creation, WebSocket streaming, persistence, cancellation, and resumability, with a demo runner by default and an optional real Anthropic runner (token-streamed) if you supply `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`. **Not MobiusX's real production Cloud** — see its own README. The AI Assistant panel and Tasks view are wired to it for real, and ground tasks using Phase 2's semantic search when a project is open.
- **Real AI-applied code edits** — Build mode proposes full-file-content changes (never diffs/patches) as structured `ProposedEdit[]`, shown in the AI Assistant panel and Tasks view with a client-side computed diff (jsdiff) for review. Nothing is ever written automatically: clicking Apply calls the desktop agent's `POST /fs/apply-edits` — the *only* code path that writes AI-generated content to disk — which re-validates every edit itself (path stays inside the open project, `modify` requires the file to already exist, `create` requires it not to, a flag-only secret scan skips anything secret-shaped for manual review instead of silently rewriting it) and reports each file's outcome individually. With no model configured, build mode still proposes one clearly-labeled demo edit so the whole propose → review → apply pipeline is exercisable end to end.
- **Second-pass Reviewer agent** — the first real multi-agent primitive in this codebase: after build-mode edits are proposed, `apps/cloud-agent-gateway` makes a genuine *second*, independent, non-streaming model call with a distinct "Code Reviewer Agent" system prompt, given the original request and the full proposed edits. It can actually disagree — a real second opinion, not a relabeling of the first response — and shows as an approve/concerns banner above the edits card. Any parse failure or unexpected response defaults to **"concerns"**, never a silent "approve", so a broken reviewer can't accidentally rubber-stamp something. Scoped to real code edits only — spec and plan modes never get one.
- **Requirements Engineering (Spec mode)** — a fourth AI mode alongside Ask/Plan/Build. Reuses the exact same `ProposedEdit`/review/apply pipeline build mode uses (a generated spec is, mechanically, just a new markdown file under `.mobiusx/specs/`) rather than a parallel structured-data system: fixed section structure (Overview, Functional/Non-Functional Requirements, Constraints & Assumptions, Risks, Gherkin Acceptance Criteria), with an "Open Questions" section as the explicit escape hatch when a request is genuinely ambiguous instead of the model inventing unstated requirements.
- **Verification Engine** — after Apply, a "Run verification" button calls the desktop agent's `POST /verify`, which runs the *open project's own* `npm run <script>` commands (`typecheck`, `build`, `lint`, `test`, in that priority order, read from the project's real `package.json`) — never a command the model invents — with a hard per-step timeout enforced by killing the whole process group (not just the immediate child, which left orphaned processes holding stdio open and hanging the timeout itself). Real pass/fail/timed-out evidence with captured (bounded) output, not a claim.
- Phase 5 governance — local-reference slice: a **terminal command guard** (`apps/desktop-agent/src/policy.ts`) that flags known-destructive command shapes (`rm -rf /`, force-pushing to main, piping a curl download into a shell, etc.), logs them, and — in the default **"off"** autonomy level — sends a best-effort interrupt after the fact. An **Approval Engine** autonomy level (`AgentSettings.terminalApprovalMode: "guarded"`, toggled in Settings, file-backed at `~/.mobiusx/settings.json`) instead catches a flagged line's completing keystroke *before* it ever reaches the shell and holds it until the user clicks Approve or Reject in the terminal panel — a real gate, not just a faster reaction — while "off" keeps today's behavior byte-for-byte unchanged. Both modes are advisory, not a sandbox (see policy.ts's doc comment for exactly why, given a real interactive PTY). A **secret scanner** (`packages/secret-scan`, shared by both apps) redacts anything secret-shaped out of a task's code context before it ever reaches a model, and separately flags (without rewriting) secret-shaped content in an AI-generated edit before it's applied to disk. All of the above write to a shared append-only audit log (`@mobiusx/audit-log`, `~/.mobiusx/audit.jsonl`), visible in the desktop shell's Settings view.

**Not yet done:** live cross-system tracing for the debugger; integration with MobiusX's actual production Cloud backend (RAG/Enterprise Knowledge/Global Intelligence); enterprise-grade governance (multi-tenant auth, centrally-managed org policy, real sandboxing) — Phase 5 here is intentionally a single-user advisory layer, not that; cross-file transactional rollback for a multi-file apply (each file is written atomically, but a crash mid-batch can leave a partial batch applied — reported per-file, not hidden); a real verification/CI pipeline beyond running a project's own existing scripts locally; a real requirements-management system beyond a generated markdown file; packaging/code signing.

## Running it locally

The agent (pure Node/TypeScript) builds and runs anywhere:

```
npm install
npm run build -w packages/context-engine -w packages/semantic-index -w apps/desktop-agent
npm run test -w packages/context-engine -w packages/semantic-index -w apps/desktop-agent
```

The Electron shell needs to be installed and launched from a real terminal on your machine (not through a bridged/sandboxed shell) so it downloads the Electron binary for your actual OS/architecture and can open a real window:

```
npm run start -w apps/desktop
```

**Known gotcha:** if `node_modules` was ever installed from a bridged/sandboxed shell (a Linux VM, CI, etc.) rather than natively on your Mac, `node_modules/electron` will hold a Linux binary and `npm run start` fails with `spawn ... errno -8` (ENOEXEC) — Electron's postinstall only fetches the binary matching whatever machine ran `npm install`. The same applies to `node_modules/node-pty` (Phase 1's real terminal): it's a native module built from source for whatever machine runs `npm install`, so a Linux-bridge install leaves a binary that can't load on macOS (`Terminal did not connect` / a require error naming `pty.node` in the agent's logs). Fix for both: `rm -rf node_modules && npm install` from a real terminal on the machine you intend to run it on.

## Structure

- `apps/desktop` — Electron shell (workspace UI, AI Workspace pane, embeds the MobiusX IDE editor surface)
- `apps/desktop-agent` — Local Agent Service (filesystem, git, terminal + command guard with a guarded/hold-for-approval autonomy level, apply-edits, verification runner, containers, MCP)
- `apps/cloud-agent-gateway` — local reference implementation of the desktop↔cloud task contract, with secret-scan/redaction on outbound context, structured build-mode edit proposals, a second-pass reviewer agent, and Spec mode
- `packages/context-engine`, `packages/semantic-index` — vendored from the MobiusX IDE project (Merkle indexer, Tree-sitter semantic chunking)
- `packages/protocol` — shared desktop↔cloud message contracts (WebSocket/SSE)
- `packages/audit-log` — shared append-only local audit log for Phase 5 governance events
- `packages/secret-scan` — shared regex-based secret detection (redact for outbound task context, flag-only for AI-generated edits before they're written to disk)
- `packages/ui-kit` — shared design system components (web + desktop) — not started
- `docs/` — architecture and phase writeups
