import type { EditReview, ModelOption, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { EDITS_MARKER, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";

// Re-exported so existing imports (test/anthropicRunner.test.ts) keep working
// unchanged now that the underlying implementation lives in promptShared.ts,
// shared with the other chat-style runners (openrouter/groq/ollama).
export { EDITS_MARKER, parseBuildResponse };

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
          // Second-pass Reviewer agent (PRD §11/§46) — only for real code
          // edits (build mode), not spec mode's requirements documents.
          // A distinct model call with a critic persona, run automatically
          // so the user sees a review alongside the diff, not something
          // they have to separately request.
          if (input.mode === "build" && edits.length > 0) {
            await reviewEdits(apiKey, model, input, edits, emit);
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
 * The second-pass Reviewer agent (PRD §11/§46): a distinct, non-streamed
 * Anthropic call with a critic system prompt, given the original request
 * and the full proposed edits, expected to answer with a small JSON
 * verdict. This is a genuinely separate model call (not a re-labeling of
 * the first response) — it can disagree with the edits it's reviewing.
 *
 * Failure modes are handled conservatively, never by silently approving:
 * a review call that errors (network, non-2xx, cancellation aside) or
 * whose response doesn't parse as {verdict, summary} is reported as
 * verdict "concerns" with an honest explanation, rather than dropped or
 * defaulted to "approve". An AbortError is re-thrown so cancellation
 * during review is handled uniformly by run()'s own catch block (the
 * whole task ends up "cancelled", not "completed" with a missing review).
 */
async function reviewEdits(
  apiKey: string,
  model: string,
  input: RunnerInput,
  edits: ProposedEdit[],
  emit: (event: TaskEvent) => void,
): Promise<void> {
  const step = {
    id: stepId(),
    label: "Running second-pass code review",
    status: "in_progress" as const,
    startedAt: new Date().toISOString(),
  };
  emit({ type: "step", step });

  try {
    const userContent = [
      `Original request: "${input.prompt}"`,
      "",
      "Proposed edits:",
      ...edits.map((e) => `--- ${e.path} (${e.action}) ---\n${e.content}`),
    ].join("\n\n");

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
        system: reviewSystemPrompt(),
        messages: [{ role: "user", content: userContent }],
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API returned ${res.status} for the review call`);
    }
    const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");

    emit({ type: "review", review: parseReview(text) });
    emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    emit({
      type: "review",
      review: {
        verdict: "concerns",
        summary: `Second-pass review could not be completed: ${(err as Error).message}`,
      },
    });
    emit({ type: "step", step: { ...step, status: "completed", completedAt: new Date().toISOString() } });
  }
}

function reviewSystemPrompt(): string {
  return [
    "You are a Code Reviewer Agent — a second, independent pass over another agent's proposed file edits, run automatically before a human decides whether to apply them.",
    "Assess: correctness risk, security concerns (hardcoded secrets, injection, unsafe input handling), whether the change actually addresses the stated request, and obvious code-quality issues.",
    'Respond with EXACTLY one JSON object and nothing else: {"verdict": "approve" | "concerns", "summary": "1-3 sentences explaining the verdict"}.',
    'Use "concerns" whenever you are not confident the change is correct and safe — do not default to "approve" out of politeness or to avoid conflict.',
  ].join("\n");
}

/** Lenient JSON extraction matching parseBuildResponse's style, but with a safe default: an unparseable review is reported as "concerns", never silently dropped or upgraded to "approve". */
export function parseReview(text: string): EditReview {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : text).trim();
  try {
    const parsed = JSON.parse(jsonText) as { verdict?: unknown; summary?: unknown };
    if ((parsed.verdict === "approve" || parsed.verdict === "concerns") && typeof parsed.summary === "string") {
      return { verdict: parsed.verdict, summary: parsed.summary };
    }
  } catch {
    /* fall through to the safe default below */
  }
  return {
    verdict: "concerns",
    summary: "Reviewer response could not be parsed as a verdict — treating as unreviewed rather than silently approving.",
  };
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
