import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { reconcile, type Snapshot } from "@mobiusx/context-engine";
import { scanForSecrets } from "@mobiusx/secret-scan";
import type { AppliedEditResult, FsNode, FsReadResponse, ProposedEdit } from "@mobiusx/protocol";

const MAX_READ_BYTES = 1_000_000; // 1MB — plenty for source files, keeps the agent responsive

export async function buildSnapshot(rootDir: string): Promise<Snapshot> {
  const { snapshot } = await reconcile(rootDir, null);
  return snapshot;
}

/** Flattens a context-engine Snapshot into the flat FsNode[] shape the shell renders as a tree. */
export function snapshotToNodes(snapshot: Snapshot): FsNode[] {
  const nodes: FsNode[] = [];
  for (const [path, node] of Object.entries(snapshot.nodes)) {
    if (path === "") continue; // root itself
    if (node.type === "file") {
      nodes.push({ name: path.split("/").pop() ?? path, path, type: "file", size: node.size });
    } else {
      nodes.push({ name: path.split("/").pop() ?? path, path, type: "dir" });
    }
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return nodes;
}

/** Resolves a project-relative path safely, rejecting any attempt to escape the project root. */
export function resolveWithinProject(projectRoot: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error("path must be relative to the open project");
  }
  const abs = resolvePath(join(projectRoot, relPath));
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("path escapes the open project root");
  }
  return abs;
}

export async function readProjectFile(projectRoot: string, relPath: string): Promise<FsReadResponse> {
  const abs = resolveWithinProject(projectRoot, relPath);
  const buf = await readFile(abs);
  const truncated = buf.byteLength > MAX_READ_BYTES;
  const content = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
  return { path: relPath, content, truncated };
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ONLY function in this codebase that ever writes AI-generated content
 * to disk — called solely from the POST /fs/apply-edits route, itself only
 * ever hit after the user reviews a task's ProposedEdit[] and clicks Apply
 * (see docs/ARCHITECTURE.md §8's human-approval step). Every edit is
 * re-validated here rather than trusted from the caller:
 *
 * - resolveWithinProject rejects any path that isn't inside the open
 *   project (same guard readProjectFile uses for reads — now gating writes).
 * - "modify" is refused if the target doesn't already exist; "create" is
 *   refused if it does. Neither is ever silently reinterpreted as the
 *   other — see AppliedEditResult.reason for exactly why a given file was
 *   skipped, always reported per-file, never swallowed.
 * - A flag-only secret scan (scanForSecrets — see @mobiusx/secret-scan)
 *   runs on the proposed content; a match SKIPS that file for manual
 *   review rather than silently stripping or rewriting content the user
 *   is about to approve, which would be its own kind of dishonesty.
 *
 * Each file is written atomically (temp file + rename) so a crash
 * mid-write can't leave a half-written file on disk. This is NOT a
 * cross-file transaction, though: if this process dies partway through a
 * multi-file batch, some files can end up applied and others not — a
 * known limitation, surfaced honestly via the per-file results rather
 * than papered over with a fake all-or-nothing guarantee this single-user
 * local agent can't actually provide.
 */
export async function applyEdits(projectRoot: string, edits: ProposedEdit[]): Promise<AppliedEditResult[]> {
  const results: AppliedEditResult[] = [];

  for (const edit of edits) {
    try {
      const abs = resolveWithinProject(projectRoot, edit.path);
      const exists = await pathExists(abs);

      if (edit.action === "modify" && !exists) {
        results.push({ path: edit.path, action: edit.action, status: "skipped", reason: "file not found — nothing to modify" });
        continue;
      }
      if (edit.action === "create" && exists) {
        results.push({ path: edit.path, action: edit.action, status: "skipped", reason: "file already exists — refusing to overwrite a create" });
        continue;
      }

      const secretMatches = scanForSecrets(edit.content);
      if (secretMatches.length > 0) {
        results.push({
          path: edit.path,
          action: edit.action,
          status: "skipped",
          reason: `possible secret-shaped content (${secretMatches.map((m) => m.ruleId).join(", ")}) — review manually`,
        });
        continue;
      }

      await mkdir(dirname(abs), { recursive: true });
      const tmpPath = `${abs}.mobiusx-tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpPath, edit.content, "utf8");
      await rename(tmpPath, abs);

      results.push({ path: edit.path, action: edit.action, status: "applied" });
    } catch (err) {
      results.push({ path: edit.path, action: edit.action, status: "skipped", reason: (err as Error).message });
    }
  }

  return results;
}
