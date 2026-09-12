import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { reconcile, type Snapshot } from "@mobiusx/context-engine";
import type { FsNode, FsReadResponse } from "@mobiusx/protocol";

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
