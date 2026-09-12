import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "./types.js";

const INDEX_DIR = ".mobiusx-index";
const SNAPSHOT_FILE = "snapshot.json";

export function indexDirFor(rootDir: string): string {
  return join(rootDir, INDEX_DIR);
}

export async function loadSnapshot(rootDir: string): Promise<Snapshot | null> {
  try {
    const raw = await readFile(join(indexDirFor(rootDir), SNAPSHOT_FILE), "utf8");
    return JSON.parse(raw) as Snapshot;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function saveSnapshot(rootDir: string, snapshot: Snapshot): Promise<void> {
  const dir = indexDirFor(rootDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2), "utf8");
}
