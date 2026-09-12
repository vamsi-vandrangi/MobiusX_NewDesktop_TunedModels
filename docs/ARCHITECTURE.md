# MobiusX.ai — Desktop App Architecture (MobiusX_WDC)

Status: Draft v0.1 for review
Owner: Vamsi | CadenceX Technologies Pvt. Ltd.
Scope: How the desktop application fits into MobiusX.ai as a whole, and what this repo (`MobiusX_WDC`) is responsible for building.

---

## 1. Framing

The question isn't "should MobiusX be web or desktop." MobiusX is an **Enterprise AI Engineering & Intelligence Platform** with multiple surfaces — Web, Desktop, Mobile, and Cloud Agents — all backed by one cloud platform that owns identity, policy, knowledge, and billing.

```
                         MOBIUSX.AI
                             │
              ┌──────────────┼──────────────┐
              │              │              │
           WEB APP       DESKTOP APP      MOBILE
              │              │
       CXO / Admin      Engineering
       Dashboards       Studio
       Enterprise       X-Coder
       Knowledge        Local Code
       Global Intel     Terminal
       Governance       Local Files
              │              │
              └───────┬──────┘
                      │
                MOBIUSX CLOUD
                      │
        ┌─────────────┼─────────────┐
        │             │             │
       EK            GI            ES
   Enterprise      Agents/       X-Coder /
   Knowledge         RAG        Artifacts
        │             │             │
        └─────────────┼─────────────┘
                      │
              AI ORCHESTRATION
                      │
        ┌─────────────┼─────────────┐
        │             │             │
      OpenAI       Anthropic      Gemini
        │             │             │
        └─────────────┼─────────────┘
                      │
                Enterprise Data
```

**Positioning**, relative to the field:

| Product | Positioning |
|---|---|
| Cursor | AI software engineering |
| Claude | AI assistant / work agent |
| ChatGPT | General-purpose AI + work agent |
| **MobiusX** | **Enterprise AI Engineering & Intelligence Platform** |

MobiusX should own the *enterprise engineering lifecycle* — knowledge, governance, intelligence, and engineering execution together — not just AI-assisted coding. That combination (enterprise knowledge + domain intelligence + engineering intelligence + governance + autonomous engineering) is the moat, not "another AI coding interface." It's also the answer to "what if Microsoft/Google build something similar" — a single coding agent is copyable; the governed, knowledge-grounded enterprise lifecycle is harder to replicate quickly.

---

## 2. Surface Responsibility Matrix

| Capability | Web | Desktop |
|---|:---:|:---:|
| Enterprise Knowledge | ★★★★★ | ★★★★ |
| Global Intelligence | ★★★★★ | ★★★★ |
| CXO Dashboard | ★★★★★ | ★ |
| Governance | ★★★★★ | ★★★ |
| Administration | ★★★★★ | ★★ |
| Engineering Studio | ★★★★ | ★★★★★ |
| X-Coder | ★★★ | ★★★★★ |
| Local repository access | ★ | ★★★★★ |
| Terminal | ★ | ★★★★★ |
| Git | ★★ | ★★★★★ |
| Debugging (cross-system) | ★★★ | ★★★★★ |
| Local code analysis | ★ | ★★★★★ |
| Cloud agents | ★★★★★ | ★★★★★ |

**Stays web-only:** Enterprise Knowledge, Global Intelligence, CXO/Board dashboards, Governance, Administration, Billing, Analytics, Customer management. These are inherently browser-shaped (multi-device, shareable, no local-system need) and shouldn't be rebuilt for desktop.

**Desktop's job:** Engineering Studio and X-Coder — the parts of MobiusX that benefit from talking directly to the local filesystem, git, terminal, Docker/Kubernetes, IDEs, cloud CLIs, and MCP servers, none of which a browser can do naturally.

---

## 3. Why Desktop — and Why X-Coder Specifically

The current X-Coder vision already looks like a full engineering lifecycle, not a code-completion tool:

```
Requirement → Architecture → Design → Code → Test → Debug → Git → Deploy
```

A browser can front this, but a desktop process can interact directly with local repositories, the filesystem, git, GitHub/GitLab, IDEs, terminals, Docker, Kubernetes, cloud CLIs, build systems, test frameworks, logs, local dev environments, and MCP servers. That's the exact direction AI coding tools are already moving (Cursor's desktop product works this way; OpenAI now bundles Chat/Work/Codex into one desktop app; Anthropic ships Claude across desktop and web). MobiusX should follow the same shape for its own reasons — not to compete with Cursor head-on, but because Engineering Studio genuinely needs local-system access to do what it claims to do.

---

## 4. Relationship to MobiusX IDE (decision, this session)

MobiusX already has a separate, in-progress project: **MobiusX IDE**, a VS Code fork with a real context engine already built —

- Phase 0: `@mobiusx/context-engine` — Merkle-tree incremental indexer, benchmarked on a 15,256-file tree (cold 50.4s / warm 9.9s / single-file update touches 8 of 17,034 nodes)
- Phase 1 (partial): `@mobiusx/semantic-index` — Tree-sitter AST-bounded chunking, embedding-provider abstraction, AES-256-GCM path obfuscation, local vector store (17 tests passing, query latency 24–30ms)
- VS Code branding patch applied; native build deferred (needs a real display + Node 24 toolchain on a real machine, not the sandboxed dev environment)

Generic desktop-app guidance says "don't build a full IDE initially — don't try to build MobiusX VS Code." That's the right default for a team starting from zero. It doesn't apply as-is here, because the IDE isn't hypothetical future work — it's real, tested, and partially built.

**Decision:** `MobiusX_WDC` is the new home for the overall desktop application (the workspace shell described in §5, the local/cloud agent split in §6, and the enterprise control-plane workflow in §8). The existing MobiusX IDE becomes **X-Coder's editor surface** inside that shell — not a rename, not a rewrite, not discarded. Concretely:

- `@mobiusx/context-engine` and `@mobiusx/semantic-index` are pulled into `MobiusX_WDC` as shared packages (npm workspace), reused by both the editor surface and the "local repository intelligence" feature in §5.
- The VS Code fork (`apps/editor-fork` in the IDE repo) is embedded as the code-editing view inside X-Coder, not launched as a standalone product. It gets opened when a user drills into "edit this file" from Engineering Studio; it is not the app's front door.
- The **front door** of MobiusX Desktop is the lighter workspace shell in §5 — chat/agent-first, with the IDE surfacing only where deep code editing is actually needed. This keeps the desktop app's first release scoped and shippable while still capitalizing on the IDE work already done.
- `mobiusx-ide`'s repo remains the source for the editor-fork package(s) until they're vendored into `MobiusX_WDC/packages/`, at which point that repo becomes a historical/reference repo rather than an actively separate product.

---

## 5. MobiusX Desktop — Product Shape

### 5.1 Workspace shell

```
┌─────────────────────────────────────────────┐
│ MOBIUSX                                      │
├──────────────┬────────────────────────────── ┤
│              │                               │
│ Enterprise   │       AI Workspace            │
│ Knowledge    │                               │
│              │   Ask / Plan / Build          │
│ Global       │                               │
│ Intelligence │   ┌──────────────────────┐    │
│              │   │ What do you want      │   │
│ Engineering  │   │ to accomplish?        │   │
│ Studio       │   └──────────────────────┘    │
│              │                               │
│ X-Coder      │       Agent Activity          │
│              │                               │
│ Projects     │       Tasks                   │
│              │       Artifacts                │
│ Governance   │       Changes                  │
│              │                               │
└──────────────┴───────────────────────────────┘
```

Left nav mirrors the web app's IA (Enterprise Knowledge, Global Intelligence, Engineering Studio, X-Coder, Projects, Governance) so a user's mental model doesn't fork between surfaces. The right pane is agent-first: a single "what do you want to accomplish" input driving Ask/Plan/Build, with Agent Activity, Tasks, Artifacts, and Changes as live, streaming panels — not a chat log.

### 5.2 Local repository intelligence

`Open Project` triggers an analysis pass building a **living engineering knowledge graph**:

```
Repository → Architecture → Services → APIs → Database →
Dependencies → Cloud infrastructure → Tests → CI/CD → Documentation
```

This reuses `@mobiusx/context-engine` (structural/Merkle indexing) and `@mobiusx/semantic-index` (semantic chunking/embedding) from the IDE work directly — this is the same underlying capability, applied at the "understand this repo" level rather than the "autocomplete this line" level.

### 5.3 Intelligent AI debugger

The differentiated capability: instead of "explain this code," support "why is the payment API taking 8 seconds," with the agent tracing across the actual call path —

```
Frontend → API Gateway → Payment Service → Redis → Database → Third-party Payment Gateway
```

— and answering with a located root cause ("third-party payment gateway timeout contributes 5.7s of total latency"), not a guess about which file might be involved. This is the most enterprise-differentiated feature in the plan and should be treated as a first-class roadmap item (§13, Phase 2), not a stretch goal.

---

## 6. Local + Cloud Agent Split

Not everything runs on the desktop.

**Local Agent** (`apps/desktop-agent`) handles what only the local machine can do: repository access, filesystem, git, terminal, local builds, tests, IDE integration, local configuration, Docker/Kubernetes CLI, cloud CLI invocation, MCP servers.

**Cloud Agent** (MobiusX Cloud) handles what benefits from scale and persistence: long-running tasks, Enterprise RAG, Global Intelligence, large document generation, multi-agent workflows, large-scale analysis, Enterprise Knowledge, cross-system analysis.

This is the same split that makes Cursor's local-agent-plus-cloud-agent model work, applied to MobiusX's own capabilities (EK/GI/ES) rather than just code generation.

---

## 7. Desktop as a UX Layer — Not a Latency Fix

A desktop shell genuinely improves *perceived* performance: the shell loads instantly, then streams from the local agent and/or cloud, with none of the browser-init / bundle-load / auth-redirect overhead a fresh web session pays every time.

```
MobiusX Desktop → Local agent → Cloud request → Streaming response
```

It does **not** fix backend latency. If the RAG/LLM pipeline takes 25 seconds today, it still takes ~25 seconds from a desktop app. Given the backend latency work already underway (BM25 retrieval fixes, Qwen2.5 7B vs 14B benchmarking, background job system for artifact generation — see `mobiusx-platform` notes), that work should continue in parallel with, not be replaced by, the desktop effort. Shipping a fast-feeling shell in front of a slow pipeline will surface the same complaint in a prettier wrapper.

---

## 8. Enterprise Control-Plane Workflow

For regulated-industry customers (BFSI, telecom, manufacturing, retail), the desktop app's value isn't just local access — it's local access *inside* a governed pipeline:

```
Enterprise developer → MobiusX Desktop → Local source code → Enterprise Knowledge →
Approved LLM → Enterprise policies → AI-generated change → Security scan →
Unit tests → Human approval → Git PR
```

This is the pitch for regulated customers specifically: an **Enterprise AI Software Engineering Control Plane**, not just an AI-assisted editor. Governance, policy enforcement, and human approval are steps in the pipeline, not bolted-on afterward.

---

## 9. Technology Strategy

**Desktop shell: Electron** (not Tauri).

The generic recommendation is "Tauri or Electron, don't build native apps per-OS separately" — both satisfy that. The deciding factor here is the existing MobiusX IDE investment: it's already a VS Code fork, which is inherently Electron. Since §4 embeds that editor surface inside the WDC shell rather than discarding it, building the outer shell in Electron too means:

- One runtime (Node/Chromium) across shell and embedded editor — no cross-runtime bridging between a Rust/webview Tauri host and an Electron-based editor subprocess.
- `@mobiusx/context-engine` and `@mobiusx/semantic-index` — already TypeScript/Node packages — drop in as npm workspace dependencies with no rewrite.
- IPC between shell and editor surface uses Electron's existing IPC primitives instead of a custom bridge.

The cost (larger binary, Chromium overhead) is accepted deliberately: it's outweighed by reusing tested code rather than rewriting a working context engine in a different runtime. This can be revisited post-Phase 1 if binary size or memory footprint becomes a real customer complaint — Tauri remains an option for a future lightweight variant, not a blocker now.

**Local agent:** a standalone MobiusX Agent Service (Node/TypeScript, matching the shell's runtime), packaged as `apps/desktop-agent`, run as a child process or background service the shell talks to over local IPC/HTTP. Handles filesystem, git, terminal, Docker/Kubernetes, cloud CLI, and MCP server orchestration.

**Communication (desktop ↔ cloud):**

```
Desktop ↕ WebSocket / SSE ↕ MobiusX API
```

WebSocket for bidirectional/interactive agent sessions, SSE for one-way streaming responses (matches the existing background-job-plus-polling pattern already used for artifact generation — this can likely upgrade to SSE/WebSocket rather than polling as part of this work).

**Cloud-side flow (unchanged, reused):**

```
MobiusX Orchestrator → Agent Runtime → EK / GI / ES → RAG → Model Router → LLM providers
```

---

## 10. MobiusX Cloud as Source of Truth

The most important architectural constraint: **MobiusX Cloud owns state, not the desktop app.**

```
                 MobiusX Cloud
                       │
       ┌───────────────┼───────────────┐
       │               │               │
      Web           Desktop           CLI
       │               │               │
       └───────────────┼───────────────┘
                       │
                 Same identity
                 Same policies
                 Same knowledge
                 Same billing
                 Same governance
```

A user can start a task on desktop and continue it on web (or vice versa) because nothing meaningful is desktop-local except ephemeral UI state and the local-agent's filesystem/git operations themselves. This also sets up a future CLI surface (`MobiusX CLI` — automate/deploy/operate) on the same foundation without re-deriving identity, policy, or knowledge access.

---

## 11. Repository Structure (this repo)

```
MobiusX_WDC/
├── apps/
│   ├── desktop/                 # Electron shell (workspace UI, §5.1)
│   │   ├── src/main/            # Electron main process
│   │   ├── src/renderer/        # Workspace shell UI (nav, AI Workspace pane)
│   │   └── src/editor-surface/  # Embeds the MobiusX IDE editor (from mobiusx-ide)
│   └── desktop-agent/           # Local Agent Service (§6)
│       ├── src/filesystem/
│       ├── src/git/
│       ├── src/terminal/
│       ├── src/containers/      # Docker/Kubernetes
│       └── src/mcp/
├── packages/
│   ├── context-engine/          # vendored from mobiusx-ide (Merkle indexer)
│   ├── semantic-index/          # vendored from mobiusx-ide (Tree-sitter + embeddings)
│   ├── protocol/                # shared WS/SSE message types, desktop↔cloud contracts
│   └── ui-kit/                  # shared design system components (web + desktop)
├── docs/
│   ├── ARCHITECTURE.md          # this document
│   └── phase-notes/             # per-phase writeups, mirroring mobiusx-ide's docs/ convention
├── package.json                 # workspace root
└── README.md
```

---

## 12. Phased Roadmap

| Phase | Scope |
|---|---|
| **1** | Desktop Agent + X-Coder workspace shell + local repository access + Git + terminal. Vendor in `context-engine`/`semantic-index` from `mobiusx-ide`. |
| **2** | Intelligent AI Debugger — static slice shipped: semantic-ish local code search (`@mobiusx/semantic-index`, hashing-lexical embeddings) correlated with per-file git history, exposed via `/debug/index`, `/debug/search`, `/debug/history` and a real Debug view in the shell. Cross-system tracing against live logs/traces/metrics (§5.3's actual differentiator) still needs real observability integration and MobiusX Cloud — that's Phase 3, not done. |
| **3** | Cloud Agents — local reference slice shipped: `apps/cloud-agent-gateway` implements the real task lifecycle (create/queue/stream/persist, cancel, resumable across a gateway restart) with a pluggable runner — a demo runner by default, or a real Anthropic call, streamed token-by-token, if the user supplies their own `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`. Tasks are cancellable mid-flight (`POST /tasks/:id/cancel`, backed by a real `AbortSignal` into the runner — aborts the in-flight Anthropic HTTP call, not just the UI) via a Stop button in both the AI Assistant panel and the Tasks view. Grounded in local context via Phase 2's semantic search. This is explicitly NOT MobiusX's real production Cloud (RAG/EK/GI) — see §12 and the gateway's own README for the swap-in path. Still open: real production-backend integration, multi-agent workflows, resumption on a real web client, cancellation surviving a gateway process restart. |
| **4** | Enterprise Knowledge + Global Intelligence integration into the desktop workspace (read/query surfaces, not full admin). |
| **5** | Enterprise-grade governance, security policy enforcement, and self-hosted/private deployment options. |

Backend latency work (RAG retrieval, model sizing, background job architecture) proceeds in parallel throughout, per §7 — it is a dependency of every phase's perceived quality, not a phase of its own.

---

## 13. Open Decisions

- **Editor embedding mechanics**: exact mechanism for hosting the VS Code fork inside the Electron shell (separate `BrowserWindow` vs. `webview` vs. iframe-equivalent) needs a spike — flagged for Phase 1 kickoff, not decided here.
- **Native build environment**: the VS Code fork's `npm install`/native compile step needs a real machine with Node 24, Xcode CLT, and network access to nodejs.org/electronjs.org — this was already identified as blocked in the sandboxed dev environment; Phase 1 planning should account for doing this step on local hardware.
- **Windows/Linux parity**: this document assumes macOS-first (matching current dev environment); Windows/Linux packaging (electron-builder targets, code signing) is not yet scoped.
