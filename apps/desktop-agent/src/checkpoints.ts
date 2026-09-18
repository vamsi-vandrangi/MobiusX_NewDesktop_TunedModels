import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { appendAuditEntry } from "@mobiusx/audit-log";
import type { Checkpoint, CheckpointEntry, CheckpointRestoreResult, CheckpointSummary, ProposedEdit } from "@mobiusx/protocol";
import { pathExists, resolveWithinProject } from "./fsOps.js";

/**
 * Checkpoints / Rollback (roadmap Phase 15, source requirement §23). See
 * CheckpointEntry's doc comment in @mobiusx/protocol for the full design
 * rationale (git-independent, project-local, whole-batch snapshots).
 *
 * Storage layout, under the open project's own `.mobiusx/` directory --
 * the same project-local convention steering (Phase 16) and specs
 * (Phase 7) already use:
 *
 *   .mobiusx/checkpoints/<id>/manifest.json   -- the Checkpoint itself
 *   .mobiusx/checkpoints/<id>/files/<relPath> -- pre-edit content, only
 *     for entries where hadPreviousContent is true
 *
 * No automatic pruning in v1 -- same conservative, manual-only posture
 * this codebase already applies to knowledge-source re-indexing (Phase
 * 17): DELETE /checkpoints/:id is the real, honest escape hatch rather
 * than a fabricated retention policy nobody asked for.
 */

function checkpointsDir(projectRoot: string): string {
  return join(projectRoot, ".mobiusx", "checkpoints");
}

function checkpointDir(projectRoot: string, id: string): string {
  return join(checkpointsDir(projectRoot), id);
}

function manifestPath(projectRoot: string, id: string): string {
  return join(checkpointDir(projectRoot, id), "manifest.json");
}

function defaultLabel(edits: ProposedEdit[]): string {
  const names = edits.map((e) => e.path);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  return `${edits.length} file(s): ${shown}${more}`;
}

/**
 * Captures the PRE-EDIT state of every path a batch of edits is about to
 * touch -- must run BEFORE applyEdits (fsOps.ts) writes anything, since
 * once applyEdits runs the pre-edit content is gone. Always creates a
 * checkpoint, even for an all-"create" batch (nothing to snapshot, but
 * the manifest itself is still what makes "restore = delete these
 * created files" possible later).
 *
 * A path that resolveWithinProject rejects (escapes the project root) is
 * silently left out of the checkpoint's entries -- applyEdits itself
 * will independently re-reject it and report why in AppliedEditResult;
 * there is nothing valid to snapshot for a path that was never going to
 * be written.
 */
export async function createCheckpoint(projectRoot: string, edits: ProposedEdit[], label?: string): Promise<Checkpoint> {
  const id = randomUUID();
  const dir = checkpointDir(projectRoot, id);
  const filesDir = join(dir, "files");
  const entries: CheckpointEntry[] = [];

  for (const edit of edits) {
    let abs: string;
    try {
      abs = resolveWithinProject(projectRoot, edit.path);
    } catch {
      continue;
    }
    const existed = await pathExists(abs);
    const hadPreviousContent = edit.action === "modify" && existed;
    if (hadPreviousContent) {
      const content = await readFile(abs, "utf8");
      const dest = join(filesDir, edit.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, "utf8");
    }
    entries.push({ path: edit.path, action: edit.action, hadPreviousContent });
  }

  const checkpoint: Checkpoint = {
    id,
    createdAt: new Date().toISOString(),
    label: label ?? defaultLabel(edits),
    entryCount: entries.length,
    entries,
  };

  await mkdir(dir, { recursive: true });
  await writeFile(manifestPath(projectRoot, id), JSON.stringify(checkpoint, null, 2), "utf8");

  void appendAuditEntry({
    source: "desktop-agent",
    category: "checkpoint-created",
    severity: "info",
    summary: `Checkpoint ${id.slice(0, 8)} created: ${checkpoint.label}`,
    detail: { projectPath: projectRoot, checkpointId: id, entries },
  });

  return checkpoint;
}

export async function listCheckpoints(projectRoot: string): Promise<CheckpointSummary[]> {
  const dir = checkpointsDir(projectRoot);
  let ids: string[];
  try {
    ids = await readdir(dir);
  } catch {
    return [];
  }
  const summaries: CheckpointSummary[] = [];
  for (const id of ids) {
    try {
      const raw = await readFile(manifestPath(projectRoot, id), "utf8");
      const cp = JSON.parse(raw) as Checkpoint;
      summaries.push({ id: cp.id, createdAt: cp.createdAt, label: cp.label, entryCount: cp.entryCount });
    } catch {
      // a missing/corrupt manifest is skipped, never crashes the whole
      // list -- same tolerance audit-log's readAuditLog already applies
      // to its own corrupt trailing lines
      continue;
    }
  }
  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return summaries;
}

export async function readCheckpoint(projectRoot: string, id: string): Promise<Checkpoint | null> {
  try {
    const raw = await readFile(manifestPath(projectRoot, id), "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * Restores a checkpoint: writes back stored pre-edit content for every
 * "modify" entry that had one, deletes the path for every "create" entry
 * (and for any "modify" entry that, honestly, had no prior content to
 * restore to). Blunt and honestly documented -- like Phase 16's hooks
 * being reactive rather than preventive, this overwrites/deletes
 * whatever is at each path right now, without attempting a smarter merge.
 *
 * Before touching anything, takes ANOTHER checkpoint of the CURRENT
 * on-disk state of these same paths -- computed fresh (never copied from
 * the checkpoint being restored), so a hand-edit made after the original
 * apply is still captured correctly. This makes restoring itself always
 * undoable, the same safety property every other mutating operation in
 * this codebase already has (applyEdits' own atomic write, audit-log's
 * append-only file).
 */
export async function restoreCheckpoint(
  projectRoot: string,
  id: string,
): Promise<{ results: CheckpointRestoreResult[]; preRestoreCheckpointId: string | null }> {
  const checkpoint = await readCheckpoint(projectRoot, id);
  if (!checkpoint) {
    throw new Error(`checkpoint ${id} not found`);
  }

  let preRestoreCheckpointId: string | null = null;
  if (checkpoint.entries.length > 0) {
    const asEdits: ProposedEdit[] = [];
    for (const entry of checkpoint.entries) {
      let existsNow = false;
      try {
        existsNow = await pathExists(resolveWithinProject(projectRoot, entry.path));
      } catch {
        existsNow = false;
      }
      // Deliberately re-derived from the CURRENT filesystem, not copied
      // from entry.action -- a path this checkpoint originally "created"
      // may have been hand-edited since, and still deserves its current
      // content snapshotted (as a "modify") before it gets overwritten.
      asEdits.push({ path: entry.path, action: existsNow ? "modify" : "create", content: "" });
    }
    const pre = await createCheckpoint(projectRoot, asEdits, `Before restoring checkpoint ${id.slice(0, 8)}`);
    preRestoreCheckpointId = pre.id;
  }

  const results: CheckpointRestoreResult[] = [];
  for (const entry of checkpoint.entries) {
    try {
      const abs = resolveWithinProject(projectRoot, entry.path);
      if (entry.hadPreviousContent) {
        const stored = join(checkpointDir(projectRoot, id), "files", entry.path);
        const content = await readFile(stored, "utf8");
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        results.push({ path: entry.path, status: "restored" });
      } else {
        const existed = await pathExists(abs);
        if (existed) {
          await rm(abs, { force: true });
          results.push({ path: entry.path, status: "deleted" });
        } else {
          results.push({ path: entry.path, status: "skipped", reason: "already absent — nothing to undo" });
        }
      }
    } catch (err) {
      results.push({ path: entry.path, status: "skipped", reason: (err as Error).message });
    }
  }

  void appendAuditEntry({
    source: "desktop-agent",
    category: "checkpoint-restored",
    severity: "info",
    summary: `Checkpoint ${id.slice(0, 8)} restored (${results.filter((r) => r.status !== "skipped").length}/${results.length} path(s))`,
    detail: { projectPath: projectRoot, checkpointId: id, results, preRestoreCheckpointId },
  });

  return { results, preRestoreCheckpointId };
}

export async function deleteCheckpoint(projectRoot: string, id: string): Promise<boolean> {
  const dir = checkpointDir(projectRoot, id);
  if (!(await pathExists(dir))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
