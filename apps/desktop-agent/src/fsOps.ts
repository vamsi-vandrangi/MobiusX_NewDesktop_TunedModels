import { constants } from "node:fs";
import { access, chmod, link, lstat, mkdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { reconcile, type Snapshot } from "@mobiusx/context-engine";
import { scanForSecrets } from "@mobiusx/secret-scan";
import type { AppliedEditResult, FsNode, FsReadResponse, ProposedEdit } from "@mobiusx/protocol";

const MAX_READ_BYTES = 1_000_000; // 1MB — plenty for source files, keeps the agent responsive
const MAX_APPLY_FILES = 200;
const MAX_EDIT_FILE_BYTES = 2_000_000;
const MAX_EDIT_BATCH_BYTES = 10_000_000;

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

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Validate the common edit schema and portable project-relative paths before touching local or remote files. */
export function validateEditBundle(value: unknown): { edits?: ProposedEdit[]; errors: string[] } {
  if (!Array.isArray(value) || value.length === 0) return { errors: ["edits must be a non-empty array"] };
  if (value.length > MAX_APPLY_FILES) return { errors: [`edit batch exceeds the ${MAX_APPLY_FILES}-file limit`] };
  const errors: string[] = [];
  const edits: ProposedEdit[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const [index, candidate] of value.entries()) {
    const label = `edit ${index + 1}`;
    if (!candidate || typeof candidate !== "object") {
      errors.push(`${label} must be an object`);
      continue;
    }
    const extraProperties = Object.keys(candidate).filter((key) => !["path", "action", "content"].includes(key));
    if (extraProperties.length) {
      errors.push(`${label} contains unsupported fields: ${extraProperties.join(", ")}`);
      continue;
    }
    const edit = candidate as Partial<ProposedEdit>;
    if (typeof edit.path !== "string" || !edit.path.trim() || typeof edit.content !== "string" || (edit.action !== "create" && edit.action !== "modify")) {
      errors.push(`${label} must include a non-empty path, action 'create' or 'modify', and complete content string`);
      continue;
    }
    const portablePath = edit.path.replaceAll("\\", "/").trim();
    if (portablePath.includes("\0") || portablePath.startsWith("/") || /^[A-Za-z]:\//.test(portablePath) || portablePath.split("/").some((part) => part === "..")) {
      errors.push(`${label} path must stay inside the project: ${edit.path}`);
      continue;
    }
    const normalizedPath = portablePath.split("/").filter((part) => part && part !== ".").join("/");
    if (!normalizedPath) {
      errors.push(`${label} path must identify a file inside the project`);
      continue;
    }
    const key = normalizedPath.toLocaleLowerCase("en-US");
    if (paths.has(key)) {
      errors.push(`duplicate destination path: ${normalizedPath}`);
      continue;
    }
    paths.add(key);
    const bytes = Buffer.byteLength(edit.content, "utf8");
    if (bytes > MAX_EDIT_FILE_BYTES) {
      errors.push(`${normalizedPath} exceeds the ${MAX_EDIT_FILE_BYTES}-byte per-file limit`);
      continue;
    }
    if (edit.content.trim().length === 0) {
      errors.push(`${normalizedPath} has empty content`);
      continue;
    }
    totalBytes += bytes;
    edits.push({ path: normalizedPath, action: edit.action, content: edit.content });
  }
  if (totalBytes > MAX_EDIT_BATCH_BYTES) errors.push(`edit batch exceeds the ${MAX_EDIT_BATCH_BYTES}-byte total content limit`);
  return errors.length ? { errors } : { edits, errors };
}

/** Project-aware preflight: validates action/existence, symlink containment, and secret-shaped content for the entire batch. */
export async function validateLocalEdits(projectRoot: string, value: unknown): Promise<{ edits?: ProposedEdit[]; errors: string[] }> {
  const bundle = validateEditBundle(value);
  if (!bundle.edits) return bundle;
  const errors: string[] = [];
  const projectAbs = resolvePath(projectRoot);
  const rootReal = await realpath(projectAbs);
  const withinRoot = (candidate: string) => {
    const rel = relative(rootReal, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  for (const edit of bundle.edits) {
    const abs = resolveWithinProject(projectRoot, edit.path);
    let exists = false;
    try {
      const targetInfo = await lstat(abs);
      exists = true;
      if (!targetInfo.isFile()) errors.push(`${edit.path}: destination is not a regular file`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push(`${edit.path}: cannot inspect destination (${(err as Error).message})`);
        continue;
      }
    }
    if (edit.action === "modify" && !exists) errors.push(`${edit.path}: modify target does not exist`);
    if (edit.action === "create" && exists) errors.push(`${edit.path}: create target already exists; refusing to overwrite`);

    // Resolve the deepest existing parent so a symlink cannot redirect a
    // seemingly project-relative write outside the opened project.
    let ancestor = dirname(abs);
    while (ancestor !== projectAbs) {
      try {
        const info = await stat(ancestor);
        if (!info.isDirectory()) errors.push(`${edit.path}: parent path is not a directory`);
        const realAncestor = await realpath(ancestor);
        if (!withinRoot(realAncestor)) errors.push(`${edit.path}: parent resolves outside the open project`);
        try { await access(ancestor, constants.W_OK); }
        catch { errors.push(`${edit.path}: parent directory is not writable`); }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`${edit.path}: cannot resolve parent path (${(err as Error).message})`);
          break;
        }
        const next = dirname(ancestor);
        if (next === ancestor) break;
        ancestor = next;
      }
    }
    if (ancestor === projectAbs) {
      try { await access(projectAbs, constants.W_OK); }
      catch { errors.push(`${edit.path}: open project directory is not writable`); }
    }
    if (exists) {
      try {
        if (!withinRoot(await realpath(abs))) errors.push(`${edit.path}: destination resolves outside the open project`);
        try { await access(abs, constants.W_OK); }
        catch { errors.push(`${edit.path}: destination is not writable`); }
      } catch (err) {
        errors.push(`${edit.path}: cannot resolve destination (${(err as Error).message})`);
      }
    }
    const secretMatches = scanForSecrets(edit.content);
    if (secretMatches.length) errors.push(`${edit.path}: possible secret-shaped content (${secretMatches.map((match) => match.ruleId).join(", ")})`);
  }
  return errors.length ? { errors } : bundle;
}

/**
 * Manual save (Monaco editor, Cmd/Ctrl+S) -- deliberately separate from
 * applyEdits below, not a repurposing of it. A human's own keystrokes in
 * their own editor shouldn't be secret-scanned or forced through
 * applyEdits' create-must-not-exist/modify-must-exist semantics; this is
 * just "write what the editor currently holds for this path." Reuses the
 * same resolveWithinProject path-containment guard and the same atomic
 * temp-file-then-rename write applyEdits uses, so a crash mid-write still
 * can't leave a half-written file on disk.
 */
export async function writeProjectFile(projectRoot: string, relPath: string, content: string): Promise<void> {
  const abs = resolveWithinProject(projectRoot, relPath);
  await mkdir(dirname(abs), { recursive: true });
  const tmpPath = `${abs}.mobiusx-tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, abs);
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
 *   and a whole-bundle preflight run before any write; a secret match,
 *   invalid path, action/existence mismatch, unwritable destination, or
 *   oversized/incomplete entry rejects the batch before a checkpoint or
 *   partial application. Content is never silently stripped or rewritten.
 *
 * Every file is staged beside its destination first. Promotion happens only
 * after all staged writes succeed; a promotion error restores modified files
 * and removes newly created files. This handles ordinary I/O failures as a
 * cross-file transaction. It is not crash-durable: process termination or
 * power loss during promotion still requires the saved checkpoint to restore.
 */
export interface ApplyEditsPromotionHooks {
  /** Injectable no-clobber promoter for deterministic rollback verification. */
  linkCreate?: typeof link;
}

export async function applyEdits(projectRoot: string, edits: ProposedEdit[], hooks: ApplyEditsPromotionHooks = {}): Promise<AppliedEditResult[]> {
  const preflight = await validateLocalEdits(projectRoot, edits);
  if (!preflight.edits) throw new Error(`Pre-apply validation failed: ${preflight.errors.join("; ")}`);
  const root = resolvePath(projectRoot);
  const createdDirectories = new Set<string>();
  const staged: Array<{ edit: ProposedEdit; abs: string; temp: string; prior?: Buffer; priorMode?: number; promoted: boolean }> = [];
  const transactionId = randomUUID();
  const cleanupTemps = async () => {
    for (const file of staged) await rm(file.temp, { force: true }).catch(() => undefined);
  };
  const removeCreatedDirectories = async () => {
    for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
      await rmdir(directory).catch(() => undefined);
    }
  };

  try {
    for (const edit of preflight.edits) {
      const abs = resolveWithinProject(root, edit.path);
      const parent = dirname(abs);
      const missing: string[] = [];
      let ancestor = parent;
      while (ancestor !== root && relative(root, ancestor) && !(await pathExists(ancestor))) {
        missing.push(ancestor);
        ancestor = dirname(ancestor);
      }
      for (const directory of missing) createdDirectories.add(directory);
      await mkdir(parent, { recursive: true });

      let prior: Buffer | undefined;
      let priorMode: number | undefined;
      try {
        const info = await lstat(abs);
        if (!info.isFile()) throw new Error(`${edit.path}: destination is not a regular file`);
        if (edit.action === "create") throw new Error(`${edit.path}: create target appeared during promotion; refusing to overwrite`);
        prior = await readFile(abs);
        priorMode = info.mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (edit.action === "modify") throw new Error(`${edit.path}: modify target disappeared during promotion`);
      }

      const temp = `${abs}.mobiusx-stage-${process.pid}-${transactionId}`;
      const stagedFile = { edit, abs, temp, prior, priorMode, promoted: false };
      staged.push(stagedFile);
      await writeFile(temp, edit.content, { encoding: "utf8", flag: "wx", mode: priorMode ?? 0o666 });
      if (priorMode !== undefined) await chmod(temp, priorMode);
    }

    for (const file of staged) {
      if (file.edit.action === "create") {
        // link() is an atomic no-clobber promotion on the same filesystem.
        await (hooks.linkCreate ?? link)(file.temp, file.abs);
        file.promoted = true;
        await unlink(file.temp);
      } else {
        await rename(file.temp, file.abs);
        file.promoted = true;
      }
    }
  } catch (promotionError) {
    const rollbackErrors: string[] = [];
    for (const file of [...staged].reverse()) {
      if (!file.promoted) continue;
      try {
        if (file.prior !== undefined) {
          const restoreTemp = `${file.abs}.mobiusx-rollback-${process.pid}-${transactionId}`;
          await writeFile(restoreTemp, file.prior, { flag: "wx", mode: file.priorMode ?? 0o666 });
          if (file.priorMode !== undefined) await chmod(restoreTemp, file.priorMode);
          await rename(restoreTemp, file.abs);
        } else {
          await unlink(file.abs);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${file.edit.path}: ${(rollbackError as Error).message}`);
      }
    }
    await cleanupTemps();
    await removeCreatedDirectories();
    const detail = `file promotion failed: ${(promotionError as Error).message}`;
    throw new Error(rollbackErrors.length ? `${detail}; rollback incomplete: ${rollbackErrors.join("; ")}` : `${detail}; all promoted files were rolled back`);
  }

  await cleanupTemps();
  return staged.map(({ edit }) => ({ path: edit.path, action: edit.action, status: "applied" }));
}
