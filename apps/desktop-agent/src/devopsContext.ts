import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { DevopsEvidence, DevopsVerificationStep, ExistingInfraFile } from "@mobiusx/protocol";
import { detectProjectContext } from "./projectContext.js";
import { detectVerificationSteps, detectPythonTestSteps } from "./verify.js";

/**
 * DevOps/Infrastructure Generation (roadmap Phase 14, source requirement
 * §21 -- "Docker/Compose/K8s/Terraform + CI/CD pipeline files, through the
 * same edits pipeline as everything else," builds on Phase 6).
 *
 * Same root-cause diagnosis every generation mode before it already made
 * (Database/Phase 8, Architecture/Phase 9, Testing/Phase 10): a model
 * asked to write a Dockerfile/CI pipeline with zero real facts about this
 * project's actual services, locations, and build/test commands has
 * nothing to go on but generic, often-wrong boilerplate. This module
 * gathers exactly the real facts DevOps mode's prompt needs, honestly:
 *
 * 1. projectContext -- reuses Phase 7's own detection (never re-guessed
 *    here) so this project's REAL detected frontend/backend components
 *    (with their real locations) and any infra ALREADY detected there
 *    ground what gets generated.
 * 2. existingInfraFiles -- full content of any Dockerfile(s),
 *    docker-compose.yml/.yaml, or GitHub Actions workflow this project
 *    already has, so the model proposes "modify" against something real
 *    instead of blindly "create"-ing over infra that already works (the
 *    same "CREATE on an existing file gets silently skipped by Apply"
 *    failure mode Database mode hit in Phase 8).
 * 3. verificationSteps -- this project's own real build/test/lint
 *    commands, reused VERBATIM from verify.ts's own detectors (never
 *    re-derived) -- the generated CI pipeline runs literally the same
 *    commands "Run Verification" already runs and already trusts, never
 *    an invented "npm test" a project doesn't actually define.
 */

// Candidate infra file paths checked at the project root -- the same
// three artifact kinds projectContext.ts's detectInfra already looks for
// (Dockerfile / docker-compose / GitHub Actions), but here the FULL
// content is read (detectInfra only records that they exist).
const ROOT_INFRA_CANDIDATES = [
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/ci.yaml",
];

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function gatherDevopsEvidence(projectRoot: string): Promise<DevopsEvidence> {
  const projectContext = await detectProjectContext(projectRoot);

  // A generated project frequently has no root Dockerfile at all -- its
  // frontend/backend each live in their own subdirectory (see
  // GreenThumbGarden) -- so also check for a Dockerfile directly inside
  // every detected frontend/backend component's own location, not just
  // the project root.
  const componentLocations = [
    ...new Set(
      projectContext.components.filter((c) => c.category === "frontend" || c.category === "backend").map((c) => c.location),
    ),
  ];
  const candidateRelPaths = new Set<string>(ROOT_INFRA_CANDIDATES);
  for (const loc of componentLocations) {
    if (loc === ".") continue;
    candidateRelPaths.add(`${loc}/Dockerfile`);
  }

  const existingInfraFiles: ExistingInfraFile[] = [];
  for (const relPath of candidateRelPaths) {
    const content = await readIfExists(join(projectRoot, relPath));
    if (content !== null) existingInfraFiles.push({ relPath, content });
  }

  // Reuses verify.ts's OWN detectors verbatim -- these are exactly the
  // steps "Run Verification" runs today, so the CI pipeline this mode
  // proposes can never drift from what this app already actually runs.
  const rawSteps = [...(await detectVerificationSteps(projectRoot)), ...(await detectPythonTestSteps(projectRoot))];
  const verificationSteps: DevopsVerificationStep[] = rawSteps.map((s) => ({
    label: s.label,
    command: s.command,
    cwd: relative(projectRoot, s.cwd) || ".",
  }));

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    projectContext,
    existingInfraFiles,
    verificationSteps,
  };
}
