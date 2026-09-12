// Deliberately not a real tokenizer (no tiktoken/BPE dependency) — a
// char-per-token heuristic (~4 chars/token is the commonly-cited average
// for English/code) is good enough to bound chunk sizes for an embedding
// model's input window. If this proves too imprecise once a real model is
// wired in (TDD §4.3), swap this one function.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
