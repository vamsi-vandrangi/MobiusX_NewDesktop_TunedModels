/**
 * Best-effort context-window lookup by model id, for the token-usage
 * alerts feature (roadmap-adjacent: "alert the token limits (50/75/90%
 * consumed) to the user while working"). There is no API that reliably
 * returns a model's context window for every provider this gateway talks
 * to (OpenRouter/Groq/Anthropic/Ollama), so this is a small, honestly
 * incomplete table of well-known models rather than a guess dressed up as
 * a fact -- an unmatched model id returns undefined, and callers must
 * treat that as "unknown", never default to some arbitrary number. Matched
 * by substring against the real model id string (e.g.
 * "anthropic/claude-sonnet-4.5" or "qwen/qwen-2.5-coder-32b-instruct:free"),
 * longest/most-specific pattern first so a more precise entry beats a
 * generic family fallback.
 */
const CONTEXT_WINDOWS: Array<{ pattern: string; window: number }> = [
  // Anthropic
  { pattern: "claude-opus-4", window: 200_000 },
  { pattern: "claude-sonnet-4", window: 200_000 },
  { pattern: "claude-haiku-4", window: 200_000 },
  { pattern: "claude-3-7", window: 200_000 },
  { pattern: "claude-3-5", window: 200_000 },
  { pattern: "claude-3", window: 200_000 },
  // OpenAI (via OpenRouter/direct-compatible)
  { pattern: "gpt-5", window: 400_000 },
  { pattern: "gpt-4.1", window: 1_000_000 },
  { pattern: "gpt-4o", window: 128_000 },
  { pattern: "gpt-4-turbo", window: 128_000 },
  { pattern: "o3", window: 200_000 },
  { pattern: "o1", window: 200_000 },
  // Google (via OpenRouter)
  { pattern: "gemini-2.5", window: 1_000_000 },
  { pattern: "gemini-2.0", window: 1_000_000 },
  { pattern: "gemini-1.5-pro", window: 2_000_000 },
  { pattern: "gemini-1.5-flash", window: 1_000_000 },
  // Meta Llama
  { pattern: "llama-3.1", window: 128_000 },
  { pattern: "llama-3.2", window: 128_000 },
  { pattern: "llama-3.3", window: 128_000 },
  { pattern: "llama-4", window: 256_000 },
  // Qwen
  { pattern: "qwen-2.5-coder-32b", window: 128_000 },
  { pattern: "qwen2.5-coder-32b", window: 128_000 },
  { pattern: "qwen-2.5", window: 128_000 },
  { pattern: "qwen3", window: 128_000 },
  // Mistral
  { pattern: "mistral-large", window: 128_000 },
  { pattern: "mixtral-8x22b", window: 64_000 },
  { pattern: "mixtral-8x7b", window: 32_000 },
  // DeepSeek
  { pattern: "deepseek-r1", window: 128_000 },
  { pattern: "deepseek-v3", window: 128_000 },
  // Groq-hosted open models
  { pattern: "gpt-oss-120b", window: 128_000 },
  { pattern: "gpt-oss-20b", window: 128_000 },
  { pattern: "llama-3.1-8b-instant", window: 128_000 },
  { pattern: "llama-3.3-70b-versatile", window: 128_000 },
];

/**
 * Returns the known context window for a model id, or undefined if this
 * table doesn't recognize it (including any Ollama-served local model,
 * which varies by the user's own Modelfile/quantization and can't be
 * guessed here at all).
 */
export function contextWindowFor(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const lower = modelId.toLowerCase();
  let best: { pattern: string; window: number } | undefined;
  for (const entry of CONTEXT_WINDOWS) {
    if (lower.includes(entry.pattern) && (!best || entry.pattern.length > best.pattern.length)) {
      best = entry;
    }
  }
  return best?.window;
}
