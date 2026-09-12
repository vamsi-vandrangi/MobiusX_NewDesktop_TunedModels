import type { TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";

/**
 * Real model calls via Anthropic's Messages API — activated only if the
 * user supplies their own ANTHROPIC_API_KEY and ANTHROPIC_MODEL. Neither is
 * ever hardcoded or defaulted here: this gateway ships with no credentials
 * and no assumed model version, on purpose (model availability changes,
 * and a wrong hardcoded model string fails louder than just staying on the
 * demo runner). Single request/response, not token-level streaming yet —
 * see apps/cloud-agent-gateway/README.md for that follow-up.
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL);
}

export const anthropicRunner: AgentRunner = {
  name: "anthropic",
  async run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL;
    if (!apiKey || !model) {
      // runnerSelector.ts should prevent this, but never silently fall through to a demo answer
      // labeled as if it came from a real model — fail loudly instead.
      emit({ type: "error", message: "ANTHROPIC_API_KEY or ANTHROPIC_MODEL not set" });
      emit({ type: "done" });
      return;
    }

    emit({ type: "status", status: "running" });
    const step = { id: stepId(), label: "Calling Anthropic API", status: "in_progress" as const, startedAt: new Date().toISOString() };
    emit({ type: "step", step });

    try {
      const systemPrompt = systemPromptFor(input);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: input.prompt }],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API returned ${res.status}: ${body.slice(0, 500)}`);
      }

      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (data.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");

      emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
      emit({ type: "output", delta: text || "(model returned no text content)" });
      emit({ type: "status", status: "completed" });
      emit({ type: "done" });
    } catch (err) {
      emit({ type: "error", message: (err as Error).message });
      emit({ type: "done" });
    }
  },
};

function systemPromptFor(input: RunnerInput): string {
  const base =
    input.mode === "ask"
      ? "You are the MobiusX Desktop AI Assistant, answering a developer's question."
      : input.mode === "plan"
        ? "You are the MobiusX Desktop AI Assistant. Draft a concrete, numbered implementation plan — do not write full code."
        : "You are the MobiusX Desktop AI Assistant. Describe the proposed change in prose (this gateway does not apply changes automatically) — do not claim you modified any files.";

  const files = input.projectContext?.relevantFiles ?? [];
  const context = files.length
    ? `\n\nRelevant code the user's local agent found:\n${files.map((f) => `--- ${f.relPath} ---\n${f.snippet}`).join("\n\n")}`
    : "";
  return base + context;
}

function stepId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
