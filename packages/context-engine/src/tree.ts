// The Merkle indexing core (TDD §4.1). Two distinct cost profiles live here
// on purpose, because they solve different problems and it would be
// dishonest to blur them into one "O(log n)" claim:
//
//   reconcile()   — periodic / cold-start full walk. Must stat() and
//                   readdir() every directory (there is no cheaper way to
//                   notice a file was added, removed, or renamed without an
//                   OS change-journal). What it DOES skip is re-reading file
//                   *contents* — a (size, mtimeMs) match against the cached
//                   snapshot lets it reuse the old content hash. Cost:
//                   O(total directory entries) for the walk, O(changed
//                   files) for the expensive part (hashing).
//
//   applyChange() — the live path, driven by the file watcher (watcher.ts /
//                   Fig. 2's "Change Detection" stage). The OS already told
//                   us exactly which file changed, so this touches only that
//                   file's node plus its ancestor chain back to the root —
//                   genuinely O(depth), which is where the "Merkle tree ->
//                   O(log n)-ish updates" property Cursor and friends
//                   advertise actually comes from.
import { readdir, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { hashBytes, hashFile } from "./hash.js";
import type {
  ApplyChangeResult,
  DirNode,
  FileNode,
  IndexNode,
  ReconcileStats,
  Snapshot,
} from "./types.js";
import { DEFAULT_IGNORE } from "./types.js";

function dirHashOf(children: { name: string; type: "file" | "dir"; hash: string }[]): string {
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
  return hashBytes(sorted.map((c) => `${c.type}:${c.name}:${c.hash}`).join("\n"));
}

export async function reconcile(
  rootDir: string,
  previous: Snapshot | null,
  ignore: Set<string> = DEFAULT_IGNORE,
): Promise<{ snapshot: Snapshot; stats: ReconcileStats }> {
  const start = Date.now();
  const nodes: Record<string, IndexNode> = {};
  const stats: ReconcileStats = {
    filesHashed: 0,
    filesSkippedCached: 0,
    dirsWalked: 0,
    totalFiles: 0,
    totalDirs: 0,
    durationMs: 0,
    changedPaths: [],
    removedPaths: [],
    unchanged: false,
  };

  async function walkDir(absDir: string, relDir: string): Promise<string> {
    stats.dirsWalked++;
    const entries = (await readdir(absDir, { withFileTypes: true }))
      .filter((e) => !ignore.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const children: { name: string; type: "file" | "dir"; hash: string }[] = [];

    for (const entry of entries) {
      const childRel = relDir ? posix.join(relDir, entry.name) : entry.name;
      const absChild = join(absDir, entry.name);

      if (entry.isDirectory()) {
        const hash = await walkDir(absChild, childRel);
        children.push({ name: entry.name, type: "dir", hash });
      } else if (entry.isFile()) {
        const st = await stat(absChild);
        const prevNode = previous?.nodes[childRel];
        let fileHash: string;
        const cacheHit =
          prevNode?.type === "file" && prevNode.size === st.size && prevNode.mtimeMs === st.mtimeMs;

        if (cacheHit) {
          fileHash = (prevNode as FileNode).hash;
          stats.filesSkippedCached++;
        } else {
          fileHash = await hashFile(absChild);
          stats.filesHashed++;
          stats.changedPaths.push(childRel);
        }

        stats.totalFiles++;
        nodes[childRel] = { type: "file", hash: fileHash, size: st.size, mtimeMs: st.mtimeMs };
        children.push({ name: entry.name, type: "file", hash: fileHash });
      }
      // symlinks and other entry types are intentionally not indexed in Phase 0.
    }

    const hash = dirHashOf(children);
    nodes[relDir] = { type: "dir", hash, children: children.map((c) => c.name) };
    stats.totalDirs++;
    return hash;
  }

  const rootHash = await walkDir(rootDir, "");

  if (previous) {
    stats.removedPaths = Object.keys(previous.nodes).filter((p) => !(p in nodes) && p !== "");
  }
  stats.unchanged = previous?.rootHash === rootHash;
  stats.durationMs = Date.now() - start;

  const snapshot: Snapshot = {
    root: rootDir,
    generatedAt: new Date().toISOString(),
    rootHash,
    nodes,
  };

  return { snapshot, stats };
}

/**
 * Apply one file-level change (as reported by the OS file watcher) to an
 * already-built snapshot, in place, touching only the changed leaf and its
 * ancestor chain. Returns the exact list of ancestor directories whose hash
 * had to be recomputed, so callers (and tests) can verify the O(depth) claim
 * directly rather than take it on faith.
 *
 * Limitation (documented, not silently papered over): if `kind === "add"`
 * introduces a brand-new nested directory that has no node in the snapshot
 * yet, this throws rather than guessing a tree shape — that case is left to
 * the next full reconcile(), which always sees the true directory structure.
 */
export async function applyChange(
  snapshot: Snapshot,
  rootDir: string,
  relPath: string,
  kind: "add" | "change" | "unlink",
): Promise<ApplyChangeResult> {
  const rootHashBefore = snapshot.rootHash;
  const posixPath = relPath.split(dirnameSep()).join("/");

  if (kind === "unlink") {
    delete snapshot.nodes[posixPath];
  } else {
    const absPath = join(rootDir, posixPath);
    const st = await stat(absPath);
    const hash = await hashFile(absPath);
    snapshot.nodes[posixPath] = { type: "file", hash, size: st.size, mtimeMs: st.mtimeMs };
  }

  const ancestorsTouched: string[] = [];
  let currentDir = posix.dirname(posixPath);
  if (currentDir === ".") currentDir = "";
  const changedName = posix.basename(posixPath);

  // The add/remove-a-name mutation only ever applies at the *first* (deepest)
  // ancestor — the changed file's immediate parent. Every directory above
  // that already lists the correct child names (a subdirectory doesn't get
  // added or removed just because something inside it changed); those
  // levels only need their hash recomputed from their children's current
  // (just-updated) hashes.
  let isImmediateParent = true;

  for (;;) {
    const dirNode = snapshot.nodes[currentDir] as DirNode | undefined;
    if (!dirNode) {
      throw new Error(
        `applyChange: no existing node for directory "${currentDir}" — run reconcile() first to pick up new directory structure`,
      );
    }

    let childNames = dirNode.children;
    if (isImmediateParent) {
      if (kind === "unlink") {
        childNames = childNames.filter((n) => n !== changedName);
      } else if (!childNames.includes(changedName)) {
        childNames = [...childNames, changedName].sort((a, b) => a.localeCompare(b));
      }
    }
    isImmediateParent = false;

    const childDescriptors = childNames.map((name) => {
      const childRel = currentDir ? posix.join(currentDir, name) : name;
      const node = snapshot.nodes[childRel];
      return { name, type: node.type, hash: node.hash };
    });

    dirNode.children = childNames;
    dirNode.hash = dirHashOf(childDescriptors);
    ancestorsTouched.push(currentDir);

    if (currentDir === "") break;
    currentDir = posix.dirname(currentDir);
    if (currentDir === ".") currentDir = "";
  }

  snapshot.rootHash = (snapshot.nodes[""] as DirNode).hash;

  return {
    path: posixPath,
    kind,
    ancestorsTouched,
    rootHashBefore,
    rootHashAfter: snapshot.rootHash,
  };
}

function dirnameSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
