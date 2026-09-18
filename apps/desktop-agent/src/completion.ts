import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectCompletionCriterion, ProjectCompletionReport } from "@mobiusx/protocol";
import { verifyProject } from "./verify.js";
import { getPreviewStatus } from "./previewOps.js";
import { detectProjectContext } from "./projectContext.js";
import { hasWiredAuthImplementation } from "./authContext.js";
import { readAuditLog } from "@mobiusx/audit-log";

/**
 * Project Completion Contract (roadmap Phase 6, source requirement §31): a
 * real, computed report of what's actually verifiable about the open
 * project right now -- never a claim that code was generated, always
 * evidence that it works. Only criteria this codebase can actually
 * measure get a real pass/fail; anything that genuinely can't be checked
 * yet is reported as "not_configured", never faked as "pass". As of
 * Phases 19-21, that now includes auth_verified (real heuristic
 * detection, see authContext.ts's hasWiredAuthImplementation) and
 * e2e_tests_pass / security_scan_clean (both real, but CACHED from their
 * own on-demand audit-log entries rather than run inline here -- see the
 * comments at each criterion below for why). deployment_verified remains
 * honestly not_configured: DevOps mode (Phase 14) can propose
 * Docker/Compose/CI files, but actually deploying and verifying a live
 * deployment needs a real target environment this codebase has no access
 * to, and is not itemized as a future roadmap phase for that reason. See
 * docs/AI_ENGINEERING_PLATFORM_ROADMAP.md's Phase 6 entry for the honesty
 * principle this follows.
 *
 * Also writes the report to `<project>/.mobiusx/PROJECT_COMPLETION.json`
 * on every call, best-effort, so it's a real inspectable artifact (per
 * source §31's naming) and not only an API response -- a write failure
 * (read-only project, permissions) never blocks returning the report to
 * the caller, since the computed data is what matters most.
 */
export async function computeCompletionReport(projectRoot: string, isGitRepo: boolean): Promise<ProjectCompletionReport> {
  const criteria: ProjectCompletionCriterion[] = [];

  const verifyResult = await verifyProject(projectRoot);
  if (verifyResult.overall === "no-verification-available") {
    criteria.push({
      id: "verification",
      label: "Build / lint / typecheck / test",
      status: "not_configured",
      detail: "No build/test/lint/typecheck script found in this project's package.json.",
    });
  } else {
    for (const step of verifyResult.steps) {
      criteria.push({
        id: `verify:${step.label}`,
        label: step.label,
        status: step.status === "passed" ? "pass" : "fail",
        detail:
          step.status === "passed"
            ? undefined
            : `${step.status === "timed_out" ? "Timed out" : `Exit code ${step.exitCode}`} — see Run verification for full output.`,
      });
    }
  }

  const preview = getPreviewStatus();
  for (const kind of ["frontend", "backend"] as const) {
    const state = preview[kind];
    const label = `${kind === "frontend" ? "Frontend" : "Backend"} preview running`;
    if (!state) {
      criteria.push({ id: `preview:${kind}`, label, status: "not_configured", detail: "Not started this session — click Start Preview." });
    } else {
      criteria.push({
        id: `preview:${kind}`,
        label,
        status: state.status === "running" ? "pass" : "fail",
        detail: state.status === "running" ? undefined : `Status: ${state.status}.`,
      });
    }
  }

  criteria.push({
    id: "git_initialized",
    label: "Git repository initialized",
    status: isGitRepo ? "pass" : "fail",
  });

  const readmeExists = await fileExists(join(projectRoot, "README.md"));
  criteria.push({
    id: "readme_present",
    label: "README present",
    status: readmeExists ? "pass" : "fail",
  });

  // Capabilities the wider source requirement (§12, §15, §21, §31) asks
  // for that this codebase genuinely does not measure yet -- reported
  // honestly as not_configured rather than silently omitted (so the
  // contract's shape already matches what later roadmap phases will fill
  // in) or, worse, faked as passing.
  // auth_verified (roadmap Phase 19, source §12): reuses Phase 7's own
  // "auth" category detection to decide whether there is anything to
  // check at all, then authContext.ts's hasWiredAuthImplementation (a
  // filename-convention match PLUS a real token-verification-call match,
  // e.g. jwt.decode/getServerSession/verify_password -- not just a
  // declared dependency) to decide pass vs. fail. Deliberately narrow,
  // same "only what's actually measurable" bar as verify.ts's own
  // criteria: this is a heuristic presence/wiring check, not a security
  // audit -- it can say "real auth code exists and calls a verification
  // function" but never "this auth implementation is secure."
  const projectContextForAuth = await detectProjectContext(projectRoot);
  const authDetected = projectContextForAuth.components.some((c) => c.category === "auth");
  if (!authDetected) {
    criteria.push({
      id: "auth_verified",
      label: "Authentication / authorization verified",
      status: "not_configured",
      detail: "No auth library or framework detected in this project (Phase 7's own tech-stack detection) — nothing to verify yet. Run Auth mode to add JWT/RBAC authentication.",
    });
  } else {
    const wired = await hasWiredAuthImplementation(projectRoot);
    criteria.push({
      id: "auth_verified",
      label: "Authentication / authorization verified",
      status: wired ? "pass" : "fail",
      detail: wired
        ? "An auth dependency is declared and a real token-verification call was found in this project's own code (heuristic check — presence of working auth code, not a security audit)."
        : "An auth dependency is declared, but no real token-verification call (e.g. jwt.decode, getServerSession, verify_password) was found in this project's files — it looks installed but not actually wired up. Run Auth mode to implement it.",
    });
  }

  // e2e_tests_pass (roadmap Phase 21): Phase 12's browser validation is
  // still on-demand (this criterion never triggers a headless-browser run
  // itself -- GET /completion stays a fast status read) but its OWN
  // "browser-validation" audit-log entries (written by POST
  // /browser-validate every time it actually runs, see routes.ts) are now
  // read back here as a real cache. Reuses the existing audit-log
  // infrastructure (Phase 5) rather than inventing a second persistence
  // mechanism -- the same "reuse an existing signal" discipline the Home
  // dashboard's own activity feed (Phase 18) already applies to this same
  // log. not_configured only means "never run in this audit log's
  // retained window," never "not available."
  const auditEntries = await readAuditLog(500);
  const lastBrowserValidation = auditEntries
    .filter((e) => e.category === "browser-validation" && (e.detail as { projectPath?: string } | undefined)?.projectPath === projectRoot)
    .at(-1);
  if (!lastBrowserValidation) {
    criteria.push({
      id: "e2e_tests_pass",
      label: "End-to-end (browser) tests passing",
      status: "not_configured",
      detail: "Browser/Application Validation (Phase 12) hasn't been run yet for this project this session — run it from the Verify panel to get a real, cached result here.",
    });
  } else {
    const overall = (lastBrowserValidation.detail as { overall?: string } | undefined)?.overall;
    criteria.push({
      id: "e2e_tests_pass",
      label: "End-to-end (browser) tests passing",
      status: overall === "passed" ? "pass" : "fail",
      detail: `Last Browser/Application Validation run (${lastBrowserValidation.timestamp}): ${lastBrowserValidation.summary} — run it again from the Verify panel for a fresh result; this reflects the last cached run, not necessarily the current state of the code.`,
    });
  }

  // security_scan_clean (roadmap Phase 20): same caching-via-audit-log
  // pattern as e2e_tests_pass above -- Security Scanning (securityScan.ts)
  // is on-demand (pattern scan across every source file + npm/pip-audit,
  // up to tens of seconds) so GET /completion stays a fast status read
  // rather than triggering a full scan every call. not_configured only
  // means "never run in this audit log's retained window."
  const lastSecurityScan = auditEntries.filter((e) => e.category === "security-scan" && (e.detail as { projectPath?: string } | undefined)?.projectPath === projectRoot).at(-1);
  if (!lastSecurityScan) {
    criteria.push({
      id: "security_scan_clean",
      label: "Security scan clean",
      status: "not_configured",
      detail: "Security Scanning (pattern scan + dependency audit, Phase 20) hasn't been run yet for this project this session — run it from the Verify panel to get a real, cached result here.",
    });
  } else {
    const findingCount = (lastSecurityScan.detail as { findingCount?: number } | undefined)?.findingCount ?? 0;
    criteria.push({
      id: "security_scan_clean",
      label: "Security scan clean",
      status: findingCount === 0 ? "pass" : "fail",
      detail: `Last Security Scan run (${lastSecurityScan.timestamp}): ${lastSecurityScan.summary} — a bounded pattern scan plus best-effort npm/pip dependency audit, not a comprehensive SAST guarantee; run it again from the Verify panel for a fresh result.`,
    });
  }

  criteria.push(
    {
      id: "deployment_verified",
      label: "Deployment verified",
      status: "not_configured",
      // Phase 14 shipped real DevOps/infrastructure GENERATION
      // (Dockerfile/compose/CI proposals, grounded in this project's own
      // real components and verification steps) -- but generating infra
      // files is not the same as verifying an actual deployment, which
      // this codebase still doesn't do.
      detail: "DevOps/infrastructure generation (Phase 14) can propose Docker/Compose/CI files, but actually deploying and verifying a live deployment is not yet implemented.",
    },
  );

  const measured = criteria.filter((c) => c.status !== "not_configured");
  const passedCount = measured.filter((c) => c.status === "pass").length;
  const completionPercent = measured.length > 0 ? Math.round((passedCount / measured.length) * 100) : 0;
  const overall: ProjectCompletionReport["overall"] =
    measured.length === 0 ? "unknown" : passedCount === measured.length ? "verified" : passedCount === 0 ? "not_started" : "in_progress";

  const report: ProjectCompletionReport = {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    overall,
    completionPercent,
    criteria,
  };

  try {
    const dir = join(projectRoot, ".mobiusx");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROJECT_COMPLETION.json"), JSON.stringify(report, null, 2), "utf8");
  } catch {
    // best-effort artifact write -- the API response returned to the caller is still authoritative
  }

  return report;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
