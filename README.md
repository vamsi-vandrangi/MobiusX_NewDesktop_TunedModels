# MobiusX_WDC

MobiusX Desktop — the desktop application surface of the MobiusX.ai Enterprise AI Engineering & Intelligence Platform.

MobiusX is Web + Desktop + Cloud Agents + CLI, not a web-to-desktop replacement. This repo builds the desktop surface: a workspace shell focused on Engineering Studio and X-Coder, with local repository access, git, terminal, and a local agent that talks to MobiusX Cloud for everything else (Enterprise Knowledge, Global Intelligence, RAG, model routing).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture: surface responsibilities, the local/cloud agent split, how this relates to the existing MobiusX IDE (VS Code fork) project, tech stack decisions, repo layout, and the phased roadmap.

## Status — Phase 1 (in progress)

Working, tested vertical slice:

- `packages/context-engine`, `packages/semantic-index` — vendored from the MobiusX IDE project (Merkle indexer, Tree-sitter semantic chunking). 22 tests passing, unmodified from source.
- `packages/protocol` — shared desktop↔agent HTTP/WS contracts.
- `apps/desktop-agent` — Local Agent Service (Express + ws, loopback-only, bearer-token auth): project open (via context-engine), file tree, file read, git status/log/diff, and a command-exec terminal over WebSocket. Smoke-tested end to end against this repo itself.
- `apps/desktop` — Electron shell v0 (no bundler): spawns the agent, workspace nav, file tree, git panel, terminal panel.

**Not yet done:** a real interactive PTY (current terminal is command-exec, not a full shell session — avoids native `node-pty` compilation for now); intelligent debugger (Phase 2); cloud agent integration (Phase 3); packaging/code signing.

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

## Structure

- `apps/desktop` — Electron shell (workspace UI, AI Workspace pane, embeds the MobiusX IDE editor surface)
- `apps/desktop-agent` — Local Agent Service (filesystem, git, terminal, containers, MCP)
- `packages/context-engine`, `packages/semantic-index` — vendored from the MobiusX IDE project (Merkle indexer, Tree-sitter semantic chunking)
- `packages/protocol` — shared desktop↔cloud message contracts (WebSocket/SSE)
- `packages/ui-kit` — shared design system components (web + desktop) — not started
- `docs/` — architecture and phase writeups
