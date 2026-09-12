import type { AgentMode, ProjectContext, TaskEvent } from "@mobiusx/protocol";

export interface RunnerInput {
  taskId: string;
  mode: AgentMode;
  prompt: string;
  projectContext?: ProjectContext;
  /** Aborts when the task is cancelled (see taskEngine.ts's cancelTask). Runners should pass this to any cancellable work (fetch calls, timers) and treat an AbortError as a clean cancellation, not a failure. */
  signal?: AbortSignal;
}

export interface AgentRunner {
  /** Stable identifier surfaced to the caller as TaskSummary.runner — never hidden. */
  name: string;
  run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void>;
}
