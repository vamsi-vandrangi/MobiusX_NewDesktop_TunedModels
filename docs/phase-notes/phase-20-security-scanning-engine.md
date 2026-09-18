# Phase 20 — Security Scanning Engine (§15 completion)

Phase 6's own phase-notes doc listed "SAST/dependency scanning... for the
Completion Contract" as explicitly not built. That stayed true through
Phase 15: `packages/secret-scan` existed, but only for content an AI was
about to write (`fsOps.ts#applyEdits`), never a project's existing files.

## Design

Two real, bounded checks — deliberately not a claim of comprehensive
SAST/vulnerability coverage, the same honesty bar `packages/secret-scan`
already sets for its narrower use:

1. **Pattern findings** — reuses `packages/secret-scan`'s own
   `scanForSecrets` (never a second copy of the same rules) across every
   real source file in the project, plus six additional high-signal
   patterns chosen for being well-known and low-false-positive rather
   than exhaustive: `eval`/`exec`, `subprocess(..., shell=True)`,
   `pickle.loads`, unsafe `yaml.load`, React `dangerouslySetInnerHTML`,
   and naive string-concatenated/interpolated SQL.
2. **Dependency audits** — `npm audit --json` for a detected JS/TS
   component with a lockfile; `pip-audit` for a detected Python backend
   IF that tool is actually installed. An unavailable tool or missing
   lockfile is reported as exactly that (`available: false`), never
   silently skipped or counted as clean.

`security_scan_clean` is cached via the audit log — the same pattern
used for `e2e_tests_pass` (Phase 21): a full scan (file walk +
network-bound audits) can take real time, so `GET /completion` stays a
fast status read. `POST /security-scan` runs the real scan and writes a
`"security-scan"` audit-log entry; `completion.ts` reads the most recent
one for the open project back.

## What shipped

- `packages/protocol/src/governance.ts` — `AuditCategory` gains
  `"security-scan"`.
- `packages/protocol/src/agent.ts` — `SecurityFinding`,
  `DependencyAuditResult`, `SecurityScanReport`, `SecurityScanResponse`.
- `apps/desktop-agent/src/securityScan.ts` (new) — `runSecurityScan`.
  Its local `SecurityFinding`/`DependencyAuditResult`/
  `SecurityScanReport` types were initially redeclared rather than
  imported from `@mobiusx/protocol` (a real duplication risk caught in
  review, not live testing); fixed to import the protocol types
  directly, confirmed with a clean rebuild and the full existing test
  suite (118/121, unchanged from before the cleanup).
- `apps/desktop-agent/src/completion.ts` — `security_scan_clean` reads
  the last cached `"security-scan"` audit entry for this exact project.
- `apps/desktop-agent/src/routes.ts` — `POST /security-scan`.
- `apps/desktop/src/renderer/{index.html,renderer.js}` — a "Security
  Scan" panel with a "Run security scan" button.

## Live evidence

Run live against the real running Electron app on GreenThumbGarden (a
real FastAPI + Next.js project, not a synthetic fixture):

- **Real pattern finding**: `high — eval()/exec() of dynamic content —
  backend/main.py`, a genuine hit in this project's actual source, not a
  contrived test case.
- **Real dependency audit**: `npm audit` against `frontend/`'s actual
  lockfile found "4 known vulnerabilities (1 high, 1 critical, 2
  total)" — a real result from a real registry-backed audit.
- **Honest unavailable, not false-clean**: `pip-audit` correctly
  reported "pip-audit is not installed in this environment — install it
  (`pip install pip-audit`) to enable Python dependency scanning" rather
  than silently omitting the backend or, worse, reporting it clean.
- **Completion Contract wiring confirmed**: after running the scan,
  `security_scan_clean` read back "Last Security Scan run
  (2026-09-18T03:11:08.207Z): Security scan: 1 pattern finding(s) across
  14 file(s), 4 dependency vulnerabilities..." and correctly reported
  `fail` (findings > 0), not a false pass.

## Scope not built

- Six deliberately narrow, high-signal pattern rules, not a general SAST
  ruleset — a real static-analysis engine (data-flow, taint tracking) is
  out of scope.
- `npm audit`/`pip-audit` are network-bound; a fully offline environment
  will see a dependency audit report `available: true, vulnerabilityCount:
  null` with a timeout explanation rather than a real result.
