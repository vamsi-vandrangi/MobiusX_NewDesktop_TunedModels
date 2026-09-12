export interface FileNode {
  type: "file";
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface DirNode {
  type: "dir";
  hash: string;
  /** Sorted immediate child names (posix-style, relative to this dir). */
  children: string[];
}

export type IndexNode = FileNode | DirNode;

export interface Snapshot {
  root: string;
  generatedAt: string;
  rootHash: string;
  /** Keyed by posix relative path; "" is the workspace root directory itself. */
  nodes: Record<string, IndexNode>;
}

export interface ReconcileStats {
  /** Files whose content was actually read and re-hashed this pass. */
  filesHashed: number;
  /** Files whose (size, mtimeMs) matched the cached snapshot — content read was skipped entirely. */
  filesSkippedCached: number;
  /** Every directory this pass had to stat() + readdir() — a full reconcile always walks all of these. */
  dirsWalked: number;
  totalFiles: number;
  totalDirs: number;
  durationMs: number;
  /** Files newly added or whose content changed, relative to the previous snapshot. */
  changedPaths: string[];
  /** Paths present in the previous snapshot but no longer found on disk. */
  removedPaths: string[];
  /** True only if rootHash is identical to the previous snapshot's rootHash. */
  unchanged: boolean;
}

export interface ApplyChangeResult {
  path: string;
  kind: "add" | "change" | "unlink";
  /** Ancestor directories whose hash had to be recomputed, root-most last. Length == depth of the changed path. */
  ancestorsTouched: string[];
  rootHashBefore: string;
  rootHashAfter: string;
}

export const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".mobiusx-index",
  "dist",
  "build",
  ".next",
  "coverage",
  ".DS_Store",
]);
