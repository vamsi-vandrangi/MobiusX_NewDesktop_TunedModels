import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DashboardArtifact, DashboardResponse } from "@mobiusx/protocol";
import { computeCompletionReport } from "./completion.js";
import { listSteeringFiles } from "./steering.js";
import { pathExists } from "./fsOps.js";

/**
 * Dashboard (roadmap Phase 18, source §32/§33/§34): "The single 'what do
 * you want to build' entry point and a live per-project health dashboard
 * (build/test/security status, artifact list, agent activity feed)."
 * Deliberately last in the roadmap -- "a presentation layer over Phases
 * 6-17's real signals" -- so this module does no new detection work of
 * its own for build/test/security: it calls completion.ts's own
 * computeCompletionReport verbatim, the same function GET /completion
 * already exposes, so the dashboard and the dedicated completion panel
 * can never silently drift apart.
 *
 * The "artifact list" half is new: a fixed, honest list of well-known
 * generated-file paths this codebase's own earlier phases can produce
 * (architecture docs, project context, the completion report itself,
 * hooks/MCP config, DevOps infra files, non-empty steering files, Spec
 * mode's own .mobiusx/specs/*.md files) -- checked for real existence,
 * never presented as a checklist of what *could* exist.
 */

const CANDIDATE_ARTIFACTS: { relPath: string; label: string; category: DashboardArtifact["category"] }[] = [
  { relPath: "docs/architecture/HLD.md", label: "High-Level Design", category: "architecture" },
  { relPath: "docs/architecture/LLD.md", label: "Low-Level Design", category: "architecture" },
  { relPath: ".mobiusx/PROJECT_CONTEXT.md", label: "Project Context", category: "context" },
  { relPath: ".mobiusx/PROJECT_COMPLETION.json", label: "Completion Report", category: "completion" },
  { relPath: ".mobiusx/hooks.json", label: "Hooks config", category: "config" },
  { relPath: ".mobiusx/mcp.json", label: "MCP config", category: "config" },
  { relPath: "Dockerfile", label: "Dockerfile", category: "devops" },
  { relPath: "docker-compose.yml", label: "Docker Compose", category: "devops" },
  { relPath: "docker-compose.yaml", label: "Docker Compose", category: "devops" },
  { relPath: ".github/workflows/ci.yml", label: "CI Pipeline", category: "devops" },
  { relPath: ".github/workflows/ci.yaml", label: "CI Pipeline", category: "devops" },
];

export async function gatherDashboard(projectRoot: string, isGitRepo: boolean): Promise<DashboardResponse> {
  const completion = await computeCompletionReport(projectRoot, isGitRepo);

  const artifacts: DashboardArtifact[] = [];
  for (const candidate of CANDIDATE_ARTIFACTS) {
    const abs = join(projectRoot, candidate.relPath);
    if (!(await pathExists(abs))) continue;
    try {
      const s = await stat(abs);
      artifacts.push({
        path: candidate.relPath,
        label: candidate.label,
        category: candidate.category,
        sizeBytes: s.size,
        modifiedAt: s.mtime.toISOString(),
      });
    } catch {
      // Existed a moment ago (pathExists) but vanished/became unreadable
      // before stat() -- skip rather than fail the whole dashboard over one file.
      continue;
    }
  }

  // Reuses the Steering panel's own file listing (steering.ts) rather
  // than a second directory-walk, and the same "non-empty only" filter
  // the Steering UI itself already applies to what counts as real content.
  const steeringFiles = await listSteeringFiles(projectRoot);
  for (const f of steeringFiles) {
    if (!f.content.trim()) continue;
    artifacts.push({
      path: `.mobiusx/steering/${f.name}.md`,
      label: `Steering: ${f.name}`,
      category: "steering",
      modifiedAt: f.updatedAt,
    });
  }

  // Spec mode (roadmap Phase 7) writes .mobiusx/specs/<slug>.md +
  // <slug>.json via its own prompt convention (see cloud-agent-gateway's
  // promptShared.ts) -- no dedicated desktop-agent module owns this
  // directory the way steering.ts owns steering files, so it's scanned
  // directly here. A missing directory (no spec generated yet) is not an
  // error, same as every other honestly-optional signal in this function.
  try {
    const specsDir = join(projectRoot, ".mobiusx", "specs");
    const specEntries = await readdir(specsDir);
    for (const name of specEntries) {
      if (!name.endsWith(".md")) continue;
      const abs = join(specsDir, name);
      const s = await stat(abs);
      artifacts.push({
        path: `.mobiusx/specs/${name}`,
        label: `Spec: ${name.replace(/\.md$/, "")}`,
        category: "spec",
        sizeBytes: s.size,
        modifiedAt: s.mtime.toISOString(),
      });
    }
  } catch {
    // no .mobiusx/specs/ directory yet -- nothing generated, not an error
  }

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    completion,
    artifacts,
  };
}
