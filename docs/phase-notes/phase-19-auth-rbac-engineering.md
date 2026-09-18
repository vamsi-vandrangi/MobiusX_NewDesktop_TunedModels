# Phase 19 — Auth/RBAC Engineering mode (§12)

Roadmap §12 (Auth/RBAC engineering) was never itemized as its own phase —
the roadmap's own text says it was "treated as a capability added
incrementally to Phase 8/11/14." That incremental addition never actually
happened: `completion.ts`'s `auth_verified` criterion stayed permanently
`not_configured` through every phase from 6 to 18, and there was no
Auth-specific generation mode, evidence gatherer, or reviewer persona.

## Design

Same generation-mode pattern established by Database (8) / Architecture
(9) / Testing (10) / DevOps (14): a dedicated `AgentMode` (`"auth"`), a
dedicated evidence-gathering module (`authContext.ts`), a dedicated
prompt branch in `promptShared.ts`, and a dedicated `AgentPersona`
("Auth Agent") for the second-pass reviewer — never folded into Build
mode's generic prompt, because auth code has security properties
(constant-time comparison, real signature verification, authorization
vs. authentication) generic review checklists don't specifically check.

`authContext.ts` reuses Phase 7's own "auth" category detection
(`ProjectContextCategory` already included `"auth"` — NextAuth/Passport/
jsonwebtoken, python-jose/PyJWT/Authlib/Flask-Login — detected since
Phase 7, just never consulted by anything until now) rather than
re-guessing what auth libraries exist. It also scans for auth-shaped
files by filename/path convention so the model extends what's there
instead of introducing a second, competing implementation.

**`auth_verified`'s honesty design** — the hardest part of this phase.
"Verified" cannot mean "we ran a security audit" (this codebase doesn't
do that for anything). It means: an auth library is actually declared
AND a real token-verification call was found in this project's own code
(`jwt.decode`, `jwt.verify`, `getServerSession`, `verify_password`, etc.
— `hasWiredAuthImplementation` in `authContext.ts`). No library detected
→ `not_configured` (nothing to check). Library declared but no real
verification call → `fail`. Both present → `pass`. This is a presence/
wiring heuristic, not a security audit, and every place it's surfaced
says so explicitly.

## What shipped

- `packages/protocol/src/cloud.ts` — `AgentMode`/`AgentPersona` gain
  `"auth"`; `ProjectContext` gains `authEvidence?: AuthEvidence`.
- `packages/protocol/src/agent.ts` — `ExistingAuthFileSample`,
  `AuthEvidence`, `AuthEvidenceResponse`.
- `apps/desktop-agent/src/authContext.ts` (new) — `gatherAuthEvidence`
  and `hasWiredAuthImplementation`.
- `apps/desktop-agent/src/completion.ts` — `auth_verified` computed for
  real instead of a permanent `not_configured`.
- `apps/desktop-agent/src/routes.ts` — `GET /auth-evidence`.
- `apps/cloud-agent-gateway/src/runners/promptShared.ts` — full "auth"
  prompt branch grounded in the evidence bundle; extends an existing
  implementation when one exists; explicit security rules the persona
  reviewer checks (real password hashing, real signature+expiry
  verification, authorization distinct from authentication, no
  hardcoded secrets).
- `apps/cloud-agent-gateway/src/runners/personas.ts` — "Auth Agent"
  persona with its own focus checklist; `classifyPersona` maps "auth".
- `apps/cloud-agent-gateway/src/runners/{openAiCompatibleRunner,
  anthropicRunner,ollamaRunner}.ts` — "auth" added to the second-pass
  review gate.
- `apps/cloud-agent-gateway/src/runners/demoRunner.ts` — a scripted demo
  auth edit for when no real model is configured, deliberately written
  so its placeholder does NOT satisfy `hasWiredAuthImplementation`.
- `apps/cloud-agent-gateway/src/routes.ts` — "auth" accepted by
  `POST /tasks`'s mode validation.
- `apps/desktop/src/renderer/{index.html,renderer.js}` — an "Auth" mode
  button, an "Auth Evidence" panel, "Auth" in Model Routing and the
  persona label map.

## Two pre-existing bugs found and fixed while auditing this pattern

Adding a new `AgentMode` means grep-auditing every place a mode name is
independently enumerated (Phase 14's own phase-notes doc names this
exact risk). That audit found two real, pre-existing bugs, neither
introduced this phase:

1. `apps/desktop-agent/src/routes.ts`'s `KNOWN_MODES` (the
   `PATCH /settings` `modelRouting` validator) was missing `"devops"` —
   every `modelRouting.devops` PATCH has failed with `"unknown mode
   devops"` since Phase 14 shipped. Fixed alongside adding `"auth"`.
2. `demoRunner.ts`'s `demoDevopsEdits` was fully written but never
   called — a demo-runner DevOps task produced zero edits since Phase 14
   shipped. Fixed: wired it in, added `"devops"`/`"auth"` branches to
   `stepsFor`/`renderOutput`.

## Live evidence

Verified against the real running Electron app on GreenThumbGarden after
a full app restart (confirmed via a new process id, 93193 vs. the prior
93131).

1. **Wiring confirmed live**: the AI Assistant mode-button row now shows
   Ask/Plan/Build/Spec/Database/Architecture/Testing/DevOps/**Auth**.
   Auth Evidence panel's baseline read: "No auth dependency detected" —
   FastAPI backend correctly identified, no auth-shaped files found
   (GreenThumbGarden genuinely has none yet).
2. **A real task, not the demo runner**: submitted "Add JWT-based
   authentication to the FastAPI backend, protecting the order-placement
   endpoints" in Auth mode. A real model served it (OpenRouter,
   `inclusionai/ling-3.0-flash-vl:free`). The response was correctly
   grounded in the evidence bundle: python-jose for JWT (signing with a
   secret read from `JWT_SECRET_KEY`, verifying signature AND expiry),
   passlib[bcrypt] for password hashing, and real authorization beyond
   authentication (`place_order` requires role `user`/`admin`;
   `get_order` additionally verifies the order's `user_id` against the
   JWT's `sub` claim) — proposing 7 files: `backend/config.py`,
   `backend/requirements.txt`, `backend/auth/{models,handlers,
   dependencies,routes}.py`, `.env.example`.
3. **The reviewer gate fails closed, not open**: the Auth Agent
   persona's second-pass review response could not be parsed as a
   verdict, and the UI correctly surfaced "⚠ Auth Agent: Concerns —
   Reviewer response could not be parsed as a verdict — treating as
   unreviewed rather than silently approving" rather than defaulting to
   an approval.
4. **Apply**: 6/7 files applied; `backend/requirements.txt` was
   correctly skipped — "already exists — refusing to overwrite a
   create," the pre-existing Phase 8 CREATE-safety behavior working
   exactly as designed on a genuine pre-existing file.
5. **A real, live-discovered edge case**: checking the Completion
   Contract immediately after Apply showed `auth_verified` still
   `not_configured`, even though `backend/auth/handlers.py` now
   contained a real `jwt.decode(token, JWT_SECRET_KEY,
   algorithms=[JWT_ALGORITHM])` call. Root-caused by reading the actual
   files on disk: because `requirements.txt` was skipped (already
   existed), `python-jose`/`passlib` were never actually declared as
   dependencies — so Phase 7's own dependency-based auth detection
   correctly found nothing new. This is a genuine interaction between
   two pre-existing, independently-correct behaviors (CREATE-skip
   safety, and dependency-based detection), not a bug introduced by this
   phase, and not something in scope to fix here (it's general
   apply-edits infrastructure from Phase 6/8, not §12-specific). To
   isolate and verify `auth_verified`'s own pass logic in isolation, the
   two missing dependency lines the CREATE-skip had omitted were added
   manually. Re-checking completion then showed `auth_verified: pass` —
   "An auth dependency is declared and a real token-verification call
   was found in this project's own code (heuristic check — presence of
   working auth code, not a security audit)" — and the Completion
   Contract's overall pass rate rose from 60% to 67%. Re-checking the
   Auth Evidence panel confirmed: "1 auth dependency detected — JWT
   (backend/ — backend/requirements.txt: `python-jose[cryptography]`)".

## Scope not built

- `auth_verified` is a wiring/presence heuristic, explicitly not a
  security audit of the auth implementation's correctness — stated
  in its own detail text every time it's shown.
- The requirements.txt CREATE-skip interaction documented above is a
  real, user-visible rough edge: a mode whose proposal includes a new
  manifest file for a project that already has one will have that
  manifest silently dropped, potentially leaving newly-written code
  that imports a package never declared. This is general apply-edits
  behavior (Phase 6/8), not specific to Auth mode, and is left as a
  known limitation rather than patched here — worth a dedicated fix
  (e.g., a MODIFY-style "append missing lines" mode for manifest files)
  in a future phase.
