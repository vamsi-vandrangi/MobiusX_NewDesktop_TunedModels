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
 * UPDATED (Sept 2026), twice:
 *
 * 1. The original lineup here (Llama 3.3 70B, Qwen2.5-Coder 32B, DeepSeek
 *    V3.1, all `:free`) all started 404ing -- OpenRouter deprecated the
 *    free tier for every Meta/Qwen/DeepSeek model, full stop (confirmed
 *    live against GET https://openrouter.ai/api/v1/models: those ids
 *    return `endpoints: []`, i.e. zero free providers left; paid versions
 *    of the same ids still exist).
 * 2. Replaced with Nex AGI's Nex-N2.5 Pro/Mini (verified genuinely free at
 *    the time) -- then DROPPED again after two separate live build-mode
 *    runs in this app both failed the same way: the model burned its
 *    entire token budget (tried at both 4096 and a raised 8192 max_tokens)
 *    on internal `delta.reasoning` chain-of-thought that referenced a tool
 *    (`cpa_final_answer`) this gateway never declares, and never reached a
 *    real `delta.content` answer either time. Not a parsing bug on this
 *    gateway's side (see openAiCompatibleRunner.ts's reasoning handling,
 *    which correctly surfaces exactly what happened both times) -- this
 *    looks like a model built for an agentic tool-calling harness this
 *    plain chat-completions gateway doesn't provide, not a fit for
 *    "answer this prompt as text." Left out entirely rather than offered
 *    as a free option that's been shown not to work.
 *
 * Ling 3.0 Flash VL is what's left, from the same live-verified-free
 * check as Nex-N2.5 -- untested by an actual build-mode run as of this
 * writing (unlike Nex-N2.5, it hasn't failed; it just also hasn't been
 * proven to work), and per its own description also a hybrid
 * instant/reasoning model, so the same failure mode is plausible. Flagged
 * honestly in its label below rather than assumed reliable. registry.ts's
 * AUTO_PRIORITY now tries Groq before OpenRouter for exactly this reason
 * -- Groq's models are plain chat models with no observed version of this
 * problem.
 *
 * OpenRouter does deprecate/rename free variants over time regardless --
 * if this 404s next, re-check https://openrouter.ai/api/v1/models and
 * update the id here (and in this comment); never guess a replacement id
 * from memory.
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
    {
      model: "inclusionai/ling-3.0-flash-vl:free",
      label:
        "Ling 3.0 Flash VL (free via OpenRouter — general purpose, 262K context, vision-capable; unverified — a hybrid reasoning model like the Nex-N2.5 models dropped above, may exhibit the same reasoning-only failure)",
      free: true,
    },
  ],
});
