import { createHash } from "node:crypto";
import path from "node:path";
import type { GenerationCheckpoint, ProposedEdit } from "@mobiusx/protocol";

export interface ArtifactOwnerRecord {
  artifactId: string;
  stageId: string;
  path: string;
  sha256: string;
  version: number;
  provenance: "model" | "deterministic" | "repair" | "checkpoint";
  replacesArtifactId?: string;
  replacementAuthorization?: string;
}

export interface ArtifactOwnershipManifest {
  schemaVersion: "1.0";
  active: ArtifactOwnerRecord[];
  superseded: ArtifactOwnerRecord[];
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const keyOf = (value: string) => value.toLocaleLowerCase("en-US");

/** Accept only canonical project-relative POSIX paths. This is shared by
 * checkpoint validation and artifact materialization, before joining a root. */
export function normalizeArtifactPath(input: string): string | undefined {
  if (!input || input.includes("\0")) return undefined;
  const slashPath = input.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[a-z]:/i.test(slashPath) || slashPath.startsWith("//")) return undefined;
  const parts = slashPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  const normalized = path.posix.normalize(slashPath);
  if (normalized !== slashPath || normalized === "." || normalized.startsWith("../")) return undefined;
  return normalized;
}

const REPLACEMENT_PATTERNS: Record<string, string[]> = {
  scaffold: [],
  // Database generation may wire the new schema/driver into the app and
  // deployment environment. Other files need a separate stage owner.
  database: [
    "backend/requirements.txt", "backend/alembic.ini", "backend/database.py",
    "backend/models.py", "backend/schemas.py", "backend/main.py",
    "backend/migrations/**", ".env.example", "README.md", "docker-compose.yml",
    "frontend/package.json", "frontend/package-lock.json", "frontend/pnpm-lock.yaml", "frontend/yarn.lock",
  ],
  backend: ["backend/**/*.py", "backend/requirements.txt", "backend/main.py", ".env.example"],
  transactions: ["backend/**/*.py", "backend/requirements.txt"],
  frontend: ["frontend/**"],
  tests: [
    "backend/tests/**", "frontend/e2e/**", "frontend/playwright.config.*",
    "frontend/package.json", "frontend/package-lock.json", "frontend/pnpm-lock.yaml",
    "frontend/yarn.lock", "backend/requirements.txt",
  ],
};

function globMatches(pattern: string, pathName: string): boolean {
  if (pattern.endsWith("/**")) return pathName.startsWith(pattern.slice(0, -2));
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { expression += "(?:.*/)?"; index += 2; }
      else { expression += ".*"; index += 1; }
    } else if (pattern[index] === "*") expression += "[^/]*";
    else expression += escapeRegex(pattern[index]);
  }
  return new RegExp(`${expression}$`, "i").test(pathName);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function stageMayReplacePath(stageId: string, pathName: string): boolean {
  return (REPLACEMENT_PATTERNS[stageId] ?? []).some((pattern) => globMatches(pattern, pathName));
}

/** Validate paths and stage ownership before an artifact set can become the
 * active checkpoint. Failed-stage proposals are intentionally not accepted
 * as input here; they remain in attemptedStages for forensic inspection. */
export function validateStageArtifactOwnership(
  stageId: string,
  previous: ProposedEdit[],
  proposed: ProposedEdit[],
): string[] {
  const issues: string[] = [];
  const proposedPaths = new Set<string>();
  for (const artifact of proposed) {
    const normalized = normalizeArtifactPath(artifact.path);
    if (!normalized) {
      issues.push(`unsafe or non-canonical artifact path: ${artifact.path}`);
      continue;
    }
    const key = keyOf(normalized);
    if (proposedPaths.has(key)) issues.push(`${stageId} stage proposes the same target path more than once: ${normalized}`);
    proposedPaths.add(key);
  }
  const oldByPath = new Map(previous.map((artifact) => [keyOf(normalizeArtifactPath(artifact.path) ?? artifact.path), artifact]));
  for (const artifact of proposed) {
    const normalized = normalizeArtifactPath(artifact.path);
    if (!normalized) continue;
    const old = oldByPath.get(keyOf(normalized));
    if (old && old.content !== artifact.content && !stageMayReplacePath(stageId, normalized)) {
      issues.push(`${stageId} stage is not authorized to replace ${normalized}; current owner content is preserved`);
    }
  }
  return issues;
}

/** Build the active materialization manifest from successful stage snapshots
 * and the authoritative aggregate. `attemptedStages` are deliberately kept
 * out of this function and can never shadow validated artifacts. */
export function buildArtifactOwnershipManifest(checkpoint: GenerationCheckpoint): ArtifactOwnershipManifest {
  const activeByPath = new Map<string, ArtifactOwnerRecord>();
  const superseded: ArtifactOwnerRecord[] = [];
  const contentByArtifactId = new Map<string, ArtifactOwnerRecord>();

  const insert = (stageId: string, artifact: { path: string; content: string; sha256?: string }, provenance: ArtifactOwnerRecord["provenance"]) => {
    const normalized = normalizeArtifactPath(artifact.path);
    if (!normalized) throw new Error(`unsafe artifact path cannot be materialized: ${artifact.path}`);
    const sha256 = digest(artifact.content);
    if (artifact.sha256 && artifact.sha256 !== sha256) throw new Error(`artifact checksum mismatch: ${normalized}`);
    const key = keyOf(normalized);
    const prior = activeByPath.get(key);
    if (prior?.sha256 === sha256) return;
    if (prior) {
      if (stageId === "checkpoint") {
        throw new Error(`aggregate artifact ${normalized} conflicts with its last validated stage owner ${prior.stageId}`);
      }
      if (!stageMayReplacePath(stageId, normalized)) {
        throw new Error(`${stageId} stage has no replacement authorization for ${normalized}; refusing last-write-wins materialization`);
      }
      superseded.push(prior);
    }
    const version = (superseded.filter((record) => keyOf(record.path) === key).length + 1);
    const artifactId = `${stageId}:${normalized}:${sha256.slice(0, 12)}`;
    const record: ArtifactOwnerRecord = {
      artifactId, stageId, path: normalized, sha256, version, provenance,
      ...(prior ? { replacesArtifactId: prior.artifactId, replacementAuthorization: `${stageId} stage replacement policy` } : {}),
    };
    activeByPath.set(key, record);
    contentByArtifactId.set(artifactId, record);
  };

  for (const stage of checkpoint.stages) {
    for (const artifact of stage.artifacts ?? []) insert(stage.id, artifact, "checkpoint");
  }
  // Legacy checkpoints can have incomplete snapshots; aggregate artifacts are
  // authoritative for the current bytes, but are tagged as checkpoint-owned.
  for (const artifact of checkpoint.artifacts) {
    const normalized = normalizeArtifactPath(artifact.path);
    if (!normalized) throw new Error(`unsafe artifact path cannot be materialized: ${artifact.path}`);
    const current = activeByPath.get(keyOf(normalized));
    if (current?.sha256 === artifact.sha256) continue;
    insert("checkpoint", artifact, "checkpoint");
  }

  return {
    schemaVersion: "1.0",
    active: [...activeByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    superseded: superseded.sort((a, b) => a.path.localeCompare(b.path) || a.version - b.version),
  };
}

export function activeCheckpointArtifacts(checkpoint: GenerationCheckpoint): GenerationCheckpoint["artifacts"] {
  // The aggregate is the only active version. Attempted-stage outputs are
  // retained for diagnosis and must never be flattened into the app workspace.
  const seen = new Set<string>();
  return checkpoint.artifacts.map((artifact) => {
    const path = normalizeArtifactPath(artifact.path);
    if (!path || path !== artifact.path.replaceAll("\\", "/")) throw new Error(`unsafe or non-canonical checkpoint path: ${artifact.path}`);
    const key = keyOf(path);
    if (seen.has(key)) throw new Error(`duplicate active checkpoint target path: ${path}`);
    seen.add(key);
    if (digest(artifact.content) !== artifact.sha256) throw new Error(`checkpoint checksum mismatch: ${artifact.path}`);
    return { ...artifact, path };
  });
}

/** Validate independently executed test slices without claiming that the
 * complete tests stage passed. Their artifacts are restricted to test-owned
 * paths and are safe to reuse after a restart. */
export function validateTestSubtaskCheckpoint(checkpoint: GenerationCheckpoint): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const slice of checkpoint.testSubtasks ?? []) {
    if (!slice.id || ids.has(slice.id)) issues.push(`duplicate or empty test subtask id: ${slice.id}`);
    ids.add(slice.id);
    if (slice.architectureHash !== checkpoint.projectArchitecture?.contractHash) issues.push(`test subtask ${slice.id} belongs to a different PAC`);
    if (!/^[a-f0-9]{64}$/.test(slice.topologyHash)) issues.push(`test subtask ${slice.id} has an invalid topology hash`);
    for (const [key, value] of Object.entries(slice.validation)) {
      if (!Number.isInteger(value) || value < 0) issues.push(`test subtask ${slice.id} has invalid ${key} count`);
    }
    if (slice.validation.pytestFailed || slice.validation.pytestSkipped || slice.validation.playwrightFailed || slice.validation.playwrightSkipped) issues.push(`test subtask ${slice.id} contains failed or skipped acceptance tests`);
    const executed = slice.validation.pytestPassed + slice.validation.playwrightPassed;
    if (executed < 1) issues.push(`test subtask ${slice.id} has no passed executable test`);
    if (slice.validation.pytestCollected !== slice.validation.pytestPassed + slice.validation.pytestFailed + slice.validation.pytestSkipped) issues.push(`test subtask ${slice.id} pytest counts do not reconcile`);
    if (slice.validation.playwrightCollected !== slice.validation.playwrightPassed + slice.validation.playwrightFailed + slice.validation.playwrightSkipped) issues.push(`test subtask ${slice.id} Playwright counts do not reconcile`);
    if (!slice.artifacts.length) issues.push(`test subtask ${slice.id} has no checkpointed artifacts`);
    const paths = new Set<string>();
    for (const artifact of slice.artifacts) {
      const normalized = normalizeArtifactPath(artifact.path);
      if (!normalized || normalized !== artifact.path || !stageMayReplacePath("tests", normalized)) issues.push(`unsafe or unauthorized test subtask artifact path: ${artifact.path}`);
      else if (paths.has(keyOf(normalized))) issues.push(`duplicate test subtask target path: ${normalized}`);
      else paths.add(keyOf(normalized));
      if (digest(artifact.content) !== artifact.sha256) issues.push(`test subtask checksum mismatch: ${artifact.path}`);
    }
  }
  return issues;
}
