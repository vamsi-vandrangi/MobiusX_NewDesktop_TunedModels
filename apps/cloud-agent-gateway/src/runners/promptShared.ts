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
export const MODES_WITH_STRUCTURED_EDITS = new Set<RunnerInput["mode"]>(["build", "spec", "fix"]);

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
/**
 * Defends against a real, observed failure mode: a free/open-weight model
 * (confirmed live: openai/gpt-oss-120b via Groq, generating a FastAPI
 * backend) can double-escape backslashes when JSON-encoding multi-line file
 * content -- writing the four characters backslash-backslash-n instead of
 * backslash-n for a line break. JSON.parse decodes that correctly per spec
 * into a literal two-character "\n" string (backslash then n) -- so the bug
 * isn't in JSON.parse or in our parsing, the model's JSON was already wrong
 * -- but the result, written verbatim to disk, is a file with literal
 * backslash-n text instead of real line breaks. Confirmed live: the
 * resulting requirements.txt failed `pip install -r` with
 * "Invalid requirement: 'fastapi\\nuvicorn...'".
 *
 * Heuristic, applied only when it's very unlikely to misfire: repair ONLY
 * when the content has zero real newlines (a correctly-escaped multi-line
 * file always has some after a correct JSON.parse) AND contains at least
 * one literal backslash-n run. Legitimate single-line content that merely
 * mentions the text "\n" is rare enough, and multi-line source/config
 * files this fixes are common enough, that this trade-off is worth it.
 */
function repairOverEscapedContent(content: string): string {
  if (content.includes("\n")) return content;
  if (!/\\n/.test(content)) return content;
  return content.replace(/\\(n|t|r|"|\\)/g, (_, ch: string) => {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return _;
    }
  });
}

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
    edits.push({ path: e.path, action: e.action, content: repairOverEscapedContent(e.content) });
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

  if (input.mode === "fix") {
    // Autonomous Build/Test/Fix Loop (roadmap Phase 6, source requirement
    // §16): reuses the exact same edits format/parsing as BUILD mode
    // (parseBuildResponse doesn't branch on mode at all) -- the only real
    // difference is what grounds the prompt: real captured verification
    // failure output (ProjectContext.failingVerification) instead of a
    // user's free-form feature request, and an explicit instruction to
    // change as little as possible.
    const fixFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    const failing = input.projectContext?.failingVerification ?? [];
    const evidence =
      failing.length > 0
        ? `\n\nReal verification evidence -- these step(s) FAILED just now when this project's own build/test/lint/typecheck scripts were run (see POST /verify):\n${failing
            .map((s) => `--- ${s.label} (${s.command}) ---\n${s.output}`)
            .join("\n\n")}`
        : "\n\nNo specific failing-step evidence was attached to this task -- diagnose from the project context below as best you can, and say so plainly in your summary.";

    return [
      "You are the MobiusX Desktop AI Assistant in FIX mode (Autonomous Build/Test/Fix Loop, roadmap Phase 6) -- diagnosing and repairing a REAL verification failure, not responding to a free-form feature request.",
      "Your job is to propose the MINIMAL set of file edits that fix the failing step(s) below. Do not refactor, rename, reformat, or \"improve\" anything unrelated to the failure -- a fix that changes more than it needs to makes the next verification pass harder to trust, not easier.",
      "If the evidence below is insufficient to diagnose a real fix (e.g. the output doesn't point at a specific file or line), say so plainly in your prose summary and propose your best-supported hypothesis rather than guessing silently.",
      "CRITICAL OUTPUT FORMAT -- follow this exactly, even for a multi-file fix:",
      "1. First write a brief prose summary (2-4 sentences) of what was failing and what you're changing to fix it. Do NOT describe individual files in prose, and do NOT put any file's contents in a markdown code fence in this summary.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing EVERY file you\'re creating or changing, as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path.ts", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      'Do not split files across multiple json blocks, and do not write any file\'s content anywhere except inside this one "edits" array (not in prose, not in a separate markdown code fence).',
      '"content" must be the entire new file content, never a diff, patch, or partial snippet -- even for a one-line fix, return the COMPLETE file with that line changed.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n (a single backslash followed by n). Do NOT double it to \\\\n (two backslashes) -- that writes literal backslash-n text into the file instead of a real line break.",
      fixFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${fixFullContentPaths.join(", ")}. Do not use "modify" for any other path.`
        : 'You were not shown the full content of any existing file, so do not use action "modify" at all -- only "create" a genuinely new path, and only if the fix genuinely requires one (rare for a fix).',
      'Only use action "create" for a path you are confident does not already exist in this project.',
      `Omit the ${EDITS_MARKER} marker and JSON block ONLY if you cannot propose any concrete fix from the evidence given.`,
      evidence,
      relevantFilesContext(input, true),
    ].join("\n");
  }

  const fullContentPaths = (input.projectContext?.relevantFiles ?? [])
    .filter((f) => f.content !== undefined)
    .map((f) => f.relPath);

  return [
    "You are the MobiusX Desktop AI Assistant in BUILD mode.",
    // Reinforced Sept 2026 after real evidence (openai/gpt-oss-120b via
    // Groq, asked to build a multi-file Next.js + FastAPI + SQLite app):
    // a model can be perfectly capable of proposing concrete file changes
    // and still not follow this custom marker+JSON convention on its
    // own -- it wrote a long, genuinely good multi-file answer as prose
    // with markdown code fences (tutorial-blog-post style, its default
    // training behavior for "build me X" prompts), never emitted
    // EDITS_MARKER at all, and so parseBuildResponse correctly found zero
    // edits -- not a parsing bug, a compliance gap. The instructions below
    // are now more explicit/repetitive about this being mandatory, not
    // optional, specifically for multi-file responses, since that's where
    // a model's natural "write it up like a tutorial" instinct seems to
    // compete hardest with the required format. Anthropic's Claude has not
    // shown this problem; free/open-weight models via Groq/OpenRouter are
    // the ones this is aimed at.
    "CRITICAL OUTPUT FORMAT — follow this exactly, even for a project with many files:",
    "1. First write a brief prose summary (2-4 sentences) of what you're building. Do NOT describe individual files in prose, and do NOT put any file's contents in a markdown code fence in this summary.",
    `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
    "3. Then exactly ONE fenced json code block containing EVERY file you're creating or changing — however many files the project needs — as entries in a single \"edits\" array, in this exact shape:",
    '{"edits": [{"path": "relative/path.ts", "action": "modify" | "create", "content": "COMPLETE new file content"}, {"path": "another/relative/path.py", "action": "create", "content": "COMPLETE new file content"}]}',
    "Do not split files across multiple json blocks, and do not write any file's content anywhere except inside this one \"edits\" array (not in prose, not in a separate markdown code fence). A 10-file project means 10 entries in this one array, not 10 separate code blocks in your response.",
    '"content" must be the entire new file content, never a diff, patch, or partial snippet.',
    "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n (a single backslash followed by n). Do NOT double it to \\\\n (two backslashes) -- that writes literal backslash-n text into the file instead of a real line break, and has been observed to corrupt files like requirements.txt.",
    // Reinforced Sept 2026 after real evidence (openai/gpt-oss-120b via
    // Groq, two separate Next.js + FastAPI + SQLite projects generated in
    // the same session): both times the model wrote backend/main.py using
    // package-relative imports ("from .database import ...", "from
    // .models import ..."). That's valid Python IF the app is ever run as
    // "python -m backend.main" from the project root, but this app (and
    // most real FastAPI tutorials/scaffolds) launches it as
    // "uvicorn main:app --reload" from *inside* backend/ -- which gives
    // main.py no package context at all, so a leading-dot import fails
    // immediately with "ImportError: attempted relative import with no
    // known parent package" the moment Start Preview runs it. This wasn't
    // a one-off; it's this model's default authoring habit for
    // multi-module FastAPI apps, so it's called out explicitly rather than
    // trusted to Python general knowledge.
    "If you are writing a Python/FastAPI backend split across multiple files in the same directory (e.g. main.py, models.py, database.py all directly under backend/), import sibling modules with PLAIN top-level names -- \"from database import ...\", \"from models import ...\" -- never with a leading dot (\"from .database import ...\"). This app runs the backend as \"uvicorn main:app\" from inside that directory, not as a Python package, so a dotted relative import will crash on startup with an ImportError.",
    "If that FastAPI backend will be called from a separately-hosted frontend (e.g. a Next.js dev server on a different port, as in a typical frontend/ + backend/ project layout), add CORS support in main.py -- import and add fastapi.middleware.cors.CORSMiddleware with allow_origins including at least \"http://localhost:3000\" (and ideally \"*\" for local dev) -- otherwise the browser will block every request the frontend makes to it.",
    fullContentPaths.length > 0
      ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${fullContentPaths.join(", ")}. Do not use "modify" for any other path.`
      : 'You were not shown the full content of any existing file, so do not use action "modify" at all — only "create" a genuinely new path.',
    'Only use action "create" for a path you are confident does not already exist in this project.',
    `Omit the ${EDITS_MARKER} marker and JSON block ONLY if you genuinely cannot propose any concrete file — e.g. the request is too ambiguous to act on. If you CAN write real file contents (as in most "build/add/create X" requests), you MUST use the format above — writing the same content as prose or markdown code fences instead is not an acceptable substitute, since only the json "edits" array actually gets applied to the user's project.`,
    relevantFilesContext(input, true),
  ].join("\n");
}

export function relevantFilesContext(input: RunnerInput, distinguishFullContent: boolean): string {
  const files = input.projectContext?.relevantFiles ?? [];
  if (files.length === 0) {
    // Real, observed failure mode (Sept 2026: qwen/qwen3.8-27b, asked to
    // build a student admission app from scratch) -- an empty
    // relevantFiles[] on its own is ambiguous: it could mean "this project
    // has no files at all" (every proposed file is a safe "create") or
    // "this project has files, none matched the search" (real risk of
    // colliding with an existing path the model was never shown). Left
    // ambiguous, a careful model reasonably refused to propose anything at
    // all rather than guess which case it was in -- so say plainly which
    // one it is instead of leaving this prompt section blank either way.
    const indexedChunkCount = input.projectContext?.indexedChunkCount;
    if (indexedChunkCount === 0) {
      return `\n\nThis project currently has no indexed files at all -- it's empty (or effectively so). Every file you propose should use action "create"; there is nothing existing to collide with.`;
    }
    if (typeof indexedChunkCount === "number" && indexedChunkCount > 0) {
      return `\n\nNo existing files matched this request closely enough to show you, but this project does have other files you weren't shown. You may still propose "create" for new, sensibly-named paths that clearly wouldn't already exist (e.g. a new feature's own files) -- just don't assume the project is empty.`;
    }
    return "";
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

/** Defensive server-side caps on top of the client's own (see renderer.js) — a runner should never choke on / balloon a prompt from an unexpectedly long or wordy history array, whatever sent it. */
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS_PER_TURN = 4000;

/**
 * Converts RunnerInput.history (see HistoryTurn in @mobiusx/protocol) into
 * chat messages to prepend before the current prompt, for every chat-style
 * runner (anthropic/openrouter/groq/ollama). Without this, each task is a
 * fresh one-shot request with no memory of anything said earlier in the
 * same AI Assistant panel session — the exact "history isn't maintained"
 * gap this closes. Returns [] when there's no history to add, so callers
 * can always spread the result into a messages array unconditionally.
 */
export function historyMessages(input: RunnerInput): { role: "user" | "assistant"; content: string }[] {
  const history = input.history ?? [];
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role,
    content:
      turn.content.length > MAX_HISTORY_CHARS_PER_TURN
        ? turn.content.slice(0, MAX_HISTORY_CHARS_PER_TURN) + "…"
        : turn.content,
  }));
}

export function stepId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
