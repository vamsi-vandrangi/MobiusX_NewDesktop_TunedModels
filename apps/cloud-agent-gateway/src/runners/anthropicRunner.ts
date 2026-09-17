import type { ModelOption, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { EDITS_MARKER, historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";
import { parseReview, runPersonaReview } from "./personas.js";

// Re-exported so existing imports (test/anthropicRunner.test.ts) keep working
// unchanged now that the underlying implementation lives in promptShared.ts
// (shared with the other chat-style runners) and, for the review pass,
// personas.ts (roadmap Phase 11 — shared across ALL runners now, not just
// this one; see that module's doc comment).
export { EDITS_MARKER, parseBuildResponse, parseReview };

/**
 * Real model calls via Anthropic's Messages API — activated only if the
 * user supplies their own ANTHROPIC_API_KEY and ANTHROPIC_MODEL. Neither is
 * ever hardcoded or defaulted here: this gateway ships with no credentials
 * and no assumed model version, on purpose (model availability changes,
 * and a wrong hardcoded model string fails louder than just staying on the
 * demo runner).
 *
 * Streams token-by-token via the Messages API's `stream: true` mode (SSE)
 * for "ask" and "plan" modes, forwarding each `text_delta` as an "output"
 * TaskEvent as it arrives — the same live-typing experience Claude/Cursor's
 * own chat UIs give. `input.signal` is passed straight to `fetch`, so
 * cancelling a task here aborts the in-flight HTTP request itself, not
 * just the UI's view of it.
 *
 * "build" and "spec" modes are a deliberate exception to live streaming:
 * the model is instructed to end its response with a structured JSON block
 * describing proposed file edits (see promptShared.ts's EDITS_MARKER —
 * "spec" mode proposes a single new requirements-spec markdown file the
 * same way "build" proposes code changes), and that block has to be parsed
 * as a whole, not token-by-token — so for these modes this runner buffers
 * the full response, then emits the prose portion as one "output" event
 * followed by an "edits" event, rather than the live deltas ask/plan get.
 * This is a real, documented trade-off, not an oversight.
 *
 * This is currently the ONLY runner with a second-pass Reviewer agent (see
 * reviewEdits below) — the newer free-model runners don't have one yet, a
 * real scope cut documented in their own module comments and in
 * apps/cloud-agent-gateway/README.md's "Known gaps".
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL);
}

export const anthropicRunner: AgentRunner = {
  name: "anthropic",
  async run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = input.modelId ?? process.env.ANTHROPIC_MODEL;
    if (!apiKey || !model) {
      // registry.ts should prevent this, but never silently fall through to a demo answer
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
          max_tokens: 4096,
          system: systemPrompt,
          messages: [...historyMessages(input), { role: "user", content: input.prompt }],
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

      let sawText: boolean;
      if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
        let fullText = "";
        sawText = await streamSse(res.body, (delta) => {
          fullText += delta;
        });
        if (!sawText) {
          emit({ type: "output", delta: "(model returned no text content)" });
        } else {
          const { prose, edits, droppedCount } = parseBuildResponse(fullText, input);
          emit({ type: "output", delta: prose || fullText });
          if (edits.length > 0) emit({ type: "edits", edits });
          if (droppedCount > 0) {
            emit({
              type: "output",
              delta: `\n\n(${droppedCount} proposed edit(s) omitted: the model tried to "modify" a file it wasn't shown in full, or its edits JSON didn't parse — see apps/cloud-agent-gateway/src/runners/promptShared.ts#parseBuildResponse.)`,
            });
          }
          // Second-pass Reviewer agent (PRD §11/§46). Roadmap Phase 11
          // (source §26) extended this to "spec" mode too (previously
          // excluded — see personas.ts's module doc comment for why: it
          // gives the new Documentation persona a real, reachable mode to
          // review) and formalized the single generic critic into named
          // personas — see personas.ts#runPersonaReview, shared with every
          // other runner now, not just this one.
          if (
            (input.mode === "build" ||
              input.mode === "fix" ||
              input.mode === "database" ||
              input.mode === "architecture" ||
              input.mode === "testing" ||
              input.mode === "spec") &&
            edits.length > 0
          ) {
            await runPersonaReview(input.mode, input, edits, emit, (systemPrompt, userContent) => callAnthropicNonStreamed(apiKey, model, systemPrompt, userContent, input.signal));
          }
        }
      } else {
        sawText = await streamSse(res.body, (delta) => emit({ type: "output", delta }));
        if (!sawText) emit({ type: "output", delta: "(model returned no text content)" });
      }

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

  async listModels(): Promise<ModelOption[]> {
    const model = process.env.ANTHROPIC_MODEL;
    const configured = isAnthropicConfigured();
    return [
      {
        provider: "anthropic",
        model: model ?? "(set ANTHROPIC_MODEL)",
        label: model ? `Claude (${model})` : "Claude (configure ANTHROPIC_API_KEY + ANTHROPIC_MODEL)",
        free: false,
        available: configured,
        unavailableReason: configured ? undefined : "requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL",
      },
    ];
  },
};

/**
 * Thin non-streamed Anthropic Messages API call, used only by the
 * second-pass persona review (see personas.ts#runPersonaReview, which
 * supplies the persona-specific system prompt and receives this as its
 * `callModel` closure). Kept separate from the main streaming call above
 * because a review verdict is small and needed all at once, not
 * token-by-token.
 */
async function callAnthropicNonStreamed(apiKey: string, model: string, systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API returned ${res.status} for the review call`);
  }
  const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
  return (body.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

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
