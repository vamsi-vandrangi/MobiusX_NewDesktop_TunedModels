import type { ModelOption, ModelProvider, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { EDITS_MARKER, historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";

// How much of a model's "reasoning" trace to show as a fallback when it
// never produces real `content` (see streamOpenAiSse's reasoning handling
// below) -- bounded the same way VerificationStep/previewOps.ts bound their
// own captured text, so one runaway "thinking" model can't flood a task's
// output.
const MAX_REASONING_FALLBACK_CHARS = 4000;

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

      // Declared here (not inside the try block) so the catch block below
      // can still see whatever was accumulated if the stream errors out
      // partway through -- see the catch block's comment.
      let fullText = "";
      let reasoningText = "";

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
            // Was 4096 -- raised after real evidence (Sept 2026, a build-mode
            // task on nex-agi/nex-n2.5-mini:free) that a "reasoning" model
            // can burn its ENTIRE token budget on `delta.reasoning`
            // chain-of-thought and hit `max_tokens` before ever reaching a
            // real `delta.content` answer -- see reasoningFallbackMessage's
            // doc comment. 8192 is a compromise: generous enough to give a
            // reasoning model real room to finish thinking on a substantial
            // build prompt, without going so high that a slow model takes
            // even longer and risks the upstream-idle-timeout failure mode
            // instead (see openrouterRunner.ts's Nex-N2.5 Pro comment).
            max_tokens: 8192,
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
          throw new Error(describeProviderError(res.status, body, config.provider, model));
        }
        if (!res.body) {
          throw new Error(`${config.provider} API response had no body to stream`);
        }

        // Some models (confirmed live: OpenRouter's nex-agi/nex-n2.5-pro:free,
        // a "hybrid instant/reasoning" model) stream their entire response as
        // `delta.reasoning` -- a chain-of-thought scratchpad -- with
        // `delta.content` staying empty the whole time. `fullText`/
        // `reasoningText` are declared above the try block precisely so
        // they're still readable from the catch block if an upstream error
        // (e.g. a provider-side idle timeout while the model is still
        // "thinking") cuts the stream off mid-reasoning, instead of that
        // work just being discarded.
        const onReasoning = (chunk: string) => {
          reasoningText += chunk;
        };

        let sawText: boolean;
        if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
          sawText = await streamOpenAiSse(
            res.body,
            (delta) => {
              fullText += delta;
            },
            onReasoning,
          );
          if (!sawText) {
            emit({ type: "output", delta: reasoningFallbackMessage(reasoningText) });
          } else {
            let { prose, edits, droppedCount } = parseBuildResponse(fullText, input);

            // Real, observed failure mode (Sept 2026: openai/gpt-oss-120b via
            // Groq, asked to build a payroll app) distinct from the "wrong
            // format" case above -- the model wrote a plausible one-paragraph
            // *description* of what it would build and then simply stopped,
            // never attempting EDITS_MARKER at all. edits.length === 0 AND
            // droppedCount === 0 is exactly that signature (a marker that was
            // present but had unusable entries already sets droppedCount, so
            // this only fires when nothing was attempted). One automatic,
            // narrowly-scoped retry -- handing the model its own prior answer
            // and explicitly demanding just the missing block -- costs one
            // extra request but recovers the (common) case where the model
            // merely forgot the format rather than being incapable of it.
            let retried = false;
            if (edits.length === 0 && droppedCount === 0) {
              retried = true;
              const retry = await retryForEdits(config, key, systemPrompt, input, fullText);
              if (retry) {
                if (retry.prose) prose = retry.prose;
                edits = retry.edits;
                droppedCount = retry.droppedCount;
              }
            }

            emit({ type: "output", delta: prose || fullText });
            if (edits.length > 0) emit({ type: "edits", edits });
            if (edits.length === 0 && droppedCount === 0) {
              emit({
                type: "output",
                delta: `\n\n(No file changes were proposed${retried ? " even after asking again" : ""} — ${config.provider}/${model} produced a plan or description instead of the required file-edit format. This happens on some free models some of the time; try again, be more explicit (e.g. "write the complete files now"), or switch models in Settings.)`,
              });
            }
            if (droppedCount > 0) {
              emit({
                type: "output",
                delta: `\n\n(${droppedCount} proposed edit(s) omitted: the model tried to "modify" a file it wasn't shown in full, or its edits JSON didn't parse — see apps/cloud-agent-gateway/src/runners/promptShared.ts#parseBuildResponse.)`,
              });
            }
            if ((input.mode === "build" || input.mode === "fix" || input.mode === "database") && edits.length > 0) {
              emit({
                type: "output",
                delta: `\n\n(Note: ${config.provider} doesn't run the second-pass Reviewer agent yet — that's currently Anthropic-only. Review these edits carefully yourself before applying. See apps/cloud-agent-gateway/README.md's "Known gaps".)`,
              });
            }
          }
        } else {
          sawText = await streamOpenAiSse(
            res.body,
            (delta) => {
              fullText += delta;
              emit({ type: "output", delta });
            },
            onReasoning,
          );
          if (!sawText) emit({ type: "output", delta: reasoningFallbackMessage(reasoningText) });
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
        // fullText/reasoningText are declared in the try block above but
        // still in scope here (function-level `let`, not block-scoped to an
        // if/else) -- so a stream that errors out partway through (the
        // upstream-idle-timeout case this was written for) doesn't just
        // discard whatever the model had already produced.
        const partial = fullText || reasoningText;
        const partialNote = partial
          ? ` (the model had produced ${partial.length} character(s) of ${fullText ? "output" : "reasoning (no final answer)"} before this happened — discarded; a smaller prompt or a different model may avoid this)`
          : "";
        emit({ type: "error", message: `${(err as Error).message}${partialNote}` });
        emit({ type: "done" });
      }
    },
  };
}

/**
 * Groq (and possibly other OpenAI-compatible providers) return a very
 * specific 429 shape when a single request's `max_tokens` ceiling alone
 * exceeds a free-tier per-minute output-token budget for that model --
 * confirmed live (Sept 2026, qwen/qwen3.8-27b via Groq, org on_demand
 * tier): {"error":{"type":"tokens","code":"rate_limit_exceeded",
 * "message":"...on output tokens per minute (OTPM): Limit 1000, Requested
 * 8192..."}}. This is NOT a transient "try again in a few seconds" rate
 * limit -- the "Requested" figure is this runner's own fixed max_tokens
 * (see the request body above), so if it already exceeds the account's
 * per-minute cap for this model, no retry or backoff fixes it; the model
 * itself needs to change. Surfacing the raw (possibly 500-char-truncated)
 * JSON blob, the generic fallback here, left a real user staring at an
 * unreadable error with no actionable next step -- this recognizes the
 * shape and explains what's actually going on instead.
 */
function describeProviderError(status: number, body: string, provider: string, model: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
    const err = parsed.error;
    if (err?.code === "rate_limit_exceeded" && err.type === "tokens" && /output tokens per minute/i.test(err.message ?? "")) {
      const limit = err.message?.match(/Limit (\d+)/)?.[1];
      const requested = err.message?.match(/Requested (\d+)/)?.[1];
      const budget =
        limit && requested
          ? ` (${provider} allows only ${limit} output tokens/minute for this model on your account here, but this request needs up to ${requested})`
          : "";
      return `${provider}'s free tier doesn't have enough output-token budget for ${model} to handle this${budget}. This isn't a transient rate limit that a quick retry fixes -- switch to a different model in Settings and try again.`;
    }
  } catch {
    // Not JSON, or not this specific shape -- fall through to the generic message.
  }
  return `${provider} API returned ${status}: ${body.slice(0, 500)}`;
}

/**
 * One narrowly-scoped retry for when a model in build/spec mode produced
 * real text but never attempted the required EDITS_MARKER+JSON format at
 * all (see run()'s call site for the full reasoning and the exact
 * condition that triggers this). Hands the model its own prior answer as
 * assistant-turn context, plus one new user message insisting on just the
 * missing block, and re-parses whatever comes back the same way the main
 * response is parsed. Returns null on any failure of the retry itself
 * (network error, non-2xx, empty body, no text produced) so the caller can
 * cleanly fall back to the original response -- a failed retry must never
 * crash or replace a real (if incomplete) answer with nothing.
 */
async function retryForEdits(
  config: OpenAiCompatibleConfig,
  key: string,
  systemPrompt: string,
  input: RunnerInput,
  priorAssistantText: string,
): Promise<{ prose: string; edits: ProposedEdit[]; droppedCount: number } | null> {
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: input.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(config.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: input.modelId ?? config.models[0]?.model,
        max_tokens: 8192,
        messages: [
          { role: "system", content: systemPrompt },
          ...historyMessages(input),
          { role: "user", content: input.prompt },
          { role: "assistant", content: priorAssistantText },
          {
            role: "user",
            content: `Your previous answer did not include the required ${EDITS_MARKER} marker and JSON edits block — it was a plan or description, not the file-edit format your instructions require. Respond again, this time following the required format exactly: a brief prose summary, then ${EDITS_MARKER} on its own line, then a single fenced json code block containing the complete content of every file in an "edits" array. Do not just repeat your previous description in prose.`,
          },
        ],
        stream: true,
      }),
    });
    if (!res.ok || !res.body) return null;
    let retryText = "";
    const sawText = await streamOpenAiSse(res.body, (delta) => {
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
 * What to show when a model produced NO real `content` at all -- either a
 * genuinely empty response, or (the case this was written for) a
 * reasoning-only response that ran out of stream before ever reaching a
 * final answer. Showing the reasoning trace is honest best-effort, not a
 * real answer to the prompt -- labeled as such rather than presented as if
 * it were one.
 */
function reasoningFallbackMessage(reasoningText: string): string {
  if (!reasoningText.trim()) return "(model returned no text content)";
  const truncated = reasoningText.length > MAX_REASONING_FALLBACK_CHARS;
  const shown = truncated ? reasoningText.slice(0, MAX_REASONING_FALLBACK_CHARS) : reasoningText;
  return (
    `(this model spent its whole response "reasoning" and never produced a final answer -- showing its reasoning trace instead, which may be incomplete and does not directly answer the prompt${truncated ? "; truncated" : ""})\n\n${shown.trim()}`
  );
}

/**
 * Reads an OpenAI-style chat-completions SSE stream, forwarding each
 * `choices[0].delta.content` chunk via `onText` as it arrives, and each
 * `choices[0].delta.reasoning` chunk via `onReasoning` if provided.
 *
 * `reasoning` is not part of the base OpenAI wire format -- it's an
 * extension some providers (confirmed live via OpenRouter, Sept 2026: at
 * least the nex-agi/* models) use for reasoning/"thinking" models, where
 * the visible chain-of-thought streams separately from the real answer.
 * Ignoring it entirely (the previous behavior here) meant a model that
 * spends its whole response reasoning -- and never gets to `content` --
 * looked exactly like a model that returned nothing at all. `onReasoning`
 * is optional so callers that don't care can ignore it with no behavior
 * change.
 *
 * Returns whether any real `content` text was seen (NOT reasoning --
 * `sawText` is specifically "did we get an actual answer", matching every
 * existing caller's use of this return value). Terminated by a `data:
 * [DONE]` line, which is not JSON and must be recognized and skipped rather
 * than fed to JSON.parse.
 */
export async function streamOpenAiSse(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  onReasoning?: (text: string) => void,
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

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        const dataStr = dataLine.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        let parsed: {
          choices?: { delta?: { content?: string; reasoning?: string }; finish_reason?: string }[];
          error?: { message?: string };
        };
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
        const reasoning = parsed.choices?.[0]?.delta?.reasoning;
        if (reasoning && onReasoning) onReasoning(reasoning);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sawText;
}
