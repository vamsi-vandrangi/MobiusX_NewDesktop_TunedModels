import type { ModelOption, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { EDITS_MARKER, historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";
import { parseReview, runPersonaReview } from "./personas.js";
import { listAllTools, callMcpTool, toAnthropicToolDefs } from "@mobiusx/mcp-client";

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

      // Broader MCP tool support (source requirement §28): only build/fix
      // mode ever gets tools (the two modes an in-progress code change
      // most plausibly benefits from e.g. a filesystem/git/database MCP
      // server), and only when this project actually has at least one
      // connected server -- listAllTools returns [] instantly for every
      // project without a .mobiusx/mcp.json, so this is a true no-op for
      // the common case, not a behavior change. See mcp-client's doc
      // comment for why this only runs against the Anthropic runner today
      // (a real, documented scope cut -- the free-model runners don't have
      // a tool-use convention wired up yet).
      const mcpTools =
        input.mode === "build" || input.mode === "fix" ? await listAllTools(input.projectContext?.projectPath ?? null) : [];

      const finishStructuredEdits = async (fullText: string, sawText: boolean): Promise<void> => {
        if (!sawText) {
          emit({ type: "output", delta: "(model returned no text content)" });
          return;
        }
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
            input.mode === "devops" ||
            input.mode === "auth" ||
            input.mode === "spec") &&
          edits.length > 0
        ) {
          await runPersonaReview(input.mode, input, edits, emit, (systemPrompt, userContent) => callAnthropicNonStreamed(apiKey, model, systemPrompt, userContent, input.signal));
        }
      };

      if (mcpTools.length > 0) {
        const { fullText, sawText } = await runToolUseLoop(apiKey, model, systemPrompt, input, mcpTools, emit);
        await finishStructuredEdits(fullText, sawText);
      } else {
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

        if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
          let fullText = "";
          const sawText = await streamSse(res.body, (delta) => {
            fullText += delta;
          });
          await finishStructuredEdits(fullText, sawText);
        } else {
          const sawText = await streamSse(res.body, (delta) => emit({ type: "output", delta }));
          if (!sawText) emit({ type: "output", delta: "(model returned no text content)" });
        }
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

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

const MAX_TOOL_ITERATIONS = 6;

/**
 * Broader MCP tool support (source requirement §28): a real, non-streamed
 * multi-turn Anthropic Messages API tool-use loop. Each iteration hands
 * the model every namespaced MCP tool this project has connected (see
 * @mobiusx/mcp-client) as a genuine Anthropic `tools` definition; when the
 * model responds with `stop_reason: "tool_use"`, every tool_use block in
 * that turn is actually executed against its real MCP server
 * (callMcpTool) and fed back as a `tool_result` before the next call —
 * never simulated or answered from the model's own guess. Capped at
 * MAX_TOOL_ITERATIONS so a model that keeps calling tools forever (or a
 * misbehaving server that always errors) can't hang a task indefinitely;
 * hitting the cap ends the loop with whatever text the model had produced
 * in its last turn, same honest "partial" framing verify.ts/hooks.ts use
 * for a timed-out step rather than pretending it finished cleanly.
 *
 * Not streamed (unlike the plain path in `run()` above) because a
 * tool-use turn's content is a structured array of blocks that has to be
 * inspected as a whole to find tool_use entries — there's no meaningful
 * way to stream "the model is 40% through deciding whether to call a
 * tool." Only build/fix mode ever reaches this function (see the mode
 * check in `run()`), and only when the project actually has ≥1 connected
 * MCP server, so the vast majority of tasks never pay a streaming-vs-not
 * trade-off at all.
 */
async function runToolUseLoop(
  apiKey: string,
  model: string,
  systemPrompt: string,
  input: RunnerInput,
  mcpTools: Parameters<typeof toAnthropicToolDefs>[0],
  emit: (event: TaskEvent) => void,
): Promise<{ fullText: string; sawText: boolean }> {
  const toolDefs = toAnthropicToolDefs(mcpTools);
  const messages: { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }[] = [
    ...historyMessages(input),
    { role: "user", content: input.prompt },
  ];

  let finalText = "";
  let sawText = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
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
        messages,
        tools: toolDefs,
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API returned ${res.status}: ${body.slice(0, 500)}`);
    }
    const parsed = (await res.json()) as { content?: AnthropicContentBlock[]; stop_reason?: string };
    const blocks = parsed.content ?? [];

    const textBlocks = blocks.filter((b): b is { type: "text"; text: string } => b.type === "text");
    finalText = textBlocks.map((b) => b.text).join("");
    if (finalText.length > 0) sawText = true;

    const toolUseBlocks = blocks.filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

    if (parsed.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
      break; // model is done — finalText is this turn's answer
    }

    messages.push({ role: "assistant", content: blocks });

    const toolResults: AnthropicContentBlock[] = [];
    for (const call of toolUseBlocks) {
      emit({
        type: "step",
        step: { id: stepId(), label: `Calling MCP tool: ${call.name}`, status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      });
      const result = await callMcpTool(input.projectContext?.projectPath ?? null, call.name, call.input ?? {});
      toolResults.push({ type: "tool_result", tool_use_id: call.id, content: result.content, is_error: result.isError });
    }
    messages.push({ role: "user", content: toolResults });

    if (iteration === MAX_TOOL_ITERATIONS - 1) {
      finalText += `\n\n(Reached the ${MAX_TOOL_ITERATIONS}-iteration MCP tool-call cap for this task — stopping with whatever was produced so far rather than looping indefinitely.)`;
      sawText = true;
    }
  }

  return { fullText: finalText, sawText };
}

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
