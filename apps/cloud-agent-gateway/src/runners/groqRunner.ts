import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * Groq (https://groq.com) — hosts a handful of open-weight models on its
 * own fast inference hardware, with a free tier activated by GROQ_API_KEY
 * (get one free at console.groq.com/keys). Groq enforces real per-model
 * rate limits on the free tier and does deprecate/rotate models over time
 * (see console.groq.com/docs/deprecations) — this gateway doesn't track
 * that itself, it just surfaces whatever error Groq returns.
 *
 * UPDATED (Sept 2026): the original lineup here (llama-3.3-70b-versatile,
 * qwen-2.5-coder-32b, deepseek-r1-distill-llama-70b) all 404 now --
 * confirmed live against console.groq.com/docs/deprecations and
 * console.groq.com/docs/rate-limits: Groq moved its Llama chat models
 * (llama-3.1-8b-instant, llama-3.3-70b-versatile) to Enterprise-only
 * ("This deprecation applies to free and developer-tier usage"), and no
 * longer hosts any DeepSeek model at all. The free-tier rate-limits table
 * (the authoritative source -- it lists real, non-zero limits per model)
 * currently shows these as the genuinely free general-purpose/coding
 * options:
 *  - openai/gpt-oss-120b / openai/gpt-oss-20b — OpenAI's own open-weight
 *    (Apache-licensed) models, hosted on Groq's free tier. Not a
 *    Llama/Qwen/DeepSeek model despite the provider being "Groq" -- Groq
 *    is an inference host, not a model family.
 * Also on the free tier per that same table but deliberately NOT added
 * here: groq/compound and groq/compound-mini (Groq's own agentic system
 * with built-in tool use/web search, not a plain chat-completions model --
 * likely needs different handling than this runner's factory assumes;
 * out of scope for now rather than guessed at).
 *
 * REMOVED (Sept 2026): qwen/qwen3.8-27b, which was briefly listed here
 * alongside the two GPT-OSS models. Real, repeated live evidence over
 * several separate build-mode attempts in the same project (a student
 * admissions app) showed it reliably failing this gateway's required
 * EDITS_MARKER+JSON format -- writing a confident, specific prose plan
 * and then simply never attempting the format, even after this runner's
 * one-shot automatic retry (see openAiCompatibleRunner.ts#retryForEdits)
 * explicitly demanded it. Separately, it also hit a hard structural wall
 * on Groq's free-tier rate limits: a 429 reporting "output tokens per
 * minute (OTPM): Limit 1000, Requested 8192" -- this runner's fixed
 * max_tokens (8192, see openAiCompatibleRunner.ts) alone exceeds this
 * model's entire per-minute budget on the free tier, so no request of
 * any real build-mode size can ever complete on it, retries included.
 * Between the format non-compliance and the token ceiling, it was never
 * going to be usable for build/spec mode -- pulled rather than left in
 * the picker as a trap. If Groq's rate limits or this model's
 * instruction-following change later, re-add with a fresh live test,
 * not by assumption.
 */
export const groqRunner = createOpenAiCompatibleRunner({
  provider: "groq",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY",
  // Groq's GPT-OSS default is medium reasoning. For structured-edit tasks,
  // it has repeatedly consumed the whole 8k response budget without ever
  // reaching delta.content; low effort leaves the budget for actual code.
  reasoningEffort: "low",
  models: [
    { model: "openai/gpt-oss-120b", label: "GPT-OSS 120B (free tier via Groq)", free: true },
    { model: "openai/gpt-oss-20b", label: "GPT-OSS 20B (free tier via Groq — lighter/faster)", free: true },
  ],
});
