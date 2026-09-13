import { createOpenAiCompatibleRunner } from "./openAiCompatibleRunner.js";

/**
 * OpenRouter (https://openrouter.ai) — one API key, many providers' models,
 * including free `:free`-suffixed variants of several open-weight models.
 * Activated by OPENROUTER_API_KEY (get one free at openrouter.ai/keys; the
 * account is free, the models below cost nothing per OpenRouter's own
 * pricing, but are rate-limited on the free tier — see their docs, this
 * gateway doesn't track or enforce those limits itself, it just surfaces
 * whatever error OpenRouter returns if you're throttled).
 *
 * The three model ids below were verified to be real, currently-listed
 * OpenRouter models (checked against openrouter.ai's own model pages) at
 * the time this runner was written — OpenRouter does deprecate/rename
 * free variants over time, so if one of these ever 404s, the fix is to
 * update the id here (and in this comment), not to guess a new one.
 */
export const openrouterRunner = createOpenAiCompatibleRunner({
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  // Optional attribution headers OpenRouter's docs ask third-party apps to
  // send (used for their own leaderboard, not required for the API to work).
  extraHeaders: {
    "HTTP-Referer": "https://mobiusx.ai",
    "X-Title": "MobiusX Desktop",
  },
  models: [
    { model: "meta-llama/llama-3.3-70b-instruct:free", label: "Llama 3.3 70B (free via OpenRouter)", free: true },
    { model: "qwen/qwen-2.5-coder-32b-instruct:free", label: "Qwen2.5-Coder 32B (free via OpenRouter)", free: true },
    { model: "deepseek/deepseek-chat-v3.1:free", label: "DeepSeek V3.1 (free via OpenRouter)", free: true },
  ],
});
