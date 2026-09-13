import type { ModelOption, ModelProvider, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";

/**
 * Factory for any provider that speaks the OpenAI chat-completions wire
 * format (`POST {baseUrl}/chat/completions`, `{model, messages, stream}`,
 * SSE `data: {"choices":[{"delta":{"content":"..."}}]}` chunks terminated
 * by `data: [DONE]`) — both OpenRouter and Groq advertise exactly this
 * compatibility, which is the whole point of building one implementation
 * instead of two near-identical ones (see openrouterRunner.ts/groqRunner.ts
 * for the small bit of config that actually differs between them).
 *
 * Reuses the exact same system prompts and build/spec-mode structured-edits
 * parsing as anthropicRunner.ts (via promptShared.ts) — a model on either
 * provider that doesn't reliably follow the EDITS_MARKER convention just
 * degrades to plain prose with no edits (parseBuildResponse's documented
 * graceful behavior), not a crash.
 *
 * Does NOT run the second-pass Reviewer agent anthropicRunner.ts has — a
 * real, deliberate scope cut for this first pass at multi-model support,
 * not a silent omission. See each concrete runner's module comment and
 * apps/cloud-agent-gateway/README.md's "Known gaps".
 */
export interface OpenAiCompatibleModelSpec {
  /** Provider-specific model id sent as the request's "model" field. */
  model: string;
  /** Human label for the picker UI, e.g. "Llama 3.3 70B (free via OpenRouter)". */
  label: string;
  free: boolean;
}

export interface OpenAiCompatibleConfig {
  provider: ModelProvider;
  /** e.g. "https://openrouter.ai/api/v1" — "/chat/completions" is appended. */
  baseUrl: string;
  /** Name of the env var holding the API key, e.g. "OPENROUTER_API_KEY". Read fresh on every call, never cached, so a `.env` picked up after startup (see index.ts's process.loadEnvFile) is honored. */
  apiKeyEnvVar: string;
  /** The curated, verified-to-exist model list this provider offers through this gateway (see each concrete runner file for where these ids came from). */
  models: OpenAiCompatibleModelSpec[];
  /** Extra request headers beyond Authorization/content-type, e.g. OpenRouter's optional attribution headers. */
  extraHeaders?: Record<string, string>;
}

export function createOpenAiCompatibleRunner(config: OpenAiCompatibleConfig): AgentRunner {
  function apiKey(): string | undefined {
    return process.env[config.apiKeyEnvVar];
  }

  return {
    name: config.provider,

    async listModels(): Promise<ModelOption[]> {
      const key = apiKey();
      return config.models.map((m) => ({
        provider: config.provider,
        model: m.model,
        label: m.label,
        free: m.free,
        available: Boolean(key),
        unavailableReason: key ? undefined : `requires ${config.apiKeyEnvVar}`,
      }));
    },

    async run(input: RunnerInput, emit: (event: TaskEvent) => void): Promise<void> {
      const key = apiKey();
      const model = input.modelId ?? config.models[0]?.model;
      if (!key || !model) {
        // registry.ts should prevent this, but never silently fall through to a demo answer
        // labeled as if it came from a real model — fail loudly instead.
        emit({ type: "error", message: `${config.apiKeyEnvVar} not set` });
        emit({ type: "done" });
        return;
      }

      emit({ type: "status", status: "running" });
      const step = {
        id: stepId(),
        label: `Streaming response from ${config.provider} (${model})`,
        status: "in_progress" as const,
        startedAt: new Date().toISOString(),
      };
      emit({ type: "step", step });

      try {
        const systemPrompt = systemPromptFor(input);
        const res = await fetch(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          signal: input.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
            ...(config.extraHeaders ?? {}),
          },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: input.prompt },
            ],
            stream: true,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`${config.provider} API returned ${res.status}: ${body.slice(0, 500)}`);
        }
        if (!res.body) {
          throw new Error(`${config.provider} API response had no body to stream`);
        }

        let sawText: boolean;
        if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
          let fullText = "";
          sawText = await streamOpenAiSse(res.body, (delta) => {
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
            if (input.mode === "build" && edits.length > 0) {
              emit({
                type: "output",
                delta: `\n\n(Note: ${config.provider} doesn't run the second-pass Reviewer agent yet — that's currently Anthropic-only. Review these edits carefully yourself before applying. See apps/cloud-agent-gateway/README.md's "Known gaps".)`,
              });
            }
          }
        } else {
          sawText = await streamOpenAiSse(res.body, (delta) => emit({ type: "output", delta }));
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
}

/**
 * Reads an OpenAI-style chat-completions SSE stream, forwarding each
 * `choices[0].delta.content` chunk via `onText` as it arrives. Returns
 * whether any text was seen at all. Terminated by a `data: [DONE]` line,
 * which is not JSON and must be recognized and skipped rather than fed to
 * JSON.parse.
 */
export async function streamOpenAiSse(body: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<boolean> {
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

        const dataStr = dataLine.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        let parsed: { choices?: { delta?: { content?: string }; finish_reason?: string }[]; error?: { message?: string } };
        try {
          parsed = JSON.parse(dataStr);
        } catch {
          continue; // malformed/partial event line — skip rather than crash the whole task on one bad chunk
        }

        if (parsed.error) {
          throw new Error(parsed.error.message ?? "upstream stream reported an error");
        }
        const text = parsed.choices?.[0]?.delta?.content;
        if (text) {
          onText(text);
          sawText = true;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sawText;
}
