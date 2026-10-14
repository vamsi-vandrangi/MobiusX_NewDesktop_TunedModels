import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * xKiro's OpenAI-compatible API. Their current public catalog advertises
 * Qwen3 Coder Plus as a free model with function calling. Auto Cloud may use
 * it as a later fallback when its key is configured and earlier candidates
 * fail. Free-tier quotas and upstream availability are controlled by xKiro
 * and may change independently of this app.
 */
export const xkiroRunner = createOpenAiCompatibleRunner({
  provider: "xkiro",
  baseUrl: "https://api.xkiro.com/v1",
  apiKeyEnvVar: "XKIRO_API_KEY",
  // Qwen3 Coder Plus can accept substantially larger completions than the
  // generic 8K ceiling. A real multi-file onboarding build hit exactly 8,192
  // completion tokens, cutting off the JSON before frontend files were
  // emitted; parseBuildResponse then correctly rejected the whole edit set.
  // Give app builds room to finish. xKiro clamps this ceiling to the selected
  // model's supported maximum, per its Chat Completions contract.
  maxOutputTokens: 32_768,
  models: [
    {
      model: "qwen/qwen3-coder-plus:free",
      label: "Qwen3 Coder Plus (free via xKiro; advertised 1.05M context, not yet phase-tested in MobiusX)",
      free: true,
    },
  ],
});
