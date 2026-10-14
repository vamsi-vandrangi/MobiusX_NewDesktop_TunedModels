import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * APInex's OpenAI-compatible API. Their public catalog currently lists
 * DeepSeek V4.1 Flash in the free category. Auto Cloud may use it as a later
 * fallback when its key is configured and earlier candidates fail. APInex
 * advertises a daily free-category token allowance; the actual quota, rate
 * limits and upstream availability remain account/provider controlled.
 */
export const apinexRunner = createOpenAiCompatibleRunner({
  provider: "apinex",
  baseUrl: "https://api.apinex.bond/v1",
  apiKeyEnvVar: "APINEX_API_KEY",
  models: [
    {
      model: "free/deepseek-v4.1-flash",
      label: "DeepSeek V4.1 Flash (free category via APInex; advertised 1.05M context, not yet phase-tested in MobiusX)",
      free: true,
    },
  ],
});
