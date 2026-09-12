import type { TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";

/**
 * Real model calls via Anthropic's Messages API — activated only if the
 * user supplies their own ANTHROPIC_API_KEY and ANTHROPIC_MODEL. Neither is
 * ever hardcoded or defaulted here: this gateway ships with no credentials
 * and no assumed model version, on purpose (model availability changes,
 * and a wrong hardcoded model string fails louder than just staying on the
 * demo runner).
 *
 * Streams token-by-token via the Messages API's `stream: true` mode (SSE),
 * forwarding each `text_delta` as an "output" TaskEvent as it arrives —
 * the same live-typing experience Claude/Cursor's own chat UIs give.
 * `input.signal` is passed straight to `fetch`, so cancelling a task here
 * aborts the in-flight HTTP request itself, not just the UI's view of it.
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
    const step = {
      id: stepId(),
      label: "Streaming response from Anthropic API",
      status: "in_progress" as const,
      startedAt: new Date().toISOString(),
    };
    emit({ type: "step", step });

    try {
      const systemPrompt = systemPromptFor(input);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: input.signal,
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
          stream: true,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API returned ${res.status}: ${body.slice(0, 500)}`);
      }
      if (!res.body) {
        throw new Error("Anthropic API response had no body to stream");
      }

      const sawText = await streamSse(res.body, (delta) => emit({ type: "output", delta }));

      if (!sawText) emit({ type: "output", delta: "(model returned no text content)" });
      emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
      emit({ type: "status", status: "completed" });
      emit({ type: "done" });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        emit({ type: "status", status: "cancelled" });
        emit({ type: "done" });
        return;
      }
      emit({ type: "error", message: (err as Error).message });
      emit({ type: "done" });
    }
  },
};

/**
 * Reads an Anthropic Messages API SSE stream, forwarding each `text_delta`
 * chunk's text via `onText` as it arrives. Returns whether any text was
 * seen at all, so the caller can fall back to a placeholder if not.
 * See https://docs.claude.com/en/api/messages-streaming for the event shapes.
 */
async function streamSse(body: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawText = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        let parsed: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
        try {
          parsed = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue; // malformed/partial event line — skip rather than crash the whole task on one bad chunk
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && parsed.delta.text) {
          onText(parsed.delta.text);
          sawText = true;
        } else if (parsed.type === "error") {
          throw new Error(parsed.error?.message ?? "Anthropic stream reported an error");
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sawText;
}

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
