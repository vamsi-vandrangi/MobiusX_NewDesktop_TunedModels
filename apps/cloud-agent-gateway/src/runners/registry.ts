import type { AgentMode, AgentSettings, ModelOption, ModelProvider, ModelSelection } from "@mobiusx/protocol";
import type { AgentRunner } from "./types.js";
import { demoRunner } from "./demoRunner.js";
import { anthropicRunner } from "./anthropicRunner.js";
import { openrouterRunner } from "./openrouterRunner.js";
import { groqRunner } from "./groqRunner.js";
import { deepseekRunner } from "./deepseekRunner.js";
import { cerebrasRunner } from "./cerebrasRunner.js";
import { xkiroRunner } from "./xkiroRunner.js";
import { apinexRunner } from "./apinexRunner.js";
import { ollamaRunner } from "./ollamaRunner.js";
import type { AutoModelTier } from "./layaRouter.js";

/**
 * Multi-model support (PRD's model-selection requirement): every runner
 * this gateway knows about, and the ONLY place that decides which one
 * actually serves a task — replaces the old runnerSelector.ts's simple
 * "Anthropic configured? use it : use demo" binary check now that there
 * are several real-model providers to choose between, plus a per-task or
 * standing-default user choice (see resolveRunner below).
 */
export const RUNNERS: Record<ModelProvider, AgentRunner> = {
  demo: demoRunner,
  anthropic: anthropicRunner,
  openrouter: openrouterRunner,
  groq: groqRunner,
  deepseek: deepseekRunner,
  cerebras: cerebrasRunner,
  xkiro: xkiroRunner,
  apinex: apinexRunner,
  ollama: ollamaRunner,
};

/**
 * Providers tried, in this order, when nothing was explicitly requested
 * and the user has no standing default set. Ollama is DELIBERATELY
 * excluded: it depends on local machine state (a background process,
 * locally-pulled models) that shouldn't silently become "the AI
 * Assistant's brain" just because it happens to be running on the user's
 * machine — using it is always an explicit choice, either per-task or as
 * an explicitly-set default (see resolveRunner). Anthropic is tried first
 * when configured (paid, generally the highest-quality option a user who
 * set it up presumably wants used by default).
 *
 * groq before openrouter is NOT arbitrary (it originally was, in
 * provider-added order) -- swapped Sept 2026 after live evidence: every
 * OpenRouter model this gateway could offer a free tier for (see
 * openrouterRunner.ts's history) turned out to be a "reasoning" model that
 * reliably burned its whole token budget on internal chain-of-thought
 * without ever producing a real answer, on perfectly ordinary build-mode
 * prompts, confirmed on two separate live runs. Groq's free-tier models are
 * plain instruction-tuned chat models with no such failure mode observed —
 * a meaningfully safer default until OpenRouter's free catalog looks
 * different. Configured xKiro/APInex free-tier models are later fallbacks;
 * their daily quotas are provider-controlled and a rejected request moves
 * on to the next available candidate.
 */
// "deepseek" and "cerebras" are deliberately absent here too, alongside
// ollama -- see ModelProvider's doc comment in packages/protocol/src/
// cloud.ts: both are paid/metered-after-free-trial providers, so each
// must only ever run when a user explicitly picks it, never as an
// automatic fallback that starts charging their account without them
// choosing that.
const AUTO_PRIORITY: ModelProvider[] = ["anthropic", "groq", "openrouter", "xkiro", "apinex"];

/** Full catalog across every provider — what GET /models returns for the picker UI, availability warts and all. */
export async function listAllModels(): Promise<ModelOption[]> {
  const all = await Promise.all(Object.values(RUNNERS).map((r) => r.listModels()));
  return all.flat();
}

export interface ResolvedRunner {
  runner: AgentRunner;
  /** The specific model id to use — always set unless `runner` is the demo runner (which ignores it). */
  modelId?: string;
  /**
   * Set only when a requested (per-task or default) selection could NOT be
   * honored and the gateway fell back to something else — explaining
   * exactly what was requested, why it wasn't usable, and what ran
   * instead. Never set when the request had no preference at all (that's
   * just normal automatic selection, not a fallback from anything).
   * Surfaced to the caller as TaskSummary.modelNote — a substitution is
   * never made silently.
   */
  fallbackNote?: string;
}

/**
 * Resolves which runner (and which specific model) should serve a task.
 * Priority: `requested` (a per-task override from CreateTaskRequest.model)
 * > `settings.modelRouting?.[mode]` (roadmap Phase 11, source §27 —
 * per-task-type model routing: a standing choice of which model handles
 * THIS task's specific mode) > `settings.defaultModel` (the user's overall
 * standing Settings choice) > automatic selection (see AUTO_PRIORITY). A
 * requested/routed/default selection that names an unknown provider, or a
 * model that provider currently reports as unavailable, falls back to
 * automatic selection rather than erroring the whole task — but ALWAYS
 * with a `fallbackNote` explaining why, never silently.
 *
 * `mode` is required (not optional) precisely so a call site can't forget
 * to pass it and silently skip modelRouting — see taskEngine.ts's call
 * site, the only place `req.mode` is naturally in scope.
 */
export async function resolveRunner(requested: ModelSelection | undefined, settings: AgentSettings, mode: AgentMode): Promise<ResolvedRunner> {
  const wanted = requested ?? settings.modelRouting?.[mode] ?? settings.defaultModel;
  if (!wanted) return autoResolve();

  const runner = RUNNERS[wanted.provider];
  if (!runner) {
    const auto = await autoResolve();
    return { ...auto, fallbackNote: `Unknown model provider "${wanted.provider}" — used ${describeChoice(auto)} instead.` };
  }

  const options = await runner.listModels();
  const match = options.find((o) => o.model === wanted.model);
  if (match?.available) {
    return { runner, modelId: wanted.model };
  }

  const reason = match?.unavailableReason ?? `${wanted.provider}/${wanted.model} is not available right now`;
  const auto = await autoResolve();
  return {
    ...auto,
    fallbackNote: `Requested ${wanted.provider}/${wanted.model}, but ${reason} — used ${describeChoice(auto)} instead.`,
  };
}

async function autoResolve(): Promise<ResolvedRunner> {
  const candidates = await autoRunnerCandidates();
  if (candidates.length) return candidates[0];
  return { runner: demoRunner };
}

/** Configured automatic providers in priority order for runtime failover. */
export async function autoRunnerCandidates(tier: AutoModelTier = "powerful"): Promise<ResolvedRunner[]> {
  const candidates: ResolvedRunner[] = [];
  const priorities: ModelProvider[] = tier === "fast"
    ? ["groq", "openrouter", "xkiro", "apinex", "anthropic"]
    : tier === "balanced"
      ? ["groq", "anthropic", "openrouter", "xkiro", "apinex"]
      : AUTO_PRIORITY;
  for (const provider of priorities) {
    const runner = RUNNERS[provider];
    const options = await runner.listModels();
    const availableOptions = options.filter((o) => o.available);
    const preferredModel = provider === "groq" && tier === "fast" ? "openai/gpt-oss-20b" : undefined;
    const available = (preferredModel ? availableOptions.find((o) => o.model === preferredModel) : undefined) ?? availableOptions[0];
    if (available) candidates.push({ runner, modelId: available.model });
  }
  return candidates;
}

function describeChoice(resolved: ResolvedRunner): string {
  return resolved.modelId ? `${resolved.runner.name}/${resolved.modelId}` : resolved.runner.name;
}

/** Used by GET /health — a quick one-line summary of what would currently serve a task if nothing were explicitly selected, without exposing the whole picker/settings plumbing there. */
export async function previewAutoRunnerName(): Promise<string> {
  const { runner } = await autoResolve();
  return runner.name;
}
