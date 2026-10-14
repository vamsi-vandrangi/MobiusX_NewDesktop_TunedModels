import { posix } from "node:path";
import type { SFTPWrapper } from "ssh2";
import { scanForSecrets } from "@mobiusx/secret-scan";
import type { AppliedEditResult, FsNode, FsReadResponse, ProposedEdit } from "@mobiusx/protocol";

const MAX_READ_BYTES = 1_000_000; // same cap readProjectFile (fsOps.ts) uses for a local file
// Real remote trees can be enormous (someone connects to "/" or a whole
// home directory with caches in it) -- cap the walk and report `truncated`
// honestly, the same pattern MAX_READ_BYTES already establishes for a
// single oversized file, rather than hanging or exhausting memory walking
// an unbounded remote tree over the network.
const MAX_REMOTE_NODES = 4000;

// Directories never worth walking into on a real remote box -- keeps a
// first connect to e.g. a Node project's home fast and the tree readable,
// not dominated by dependency/build output. Mirrors context-engine's own
// local-fs ignore list in spirit, not copied from it (that one isn't
// reachable from here -- this is a separate, SFTP-only walk).
const SKIP_DIR_NAMES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".Trash", "dist", "build", ".next", ".terraform"]);

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<import("ssh2").FileEntry[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

/**
 * Walks the remote tree over SFTP, breadth-first, capped at
 * MAX_REMOTE_NODES. Deliberately NOT context-engine's reconcile() (that's
 * a local-fs-only implementation with its own hashing/ignore logic this
 * doesn't try to replicate over the network) -- this mirrors
 * fsOps.ts#buildSnapshot + snapshotToNodes's OUTPUT shape only (FsNode[]),
 * not their implementation, which is what routes.ts's GET /fs/tree branch
 * actually needs.
 */
export async function buildRemoteTree(sftp: SFTPWrapper, rootAbs: string): Promise<{ nodes: FsNode[]; truncated: boolean }> {
  const nodes: FsNode[] = [];
  const queue: string[] = [rootAbs];
  let truncated = false;

  while (queue.length > 0) {
    if (nodes.length >= MAX_REMOTE_NODES) {
      truncated = true;
      break;
    }
    const dirAbs = queue.shift()!;
    const relDir = posix.relative(rootAbs, dirAbs);
    let entries: import("ssh2").FileEntry[];
    try {
      entries = await sftpReaddir(sftp, dirAbs);
    } catch {
      continue; // permission denied / vanished mid-walk -- skip this one directory rather than fail the whole tree
    }
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      if (SKIP_DIR_NAMES.has(entry.filename)) continue;
      if (nodes.length >= MAX_REMOTE_NODES) {
        truncated = true;
        break;
      }
      const entryAbs = posix.join(dirAbs, entry.filename);
      const relPath = relDir ? posix.join(relDir, entry.filename) : entry.filename;
      const mode = entry.attrs?.mode ?? 0;
      const isDir = (mode & S_IFMT) === S_IFDIR;
      nodes.push({
        name: entry.filename,
        path: relPath,
        type: isDir ? "dir" : "file",
        ...(isDir ? {} : { size: entry.attrs?.size }),
      });
      if (isDir) queue.push(entryAbs);
    }
  }
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return { nodes, truncated };
}

/** Resolves a project-relative remote path safely, rejecting any attempt to
 * escape the open remote project root -- same contract as fsOps.ts's
 * resolveWithinProject, POSIX-path version (SFTP paths are always POSIX,
 * even when the SFTP client itself is running on Windows). */
function resolveWithinRemoteProject(rootAbs: string, relPath: string): string {
  if (relPath.startsWith("/")) {
    throw new Error("path must be relative to the open project");
  }
  const joined = posix.normalize(posix.join(rootAbs, relPath));
  if (joined !== rootAbs && !joined.startsWith(rootAbs.replace(/\/$/, "") + "/")) {
    throw new Error("path escapes the open project root");
  }
  return joined;
}

export async function readRemoteFile(sftp: SFTPWrapper, rootAbs: string, relPath: string): Promise<FsReadResponse> {
  const abs = resolveWithinRemoteProject(rootAbs, relPath);
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(abs);
    stream.on("data", (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  const truncated = buf.byteLength > MAX_READ_BYTES;
  const content = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
  return { path: relPath, content, truncated };
}

function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err) => resolve(!err));
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<import("ssh2").Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => {
      if (!err) return resolve(attrs);
      // SFTP status 2 is SSH_FX_NO_SUCH_FILE. Other failures (including
      // permission denied) must not be mistaken for a missing destination.
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "2") return resolve(null);
      reject(err);
    });
  });
}

/** Validate the complete remote edit batch before the first SFTP write. */
export async function validateRemoteEdits(
  sftp: SFTPWrapper,
  rootAbs: string,
  edits: ProposedEdit[],
): Promise<{ edits?: ProposedEdit[]; errors: string[] }> {
  const errors: string[] = [];
  for (const edit of edits) {
    try {
      const abs = resolveWithinRemoteProject(rootAbs, edit.path);
      const attrs = await sftpStat(sftp, abs);
      const exists = attrs !== null;
      if (attrs && (attrs.mode & S_IFMT) === S_IFDIR) {
        errors.push(`${edit.path}: destination is a directory`);
      } else if (edit.action === "modify" && !exists) {
        errors.push(`${edit.path}: file to modify does not exist`);
      } else if (edit.action === "create" && exists) {
        errors.push(`${edit.path}: create destination already exists`);
      }
      const secretMatches = scanForSecrets(edit.content);
      if (secretMatches.length > 0) {
        errors.push(`${edit.path}: possible secret-shaped content (${secretMatches.map((m) => m.ruleId).join(", ")})`);
      }
    } catch (err) {
      errors.push(`${edit.path}: remote preflight failed: ${(err as Error).message}`);
    }
  }
  return errors.length > 0 ? { errors } : { edits, errors };
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, { encoding: "utf8" }, (err) => (err ? reject(err) : resolve()));
  });
}

async function sftpMkdirRecursive(sftp: SFTPWrapper, dirAbs: string, rootAbs: string): Promise<void> {
  // SFTP has no mkdir -p -- walk down from rootAbs, creating any missing
  // segment, the same "create parent dirs as needed" behavior fsOps.ts's
  // local applyEdits gets for free from fs.mkdir({recursive: true}).
  const rel = posix.relative(rootAbs, dirAbs);
  if (!rel || rel === ".") return;
  const segments = rel.split("/");
  let cur = rootAbs;
  for (const seg of segments) {
    cur = posix.join(cur, seg);
    const exists = await sftpExists(sftp, cur);
    if (!exists) {
      await new Promise<void>((resolve, reject) => sftp.mkdir(cur, (err) => (err ? reject(err) : resolve())));
    }
  }
}

/**
 * SFTP-backed twin of fsOps.ts#applyEdits -- same real contract (path
 * containment, modify-must-exist / create-must-not-exist, a flag-only
 * secret scan, per-file results, with batch preflight before writes, never a fabricated all-or-nothing
 * guarantee). One real, honestly-noted difference: no atomic
 * temp-file-then-rename here -- renaming over an existing file isn't
 * reliable across every SFTP server implementation, so this writes
 * directly. A write that fails partway (a connection drop mid-transfer)
 * can leave a partially-written remote file; that's reported through this
 * edit's own "skipped"/exception path rather than silently assumed safe.
 * Checkpoints/rollback (Phase 15) are local-project-only in this phase --
 * see routes.ts's /fs/apply-edits doc comment for that scope note.
 */
export async function applyRemoteEdits(sftp: SFTPWrapper, rootAbs: string, edits: ProposedEdit[]): Promise<AppliedEditResult[]> {
  const preflight = await validateRemoteEdits(sftp, rootAbs, edits);
  if (!preflight.edits) throw new Error(`Pre-apply validation failed: ${preflight.errors.join("; ")}`);
  const results: AppliedEditResult[] = [];
  for (const edit of edits) {
    try {
      const abs = resolveWithinRemoteProject(rootAbs, edit.path);
      const exists = await sftpExists(sftp, abs);

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

      await sftpMkdirRecursive(sftp, posix.dirname(abs), rootAbs);
      await sftpWriteFile(sftp, abs, edit.content);
      results.push({ path: edit.path, action: edit.action, status: "applied" });
    } catch (err) {
      results.push({ path: edit.path, action: edit.action, status: "skipped", reason: (err as Error).message });
    }
  }
  return results;
}
