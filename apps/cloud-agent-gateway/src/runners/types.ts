import type { AgentMode, ProjectContext, TaskEvent } from "@mobiusx/protocol";

export interface RunnerInput {
  taskId: string;
  mode: AgentMode;
  prompt: string;
  projectContext?: ProjectContext;
}

export interface AgentRunner {
  /** Stable identifier surfaced to the caller as TaskSummary.runner — never hidden. */
  name: string;
  run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void>;
}
