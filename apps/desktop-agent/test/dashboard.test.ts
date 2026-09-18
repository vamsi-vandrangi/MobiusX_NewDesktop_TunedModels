import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherDashboard } from "../src/dashboard.js";
import { writeSteeringFile } from "../src/steering.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mobiusx-dashboard-test-"));
}

test("gatherDashboard reports an empty artifact list for a project with nothing generated yet, and reuses the real completion report", async () => {
  const dir = await tempProject();
  const dash = await gatherDashboard(dir, false);

  assert.equal(dash.projectPath, dir);
  // computeCompletionReport itself writes .mobiusx/PROJECT_COMPLETION.json as a real
  // side effect (see completion.ts) -- gatherDashboard calls it BEFORE checking candidate
  // artifacts, so that file genuinely exists by the time the artifact scan runs. The
  // only honest expectation for a project with nothing else generated is that ONE entry.
  assert.equal(dash.artifacts.length, 1);
  assert.equal(dash.artifacts[0].path, ".mobiusx/PROJECT_COMPLETION.json");
  // completion is the exact same shape computeCompletionReport itself returns --
  // not a re-derived summary -- so it must carry the same honest not_configured criteria.
  assert.ok(dash.completion.criteria.some((c) => c.id === "security_scan_clean" && c.status === "not_configured"));
  assert.equal(dash.completion.projectPath, dir);
});

test("gatherDashboard detects real architecture docs, project context, and devops infra files that exist on disk", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, "docs", "architecture"), { recursive: true });
  await writeFile(join(dir, "docs", "architecture", "HLD.md"), "# HLD\n");
  await mkdir(join(dir, ".mobiusx"), { recursive: true });
  await writeFile(join(dir, ".mobiusx", "PROJECT_CONTEXT.md"), "# Context\n");
  await writeFile(join(dir, "Dockerfile"), "FROM node:20-slim\n");

  const dash = await gatherDashboard(dir, false);
  const byPath = new Map(dash.artifacts.map((a) => [a.path, a]));

  assert.ok(byPath.has("docs/architecture/HLD.md"));
  assert.equal(byPath.get("docs/architecture/HLD.md")!.category, "architecture");
  assert.ok(byPath.has(".mobiusx/PROJECT_CONTEXT.md"));
  assert.equal(byPath.get(".mobiusx/PROJECT_CONTEXT.md")!.category, "context");
  assert.ok(byPath.has("Dockerfile"));
  assert.equal(byPath.get("Dockerfile")!.category, "devops");
  assert.ok(byPath.get("Dockerfile")!.sizeBytes! > 0);
  assert.ok(byPath.get("Dockerfile")!.modifiedAt);
  // LLD.md was never created -- must not be reported as if it existed.
  assert.equal(byPath.has("docs/architecture/LLD.md"), false);
});

test("gatherDashboard lists a non-empty steering file but skips an empty one", async () => {
  const dir = await tempProject();
  await writeSteeringFile(dir, "architecture", "Follow hexagonal architecture.");
  await writeSteeringFile(dir, "empty-one", "   ");

  const dash = await gatherDashboard(dir, false);
  const steeringArtifacts = dash.artifacts.filter((a) => a.category === "steering" && a.path.includes("steering/"));

  assert.equal(steeringArtifacts.length, 1);
  assert.equal(steeringArtifacts[0].path, ".mobiusx/steering/architecture.md");
});

test("gatherDashboard lists real Spec-mode output from .mobiusx/specs/*.md and ignores non-.md siblings", async () => {
  const dir = await tempProject();
  await mkdir(join(dir, ".mobiusx", "specs"), { recursive: true });
  await writeFile(join(dir, ".mobiusx", "specs", "shopping-cart-checkout.md"), "# Shopping cart checkout\n");
  await writeFile(join(dir, ".mobiusx", "specs", "shopping-cart-checkout.json"), "{}\n");

  const dash = await gatherDashboard(dir, false);
  const specArtifacts = dash.artifacts.filter((a) => a.category === "spec");

  assert.equal(specArtifacts.length, 1);
  assert.equal(specArtifacts[0].path, ".mobiusx/specs/shopping-cart-checkout.md");
  assert.equal(specArtifacts[0].label, "Spec: shopping-cart-checkout");
});

test("gatherDashboard passes isGitRepo through to the completion report honestly", async () => {
  const dir = await tempProject();
  const dashTrue = await gatherDashboard(dir, true);
  const dashFalse = await gatherDashboard(dir, false);

  const gitCriterion = (report: typeof dashTrue.completion) => report.criteria.find((c) => c.id === "git_initialized");
  assert.equal(gitCriterion(dashTrue.completion)?.status, "pass");
  assert.equal(gitCriterion(dashFalse.completion)?.status, "fail");
});
