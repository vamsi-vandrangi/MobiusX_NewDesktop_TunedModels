/**
 * Ties the Phase 0 Merkle indexer (@mobiusx/context-engine) and Phase 1's
 * chunker + embeddings + obfuscation + vector store into a single
 * index/query pipeline — the local half of the TDD's §2.2 "@Codebase"
 * pipeline (client-side snippet fetching; nothing but vectors + shape
 * metadata is ever persisted — see vector-store.ts's header).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  reconcile,
  loadSnapshot,
  saveSnapshot,
  hashBytes,
  type Snapshot,
} from "@mobiusx/context-engine";
import { chunkSource } from "./chunker.js";
import { languageForFile, supportedExtensions } from "./languages.js";
import { loadOrCreateWorkspaceKey } from "./workspace-key.js";
import { obfuscatePath, deobfuscatePath } from "./obfuscate.js";
import type { EmbeddingProvider } from "./embeddings/provider.js";
import { HashingEmbeddingProvider } from "./embeddings/hashing.js";
import { VectorStore, type VectorRecord } from "./vector-store.js";

export interface BuildOptions {
  embeddingProvider?: EmbeddingProvider;
}

export interface BuildStats {
  provider: string;
  filesConsidered: number;
  filesChunked: number;
  filesRemoved: number;
  chunksIndexed: number;
  totalChunksInStore: number;
  durationMs: number;
}

export interface QueryOptions {
  embeddingProvider?: EmbeddingProvider;
}

export interface QueryHit {
  relPath: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface QueryResult {
  hits: QueryHit[];
  durationMs: number;
  storeSize: number;
  provider: string;
}

const supportedSet = new Set(supportedExtensions());

function isSupported(relPath: string): boolean {
  const ext = relPath.slice(relPath.lastIndexOf("."));
  return supportedSet.has(ext.toLowerCase());
}

/**
 * Build or incrementally update the semantic index for `rootDir`.
 *
 * Reuses the context-engine's own Merkle snapshot as the change-detection
 * cache: a file only gets re-chunked + re-embedded if `reconcile()` says its
 * content hash actually changed since the last run (or it's new). This is
 * the same incremental-cost story as Phase 0 — cheap re-runs, not a full
 * re-index every time.
 */
export async function buildIndex(rootDir: string, opts: BuildOptions = {}): Promise<BuildStats> {
  const start = Date.now();
  const provider = opts.embeddingProvider ?? new HashingEmbeddingProvider();

  const key = await loadOrCreateWorkspaceKey(rootDir);
  const previousContextSnapshot: Snapshot | null = await loadSnapshot(rootDir);
  const { snapshot, stats: reconcileStats } = await reconcile(rootDir, previousContextSnapshot);
  await saveSnapshot(rootDir, snapshot);

  const store = (await VectorStore.load(rootDir)) ?? new VectorStore(provider.name, provider.dimensions);
  if (store.provider !== provider.name) {
    throw new Error(
      `Existing index at ${rootDir} was built with embedding provider "${store.provider}", ` +
        `but "${provider.name}" was requested. Delete .mobiusx-index/vectors.json to rebuild with a different provider.`,
    );
  }

  for (const removedPath of reconcileStats.removedPaths) {
    if (!isSupported(removedPath)) continue;
    store.removePath(obfuscatePath(key, removedPath));
  }

  const toChunk = reconcileStats.changedPaths.filter(isSupported);
  let filesChunked = 0;
  let chunksIndexed = 0;

  for (const relPath of toChunk) {
    if (!languageForFile(relPath)) continue; // safety net; isSupported already filters by extension
    const absPath = join(rootDir, relPath);
    let source: string;
    try {
      source = await readFile(absPath, "utf8");
    } catch {
      // File vanished between reconcile() and now (e.g. a rapid edit/delete race) — skip, next build picks it up.
      continue;
    }

    const chunks = await chunkSource(relPath, source);
    const obfuscated = obfuscatePath(key, relPath);
    const records: VectorRecord[] = [];

    if (chunks.length > 0) {
      const vectors = await provider.embed(chunks.map((c) => c.text));
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        records.push({
          id: `${obfuscated}#${chunk.startLine}-${chunk.endLine}`,
          obfuscatedPath: obfuscated,
          kind: chunk.kind,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          tokens: chunk.tokens,
          contentHash: hashBytes(chunk.text),
          vector: Array.from(vectors[i]!),
        });
      }
    }

    store.replaceForPath(obfuscated, records);
    filesChunked++;
    chunksIndexed += records.length;
  }

  await store.save(rootDir);

  return {
    provider: provider.name,
    filesConsidered: reconcileStats.totalFiles,
    filesChunked,
    filesRemoved: reconcileStats.removedPaths.filter(isSupported).length,
    chunksIndexed,
    totalChunksInStore: store.size,
    durationMs: Date.now() - start,
  };
}

/**
 * Query the semantic index. Resolves each hit's real path and snippet text
 * locally (by deobfuscating the path and re-reading the live file) — the
 * persisted store itself never held either.
 */
export async function queryIndex(
  rootDir: string,
  queryText: string,
  k: number,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const start = Date.now();
  const provider = opts.embeddingProvider ?? new HashingEmbeddingProvider();

  const key = await loadOrCreateWorkspaceKey(rootDir);
  const store = await VectorStore.load(rootDir);
  if (!store) {
    throw new Error(`No index found at ${rootDir} — run buildIndex() first.`);
  }
  if (store.provider !== provider.name) {
    throw new Error(
      `Index at ${rootDir} was built with embedding provider "${store.provider}", but query requested "${provider.name}".`,
    );
  }

  const [queryVector] = await provider.embed([queryText]);
  const hits = store.search(queryVector!, k);

  const resolved: QueryHit[] = [];
  for (const { record, score } of hits) {
    const relPath = deobfuscatePath(key, record.obfuscatedPath);
    let snippet = "";
    try {
      const source = await readFile(join(rootDir, relPath), "utf8");
      const lines = source.split("\n");
      snippet = lines.slice(record.startLine - 1, record.endLine).join("\n");
    } catch {
      snippet = "(source file no longer readable — index may be stale; rebuild)";
    }
    resolved.push({
      relPath,
      kind: record.kind,
      startLine: record.startLine,
      endLine: record.endLine,
      score,
      snippet,
    });
  }

  return {
    hits: resolved,
    durationMs: Date.now() - start,
    storeSize: store.size,
    provider: provider.name,
  };
}
