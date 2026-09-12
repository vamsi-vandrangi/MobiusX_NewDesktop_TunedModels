// Default, always-available embedding provider. This is deliberately NOT a
// neural embedding — it's a feature-hashing (the "hashing trick") bag-of-
// tokens vectorizer: a well-established, real lexical-similarity technique
// (the same family BM25/TF-IDF belong to — notably, CadenceX's existing
// platform RAG work already leans on BM25), not a placeholder pretending to
// be semantic search. It finds chunks that share identifiers and keywords;
// it does not understand that `computeTotal` and `getSum` are related. Swap
// in OllamaEmbeddingProvider (same interface) the moment a real model is
// reachable — nothing else in the pipeline needs to change.
import type { EmbeddingProvider } from "./provider.js";

const DIMENSIONS = 256;

function tokenize(text: string): string[] {
  // Split on non-alphanumeric runs, then split camelCase/PascalCase boundaries
  // so `validateOrderPayload` contributes `validate`, `order`, `payload` as
  // separate lexical signals rather than one opaque blob.
  return text
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((word) => word.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1);
}

// Two independent FNV-1a variants: one picks the feature's index, the other
// its sign. Using separate hashes for index/sign is the standard mitigation
// for the hashing trick's collision bias (Weinberger et al., 2009).
function fnv1a(str: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hashing-lexical-v1";
  readonly dimensions = DIMENSIONS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): Float32Array {
    const vector = new Float32Array(DIMENSIONS);
    for (const token of tokenize(text)) {
      const index = fnv1a(token, 0x811c9dc5) % DIMENSIONS;
      const sign = fnv1a(token, 0x9e3779b9) % 2 === 0 ? 1 : -1;
      vector[index]! += sign;
    }
    let norm = 0;
    for (let i = 0; i < DIMENSIONS; i++) norm += vector[i]! * vector[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < DIMENSIONS; i++) vector[i]! /= norm;
    }
    return vector;
  }
}
