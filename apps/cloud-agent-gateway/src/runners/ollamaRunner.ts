import type { ModelOption, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";
import { runPersonaReview } from "./personas.js";

/**
 * Local Ollama (https://ollama.com) — no API key, runs entirely on the
 * user's own machine against whatever models they've pulled. Unlike the
 * cloud providers, "available" here can't be answered from an env var: it
 * genuinely depends on whether Ollama is running right now and which
 * models are actually pulled, so listModels() makes a real (short-timeout)
 * HTTP call to Ollama's own /api/tags rather than assuming anything.
 *
 * Deliberately never auto-selected (see registry.ts's AUTO_PRIORITY
 * comment) — using local compute is always an explicit user choice, not
 * something that silently becomes "the AI Assistant's brain" just because
 * a background process happens to be running.
 *
 * Uses Ollama's own /api/chat, whose streaming format is newline-delimited
 * JSON (one `{"message":{"content":"..."},"done":false}` object per line),
 * NOT Server-Sent Events — a different framing from the cloud providers,
 * handled by streamOllamaNdjson below rather than reusing streamOpenAiSse.
 *
 * Runs the same persona-based second-pass Reviewer agent the other runners
 * do (roadmap Phase 11, source §26/§27 — see runners/personas.ts), via one
 * extra non-streamed /api/chat call (`stream: false`) after edits are
 * parsed. A small local model is more likely to miss the review's expected
 * JSON verdict shape too — handled the same conservative way as any other
 * unparseable review (personas.ts#parseReview: reported as "concerns", not
 * silently dropped or upgraded to "approve").
 */
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const TAGS_TIMEOUT_MS = 1000;

interface CandidateModel {
  /** The model id/tag this gateway will ask Ollama to run. */
  model: string;
  label: string;
  /** Case-insensitive prefixes of a locally-pulled tag name that count as "this model is available" — Ollama tags often carry a size/quantization suffix (e.g. "llama3.1:8b"), so an exact-match would under-report what's actually usable. */
  matchPrefixes: string[];
  /** Suggested `ollama pull` argument shown in the unavailable reason when nothing matching is pulled yet. */
  pullHint: string;
}

const CANDIDATE_MODELS: CandidateModel[] = [
  { model: "llama3.1", label: "Llama 3.1 (local via Ollama)", matchPrefixes: ["llama3.1", "llama3", "llama-3"], pullHint: "llama3.1" },
  {
    model: "qwen2.5-coder",
    label: "Qwen2.5-Coder (local via Ollama)",
    matchPrefixes: ["qwen2.5-coder", "qwen2.5coder"],
    pullHint: "qwen2.5-coder",
  },
  {
    model: "deepseek-coder-v2",
    label: "DeepSeek-Coder (local via Ollama)",
    matchPrefixes: ["deepseek-coder"],
    pullHint: "deepseek-coder-v2",
  },
];

function baseUrl(): string {
  return process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL;
}

/** Returns the locally-pulled model tag names, or null if Ollama isn't reachable at all (distinct from "reachable but nothing pulled", which is `[]`). */
async function fetchInstalledTags(): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/tags`, { signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name?: string }[] };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
  } catch {
    return null;
  }
}

export const ollamaRunner: AgentRunner = {
  name: "ollama",

  async listModels(): Promise<ModelOption[]> {
    const installed = await fetchInstalledTags();
    if (installed === null) {
      return CANDIDATE_MODELS.map((c) => ({
        provider: "ollama",
        model: c.model,
        label: c.label,
        free: true,
        available: false,
        unavailableReason: `Ollama not reachable at ${baseUrl()} — install it from ollama.com and make sure it's running`,
      }));
    }
    return CANDIDATE_MODELS.map((c) => {
      const match = installed.find((name) => c.matchPrefixes.some((p) => name.toLowerCase().startsWith(p)));
      // Reporting the REAL installed tag (e.g. "qwen2.5-coder:latest") as
      // `model`, not the generic candidate id, matters because
      // registry.ts#resolveRunner matches a requested/default selection by
      // exact string equality against what this function returns. Known,
      // accepted limitation: a Settings default saved against one tag
      // suffix goes stale (falls back to demo with a "not pulled yet" note,
      // even though a same-family model IS installed) if the user later
      // re-pulls under a different suffix -- see registry.test.ts and the
      // README's "Known gaps" rather than adding fuzzy matching here, which
      // would blur the "always tell the truth about availability" contract.
      return {
        provider: "ollama",
        model: match ?? c.model,
        label: c.label,
        free: true,
        available: Boolean(match),
        unavailableReason: match ? undefined : `not pulled yet — run \`ollama pull ${c.pullHint}\``,
      };
    });
  },

  async run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void> {
    const model = input.modelId;
    if (!model) {
      emit({ type: "error", message: "no Ollama model id resolved — see registry.ts#resolveRunner" });
      emit({ type: "done" });
      return;
    }

    emit({ type: "status", status: "running" });
    const step = {
      id: stepId(),
      label: `Streaming response from local Ollama (${model})`,
      status: "in_progress" as const,
      startedAt: new Date().toISOString(),
    };
    emit({ type: "step", step });

    try {
      const systemPrompt = systemPromptFor(input);
      const res = await fetch(`${baseUrl()}/api/chat`, {
        method: "POST",
        signal: input.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            ...historyMessages(input),
            { role: "user", content: input.prompt },
          ],
          stream: true,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 500)}`);
      }
      if (!res.body) {
        throw new Error("Ollama response had no body to stream");
      }

      let sawText: boolean;
      let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;
      const onUsage = (usage: { promptTokens: number; completionTokens: number }) => {
        capturedUsage = usage;
      };
      if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
        let fullText = "";
        sawText = await streamOllamaNdjson(
          res.body,
          (delta) => {
            fullText += delta;
          },
          onUsage,
        );
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
            await runPersonaReview(input.mode, input, edits, emit, (systemPrompt, userContent) =>
              callOllamaNonStreamed(model, systemPrompt, userContent, input.signal),
            );
          }
        }
      } else {
        sawText = await streamOllamaNdjson(res.body, (delta) => emit({ type: "output", delta }), onUsage);
        if (!sawText) emit({ type: "output", delta: "(model returned no text content)" });
      }

      if (capturedUsage) {
        emit({
          type: "usage",
          usage: {
            promptTokens: capturedUsage.promptTokens,
            completionTokens: capturedUsage.completionTokens,
            totalTokens: capturedUsage.promptTokens + capturedUsage.completionTokens,
            // No contextWindow: a local Ollama model's window depends on
            // the user's own pull/Modelfile, not something this gateway
            // can look up (see streamOllamaNdjson's comment above).
          },
        });
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
 * Thin non-streamed Ollama /api/chat call, used only by the second-pass
 * persona review (see personas.ts#runPersonaReview, which supplies the
 * persona-specific system prompt and receives this as its `callModel`
 * closure). `stream: false` returns the whole response as one JSON object
 * (`{message: {content: "..."}, ...}`), no NDJSON parsing required.
 */
async function callOllamaNonStreamed(model: string, systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama returned ${res.status} for the review call: ${body.slice(0, 500)}`);
  }
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(body.error);
  return body.message?.content ?? "";
}

/**
 * Reads Ollama's /api/chat streaming response: one JSON object per line
 * (NOT SSE — no "data:" prefix), each carrying an incremental
 * `message.content` chunk until a final line with `"done": true`. Returns
 * whether any text content was seen.
 */
export async function streamOllamaNdjson(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawText = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        let parsed: {
          message?: { content?: string };
          error?: string;
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // malformed/partial line — skip rather than crash the whole task on one bad chunk
        }

        if (parsed.error) {
          throw new Error(parsed.error);
        }
        const text = parsed.message?.content;
        if (text) {
          onText(text);
          sawText = true;
        }
        // Ollama's final NDJSON line (done:true) carries real token counts
        // for this local generation -- no context-window lookup applies
        // here though (see contextWindowFor's doc comment: a local model's
        // window depends on the user's own Modelfile/quantization, which
        // this gateway has no way to know), so the UI shows raw counts for
        // Ollama tasks without a percentage.
        if (
          parsed.done &&
          onUsage &&
          typeof parsed.prompt_eval_count === "number" &&
          typeof parsed.eval_count === "number"
        ) {
          onUsage({ promptTokens: parsed.prompt_eval_count, completionTokens: parsed.eval_count });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sawText;
}
