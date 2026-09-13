import type { AgentMode, ModelOption, ProjectContext, TaskEvent } from "@mobiusx/protocol";

export interface RunnerInput {
  taskId: string;
  mode: AgentMode;
  prompt: string;
  projectContext?: ProjectContext;
  /**
   * The specific model id this run should use, resolved by
   * registry.ts#resolveRunner BEFORE the runner is invoked — always set for
   * every real-model runner by the time it reaches run() (registry.ts never
   * calls a real runner without first picking one of its available models).
   * Ignored by demoRunner, which has no real model behind it.
   */
  modelId?: string;
  /** Aborts when the task is cancelled (see taskEngine.ts's cancelTask). Runners should pass this to any cancellable work (fetch calls, timers) and treat an AbortError as a clean cancellation, not a failure. */
  signal?: AbortSignal;
}

export interface AgentRunner {
  /** Stable identifier surfaced to the caller as TaskSummary.runner — never hidden. */
  name: string;
  run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void>;
  /**
   * The full catalog of models this runner could serve, INCLUDING ones
   * that aren't currently usable (no key set, a local dependency not
   * running/pulled) — see ModelOption's doc comment in @mobiusx/protocol.
   * Called by GET /models (for the picker UI) and by registry.ts#resolveRunner
   * (to check whether a requested/default selection is actually available
   * right now). May do real I/O (e.g. ollamaRunner checking whether Ollama
   * is reachable) — callers should expect it to occasionally take a moment,
   * not assume it's free.
   */
  listModels(): Promise<ModelOption[]>;
}
