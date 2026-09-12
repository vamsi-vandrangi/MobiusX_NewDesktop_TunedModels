import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateWorkspaceKey, type WorkspaceKey } from "./obfuscate.js";

const INDEX_DIR = ".mobiusx-index";
const KEY_FILE = "workspace.key";

export async function loadOrCreateWorkspaceKey(rootDir: string): Promise<WorkspaceKey> {
  const dir = join(rootDir, INDEX_DIR);
  const path = join(dir, KEY_FILE);
  try {
    return Buffer.from(await readFile(path, "utf8"), "base64");
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  const key = generateWorkspaceKey();
  await mkdir(dir, { recursive: true });
  await writeFile(path, key.toString("base64"), "utf8");
  return key;
}
