import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * Groq (https://groq.com) — hosts a handful of open-weight models on its
 * own fast inference hardware, with a free tier activated by GROQ_API_KEY
 * (get one free at console.groq.com/keys). Groq enforces real per-model
 * rate limits on the free tier and does deprecate/rotate models over time
 * (see console.groq.com/docs/deprecations) — this gateway doesn't track
 * that itself, it just surfaces whatever error Groq returns.
 *
 * Model ids verified against Groq's own docs (console.groq.com/docs/models)
 * at the time this runner was written:
 *  - llama-3.3-70b-versatile — Llama.
 *  - qwen-2.5-coder-32b — Qwen2.5-Coder (Groq does host this exact model).
 *  - deepseek-r1-distill-llama-70b — Groq does NOT host a model literally
 *    named "DeepSeek-Coder"; this is DeepSeek's own R1-distilled reasoning
 *    model, still strong at code, just not the coder-specialized variant.
 *    Labeled honestly below rather than as "DeepSeek-Coder" — see
 *    apps/cloud-agent-gateway/README.md's "Known gaps" for the same caveat.
 */
export const groqRunner = createOpenAiCompatibleRunner({
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY",
  models: [
    { model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (free tier via Groq)", free: true },
    { model: "qwen-2.5-coder-32b", label: "Qwen2.5-Coder 32B (free tier via Groq)", free: true },
    {
      model: "deepseek-r1-distill-llama-70b",
      label: "DeepSeek R1 Distill 70B (free tier via Groq — reasoning model, not literally \"DeepSeek-Coder\")",
      free: true,
    },
  ],
});
