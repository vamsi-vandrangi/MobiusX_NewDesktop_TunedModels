import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectCompletionCriterion, ProjectCompletionReport } from "@mobiusx/protocol";
import { verifyProject } from "./verify.js";
import { getPreviewStatus } from "./previewOps.js";

/**
 * Project Completion Contract (roadmap Phase 6, source requirement §31): a
 * real, computed report of what's actually verifiable about the open
 * project right now -- never a claim that code was generated, always
 * evidence that it works. Deliberately narrow for v1: only criteria this
 * codebase can actually measure today (verify.ts's build/lint/typecheck/
 * test, live preview status, git-initialized, README present) get a real
 * pass/fail; everything the wider source requirement asks for that isn't
 * built yet (auth verification, e2e, a security scan, deployment) is
 * reported as "not_configured" with a note on which future roadmap phase
 * adds it -- never faked as "pass" just because nothing checks it yet. See
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
  criteria.push(
    {
      id: "auth_verified",
      label: "Authentication / authorization verified",
      status: "not_configured",
      detail: "Auth engineering (RBAC/OAuth2/JWT generation + verification) not yet implemented — see roadmap Phase 8+.",
    },
    {
      id: "e2e_tests_pass",
      label: "End-to-end (browser) tests passing",
      status: "not_configured",
      // Phase 12 shipped a real headless-browser validator
      // (browserOps.ts's runBrowserValidation, POST /browser-validate) --
      // this criterion stays honestly "not_configured" because that check
      // is on-demand and requires an already-running preview; there is no
      // cached last-run result this report could report a real pass/fail
      // from without re-running it itself (which would change GET
      // /completion from a fast status read into one that launches a
      // headless browser on every call). Run it from the AI Assistant /
      // Verify panel to get a real result.
      detail: "Browser/Application Validation (Phase 12) exists but is on-demand and needs a running preview — run it from the Verify panel; it isn't cached here.",
    },
    {
      id: "security_scan_clean",
      label: "Security scan clean",
      status: "not_configured",
      // Still genuinely true as of Phase 15: packages/secret-scan only
      // flag-scans content an AI is about to WRITE (fsOps.ts#applyEdits),
      // never the project's already-existing files. No roadmap phase
      // number is assigned to a real project-wide SAST / dependency scan
      // yet (Phase 14 turned out to be DevOps/Infrastructure Generation,
      // not a security scanner -- the old text here guessed wrong).
      detail: "Only outbound/inbound secret-shaped-text flagging exists today (packages/secret-scan), and only on content about to be written — a real project-wide SAST / dependency-vulnerability scan is not yet implemented or roadmapped.",
    },
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
