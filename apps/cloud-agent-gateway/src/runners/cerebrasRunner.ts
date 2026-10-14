import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * Cerebras Cloud (https://cerebras.ai) — wafer-scale inference hardware,
 * OpenAI-compatible chat-completions API at https://api.cerebras.ai/v1
 * (confirmed live, Oct 2026, against inference-docs.cerebras.ai/
 * resources/openai). Activated by CEREBRAS_API_KEY.
 *
 * Ported from the MobiusX WEB APP (the CredenceX repo, a separate
 * codebase from this one), where it's already a real, working fallback
 * provider in X-Debug's model chain — see that repo's
 * app/core/ai_config.py#get_cerebras_llm and app/core/settings.py's
 * CEREBRAS_MODEL/CEREBRAS_TPM_LIMIT. This runner mirrors that provider
 * choice and model lineup for this gateway's own OpenAI-compatible
 * factory (see openAiCompatibleRunner.ts), not a from-scratch integration.
 *
 * NOT added to registry.ts's AUTO_PRIORITY, deliberately, for the same
 * reason deepseekRunner.ts isn't — see ModelProvider's doc comment in
 * packages/protocol/src/cloud.ts. Cerebras's free tier here is a $5
 * trial credit, not an indefinitely-free lineup like Groq/OpenRouter's
 * current models: the web app's own settings.py documents a 30K
 * tokens/minute limit on that trial (confirmed live on that account's
 * dashboard), rising to a much larger limit (1.5M TPM, also confirmed
 * live on that account) only after moving to a paid Developer-tier
 * purchase. Which tier THIS gateway's CEREBRAS_API_KEY is actually on is
 * unverified as of writing — never assumed free. A user must explicitly
 * pick Cerebras, same as DeepSeek, so nothing starts metering their
 * account without them choosing that.
 *
 * Two models, both confirmed live via Cerebras's own docs (Oct 2026):
 *  - "gpt-oss-120b" — the same model this gateway already offers for free
 *    via Groq (see groqRunner.ts), but here with Cerebras's much larger
 *    per-minute token budget (confirmed, Oct 2026: a real build-mode task
 *    generating a full Next.js+FastAPI+SQLite app — three files, several
 *    hundred lines — overran Groq's 8K-tokens/minute ceiling twice in a
 *    row via this gateway's one-shot EDITS_MARKER+JSON format, even with
 *    the automatic retry; the identical prompt is the reason this runner
 *    was added). 65K context window, 32K max output tokens per the web
 *    app's own doc comment.
 *  - "qwen-3.8-27b" — Alibaba's Qwen 3.8 27B, also hosted on Cerebras
 *    (confirmed live via Cerebras's own docs and model pages, Oct 2026;
 *    NOT the older "qwen-3-32b" the web app's settings.py notes was
 *    deprecated on Cerebras in Feb 2026 — a different, newer model id).
 *    Same 65K context / 32K max output as gpt-oss-120b per Cerebras's
 *    published specs.
 *
 * If either model 404s or Cerebras's lineup/limits change, re-check
 * https://inference-docs.cerebras.ai/models/overview and this repo's own
 * CredenceX/backend/app/core/settings.py (which tracks this live for the
 * web app) rather than guessing a replacement id or limit from memory.
 */
export const cerebrasRunner = createOpenAiCompatibleRunner({
  provider: "cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKeyEnvVar: "CEREBRAS_API_KEY",
  // Qwen 3.8 defaults to xhigh reasoning. A real Employee Payroll build
  // exhausted Cerebras's full 32K completion budget in private reasoning
  // on both the initial request and the retry, leaving no user-facing
  // answer or edits. Qwen supports low/medium/xhigh reasoning_effort; low
  // bounds its reasoning budget so the request can reach the required
  // structured file output. The same conservative setting is safe for the
  // GPT-OSS model and keeps this provider's build path predictable.
  reasoningEffort: "low",
  // Cerebras documents a 32K completion limit for both listed models.
  // Use that available headroom for full-project JSON edits instead of the
  // generic 8K fallback; other providers keep their own safer defaults.
  maxOutputTokens: 32_000,
  models: [
    {
      model: "gpt-oss-120b",
      label: "GPT-OSS 120B (via Cerebras — same model as Groq's, far larger token budget; $5 free trial, then metered)",
      free: false,
    },
    {
      model: "qwen-3.8-27b",
      label: "Qwen 3.8 27B (via Cerebras; $5 free trial, then metered)",
      free: false,
    },
  ],
});
