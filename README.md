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
- Phase 5 governance — local-reference slice: a **terminal command guard** (`apps/desktop-agent/src/policy.ts`) that flags known-destructive command shapes (`rm -rf /`, force-pushing to main, piping a curl download into a shell, etc.), logs them, and sends a best-effort interrupt — advisory and reactive, not a sandbox (see its doc comment for exactly why, given a real interactive PTY). A **secret scanner** (`apps/cloud-agent-gateway/src/policy/secretScan.ts`) redacts anything secret-shaped out of a task's code context before it ever reaches a model. Both write to a shared append-only audit log (`@mobiusx/audit-log`, `~/.mobiusx/audit.jsonl`), visible in the desktop shell's Settings view.

**Not yet done:** live cross-system tracing for the debugger; integration with MobiusX's actual production Cloud backend (RAG/Enterprise Knowledge/Global Intelligence); enterprise-grade governance (multi-tenant auth, centrally-managed org policy, real sandboxing) — Phase 5 here is intentionally a single-user advisory layer, not that; packaging/code signing.

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
- `apps/desktop-agent` — Local Agent Service (filesystem, git, terminal + command guard, containers, MCP)
- `apps/cloud-agent-gateway` — local reference implementation of the desktop↔cloud task contract, with secret-scan/redaction on outbound context
- `packages/context-engine`, `packages/semantic-index` — vendored from the MobiusX IDE project (Merkle indexer, Tree-sitter semantic chunking)
- `packages/protocol` — shared desktop↔cloud message contracts (WebSocket/SSE)
- `packages/audit-log` — shared append-only local audit log for Phase 5 governance events
- `packages/ui-kit` — shared design system components (web + desktop) — not started
- `docs/` — architecture and phase writeups
