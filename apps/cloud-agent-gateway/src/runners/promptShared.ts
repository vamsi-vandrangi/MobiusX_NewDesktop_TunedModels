import type { ProposedEdit } from "@mobiusx/protocol";
import type { RunnerInput } from "./types.js";

/**
 * Prompting and structured-edit-parsing logic shared by every "chat-style"
 * runner (anthropic, openrouter, groq, ollama) — originally lived only in
 * anthropicRunner.ts, extracted here once more providers needed the exact
 * same system prompts and the exact same build/spec-mode edits convention,
 * so behavior can't drift between providers just because one runner's copy
 * got tweaked and another's didn't. anthropicRunner.ts re-exports
 * EDITS_MARKER/parseBuildResponse from here so existing imports of those
 * names keep working unchanged.
 */

/** Marks the boundary between the model's human-readable summary and the machine-readable edits JSON block in a build/spec-mode response. Never shown to the user. */
export const EDITS_MARKER = "===MOBIUSX_EDITS===";

/** Modes whose response is buffered and parsed for a structured ProposedEdit[] block, rather than streamed live token-by-token. */
export const MODES_WITH_STRUCTURED_EDITS = new Set<RunnerInput["mode"]>(["build", "spec"]);

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
 * should still show its reasoning, not fail outright. This matters even
 * more now that not every provider is Anthropic-quality at reliably
 * following the marker convention — a model that ignores it degrades to
 * plain prose, not a crash.
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

export function systemPromptFor(input: RunnerInput): string {
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
  if (input.mode === "spec") {
    return [
      "You are the MobiusX Desktop AI Assistant in SPEC mode — a Requirements Engineering assistant (not a coder in this mode).",
      "Given the user's natural-language request, write a structured requirements specification as a single markdown document with EXACTLY these sections, in this order: '## Overview', '## Functional Requirements' (numbered), '## Non-Functional Requirements' (numbered), '## Constraints & Assumptions', '## Risks', '## Acceptance Criteria' (as Given/When/Then scenarios).",
      "If the request is ambiguous or missing information a real spec would need, do not guess silently — add those as explicit open questions under a '## Open Questions' section instead of inventing requirements the user never stated.",
      "First, write a one-to-two-sentence prose summary of what you're specifying.",
      `Then, on its own line, output exactly ${EDITS_MARKER} followed by a single fenced json code block with this exact shape:`,
      '{"edits": [{"path": ".mobiusx/specs/<kebab-case-slug>.md", "action": "create", "content": "the complete markdown spec document"}]}',
      "Choose a short, descriptive kebab-case slug for the filename based on the feature being specified (e.g. \".mobiusx/specs/subscription-management.md\"). Always use action \"create\" — never \"modify\" in this mode.",
      relevantFilesContext(input, false),
    ].join("\n");
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

export function relevantFilesContext(input: RunnerInput, distinguishFullContent: boolean): string {
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

export function stepId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
