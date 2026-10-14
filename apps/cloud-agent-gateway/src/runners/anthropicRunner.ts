import { BUILD_RESPONSE_CONTRACT_VERSION, type ModelOption, type ProposedEdit, type TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { createStructuredProseStreamer, EDITS_MARKER, historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";
import { parseReview, runPersonaReview } from "./personas.js";
import { maybeExtractAssistantMemory } from "./memoryExtraction.js";
import { listAllTools, callMcpTool, toAnthropicToolDefs } from "@mobiusx/mcp-client";
import { contextWindowFor } from "./contextWindows.js";

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
      label: `Generating response with Anthropic (${model})`,
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

      const finishStructuredEdits = async (fullText: string, sawText: boolean, streamedProse = ""): Promise<void> => {
        if (!sawText) {
          emit({ type: "output", delta: "(model returned no text content)" });
          return;
        }
        let { prose, edits, droppedCount, parseFailed } = parseBuildResponse(fullText, input);

        // One narrowly-scoped retry, same spirit as the other runners'
        // retryForEdits (this runner had none at all before this fix --
        // see parseFailed's doc comment in promptShared.ts for the live
        // failure this closes). Handing the model its own truncated/
        // unparseable prior answer plus one explicit instruction to finish
        // the block properly recovers the common case: the model had the
        // right content, it just ran out of room or malformed the closing
        // fence.
        let retried = false;
        if (parseFailed) {
          retried = true;
          const retry = await retryAnthropicForEdits(apiKey, model, systemPrompt, input, fullText);
          if (retry) {
            if (retry.prose) prose = retry.prose;
            edits = retry.edits;
            droppedCount = retry.droppedCount;
            parseFailed = retry.parseFailed;
          }
        }

        if (!streamedProse) {
          // If the marker starts the response, fullText contains only the
          // machine-readable edit bundle. Never dump it into the chat when
          // there is no user-facing prose prefix.
          const hadMarker = fullText.includes(EDITS_MARKER);
          const visibleText = prose || (hadMarker ? "" : fullText);
          if (visibleText) emit({ type: "output", delta: visibleText });
        }
        else if (retried && prose && prose.trim() !== streamedProse.trim()) {
          emit({ type: "output", delta: `\n\nUpdated response after retry:\n${prose}` });
        }
        if (edits.length > 0) emit({ type: "edits", edits, contractVersion: BUILD_RESPONSE_CONTRACT_VERSION });
        if (parseFailed) {
          // Honest and specific, not the generic "0 edits omitted" count
          // (there's no per-edit count to give -- the whole block failed
          // to parse) and never mislabeled as a clarifying question.
          emit({
            type: "output",
            delta: `\n\n(This response included the file-edit marker${retried ? ", even after asking again," : ""} but the JSON that followed it didn't parse — almost always because the response was cut off before the JSON finished. No files were changed. Try again, or ask for a smaller/more focused change.)`,
          });
        }
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
          (!input.stagedBuild || input.stagedBuild.final) &&
          edits.length > 0
        ) {
          await runPersonaReview(input.mode, input, edits, emit, (systemPrompt, userContent) => callAnthropicNonStreamed(apiKey, model, systemPrompt, userContent, input.signal));
        }
        // Assistant Memory's automatic-extraction call (Oct 2026 addition) —
        // see memoryExtraction.ts's module doc comment for why this is
        // deliberately wired at the same call site as runPersonaReview just
        // above, reusing its exact callModel closure. No-ops unless the
        // user has turned AgentSettings.memoryMode to "auto".
        await maybeExtractAssistantMemory(input, prose || fullText, edits, (systemPrompt, userContent) =>
          callAnthropicNonStreamed(apiKey, model, systemPrompt, userContent, input.signal),
        );
      };

      if (mcpTools.length > 0) {
        const publicProse = createStructuredProseStreamer((delta) => emit({ type: "output", delta }));
        const { fullText, sawText } = await runToolUseLoop(apiKey, model, systemPrompt, input, mcpTools, emit, publicProse);
        await finishStructuredEdits(fullText, sawText, publicProse.finish());
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
            max_tokens: maxTokensFor(input.mode),
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

        let capturedUsage: { inputTokens: number; outputTokens: number } | undefined;
        const onUsage = (usage: { inputTokens: number; outputTokens: number }) => {
          capturedUsage = usage;
        };
        if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
          let fullText = "";
          const publicProse = createStructuredProseStreamer((delta) => emit({ type: "output", delta }));
          const sawText = await streamSse(
            res.body,
            (delta) => {
              fullText += delta;
              publicProse.push(delta);
            },
            onUsage,
          );
          await finishStructuredEdits(fullText, sawText, publicProse.finish());
        } else {
          const sawText = await streamSse(res.body, (delta) => emit({ type: "output", delta }), onUsage);
          if (!sawText) emit({ type: "output", delta: "(model returned no text content)" });
        }
        if (capturedUsage) {
          emit({
            type: "usage",
            usage: {
              promptTokens: capturedUsage.inputTokens,
              completionTokens: capturedUsage.outputTokens,
              totalTokens: capturedUsage.inputTokens + capturedUsage.outputTokens,
              contextWindow: contextWindowFor(model),
            },
          });
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

// Root cause, confirmed live Oct 2026 via the raw-SSE-event diagnostic
// above: every build-mode call used the same flat max_tokens: 4096 as
// plain chat modes (ask/plan), regardless of how much the model actually
// needed to write. A real multi-file response -- several Next.js pages,
// a FastAPI backend split across modules, a seed script, all encoded as
// a single JSON "edits" array -- routinely needs far more than 4096
// output tokens, and when the model hits that ceiling mid-response
// Anthropic's API just stops: stop_reason "max_tokens", whatever text
// streamed before the cutoff (sometimes substantial, sometimes barely a
// paragraph -- that part varies response to response) is ALL there is,
// no EDITS_MARKER, no edits, nothing applied. completionTokens landing
// exactly on 4096 was the tell both times this was reproduced live.
// Scoped to MODES_WITH_STRUCTURED_EDITS specifically (build/fix/database/
// architecture/testing/devops/auth/spec) rather than raised for every
// mode: those are the modes that write real file content and can
// legitimately need this much room; ask/plan stay at the smaller,
// cheaper budget since they're meant to be conversational replies, not
// file dumps.
//
// A real Employee Payroll build on 2026-10-07 exhausted exactly 32,000
// completion tokens on claude-sonnet-4-5-20250929 and left an incomplete
// edit bundle, so the automatic repair call also failed to produce files.
// This model supports up to 64K output tokens; using that ceiling gives
// multi-file builds room to finish while still allowing shorter answers to
// stop naturally as soon as they are complete.
const STRUCTURED_EDITS_MAX_TOKENS = 64_000;
const CHAT_MAX_TOKENS = 4096;
function maxTokensFor(mode: RunnerInput["mode"]): number {
  return MODES_WITH_STRUCTURED_EDITS.has(mode) ? STRUCTURED_EDITS_MAX_TOKENS : CHAT_MAX_TOKENS;
}

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
 * Uses Anthropic's SSE stream for every tool-enabled turn. Public text is
 * forwarded as it arrives (through the structured-output prose filter),
 * while tool_use JSON is buffered until the block is complete so it can be
 * safely validated and executed. Private reasoning blocks are never emitted.
 */
async function runToolUseLoop(
  apiKey: string,
  model: string,
  systemPrompt: string,
  input: RunnerInput,
  mcpTools: Parameters<typeof toAnthropicToolDefs>[0],
  emit: (event: TaskEvent) => void,
  publicProse: ReturnType<typeof createStructuredProseStreamer>,
): Promise<{ fullText: string; sawText: boolean }> {
  const toolDefs = toAnthropicToolDefs(mcpTools);
  const messages: { role: "user" | "assistant"; content: string | AnthropicContentBlock[] }[] = [
    ...historyMessages(input),
    { role: "user", content: input.prompt },
  ];

  let finalText = "";
  let sawText = false;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const modelStepId = stepId();
    const modelStepStartedAt = new Date().toISOString();
    const modelStep = { id: modelStepId, label: `Requesting model response with MCP tools (round ${iteration + 1})`, status: "in_progress" as const, startedAt: modelStepStartedAt };
    emit({ type: "step", step: modelStep });
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
        max_tokens: maxTokensFor(input.mode),
        system: systemPrompt,
        messages,
        tools: toolDefs,
        stream: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API returned ${res.status}: ${body.slice(0, 500)}`);
    }
    if (!res.body) throw new Error("Anthropic tool-use response had no body to stream");
    const { blocks, stopReason } = await streamAnthropicToolTurn(res.body, (text) => {
      publicProse.push(text);
    });
    emit({ type: "step", step: { ...modelStep, status: "completed", completedAt: new Date().toISOString() } });

    const textBlocks = blocks.filter((b): b is { type: "text"; text: string } => b.type === "text");
    finalText = textBlocks.map((b) => b.text).join("");
    if (finalText.length > 0) sawText = true;

    const toolUseBlocks = blocks.filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");

    if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
      break; // model is done — finalText is this turn's answer
    }

    messages.push({ role: "assistant", content: blocks });

    const toolResults: AnthropicContentBlock[] = [];
    for (const call of toolUseBlocks) {
      const toolStep = { id: stepId(), label: `Calling MCP tool: ${call.name}`, status: "in_progress" as const, startedAt: new Date().toISOString() };
      emit({
        type: "step",
        step: toolStep,
      });
      const result = await callMcpTool(input.projectContext?.projectPath ?? null, call.name, call.input ?? {});
      emit({
        type: "step",
        step: { ...toolStep, label: result.isError ? `MCP tool returned an error: ${call.name}` : `Completed MCP tool: ${call.name}`, status: "completed", completedAt: new Date().toISOString() },
      });
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

async function streamAnthropicToolTurn(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<{ blocks: AnthropicContentBlock[]; stopReason?: string }> {
  type BlockBuffer = { type: "text" | "tool_use"; text: string; id?: string; name?: string; input?: Record<string, unknown>; partialInput: string };
  const blocks = new Map<number, BlockBuffer>();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason: string | undefined;

  const consumeEvent = (raw: string) => {
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    let event: {
      type?: string;
      index?: number;
      content_block?: { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    if (event.type === "error") throw new Error(event.error?.message ?? "Anthropic tool-use stream reported an error");
    if (event.type === "content_block_start" && Number.isInteger(event.index) && event.content_block) {
      if (event.content_block.type === "text") {
        blocks.set(event.index!, { type: "text", text: event.content_block.text ?? "", partialInput: "" });
      } else if (event.content_block.type === "tool_use") {
        blocks.set(event.index!, {
          type: "tool_use",
          text: "",
          id: event.content_block.id,
          name: event.content_block.name,
          input: event.content_block.input ?? {},
          partialInput: "",
        });
      }
      return;
    }
    if (event.type === "content_block_delta" && Number.isInteger(event.index) && event.delta) {
      const block = blocks.get(event.index!);
      if (!block) return;
      if (event.delta.type === "text_delta" && event.delta.text) {
        block.text += event.delta.text;
        onText(event.delta.text);
      } else if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
        block.partialInput += event.delta.partial_json;
      }
      return;
    }
    if (event.type === "message_delta") stopReason = event.delta?.stop_reason;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        consumeEvent(raw);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const completed: AnthropicContentBlock[] = [];
  for (const block of [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
    if (block.type === "text") {
      completed.push({ type: "text", text: block.text });
    } else {
      let input = block.input ?? {};
      if (block.partialInput) {
        try {
          const parsed = JSON.parse(block.partialInput);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tool input must be a JSON object");
          input = parsed as Record<string, unknown>;
        } catch (err) {
          throw new Error(`Anthropic returned invalid JSON for an MCP tool call: ${(err as Error).message}`);
        }
      }
      if (!block.id || !block.name) throw new Error("Anthropic returned an incomplete MCP tool call");
      completed.push({ type: "tool_use", id: block.id, name: block.name, input });
    }
  }
  return { blocks: completed, stopReason };
}

/**
 * One narrowly-scoped retry for when a build/spec-mode response included
 * EDITS_MARKER but the JSON after it failed to parse under every strategy
 * (see promptShared.ts's parseBuildResponse / parseFailed doc comment for
 * the live failure this was written for -- a real claude-sonnet-4-5 build
 * task that streamed for 2+ minutes and still produced zero files, with no
 * warning shown anywhere before this fix). Mirrors
 * openAiCompatibleRunner.ts's retryForEdits: hands the model its own prior
 * (truncated/malformed) answer as assistant-turn context, plus one new
 * user message insisting it finish the block properly, and re-parses
 * whatever comes back the same way the main response is parsed. Streamed,
 * same as the main path, so a genuinely large corrected response isn't
 * capped any tighter than the first attempt. Returns null on any failure
 * of the retry itself so the caller falls back cleanly to the original
 * (if incomplete) response instead of losing it to a retry error.
 */
async function retryAnthropicForEdits(
  apiKey: string,
  model: string,
  systemPrompt: string,
  input: RunnerInput,
  priorAssistantText: string,
): Promise<{ prose: string; edits: ProposedEdit[]; droppedCount: number; parseFailed: boolean } | null> {
  try {
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
        max_tokens: maxTokensFor(input.mode),
        system: systemPrompt,
        messages: [
          ...historyMessages(input),
          { role: "user", content: input.prompt },
          { role: "assistant", content: priorAssistantText },
          {
            role: "user",
            content: `Your previous answer included the ${EDITS_MARKER} marker, but the JSON that followed it was incomplete or malformed — most likely it was cut off before finishing. Respond again from the start. Keep the prose brief and preserve the full requested application scope: implement every requested core feature, and include all files necessary for the application to run. Reduce duplicated boilerplate and explanatory text instead of dropping features or omitting necessary files. Then write ${EDITS_MARKER} on its own line, followed by one fenced json code block containing the complete content of every file in an "edits" array. Ensure the JSON and closing fence are complete.`,
          },
        ],
        stream: true,
      }),
    });
    if (!res.ok || !res.body) return null;
    let retryText = "";
    const sawText = await streamSse(res.body, (delta) => {
      retryText += delta;
    });
    if (!sawText) return null;
    return parseBuildResponse(retryText, input);
  } catch {
    // AbortError, network failure, etc. -- the caller falls back to the
    // original (unparsed) response rather than losing it to a retry error.
    return null;
  }
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
async function streamSse(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawText = false;
  // Anthropic reports usage across two event types: `message_start` carries
  // the real input_tokens once, up front; `message_delta` carries a
  // cumulative output_tokens that updates as the response streams. Track
  // both and re-report on every update -- the caller just keeps whatever
  // it saw last, which by the time the stream ends is the final total.
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const reportUsage = () => {
    if (onUsage && inputTokens !== undefined && outputTokens !== undefined) {
      onUsage({ inputTokens, outputTokens });
    }
  };

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

        let parsed: {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { message?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };
        try {
          parsed = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue; // malformed/partial event line — skip rather than crash the whole task on one bad chunk
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && parsed.delta.text) {
          onText(parsed.delta.text);
          sawText = true;
        } else if (parsed.type === "message_start" && typeof parsed.message?.usage?.input_tokens === "number") {
          inputTokens = parsed.message.usage.input_tokens;
          reportUsage();
        } else if (parsed.type === "message_delta" && typeof parsed.usage?.output_tokens === "number") {
          outputTokens = parsed.usage.output_tokens;
          reportUsage();
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
