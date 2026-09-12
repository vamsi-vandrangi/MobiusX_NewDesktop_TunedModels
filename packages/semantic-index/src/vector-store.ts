/**
 * Local, brute-force cosine-similarity vector store.
 *
 * Persisted representation deliberately excludes anything that would leak
 * source code or real file identity:
 *   - `obfuscatedPath` (not the real relPath) identifies the file.
 *   - `startLine`/`endLine`/`kind`/`tokens` describe the chunk's shape only.
 *   - `contentHash` is a one-way SHA-256 of the chunk text, used only to
 *     detect that a chunk changed (skip/replace on rebuild) — it cannot be
 *     inverted back to the source text.
 *   - No `text`, no `symbolPath` (symbol/identifier names are also
 *     code-identifying information) is stored here at all.
 *
 * The real path and the actual snippet text are resolved only at query
 * time, locally, by deobfuscating the path and re-reading the live file
 * from disk (see query.ts). This mirrors the TDD's client-side-snippet
 * privacy stance: what would ever leave the client (if this store were
 * synced to a remote backend) is vectors + shape metadata, never code.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cosineSimilarity } from "./embeddings/provider.js";

export interface VectorRecord {
  id: string;
  obfuscatedPath: string;
  kind: string;
  startLine: number;
  endLine: number;
  tokens: number;
  contentHash: string;
  vector: number[];
}

export interface SearchHit {
  record: VectorRecord;
  score: number;
}

export interface VectorStoreFile {
  provider: string;
  dimensions: number;
  builtAt: string;
  records: VectorRecord[];
}

const STORE_RELATIVE_PATH = join(".mobiusx-index", "vectors.json");

export class VectorStore {
  provider: string;
  dimensions: number;
  private records: VectorRecord[] = [];
  /** obfuscatedPath -> record ids, so rebuilds can drop stale entries for a changed/deleted file in O(1). */
  private byPath = new Map<string, Set<string>>();

  constructor(provider: string, dimensions: number) {
    this.provider = provider;
    this.dimensions = dimensions;
  }

  get size(): number {
    return this.records.length;
  }

  /** Replace all chunks previously indexed for this obfuscated path with a new set (used on rebuild/incremental update). */
  replaceForPath(obfuscatedPath: string, records: VectorRecord[]): void {
    this.removePath(obfuscatedPath);
    for (const r of records) {
      this.records.push(r);
      let set = this.byPath.get(r.obfuscatedPath);
      if (!set) {
        set = new Set();
        this.byPath.set(r.obfuscatedPath, set);
      }
      set.add(r.id);
    }
  }

  removePath(obfuscatedPath: string): void {
    const ids = this.byPath.get(obfuscatedPath);
    if (!ids || ids.size === 0) return;
    this.records = this.records.filter((r) => !ids.has(r.id));
    this.byPath.delete(obfuscatedPath);
  }

  search(queryVector: Float32Array, k: number): SearchHit[] {
    const scored: SearchHit[] = this.records.map((record) => ({
      record,
      score: cosineSimilarity(new Float32Array(record.vector), queryVector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k));
  }

  toFile(): VectorStoreFile {
    return {
      provider: this.provider,
      dimensions: this.dimensions,
      builtAt: new Date().toISOString(),
      records: this.records,
    };
  }

  static fromFile(file: VectorStoreFile): VectorStore {
    const store = new VectorStore(file.provider, file.dimensions);
    store.replaceForPath("__bulk__", []); // no-op, keeps symmetry with replaceForPath bookkeeping
    for (const r of file.records) {
      store.records.push(r);
      let set = store.byPath.get(r.obfuscatedPath);
      if (!set) {
        set = new Set();
        store.byPath.set(r.obfuscatedPath, set);
      }
      set.add(r.id);
    }
    return store;
  }

  async save(rootDir: string): Promise<string> {
    const path = join(rootDir, STORE_RELATIVE_PATH);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.toFile(), null, 2), "utf8");
    return path;
  }

  static async load(rootDir: string): Promise<VectorStore | undefined> {
    const path = join(rootDir, STORE_RELATIVE_PATH);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as VectorStoreFile;
      return VectorStore.fromFile(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  static storeRelativePath(): string {
    return STORE_RELATIVE_PATH;
  }
}
