import { getSettings } from "@mobiusx/agent-settings";
import { appendMemoryFacts } from "@mobiusx/assistant-memory";
import type { ProposedEdit } from "@mobiusx/protocol";
import type { RunnerInput } from "./types.js";

/**
 * Assistant Memory's automatic-extraction call (Oct 2026 addition — the
 * top-priority gap from a direct capability comparison against Claude
 * Chat/Code: this app had nothing resembling persisted, cross-session
 * memory of the user until this feature). See AgentSettings.memoryMode's
 * doc comment in @mobiusx/protocol for the opt-in contract, and
 * @mobiusx/assistant-memory's module doc comment for the storage layer.
 *
 * Deliberately wired at the SAME call sites as runPersonaReview
 * (personas.ts) — right after it, reusing the exact same `callModel`
 * closure each runner already built for that review call — rather than
 * centralized once in taskEngine.ts's runRunnerAndPersist(). That chokepoint
 * would be architecturally cleaner (one call site instead of four), but it
 * doesn't have a ready non-streamed "ask a model one question" capability
 * without adding one to the AgentRunner interface itself; personas.ts
 * already accepted this exact same duplication for the identical reason,
 * so this follows that real precedent rather than inventing a new pattern.
 *
 * Stated scope cut, not silently dropped: only fires for the structured-
 * edit modes runPersonaReview already covers (build/fix/spec/database/
 * architecture/testing/devops/auth with real edits). A user might equally
 * state a durable preference in a plain "ask" or "plan" conversation with
 * no files touched — that's a natural follow-up, not implemented here.
 */

const VALID_TARGET = /^\[(profile|preferences|topic-[a-z0-9-]+)\]\s*(.+)$/i;

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract durable facts worth remembering about this user and how they work, across FUTURE, SEPARATE sessions, from one just-completed AI Assistant task.",
  "Only extract things that are genuinely durable and reusable later: stated preferences for how the assistant should work, naming/architecture conventions the user explicitly asked for, recurring constraints, explicit corrections the user made. NEVER extract one-off specifics of this single task (which exact bug, which exact file, this task's particular numbers) or anything already obvious from reading the code itself.",
  "If nothing durable was stated, output exactly: NONE",
  "Otherwise output one fact per line, each prefixed with its target: [profile] for who the user is / their role, [preferences] for how they want the assistant to behave, or [topic-<short-slug>] for a specific recurring subject (e.g. [topic-database] for a persistent database convention). Keep each line compact, one sentence. Never invent a fact the user didn't actually state or confirm — when in doubt, leave it out.",
].join("\n");

export async function maybeExtractAssistantMemory(
  input: RunnerInput,
  finalOutput: string,
  edits: ProposedEdit[],
  callModel: (systemPrompt: string, userContent: string) => Promise<string>,
): Promise<void> {
  try {
    // Staged builds call the provider once per bounded implementation stage.
    // Running a separate memory-extraction inference after every intermediate
    // stage adds hidden latency and delays the next stage; extract once only
    // after the final stage (or once for a non-staged task).
    if (input.stagedBuild && !input.stagedBuild.final) return;
    // Automated runner tests must be independent of the user's real
    // ~/.mobiusx/settings.json and must not add an extra mocked model call.
    if (process.env.MOBIUSX_DISABLE_MEMORY_EXTRACTION === "1") return;
    const settings = await getSettings();
    if (settings.memoryMode !== "auto") return;
    if (!finalOutput.trim() && edits.length === 0) return;

    const editsSummary = edits.length > 0 ? `Files touched: ${edits.map((e) => `${e.action} ${e.path}`).join(", ")}` : "No files were changed.";
    const userContent = [
      `Task mode: ${input.mode}`,
      `User's request: ${input.prompt}`,
      "",
      "Assistant's response (truncated):",
      finalOutput.slice(0, 3000),
      "",
      editsSummary,
    ].join("\n");

    const raw = await callModel(EXTRACTION_SYSTEM_PROMPT, userContent);

    const byFile = new Map<string, string[]>();
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.toUpperCase() === "NONE") continue;
      const m = line.match(VALID_TARGET);
      if (!m) continue; // ignore any line that doesn't match the required [target] prefix, rather than guessing where it belongs
      const file = m[1].toLowerCase();
      const fact = m[2].trim();
      if (!fact) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(fact);
    }

    for (const [file, facts] of byFile) {
      await appendMemoryFacts(file, facts);
    }
  } catch {
    // Best-effort, same contract as runPersonaReview: a failed extraction
    // call (network error, malformed response, a disk write failure) must
    // never fail or delay the task it rode along with — this runs after
    // the task's own result has already been emitted to the user.
  }
}
