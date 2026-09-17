import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * DeepSeek's own API (https://platform.deepseek.com) — NOT the free-tier
 * pattern the other runners here follow. This is a paid, metered provider:
 * DEEPSEEK_API_KEY comes from platform.deepseek.com (a separate signup and
 * billing relationship, distinct from OpenRouter/Groq), and every request
 * costs real money against that account. Added Sept 2026 at the user's
 * explicit request, after confirming live (via api-docs.deepseek.com) that:
 *
 *  - Base URL is https://api.deepseek.com (no "/v1" segment) and the API is
 *    documented as OpenAI-compatible -- same request/response shape this
 *    gateway's shared openAiCompatibleRunner.ts factory already handles.
 *  - The model formerly called "DeepSeek V4-Flash" is now DeepSeek-V4.1-Flash,
 *    with the model ID string "deepseek-flash" (the old "deepseek-v4-flash"
 *    name is accepted as a legacy alias but silently routes to the same
 *    V4.1-Flash model, so this runner uses the current, non-deprecated ID).
 *  - Roughly $0.15-0.30/M input tokens and $0.60-1.20/M output tokens
 *    depending on cache hits and peak/off-peak UTC hours -- see
 *    api-docs.deepseek.com/quick_start/pricing for current rates before
 *    relying on this comment; pricing pages change without notice.
 *
 * NOT independently confirmed live end-to-end through this gateway yet
 * (no DeepSeek API key was available to test with while writing this) --
 * the SSE streaming format specifically (choices[0].delta.content chunks
 * terminated by "data: [DONE]") is DeepSeek's documented OpenAI-compatible
 * behavior, not something this gateway has itself verified against a real
 * response. If it 400s/404s or streams differently than expected, that's
 * the first thing to check, the same way openrouterRunner.ts and
 * groqRunner.ts's model lists have both needed real-world correction after
 * being added.
 *
 * Deliberately excluded from registry.ts's AUTO_PRIORITY (see
 * ModelProvider's doc comment in packages/protocol/src/cloud.ts) -- a paid
 * provider must never be silently auto-selected. It only ever runs when a
 * user explicitly picks it (Settings default or per-task).
 */
export const deepseekRunner = createOpenAiCompatibleRunner({
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKeyEnvVar: "DEEPSEEK_API_KEY",
  models: [
    {
      model: "deepseek-flash",
      label: "DeepSeek V4.1-Flash (paid — DeepSeek's own API, ~$0.15-0.30/M in, $0.60-1.20/M out)",
      free: false,
    },
  ],
});
