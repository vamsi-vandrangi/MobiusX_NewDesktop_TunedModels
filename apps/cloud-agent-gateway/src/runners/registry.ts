import type { AgentSettings, ModelOption, ModelProvider, ModelSelection } from "@mobiusx/protocol";
import type { AgentRunner } from "./types.js";
import { demoRunner } from "./demoRunner.js";
import { anthropicRunner } from "./anthropicRunner.js";
import { openrouterRunner } from "./openrouterRunner.js";
import { groqRunner } from "./groqRunner.js";
import { ollamaRunner } from "./ollamaRunner.js";

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
 * set it up presumably wants used by default); the free providers are
 * tried after, in no particular quality order — just the order they were
 * added.
 */
const AUTO_PRIORITY: ModelProvider[] = ["anthropic", "openrouter", "groq"];

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
 * > `settings.defaultModel` (the user's standing Settings choice) >
 * automatic selection (see AUTO_PRIORITY). A requested/default selection
 * that names an unknown provider, or a model that provider currently
 * reports as unavailable, falls back to automatic selection rather than
 * erroring the whole task — but ALWAYS with a `fallbackNote` explaining
 * why, never silently.
 */
export async function resolveRunner(requested: ModelSelection | undefined, settings: AgentSettings): Promise<ResolvedRunner> {
  const wanted = requested ?? settings.defaultModel;
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
  for (const provider of AUTO_PRIORITY) {
    const runner = RUNNERS[provider];
    const options = await runner.listModels();
    const available = options.find((o) => o.available);
    if (available) return { runner, modelId: available.model };
  }
  return { runner: demoRunner };
}

function describeChoice(resolved: ResolvedRunner): string {
  return resolved.modelId ? `${resolved.runner.name}/${resolved.modelId}` : resolved.runner.name;
}

/** Used by GET /health — a quick one-line summary of what would currently serve a task if nothing were explicitly selected, without exposing the whole picker/settings plumbing there. */
export async function previewAutoRunnerName(): Promise<string> {
  const { runner } = await autoResolve();
  return runner.name;
}
