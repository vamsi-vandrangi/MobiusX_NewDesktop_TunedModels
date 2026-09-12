import { buildIndex, queryIndex, type BuildStats } from "@mobiusx/semantic-index";
import type { DebugIndexResponse, DebugSearchHit } from "@mobiusx/protocol";

/**
 * Lexical/hashing embeddings by default (no external dependency, always
 * works offline). A real embedding provider (e.g. Ollama, if reachable on
 * the user's machine) can be swapped in later — see
 * @mobiusx/semantic-index's EmbeddingProvider — without changing this
 * module's shape.
 */

function toIndexResponse(stats: BuildStats): DebugIndexResponse {
  return {
    provider: stats.provider,
    filesConsidered: stats.filesConsidered,
    filesChunked: stats.filesChunked,
    filesRemoved: stats.filesRemoved,
    chunksIndexed: stats.chunksIndexed,
    totalChunksInStore: stats.totalChunksInStore,
    durationMs: stats.durationMs,
  };
}

export async function buildSemanticIndex(rootDir: string): Promise<DebugIndexResponse> {
  const stats = await buildIndex(rootDir);
  return toIndexResponse(stats);
}

export async function searchSemanticIndex(
  rootDir: string,
  query: string,
  k: number,
): Promise<{ hits: DebugSearchHit[]; provider: string; durationMs: number; storeSize: number }> {
  const result = await queryIndex(rootDir, query, k);
  return {
    hits: result.hits.map((h) => ({
      relPath: h.relPath,
      kind: h.kind,
      startLine: h.startLine,
      endLine: h.endLine,
      score: h.score,
      snippet: h.snippet,
    })),
    provider: result.provider,
    durationMs: result.durationMs,
    storeSize: result.storeSize,
  };
}
