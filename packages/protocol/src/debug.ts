/**
 * Intelligent Debugger (Phase 2) contract.
 *
 * Scope, honestly: this is *static* code intelligence — semantic-ish code
 * search (chunker + local hashing embeddings from @mobiusx/semantic-index)
 * correlated with git history for the files that turn up. It does not read
 * live logs, traces, or metrics from a running system — that needs real
 * observability integration and MobiusX Cloud (Phase 3). Treat results here
 * as "code + history worth looking at," not an automated root-cause verdict.
 */

export interface DebugIndexResponse {
  provider: string;
  filesConsidered: number;
  filesChunked: number;
  filesRemoved: number;
  chunksIndexed: number;
  totalChunksInStore: number;
  durationMs: number;
}

export interface DebugSearchHit {
  relPath: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface DebugSearchResponse {
  hits: DebugSearchHit[];
  provider: string;
  durationMs: number;
  storeSize: number;
  indexedJustNow: boolean;
}

export interface DebugHistoryEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface DebugHistoryResponse {
  path: string;
  entries: DebugHistoryEntry[];
}
