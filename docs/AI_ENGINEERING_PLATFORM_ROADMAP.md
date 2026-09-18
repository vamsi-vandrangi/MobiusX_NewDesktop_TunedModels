# MobiusX Desktop — AI Software Engineering Platform Roadmap

Status: Draft v0.1
Owner: Vamsi | CadenceX Technologies Pvt. Ltd.
Scope: Translates the "MobiusX Desktop: AI Software Engineering Platform" requirement (39 sections, idea→deployment lifecycle, multi-agent orchestration, autonomous build/test/fix) into an ordered, dependency-aware phase plan, grounded in what this repo (`MobiusX_WDC`) has actually built so far (`docs/ARCHITECTURE.md` §12, Phases 1–5).

This document does not restate the source requirement's 39 sections in full — it maps each one to either **already built**, **this phase**, or **a later phase**, and says why that ordering was chosen. Section numbers below (`§N`) refer to the source requirement unless marked `PRD §N`, which refers to this codebase's own existing internal PRD numbering (visible in code comments, e.g. `verify.ts`'s `PRD §22`, `cloud.ts`'s `PRD §11/§46`).

---

## 1. Where this fits against the existing roadmap

`docs/ARCHITECTURE.md` §12 already ships Phases 1–5:

| Existing phase | What it built | Maps to source §s |
|---|---|---|
| 1 | Desktop Agent, workspace shell, local repo/git/terminal access | §17 (partial — terminal execution engine) |
| 2 | Debug view (static slice): semantic search + per-file git history | §20 (partial — Intelligent Debugger, no cross-stack tracing yet) |
| 3 | Cloud Agents: task lifecycle, multi-model runners, Ask/Plan/Build/Spec modes, `ProposedEdit[]` apply pipeline, a real second-pass Reviewer agent (`PRD §11/§46`) | §6 (Spec mode exists, lacks acceptance-criteria structure), §26/§27 (one real multi-agent primitive + model routing groundwork), §9–§11 (Build mode already generates backend/API/frontend files, just not lifecycle-complete) |
| 4 | *Unbuilt* — Enterprise Knowledge + Global Intelligence integration | §29, §30 |
| 5 | Governance: `policy.ts` (terminal command guard), `verify.ts` (build/test/lint/typecheck detection + run, `PRD §22`), `packages/secret-scan`, `packages/audit-log` | §15 (security testing — partial: secret scan only), §35 (secure tool execution) |

So roughly a third of the new requirement already has a real foothold. The gap this roadmap addresses is: nothing today closes the loop from "verification failed" to "diagnosed, fixed, and re-verified automatically" (§16), nothing computes an honest completion percentage (§31), there's no database/architecture/DevOps generation engine (§7, §8, §21), no real multi-agent orchestrator (§26), and no browser-driven validation (§18) feeding an error-intelligence layer (§19, §20).

---

## 2. Phase sequencing and why

Ordering follows two rules: **(a)** a phase should build on machinery that already exists rather than starting parallel infrastructure, and **(b)** a phase should be independently shippable and verifiable — per the source document's own §3 principle, nothing here counts as "done" until it's been run against a real project and its output inspected, the same discipline this session just applied to the gardening-site test.

| Phase | Scope | Source §s | Builds on |
|---|---|---|---|
| **6** *(this build)* | **Autonomous Build/Test/Fix Loop + Project Completion Contract.** A "Diagnose & Fix" step that takes a real `verify.ts` failure, gets a model-proposed fix through the existing edits pipeline, and — once applied — automatically re-verifies. A `manual` (default, human approves each fix cycle) vs `auto` (capped-iteration, auto-apply) mode, mirroring the existing `terminalApprovalMode` off/guarded pattern in `policy.ts` rather than inventing a new autonomy model. A real, computed `PROJECT_COMPLETION.json` reporting only what's actually measurable today (build/lint/typecheck/test from verify, preview running state, git-initialized, README present) — fields for capabilities that don't exist yet (auth, e2e, security scan, deployment) are marked `not_configured`, never faked `PASS`. | §3, §16, §31 | `verify.ts`, the Build-mode edits pipeline, `agent-settings`, `audit-log` |
| **7** | **Project Understanding + Specification Engine.** `PROJECT_CONTEXT.md` / `project-context.json` — automatic tech-stack detection (frontend/backend/db/orm/auth/test framework/infra) written once per project and kept current. Extends Spec mode's existing markdown output with structured, numbered, testable acceptance criteria (`REQ-001`-style) instead of free-form prose. | §5, §6 | Phase 1–2's semantic-index/context-engine, Phase 3's Spec mode |
| **8** | **Database Engineering.** Schema/migration/seed/ORM-model generation as a distinct, reviewable artifact class (not just files inside a generic Build-mode edit set) — Postgres/MySQL first, pluggable. Domain-model → ER → schema → ORM → API consistency check. | §8 | Phase 6's edits+verify loop (a migration is just another file the fix loop can validate ran cleanly) |
| **9** | **Architecture Generation.** HLD/LLD docs + Mermaid diagrams (system context, container, component, sequence, deployment, ER) written to `docs/architecture/`. | §7 | Phase 7's project understanding (can't diagram what it hasn't detected) |
| **10** | **Testing Engine (generation, not just execution).** `verify.ts` today only *runs* a project's existing `test` script. This phase makes test-file *generation* (unit/integration/contract) part of the standard Build-mode output for new backend/frontend code, and adds e2e scaffolding once Phase 12 exists. | §15 | Phase 6 (a generated test is validated the same way a fix is) |
| **11** | **Multi-Agent Orchestration.** Formalizes the existing single Reviewer-agent second pass (`PRD §11/§46`) into named agent personas (Architecture/Database/Backend/Frontend/API/Testing/DevOps/Documentation/Debugger) with distinct system prompts and, per §27, per-task-type model routing — real role separation, not necessarily separate concurrent processes on day one. | §26, §27 | Phase 3's runner registry + Reviewer-agent precedent |
| **12** | **Browser / Application Validation.** Drives the already-running preview (via `previewOps.ts`) with a real browser (Playwright — already configured in this environment) to click through flows, capture screenshots, read console/network errors, and feed failures into Phase 6's fix loop as a new evidence source alongside `verify.ts`. | §18 | Phase 6 (fix loop), existing `previewOps.ts` |
| **13** | **Error Intelligence + Debugger v2.** Extends the existing static Debug view (Phase 2) into full-stack tracing (browser → frontend → API → backend → DB) with root-cause classification, now that Phase 12 produces the trace evidence to classify. | §19, §20 | Phase 2, Phase 12 |
| **14** | **DevOps / Infrastructure Generation.** Docker/Compose/K8s/Terraform + CI/CD pipeline files, through the same edits pipeline as everything else. | §21 | Phase 6 |
| **15** | **Checkpoints / Rollback.** A real restore-point mechanism. Called out as its own phase rather than a Phase 6 prerequisite because Phase 6 ships safely without it (manual-mode approval + `audit-log` is the interim safety net) — but every autonomous phase after this one benefits from it, so it's prioritized early rather than deferred indefinitely. | §23 | `audit-log` (already tracks what changed; this phase adds "and can undo it") |
| **16** | **Project Memory/Steering + Hooks.** Persistent `.mobiusx/` engineering-context files (architecture/security/api-standards/testing conventions) the agent consults automatically, plus event-driven hooks (after-API-change → update OpenAPI, before-commit → quality gate). | §24, §25 | Phase 7 |
| **17** | **Enterprise Knowledge + Global Intelligence integration.** Same scope as the existing (unbuilt) Phase 4 — this is where §29/§30 actually get wired into Engineering Studio's generation prompts. | §29, §30 | — (currently the biggest single gap; genuinely blocked on MobiusX Cloud's EK/GI surfaces existing to integrate against) |
| **18** | **Dashboard / Developer Experience polish.** The single "what do you want to build" entry point and a live per-project health dashboard (build/test/security status, artifact list, agent activity feed). Deliberately last — it's a presentation layer over Phases 6–17's real signals, and building it earlier would mean displaying numbers nothing yet computes. | §32, §33, §34 | Everything above |
| **19** | **Auth/RBAC Engineering.** A dedicated generation mode (evidence gatherer, prompt branch, "Auth Agent" reviewer persona) for adding or extending authentication/authorization, following the same real-evidence-grounded pattern as Database/Architecture/Testing/DevOps. Wires the Completion Contract's `auth_verified` criterion to a real presence/wiring heuristic instead of a permanent placeholder. | §12 | Phase 6–8/11/14's generation-mode pattern |
| **20** | **Security Scanning Engine.** A bounded, honestly-scoped SAST-lite pattern scan (reusing `packages/secret-scan`) plus best-effort npm/pip dependency audits, closing the Completion Contract's `security_scan_clean` gap named in Phase 6's own notes. | §15 | Phase 6, `packages/secret-scan` |
| **21** | **`e2e_tests_pass` completion wiring.** Reads Phase 12's already-written `browser-validation` audit-log entries back into the Completion Contract instead of leaving the criterion permanently uncached. | §18 | Phase 12, Phase 6 |
| **22** | **Auto Fix-Loop mode.** Closes Phase 6's own documented gap — a client-orchestrated "auto" mode that chains Apply → Verify → Diagnose without a click each cycle, additive over the existing manual flow. | §16 | Phase 6 |
| **23** | **Config/env-file generation.** Scans a project's own source for real `process.env`/`os.environ`/`os.getenv` reads and generates/extends `.env.example` with exactly the missing keys, never overwriting an existing line. | §13 | Phase 7 |

§12 (auth/RBAC engineering) and §13 (config/env-file generation) were originally deferred as "incremental capabilities" rather than standalone phases; that incremental addition never actually happened, so they were later itemized as Phase 19 and Phase 23 respectively. §14 remains genuinely covered by Phase 6's env handling (passing the current process's env to a spawned preview server) and is not itemized separately. §28 (broader MCP tool support) shipped incrementally as originally planned, wired into the task lifecycle (see `apps/desktop-agent/src/mcpClient.ts` and the Settings → MCP Tools panel).

---

## 3. What "complete" means for this roadmap itself

Per the source requirement's own §3 and this session's established practice: a phase in this document is not marked done because code was written for it. It's done when it's been exercised against a real generated project — the same live-GUI, real-bug-finding discipline used to validate the gardening-site preview/auto-install work — and the phase-notes writeup (`docs/phase-notes/`) says so with evidence, not intention.

---

## 4. Immediate next step

Phase 6 (Autonomous Build/Test/Fix Loop + Project Completion Contract) is being implemented now, directly extending `verify.ts`, the Build-mode edits pipeline, and `agent-settings`. See `docs/phase-notes/phase-6-autonomous-fix-loop.md` once it lands for the concrete result.
