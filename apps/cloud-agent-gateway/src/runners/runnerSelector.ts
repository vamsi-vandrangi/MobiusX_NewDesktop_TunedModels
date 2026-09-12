import type { AgentRunner } from "./types.js";
import { demoRunner } from "./demoRunner.js";
import { anthropicRunner, isAnthropicConfigured } from "./anthropicRunner.js";

/** The only place that decides which runner serves a task. Add new runners here, not scattered around the codebase. */
export function selectRunner(): AgentRunner {
  if (isAnthropicConfigured()) return anthropicRunner;
  return demoRunner;
}
