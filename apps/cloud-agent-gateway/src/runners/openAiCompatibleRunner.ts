import { BUILD_RESPONSE_CONTRACT_VERSION, type ModelOption, type ModelProvider, type ProposedEdit, type TaskEvent } from "@mobiusx/protocol";
import type { AgentRunner, RunnerInput } from "./types.js";
import { createStructuredProseStreamer, EDITS_MARKER, historyMessages, MODES_WITH_STRUCTURED_EDITS, parseBuildResponse, stepId, systemPromptFor } from "./promptShared.js";
import { runPersonaReview } from "./personas.js";
import { maybeExtractAssistantMemory } from "./memoryExtraction.js";
import { contextWindowFor } from "./contextWindows.js";

// Provider reasoning is private. Keep only enough information internally
// to distinguish an empty response from a reasoning-only response and show
// a concise actionable fallback to the user.

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
 * Runs the same persona-based second-pass Reviewer agent anthropicRunner.ts
 * does (roadmap Phase 11, source §26/§27 — see runners/personas.ts), via
 * one extra non-streamed /chat/completions call after edits are parsed.
 * Extending review here (not just formalizing it in the Anthropic runner)
 * was a deliberate Phase 11 decision: this gateway ships with no assumed
 * ANTHROPIC_API_KEY, so a persona review reachable only from the Anthropic
 * runner would be unverifiable in any environment relying on the free
 * OpenRouter/Groq tier — see docs/phase-notes/
 * phase-11-multi-agent-orchestration.md for how this was actually
 * exercised live. Previously a real, documented scope cut ("Known gaps");
 * closed as of this phase.
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
  /** Optional provider/model-specific reasoning budget. Groq's GPT-OSS models otherwise default to medium reasoning, which can consume the entire output budget before producing any answer. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Provider/model output ceiling for structured app edits. Keep conservative defaults for providers with strict per-minute quotas; raise explicitly where the selected provider supports larger completions. */
  maxOutputTokens?: number;
}

function outputLimit(config: OpenAiCompatibleConfig): number {
  return config.maxOutputTokens ?? 8192;
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
        label: `Generating response with ${config.provider} (${model})`,
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
            ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
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
            max_tokens: outputLimit(config),
            messages: [
              { role: "system", content: systemPrompt },
              ...historyMessages(input),
              { role: "user", content: input.prompt },
            ],
            stream: true,
            // Asks the provider to send a final SSE chunk carrying real
            // token counts (see streamOpenAiSse's onUsage) -- OpenAI/
            // OpenRouter/Groq all honor this; a provider that doesn't just
            // omits the field and this task's usage goes unreported
            // (honest absence, not a guess -- see TokenUsage's doc comment).
            stream_options: { include_usage: true },
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
        // `delta.reasoning` -- a private reasoning scratchpad -- with
        // `delta.content` staying empty the whole time. `fullText`/
        // `reasoningText` are declared above the try block precisely so
        // they're still readable from the catch block if an upstream error
        // (e.g. a provider-side idle timeout while the model is still
        // "thinking") cuts the stream off mid-reasoning, instead of that
        // work just being discarded.
        const onReasoning = (chunk: string) => {
          reasoningText += chunk;
        };
        let capturedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
        const onUsage = (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => {
          capturedUsage = usage;
        };

        let sawText: boolean;
        if (MODES_WITH_STRUCTURED_EDITS.has(input.mode)) {
          const publicProse = createStructuredProseStreamer((delta) => emit({ type: "output", delta }));
          sawText = await streamOpenAiSse(
            res.body,
            (delta) => {
              fullText += delta;
              publicProse.push(delta);
            },
            onReasoning,
            onUsage,
          );
          const streamedProse = publicProse.finish();
          if (!sawText) {
            // Real, observed failure mode (Oct 2026: openai/gpt-oss-20b via
            // Groq, asked to build a gardening-business storefront) --
            // distinct from the "wrote prose but forgot the marker" case
            // below. Here the model spent its ENTIRE max_tokens budget on
            // `delta.reasoning` private reasoning and never emitted any real
            // `delta.content` at all, so there is no fullText for
            // parseBuildResponse to even look at. Previously this just
            // showed a long internal trace as the task's entire `output`;
            // that is neither a useful answer nor an appropriate disclosure.
            // A concise fallback now explains what happened while
            // every chat panel in this app auto-scrolls new messages to the
            // BOTTOM (see renderer.js's feed.scrollTop = feed.scrollHeight).
            // A real user never saw that sentence -- only an abrupt,
            // unexplained tail cut off mid-thought, indistinguishable from
            // the app having glitched. Two real fixes, not just a better
            // error string: (1) one narrowly-scoped retry, same shape as
            // retryForEdits below but asking the model to skip extended
            // reasoning and answer directly -- recovers the (common) case
            // where the model just needed a push rather than being
            // incapable of the task; (2) when that still doesn't produce
            // usable edits, lead with the actionable explanation and keep
            // private reasoning out of the conversation.
            const retried = true;
            const retry = await retryWithoutReasoning(config, key, systemPrompt, input);
            if (retry && retry.edits.length > 0) {
              emit({ type: "output", delta: retry.prose || "(no files were created on the first attempt, so this response was regenerated once -- see the files proposed below)" });
              emit({ type: "edits", edits: retry.edits, contractVersion: BUILD_RESPONSE_CONTRACT_VERSION });
              if (retry.droppedCount > 0) {
                emit({
                  type: "output",
                  delta: `\n\n(${retry.droppedCount} proposed edit(s) omitted: the model tried to "modify" a file it wasn't shown in full, or its edits JSON didn't parse — see apps/cloud-agent-gateway/src/runners/promptShared.ts#parseBuildResponse.)`,
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
                (!input.stagedBuild || input.stagedBuild.final)
              ) {
                await runPersonaReview(input.mode, input, retry.edits, emit, (systemPrompt, userContent) =>
                  callOpenAiCompatibleNonStreamed(config, key, model, systemPrompt, userContent, input.signal),
                );
              }
              // Assistant Memory's automatic-extraction call (Oct 2026
              // addition) — see memoryExtraction.ts's module doc comment.
              // No-ops unless the user has turned AgentSettings.memoryMode
              // to "auto".
              await maybeExtractAssistantMemory(input, retry.prose ?? "", retry.edits, (systemPrompt, userContent) =>
                callOpenAiCompatibleNonStreamed(config, key, model, systemPrompt, userContent, input.signal),
              );
            } else {
              if (input.autoCloud) {
                emit({ type: "provider_failure", message: `${config.provider}/${model} returned no usable file edits after the automatic recovery attempt.` });
                emit({ type: "done" });
                return;
              }
              emit({
                type: "output",
                delta: `(No file changes were proposed${retried ? " even after asking again" : ""} — ${config.provider}/${model} did not produce a final answer. Internal reasoning is not displayed. Try again, ask for a smaller/more specific change, or switch models in Settings.)`,
              });
            }
          } else {
            let { prose, edits, droppedCount, hadMarker, parseFailed } = parseBuildResponse(fullText, input);

            // Real, observed failure mode (Sept 2026: openai/gpt-oss-120b via
            // Groq, asked to build a payroll app) distinct from the "wrong
            // format" case above -- the model wrote a plausible one-paragraph
            // *description* of what it would build and then simply stopped,
            // never attempting EDITS_MARKER at all. edits.length === 0 AND
            // droppedCount === 0 AND !hadMarker is exactly that signature (a
            // marker that was present but had unusable entries already sets
            // droppedCount; a marker present with a deliberate empty array --
            // the pre-flight-clarification case, see the BUILD prompt's
            // {"edits": []} instruction -- sets hadMarker but proposes
            // nothing, and should NOT be treated as a failure to retry away).
            //
            // A second, previously-conflated failure mode (Oct 2026, see
            // promptShared.ts's parseFailed doc comment): marker present,
            // but the JSON after it never parsed under any strategy -- most
            // often the response hit its token ceiling mid-JSON. This used
            // to report the exact same {hadMarker:true, edits:[],
            // droppedCount:0} shape as the deliberate-clarification case
            // below, so it was silently mislabeled as "waiting on your
            // answer" -- actively misleading, since nothing was actually
            // asked. parseFailed distinguishes the two so each gets its own
            // real retry and its own honest message.
            //
            // One automatic, narrowly-scoped retry -- handing the model its
            // own prior answer and explicitly demanding just the missing
            // block -- costs one extra request but recovers the (common)
            // case where the model merely forgot the format, or got cut off,
            // rather than being incapable of it.
            let retried = false;
            if (edits.length === 0 && droppedCount === 0 && (!hadMarker || parseFailed)) {
              retried = true;
              const retry = await retryForEdits(config, key, systemPrompt, input, fullText);
              if (retry) {
                if (retry.prose) prose = retry.prose;
                edits = retry.edits;
                droppedCount = retry.droppedCount;
                parseFailed = retry.parseFailed;
              }
            }

            if (retried && prose && prose.trim() !== streamedProse.trim() && (!input.autoCloud || edits.length > 0)) {
              emit({ type: "output", delta: `\n\nUpdated response after retry:\n${prose}` });
            }
            if (edits.length > 0) emit({ type: "edits", edits, contractVersion: BUILD_RESPONSE_CONTRACT_VERSION });
            if (input.autoCloud && edits.length === 0 && (!hadMarker || droppedCount > 0)) {
              emit({ type: "provider_failure", message: `${config.provider}/${model} returned a plan or unusable file edits after the automatic recovery attempt.` });
              emit({ type: "done" });
              return;
            }
            if (edits.length === 0 && droppedCount === 0 && !hadMarker) {
              emit({
                type: "output",
                delta: `\n\n(No file changes were proposed${retried ? " even after asking again" : ""} — ${config.provider}/${model} produced a plan or description instead of the required file-edit format. This happens on some free models some of the time; try again, be more explicit (e.g. "write the complete files now"), or switch models in Settings.)`,
              });
            } else if (parseFailed) {
              if (input.autoCloud) {
                emit({ type: "step", step: { ...step, status: "failed", completedAt: new Date().toISOString() } });
                emit({ type: "provider_failure", message: `${config.provider}/${model} returned an incomplete or invalid file-edit JSON response.` });
                return;
              }
              emit({
                type: "output",
                delta: `\n\n(This response included the file-edit marker${retried ? ", even after asking again," : ""} but the JSON that followed it didn't parse — almost always because the response was cut off before the JSON finished. No files were changed. Try again, ask for something smaller/more focused, or switch models in Settings.)`,
              });
            } else if (edits.length === 0 && hadMarker && droppedCount === 0) {
              // The pre-flight-clarification case: the model deliberately
              // asked questions instead of proposing files (its questions
              // are already in `prose`/the output above) -- a plain,
              // accurate note instead of the "this happens on some free
              // models" apology, which would be actively misleading here.
              emit({
                type: "output",
                delta: `\n\n(Waiting on your answer above before proposing any files — reply in this conversation and ask again, or just say "go ahead" once you've decided.)`,
              });
            }
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
              (!input.stagedBuild || input.stagedBuild.final) &&
              edits.length > 0
            ) {
              await runPersonaReview(input.mode, input, edits, emit, (systemPrompt, userContent) =>
                callOpenAiCompatibleNonStreamed(config, key, model, systemPrompt, userContent, input.signal),
              );
            }
            // Assistant Memory's automatic-extraction call (Oct 2026
            // addition) — see memoryExtraction.ts's module doc comment.
            // No-ops unless the user has turned AgentSettings.memoryMode to
            // "auto".
            await maybeExtractAssistantMemory(input, prose || fullText, edits, (systemPrompt, userContent) =>
              callOpenAiCompatibleNonStreamed(config, key, model, systemPrompt, userContent, input.signal),
            );
          }
        } else {
          sawText = await streamOpenAiSse(
            res.body,
            (delta) => {
              fullText += delta;
              emit({ type: "output", delta });
            },
            onReasoning,
            onUsage,
          );
          if (!sawText) emit({ type: "output", delta: reasoningFallbackMessage(Boolean(reasoningText.trim())) });
        }

        if (capturedUsage) {
          emit({
            type: "usage",
            usage: {
              promptTokens: capturedUsage.prompt_tokens,
              completionTokens: capturedUsage.completion_tokens,
              totalTokens: capturedUsage.total_tokens,
              contextWindow: contextWindowFor(model),
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
): Promise<{ prose: string; edits: ProposedEdit[]; droppedCount: number; parseFailed: boolean } | null> {
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
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        max_tokens: outputLimit(config),
        messages: [
          { role: "system", content: systemPrompt },
          ...historyMessages(input),
          { role: "user", content: input.prompt },
          { role: "assistant", content: priorAssistantText },
          {
            role: "user",
            content: `Your previous answer did not include the required ${EDITS_MARKER} marker and JSON edits block, or included it but the JSON after it was incomplete/malformed (most likely cut off before finishing) — it was a plan or description, not the file-edit format your instructions require. Respond again with no architecture diagram, tutorial, or long explanation: at most 40 words of summary, then ${EDITS_MARKER} on its own line, then one fenced json code block containing the complete content of the necessary files in an "edits" array. Preserve the user's explicitly requested core features, but consolidate related code and configuration into a compact, runnable implementation of at most 10 files. Omit speculative extras and duplicate boilerplate. Do not just repeat your previous description in prose.`,
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
 * One narrowly-scoped retry for when a model in build/spec mode spent its
 * entire response on `delta.reasoning` and never produced any real
 * `delta.content` (see run()'s `!sawText` branch for the full reasoning and
 * the observed case this was written for). Unlike retryForEdits above,
 * there is no usable prior assistant turn to hand back -- it was all
 * chain-of-thought, not an answer -- so this sends the original prompt
 * again with one added instruction to skip extended reasoning and answer
 * directly. Same failure-handling contract as retryForEdits: returns null
 * on any failure of the retry itself so the caller falls back cleanly to
 * the original (empty) response instead of losing the task to a retry
 * error.
 */
async function retryWithoutReasoning(
  config: OpenAiCompatibleConfig,
  key: string,
  systemPrompt: string,
  input: RunnerInput,
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
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        max_tokens: outputLimit(config),
        messages: [
          { role: "system", content: systemPrompt },
          ...historyMessages(input),
          {
            role: "user",
            content: `${input.prompt}\n\nIMPORTANT: Your previous attempt spent its response on reasoning and did not produce a usable answer. Keep any private reasoning brief. Do not write an architecture diagram, tutorial, or long explanation. Output at most 40 words of summary, then the ${EDITS_MARKER} marker on its own line, then one fenced json code block with complete, compact files that preserve the explicitly requested core features. Consolidate the implementation into at most 10 files; do not omit explicitly requested functionality.`,
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
    // original (empty) response rather than losing it to a retry error.
    return null;
  }
}

/**
 * Thin non-streamed /chat/completions call, used only by the second-pass
 * persona review (see personas.ts#runPersonaReview, which supplies the
 * persona-specific system prompt and receives this as its `callModel`
 * closure). `stream: false` here (unlike the main run() call above) since a
 * review verdict is small and needed all at once, not token-by-token — no
 * SSE parsing required, just the ordinary JSON response shape.
 */
async function callOpenAiCompatibleNonStreamed(
  config: OpenAiCompatibleConfig,
  key: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...(config.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(describeProviderError(res.status, body, config.provider, model));
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

/**
 * What to show when a model produced NO real `content` at all -- either a
 * genuinely empty response, or (the case this was written for) a
 * reasoning-only response that ran out of stream before ever reaching a
 * final answer. Private reasoning is never a user-facing fallback; give an
 * actionable explanation instead.
 */
function reasoningFallbackMessage(hasReasoning: boolean): string {
  return hasReasoning
    ? "(The model did not produce a final answer. Its internal reasoning is not displayed. Try a smaller request or choose another model.)"
    : "(model returned no text content)";
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
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void,
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
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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
        // The chunk carrying `usage` (requested via stream_options above)
        // has an EMPTY choices array per the OpenAI spec -- it's a
        // trailer, not a content delta -- so this is checked unconditionally,
        // not nested inside the `text`/`reasoning` handling above.
        if (
          onUsage &&
          parsed.usage &&
          typeof parsed.usage.prompt_tokens === "number" &&
          typeof parsed.usage.completion_tokens === "number" &&
          typeof parsed.usage.total_tokens === "number"
        ) {
          onUsage({
            prompt_tokens: parsed.usage.prompt_tokens,
            completion_tokens: parsed.usage.completion_tokens,
            total_tokens: parsed.usage.total_tokens,
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return sawText;
}
