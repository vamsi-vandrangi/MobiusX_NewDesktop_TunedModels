import type { ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";

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
 * "build" mode is a deliberate exception to live streaming: the model is
 * instructed to end its response with a structured JSON block describing
 * proposed file edits (see EDITS_MARKER below), and that block has to be
 * parsed as a whole, not token-by-token — so for build mode this runner
 * buffers the full response, then emits the prose portion as one "output"
 * event followed by an "edits" event, rather than the live deltas ask/plan
 * get. This is a real, documented trade-off, not an oversight.
 */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL);
}

/** Marks the boundary between the model's human-readable summary and the machine-readable edits JSON block in a build-mode response. Never shown to the user. */
export const EDITS_MARKER = "===MOBIUSX_EDITS===";

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
      if (input.mode === "build") {
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
              delta: `\n\n(${droppedCount} proposed edit(s) omitted: the model tried to "modify" a file it wasn't shown in full, or its edits JSON didn't parse — see apps/cloud-agent-gateway/src/runners/anthropicRunner.ts#parseBuildResponse.)`,
            });
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

/**
 * Splits a build-mode response into its human-readable prose and its
 * proposed edits, and validates every edit against the one safety
 * invariant this gateway can actually check without disk access: a
 * "modify" is only honored if the model was shown that path's FULL
 * content (not just a search snippet) earlier in this same request — see
 * ProjectContext.relevantFiles in @mobiusx/protocol. "create" can't be
 * validated here (the gateway never has a real file listing) — the
 * desktop agent enforces create-must-not-exist itself before writing
 * anything (see apps/desktop-agent/src/fsOps.ts#applyEdits). Parsing is
 * deliberately lenient: if the marker or JSON is missing or malformed,
 * this returns the raw text as prose and an empty edits list rather than
 * throwing — a build-mode task that didn't produce a parseable proposal
 * should still show its reasoning, not fail outright.
 */
export function parseBuildResponse(
  fullText: string,
  input: RunnerInput,
): { prose: string; edits: ProposedEdit[]; droppedCount: number } {
  const markerIdx = fullText.indexOf(EDITS_MARKER);
  if (markerIdx === -1) return { prose: fullText, edits: [], droppedCount: 0 };

  const prose = fullText.slice(0, markerIdx).trim();
  const rest = fullText.slice(markerIdx + EDITS_MARKER.length);

  // Strip a ```json ... ``` (or bare ``` ... ```) fence if present; otherwise use the raw remainder.
  const fenceMatch = rest.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenceMatch ? fenceMatch[1] : rest).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { prose, edits: [], droppedCount: 0 };
  }

  const rawEdits =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { edits?: unknown }).edits)
      ? (parsed as { edits: unknown[] }).edits
      : [];

  const modifiableRelPaths = new Set(
    (input.projectContext?.relevantFiles ?? []).filter((f) => f.content !== undefined).map((f) => f.relPath),
  );

  const edits: ProposedEdit[] = [];
  let droppedCount = 0;
  for (const raw of rawEdits) {
    if (!raw || typeof raw !== "object") {
      droppedCount++;
      continue;
    }
    const e = raw as { path?: unknown; action?: unknown; content?: unknown };
    if (typeof e.path !== "string" || !e.path || typeof e.content !== "string") {
      droppedCount++;
      continue;
    }
    if (e.action !== "modify" && e.action !== "create") {
      droppedCount++;
      continue;
    }
    // Cheap sanity check — the desktop agent's resolveWithinProject is the real guard,
    // but there's no reason to even propose something this obviously wrong.
    if (e.path.startsWith("/") || e.path.split("/").includes("..")) {
      droppedCount++;
      continue;
    }
    if (e.action === "modify" && !modifiableRelPaths.has(e.path)) {
      droppedCount++;
      continue;
    }
    edits.push({ path: e.path, action: e.action, content: e.content });
  }

  return { prose, edits, droppedCount };
}

function systemPromptFor(input: RunnerInput): string {
  if (input.mode === "ask") {
    return (
      "You are the MobiusX Desktop AI Assistant, answering a developer's question." + relevantFilesContext(input, false)
    );
  }
  if (input.mode === "plan") {
    return (
      "You are the MobiusX Desktop AI Assistant. Draft a concrete, numbered implementation plan — do not write full code." +
      relevantFilesContext(input, false)
    );
  }

  const fullContentPaths = (input.projectContext?.relevantFiles ?? [])
    .filter((f) => f.content !== undefined)
    .map((f) => f.relPath);

  return [
    "You are the MobiusX Desktop AI Assistant in BUILD mode.",
    "First, write a brief prose summary (a few sentences) of the change you're proposing.",
    `Then, on its own line, output exactly ${EDITS_MARKER} followed by a single fenced json code block with this exact shape:`,
    '{"edits": [{"path": "relative/path.ts", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
    '"content" must be the entire new file content, never a diff, patch, or partial snippet.',
    fullContentPaths.length > 0
      ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${fullContentPaths.join(", ")}. Do not use "modify" for any other path.`
      : 'You were not shown the full content of any existing file, so do not use action "modify" at all — only "create" a genuinely new path.',
    'Only use action "create" for a path you are confident does not already exist in this project.',
    `If you cannot confidently propose concrete file changes, omit the ${EDITS_MARKER} marker and JSON block entirely and just explain why in prose.`,
    relevantFilesContext(input, true),
  ].join("\n");
}

function relevantFilesContext(input: RunnerInput, distinguishFullContent: boolean): string {
  const files = input.projectContext?.relevantFiles ?? [];
  if (files.length === 0) return "";

  if (!distinguishFullContent) {
    return `\n\nRelevant code the user's local agent found:\n${files.map((f) => `--- ${f.relPath} ---\n${f.snippet}`).join("\n\n")}`;
  }

  const withContent = files.filter((f) => f.content !== undefined);
  const snippetOnly = files.filter((f) => f.content === undefined);
  let out = "";
  if (withContent.length > 0) {
    out += `\n\nFull file contents you may modify:\n${withContent.map((f) => `--- ${f.relPath} ---\n${f.content}`).join("\n\n")}`;
  }
  if (snippetOnly.length > 0) {
    out += `\n\nOther relevant snippets (context only — you may NOT modify these, you weren't shown them in full):\n${snippetOnly.map((f) => `--- ${f.relPath} ---\n${f.snippet}`).join("\n\n")}`;
  }
  return out;
}

function stepId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
