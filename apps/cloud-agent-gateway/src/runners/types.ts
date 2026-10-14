import type { AgentMode, AppArchitectureMode, GenerationCheckpoint, HistoryTurn, ModelOption, ProjectContext, TaskEvent } from "@mobiusx/protocol";

export interface RunnerInput {
  taskId: string;
  mode: AgentMode;
  prompt: string;
  projectContext?: ProjectContext;
  /** See AppArchitectureMode's doc comment in @mobiusx/protocol and archModeGuidanceBlock in promptShared.ts. Copied straight from CreateTaskRequest.archMode — undefined for any call site that doesn't expose the toggle. */
  archMode?: AppArchitectureMode;
  /** Prior turns from the same AI Assistant panel session — see HistoryTurn's doc comment in @mobiusx/protocol. A chat-style runner should prepend these as real messages (see promptShared.ts#historyMessages) so a follow-up like "show me the output" isn't answered as if it were a fresh, contextless request. Absent or empty for a task with no prior turns (or from a runner/caller that doesn't support it). */
  history?: HistoryTurn[];
  /**
   * The specific model id this run should use, resolved by
   * registry.ts#resolveRunner BEFORE the runner is invoked — always set for
   * every real-model runner by the time it reaches run() (registry.ts never
   * calls a real runner without first picking one of its available models).
   * Ignored by demoRunner, which has no real model behind it.
   */
  modelId?: string;
  /** The caller selected Cloud Auto, so recoverable provider failures may be retried elsewhere. */
  autoCloud?: boolean;
  /** Internal staged-build metadata; never changes the chosen provider/model. */
  stagedBuild?: { index: number; total: number; id: string; final: boolean; repair?: boolean; subtask?: { id: string; targetPaths: string[]; acceptanceCriteria: string[]; targetFileOperations?: Array<{ path: string; action: "create" | "modify"; expectedContentSha256?: string }> } };
  /** Verified server-side checkpoint provided only by POST /tasks/:id/resume. */
  resumeCheckpoint?: GenerationCheckpoint;
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
