import { createHash } from "node:crypto";
import { BUILD_RESPONSE_CONTRACT_VERSION, type BuildResponseEnvelope, type ParsedBuildResponse, type ProposedEdit } from "@mobiusx/protocol";
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

/** Shared semantic contract injected into every runner's structured-edit prompt. Provider adapters may differ in transport format, but must normalize to this schema before proposing files. */
export const BUILD_RESPONSE_CONTRACT_RULES = [
  "MOBIUSX BUILD RESPONSE CONTRACT v1: return a concise user-facing summary and one edits array. Each edit has exactly a project-relative path, action ('create' or 'modify'), and the complete new file content. Never return diffs, partial snippets, placeholders, or claim a build/test passed without actual tool output.",
  "Use 'modify' only for an existing file whose complete contents were included in the supplied project context. Use 'create' only for a genuinely new path. Do not use absolute paths, parent-directory traversal, duplicate paths, or paths outside the project. If a necessary decision is genuinely unclear, ask up to three concise questions and return an empty edits array; otherwise implement with reasonable defaults.",
].join("\n");

/** Streams only the user-facing prose preceding the structured edit bundle.
 * Code/JSON after EDITS_MARKER stays buffered until it can be parsed and
 * shown in the review card; the model's separate reasoning channel is never
 * passed here. The small suffix buffer handles the marker split across SSE
 * chunks without leaking any of it into the visible prose. */
export function createStructuredProseStreamer(emit: (delta: string) => void): { push: (delta: string) => void; finish: () => string } {
  let pending = "";
  let visible = "";
  let sawMarker = false;
  const write = (text: string) => {
    if (!text) return;
    visible += text;
    emit(text);
  };
  return {
    push(delta) {
      if (sawMarker) return;
      pending += delta;
      const markerIndex = pending.indexOf(EDITS_MARKER);
      if (markerIndex !== -1) {
        write(pending.slice(0, markerIndex));
        pending = "";
        sawMarker = true;
        return;
      }
      const safeLength = Math.max(0, pending.length - EDITS_MARKER.length + 1);
      if (safeLength > 0) {
        write(pending.slice(0, safeLength));
        pending = pending.slice(safeLength);
      }
    },
    finish() {
      if (!sawMarker) write(pending);
      pending = "";
      return visible;
    },
  };
}

/**
 * Private model scratchpads are not user-facing telemetry. Across every
 * mode, expose concise conclusions and observable task/tool progress only.
 */
export const PUBLIC_PROGRESS_RULE =
  "Keep private chain-of-thought, hidden reasoning, and internal scratchpads private. Give concise user-facing explanations and conclusions, and report only observable progress or tool actions; never present hidden reasoning traces as status updates.";

/**
 * Standing quality rule appended to every mode that actually writes
 * application code (build, fix, database, testing, devops, auth) — feature
 * request: "always generate the project code that human engineers can
 * debug the code". Not a new capability, a prompt-level constraint: code
 * that's clever/compressed/unlabeled is harder for a human to pick up when
 * something goes wrong than code that's ordinary and legible, and this
 * platform's whole premise is a human reviewing and applying every edit
 * (see the Apply/Verify/Diagnose flow), not code nobody but the model can
 * follow.
 */
export const DEBUGGABLE_CODE_RULE =
  "Write code a human engineer can actually debug: clear, descriptive names (no single-letter variables outside trivial loop counters), small functions with a single obvious purpose, comments on non-obvious logic (why, not what), consistent formatting/style with the rest of this project, and explicit error handling with informative messages instead of silently swallowing failures. Prefer the straightforward, readable approach over a clever one-liner — this code will be read, run, and fixed by a person, not just executed.";

/** Keeps authenticated binary downloads usable across browser navigation. */
export const AUTHENTICATED_FILE_DOWNLOADS_RULE =
  "AUTHENTICATED FILE DOWNLOADS: when an API endpoint (for example, a payslip PDF, report export, or attachment) requires JWT/Bearer authentication, do not link to it with a plain <a href> or window.open because those requests cannot attach the Authorization header. Use a button that fetches the endpoint with the active bearer token, checks response.ok, reports API/network errors in the page, reads the successful response as a Blob, and downloads it via a temporary object URL that is revoked afterward. A direct link is acceptable only when the app uses a secure cookie session that the browser sends automatically; never put access tokens in query strings. Keep binary-download handling separate from JSON API helpers so a PDF is not parsed as JSON.";

/** Modes whose response is buffered and parsed for a structured ProposedEdit[] block, rather than streamed live token-by-token. */
export const MODES_WITH_STRUCTURED_EDITS = new Set<RunnerInput["mode"]>(["build", "spec", "fix", "database", "architecture", "testing", "devops", "auth"]);

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

/**
 * Candidate ways to pull the JSON object out of the text that follows
 * EDITS_MARKER, tried in order until one actually parses.
 *
 * Real, observed failure mode (Oct 2026 regression: a Claude build task
 * with a genuinely large multi-file response -- 14647 completion tokens,
 * comfortably under the max_tokens ceiling, so NOT a truncation case --
 * produced editsCount 0 despite the marker being present). Root cause: the
 * previous single strategy used a NON-GREEDY fence match
 * (```` ```(?:json)?\s*([\s\S]*?)``` ````), which stops at the FIRST ``` it
 * finds after the opening fence. For a large build this is routinely a
 * nested code fence inside one of the proposed files' own content -- most
 * commonly a generated README.md or any markdown file whose content legitimately
 * contains ``` for its own example code blocks -- which truncates the
 * extracted text mid-JSON and makes it unparseable. The larger and more
 * complete a build response is (exactly what the COMPLETENESS/FIRST-RUN
 * CONTENT prompt additions push models toward), the more likely it is to
 * contain such a nested fence, so this bug got MORE likely to fire, not
 * less, as build quality improved -- worth stating explicitly since it's
 * counterintuitive.
 *
 * Fix: prefer anchoring to the LAST ``` in the remainder as the real
 * closing fence (correct whenever the model closes the fence at the very
 * end of its response, as instructed -- the overwhelmingly common case),
 * falling back to the old first-fence behavior and then the raw
 * unstripped remainder, so a response that doesn't fit the common shape
 * still gets a real parse attempt instead of silently losing every edit.
 */
function candidateJsonTexts(rest: string): string[] {
  const trimmed = rest.trim();
  const candidates: string[] = [];

  const leadingFence = trimmed.match(/^```(?:json)?\s*/i);
  if (leadingFence) {
    const body = trimmed.slice(leadingFence[0].length);
    const lastFenceIdx = body.lastIndexOf("```");
    candidates.push((lastFenceIdx === -1 ? body : body.slice(0, lastFenceIdx)).trim());
  }

  // Old behavior: first fence pair found anywhere (non-greedy) -- kept as a
  // fallback for a response shaped differently than the common case above.
  const firstFenceMatch = rest.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (firstFenceMatch) candidates.push(firstFenceMatch[1].trim());

  candidates.push(trimmed);
  return [...new Set(candidates)]; // de-dupe -- often the same string from two strategies
}

export function parseBuildResponse(
  fullText: string,
  input: RunnerInput,
): ParsedBuildResponse & { prose: string } {
  const markerIdx = fullText.indexOf(EDITS_MARKER);
  if (markerIdx === -1) {
    const trimmed = fullText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    try {
      const envelope = JSON.parse(trimmed) as Partial<BuildResponseEnvelope>;
      if (envelope && typeof envelope === "object" && "edits" in envelope) {
        if (Object.keys(envelope).some((key) => key !== "summary" && key !== "edits")) {
          return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: "", prose: "", edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
        }
        if (Array.isArray(envelope.edits)) {
          const summary = typeof envelope.summary === "string" ? envelope.summary : "";
          return parseBuildResponse(`${summary}\n${EDITS_MARKER}\n${JSON.stringify({ edits: envelope.edits })}`, input);
        }
        return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: "", prose: "", edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
      }
    } catch {
      if (/^\s*(?:```(?:json)?\s*)?\{[\s\S]*["']edits["']\s*:/i.test(fullText)) {
        return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: "", prose: "", edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
      }
    }
    return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: "", prose: fullText, edits: [], droppedCount: 0, hadMarker: false, parseFailed: false };
  }

  let prose = fullText.slice(0, markerIdx).trim();
  const rest = fullText.slice(markerIdx + EDITS_MARKER.length);

  let parsed: unknown;
  let didParse = false;
  for (const candidate of candidateJsonTexts(rest)) {
    try {
      parsed = JSON.parse(candidate);
      didParse = true;
      break;
    } catch {
      continue; // try the next extraction strategy
    }
  }
  if (!didParse) {
    // Real, observed failure mode (Oct 2026, this exact session): a live
    // Claude build task streamed for 2+ minutes, ended with EDITS_MARKER
    // present, and STILL produced zero files on disk -- with no warning
    // shown anywhere. Root cause traced by reading this function: when
    // every candidateJsonTexts() strategy fails to JSON.parse (the classic
    // cause is the response hitting max_tokens mid-JSON, so the edits
    // block is cut off mid-string/mid-array, not malformed-but-complete
    // JSON), this used to return droppedCount: 0 -- identical to the
    // "model deliberately proposed zero edits" case below -- so every
    // caller's `if (droppedCount > 0)` check stayed silent and some
    // callers (openAiCompatibleRunner.ts) actively mislabeled it as "the
    // model asked a clarifying question." parseFailed distinguishes this
    // case so callers can tell a human-readable truth and retry, instead
    // of quietly discarding a real (if truncated) generation.
    return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: prose, prose, edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { edits?: unknown }).edits)) {
    return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: prose, prose, edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
  }
  const envelope = parsed as { summary?: unknown; edits: unknown[] };
  if (Object.keys(parsed as object).some((key) => key !== "summary" && key !== "edits")) {
    return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: prose, prose, edits: [], droppedCount: 0, hadMarker: true, parseFailed: true };
  }
  if (!prose && typeof envelope.summary === "string") prose = envelope.summary.trim();
  const rawEdits = envelope.edits;

  const modifiableRelPaths = new Map(
    (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => [f.relPath.replaceAll("\\", "/").toLocaleLowerCase("en-US"), f.relPath.replaceAll("\\", "/")]),
  );
  const expectedActions = new Map((input.stagedBuild?.subtask?.targetFileOperations ?? [])
    .map((target) => [target.path.replaceAll("\\", "/").toLocaleLowerCase("en-US"), target]));

  const edits: ProposedEdit[] = [];
  const seenPaths = new Set<string>();
  const rejectedEditPaths: string[] = [];
  let droppedCount = 0;
  for (const raw of rawEdits) {
    if (!raw || typeof raw !== "object") {
      droppedCount++;
      continue;
    }
    if (Object.keys(raw).some((key) => !["path", "action", "content"].includes(key))) {
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
    // Common contract validation runs before the desktop agent's independent
    // resolveWithinProject guard. Normalize Windows separators, then reject
    // absolute paths, traversal, NUL bytes, and duplicate destinations.
    const normalizedPath = e.path.replaceAll("\\", "/");
    if (/\0/.test(normalizedPath) || normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath) || normalizedPath.split("/").includes("..")) {
      droppedCount++;
      continue;
    }
    const pathKey = normalizedPath.toLocaleLowerCase("en-US");
    if (seenPaths.has(pathKey)) {
      droppedCount++;
      continue;
    }
    const canonicalExistingPath = modifiableRelPaths.get(pathKey);
    const expectedTarget = expectedActions.get(pathKey);
    // Staged Build knows whether each exact target is new or an existing,
    // checkpointed file. Correct a model that labels a complete new-file
    // replacement as "modify" only when the stage contract explicitly says
    // create. The desktop agent still enforces create-must-not-exist at the
    // actual workspace boundary, so this cannot overwrite an unreported file.
    if (expectedTarget?.action === "create" && e.action === "modify") {
      seenPaths.add(pathKey);
      edits.push({ path: normalizedPath, action: "create", content: repairOverEscapedContent(e.content) });
      continue;
    }
    if (e.action === "modify" && !canonicalExistingPath) {
      droppedCount++;
      rejectedEditPaths.push(normalizedPath);
      continue;
    }
    if (expectedTarget?.action === "modify" && e.action === "create") {
      droppedCount++;
      rejectedEditPaths.push(normalizedPath);
      continue;
    }
    if (e.action === "modify" && expectedTarget?.expectedContentSha256) {
      const contextFile = (input.projectContext?.relevantFiles ?? []).find((file) => file.relPath.replaceAll("\\", "/").toLocaleLowerCase("en-US") === pathKey && file.content !== undefined);
      if (!contextFile || createHash("sha256").update(contextFile.content!).digest("hex") !== expectedTarget.expectedContentSha256) {
        droppedCount++;
        rejectedEditPaths.push(normalizedPath);
        continue;
      }
    }
    seenPaths.add(pathKey);
    edits.push({ path: e.action === "modify" ? canonicalExistingPath! : normalizedPath, action: e.action, content: repairOverEscapedContent(e.content) });
  }

  return { contractVersion: BUILD_RESPONSE_CONTRACT_VERSION, summary: prose, prose, edits, droppedCount, hadMarker: true, parseFailed: false, ...(rejectedEditPaths.length ? { rejectedEditPaths } : {}) };
}

/**
 * Project Memory/Steering (roadmap Phase 16, source requirement §24/§25):
 * every mode's prompt is grounded in this project's own
 * .mobiusx/steering/*.md conventions when any exist -- see
 * ProjectContext.steeringContext's doc comment in @mobiusx/protocol for
 * why this is intentionally NOT scoped to one mode (build/fix/etc.) the
 * way architectureEvidence/testingEvidence are: a real engineer consults
 * a project's own conventions regardless of what task they're doing.
 * Prepended, not appended, so it reads as standing context the specific
 * mode instructions below then apply.
 */
function steeringContextBlock(input: RunnerInput): string {
  const steering = input.projectContext?.steeringContext;
  if (!steering) return "";
  return `This project has its own recorded engineering conventions (.mobiusx/steering/) — follow them wherever they apply to this request, and never contradict them without saying so explicitly in your response:
${steering}

---

`;
}

/**
 * Assistant Memory (Oct 2026 addition — see MemoryFile's doc comment in
 * @mobiusx/protocol's agent.ts for the full feature background). Prepended
 * BEFORE steeringContextBlock above, not after: memory is standing context
 * about the USER (who they are, how they like to work) that holds across
 * every project, whereas steering is THIS project's own conventions — the
 * natural reading order is "who you're working with" then "the rules of
 * this particular codebase". Like steering, intentionally not scoped to
 * any one mode: a real colleague who knows your preferences brings that
 * knowledge to a quick question exactly as much as to a big build.
 */
function assistantMemoryBlock(input: RunnerInput): string {
  const memory = input.projectContext?.assistantMemoryContext;
  if (!memory) return "";
  return `You have standing memory of this user from past sessions — real facts they stated or confirmed, not assumptions. Use it to tailor your response; never recite it back verbatim or mention that you "remember" it unless the user asks:
${memory}

---

`;
}

/**
 * Web App / Enterprise / Core / Embedded app style mode (Oct 2026 addition) — a
 * per-task toggle in the Assistant panel's header (see renderer.js's
 * `archMode` state in createAssistantPanel), threaded through
 * CreateTaskRequest -> RunnerInput unchanged. Like steeringContextBlock
 * above, this is intentionally NOT scoped to build-like modes only: Ask
 * and Plan should answer in the same register as whatever Build would
 * actually produce, so a developer asking "how should I structure this
 * endpoint" in Ask mode gets lean-prototype advice or layered-architecture
 * advice consistent with what a follow-up Build task would generate.
 *
 * Deliberately absent (input.archMode undefined) for every call site that
 * doesn't expose the toggle -- the Verify panel's "Diagnose & Fix" button
 * and the Debug & Fix ticket-to-fix flow both create mode:"fix" tasks
 * directly, outside the Assistant panel, with no toggle in their UI to set
 * this from. Returning "" for undefined (rather than defaulting to either
 * mode) keeps those call sites' prompts byte-for-byte unchanged.
 */
function archModeGuidanceBlock(input: RunnerInput): string {
  if (input.archMode === "core") {
    return `APPLICATION STYLE: Core App (general-purpose software development). This request is about creating, extending, or debugging an application. Work in the language and ecosystem requested or already used by the project, including C, C++, Java, Python, C#, JavaScript/TypeScript, Go, Rust, and other languages you can handle. Inspect the supplied files first; preserve the existing framework/runtime version, architecture, package manager, toolchain, naming, and conventions. Do not convert the project or add an unrelated stack unless explicitly requested. For debugging, trace supplied errors and failing commands to the smallest supported fix and preserve unrelated behavior. Follow the repository's actual build, run, and test commands when available; never claim a command succeeded unless its output confirms that. Add focused regression coverage when the project has an appropriate test setup. State capability or tooling limits plainly rather than fabricating details.

---

`;
  }
  if (input.archMode === "embedded") {
    return `APPLICATION STYLE: Embedded Apps (embedded, bare-metal, and RTOS development). Apply this guidance only to projects or requests that identify an MCU, SoC, RTOS, bare-metal target, embedded Linux system, or hardware interface. Work in the existing/requested language and toolchain, including C, Embedded C++, Rust (including no_std where appropriate), and HDL such as Verilog/SystemVerilog for hardware verification. First inspect the project and identify the exact board/chip, core, SDK/toolchain, RTOS and version, clock configuration, memory limits, pin/peripheral assignments, and relevant datasheet/evidence. Do not invent register addresses, bit masks, pin mappings, interrupt numbers, clock rates, hardware capabilities, or vendor API signatures. If required details are missing, ask focused questions or label assumptions clearly; do not present guessed hardware code as ready to flash. Distinguish bare-metal, RTOS, and embedded-Linux designs, and use the existing HAL/BSP/vendor SDK.

MISSION-CRITICAL RELIABILITY: Treat safety and failure requirements as constraints, not as proof generated code is safe. Identify hazards, safe states, fault-detection paths, recovery behavior, and degraded modes supported by the requirements. Use watchdogs, brownout/hardware-fault handling, redundancy, and recovery only when supported by the target and system design; ensure recovery cannot repeat unsafe actions or conceal persistent faults. Never promise failure is impossible or code is certified. For medical, automotive, aviation, industrial-control, or other safety-critical use, surface the need for hazard analysis, traceability, independent review, target-hardware verification, and applicable certification; never recommend deploying AI-generated code directly to a live safety-critical system.

REAL-TIME AND CONCURRENCY: Do not invent microsecond deadlines or claim deterministic timing without a stated budget and target measurements. Distinguish hard from soft deadlines; reason about worst-case execution time, interrupt latency, priorities, scheduling, stack sizes, and blocking. Keep ISRs short and bounded; never block or do unbounded work in an ISR, and defer processing to tasks/queues when appropriate. Use tasks, queues, semaphores, and mutexes according to the project's FreeRTOS, Zephyr, VxWorks, QNX, or other RTOS version. Address priority inversion, races, atomicity, and inter-core ownership when relevant. Separate time-critical control from UI, logging, telemetry, and connectivity work.

HARDWARE AND RESOURCE CONSTRAINTS: Use peripherals/protocols such as GPIO, timers, ADC, I2C, SPI, UART, CAN, BLE, PCIe, and DMA only when supported by the target and requirements. Respect DMA buffer lifetime/alignment, cache coherency, memory barriers, MMIO semantics, and concurrency; volatile alone is not thread safety. Meet explicit RAM, Flash, stack, and latency budgets. For constrained or deterministic targets, prefer bounded/static allocation, fixed-size buffers or pools, and no heap/GC in time-critical paths when compatible with the runtime and requirements. Make buffer bounds and failure behavior explicit.

DEBUGGING AND VERIFICATION: Trace logs, crash dumps, fault registers, map files, stack/heap evidence, and race symptoms to the smallest supported fix. Consider stack overflow, memory corruption, pointer/lifetime errors, data races, deadlocks, priority inversion, and timing overruns when relevant. Use actual compiler, linker, build, test, simulator, and flashing commands; never claim verification without confirming output. Prefer host-side tests for portable logic plus target-appropriate simulation, hardware-in-the-loop, fault-injection, and hardware testbench verification. State what could not be verified without target hardware or instrumentation. Preserve the project's conventions and unrelated behavior.

---

`;
  }
  if (input.archMode === "enterprise") {
    return `ARCHITECTURE MODE: Enterprise Application (Robust, Secure, and Maintainable). Design for clear ownership, integration boundaries, operability, and safe change over time. First inspect the repository and the user's requested scope. Follow its existing language, framework, deployment model, and conventions; use suitable enterprise frameworks when starting a new component or when explicitly requested (for example Spring Boot, ASP.NET Core, Django, or Quarkus). Do not add distributed infrastructure just to make a design look enterprise-grade.

ARCHITECTURE AND APIs: Split responsibilities into cohesive layers or modules appropriate to the project (for example MVC, Clean Architecture, DDD, or ports-and-adapters); explain the choice briefly when it affects structure. Keep domain rules separate from transport and persistence where the scope justifies it. For service boundaries, define versionable REST endpoints and request/response contracts; use GraphQL or gRPC only when requested or supported by clear project requirements. For multiple services, identify ownership, dependencies, failure boundaries, and communication needs. Prefer asynchronous/event-driven communication only when it improves decoupling or reliability for a real workflow; never assume a broker exists.

PATTERNS AND OPERABILITY: Apply SOLID and established patterns (dependency injection, Strategy, Factory, Observer, and Singleton) where they solve an evidenced problem; avoid pattern-for-pattern's-sake and never use a process-wide Singleton for mutable request/user state. Add consistent structured logging, centralized error handling, validated configuration, and clear service boundaries appropriate to the framework. Keep modules cohesive and changes reviewable; a small feature does not require scaffolding unrelated tiers.

DATA AND PERSISTENCE: Follow the existing database and ORM (including Hibernate, Entity Framework, Prisma, Django ORM, or the project's equivalent). Keep schema/model/migration changes consistent, use parameterized queries, and preserve transaction boundaries for multi-step writes. Consider indexes from actual query/filter/order patterns and data volume; do not add speculative indexes or silently change database engines. Make transaction isolation and concurrency assumptions explicit when they affect correctness.

SECURITY AND RESILIENCE: Treat authentication and authorization as separate concerns. Use the project's established JWT, OAuth2/OIDC, or secure-session approach; enforce least privilege and resource-level RBAC/ABAC checks on protected operations. Validate and constrain untrusted input, encode output, use CSRF protections for cookie-authenticated state changes, and prevent SQL injection through parameterized access. Never hard-code secrets. Handle errors without leaking credentials or sensitive data. For remote dependencies, apply explicit timeouts and bounded retries with backoff only for safe/idempotent operations; use circuit breakers or bulkheads only where the stack supports them and a real failure boundary warrants them. Do not swallow errors or retry non-idempotent writes blindly.

TESTING AND DELIVERY: Add or update focused unit/integration tests for changed behavior and security-sensitive paths, following the repository's existing test setup. When requested or supported by project evidence, generate production-conscious containers, Compose wiring, and CI/CD workflows for the actual stack (GitHub Actions, GitLab CI, or Jenkins); use Terraform or Kubernetes manifests only when requested or clearly part of the existing deployment. Ground every service, port, command, environment variable, and deployment artifact in the repository or the user's requirements. Use non-root containers, minimal runtime images, health checks, pinned/reproducible dependencies, secret injection, and least-privilege permissions where applicable. Do not invent infrastructure or claim builds, tests, scans, or deployments succeeded without output confirming it.

---

`;
  }
  if (input.archMode === "web") {
    return `ARCHITECTURE MODE: Web Application (Lean & Agile). Prioritize speed-to-market, a clean UI, and a modern developer/user experience over heavyweight process. Favor modern frameworks already common in this ecosystem (Next.js/React/Vue/Svelte-style component patterns), utility-first styling, light client or server state management, and the simplest database that fits (lightweight SQL or NoSQL) over introducing new infrastructure. Favor component modularity, client-side routing, and rapid, working prototypes. Skip enterprise scaffolding this request doesn't need — no multi-layer DI containers, no message brokers, no speculative abstraction — unless the user actually asks for it. "Lean" governs process and infrastructure only, never visual finish — this mode's whole point is a product a real user would judge on sight, so the VISUAL QUALITY and DEPENDENCY VERSION SAFETY rules below (when this task is in Build mode) are not optional extras to trim for speed; a fast, under-designed result is not actually lean, it's just unfinished.

---

`;
  }
  return "";
}

export function systemPromptFor(input: RunnerInput): string {
  const editContract = input.mode === "ask" || input.mode === "plan" ? "" : `${BUILD_RESPONSE_CONTRACT_RULES}\n\n`;
  const memory = `${PUBLIC_PROGRESS_RULE}\n\n${editContract}${assistantMemoryBlock(input)}`;
  const steering = steeringContextBlock(input);
  const archGuidance = archModeGuidanceBlock(input);
  if (input.mode === "ask") {
    return (
      memory + steering + archGuidance + "You are the MobiusX Desktop AI Assistant, answering a developer's question." + relevantFilesContext(input, false)
    );
  }
  if (input.mode === "plan") {
    return (
      memory + steering + archGuidance + "You are the MobiusX Desktop AI Assistant. Draft a concrete, numbered implementation plan — do not write full code." +
      relevantFilesContext(input, false)
    );
  }
  if (input.mode === "spec") {
    // Project Understanding + Specification Engine (roadmap Phase 7,
    // source requirement §6): acceptance criteria are no longer just
    // Given/When/Then prose -- each one gets a stable REQ-NNN id (numbered
    // continuously across BOTH functional and non-functional requirements,
    // in the order they appear in the markdown doc) and a second,
    // machine-readable JSON twin is emitted alongside the markdown, so the
    // UI can render a real checklist instead of parsing prose. The
    // markdown doc remains the human-facing artifact; the JSON is never
    // meant to be read standalone.
    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in SPEC mode — a Requirements Engineering assistant (not a coder in this mode).",
      "Given the user's natural-language request, write a structured requirements specification as a single markdown document with EXACTLY these sections, in this order: '## Overview', '## Functional Requirements' (numbered), '## Non-Functional Requirements' (numbered), '## Constraints & Assumptions', '## Risks', '## Acceptance Criteria'.",
      "EVERY requirement in '## Functional Requirements' and '## Non-Functional Requirements' must be prefixed with a stable id in the form 'REQ-001', 'REQ-002', ... — numbered continuously across both sections in the order they appear (do not restart numbering for non-functional requirements). Example line: '1. **REQ-001** — The system shall let a user reset their password via emailed link.'",
      "In '## Acceptance Criteria', write one Given/When/Then scenario per requirement, each labeled with the SAME REQ-NNN id it tests, e.g. '**REQ-001** — Given a registered user on the login page, When they click \"Forgot password\" and submit their email, Then a reset link is emailed within 60 seconds.' Every REQ-NNN from the requirements sections must have at least one acceptance criterion; never introduce a REQ-NNN id in this section that wasn't defined above.",
      "If the request is ambiguous or missing information a real spec would need, do not guess silently — add those as explicit open questions under a '## Open Questions' section instead of inventing requirements the user never stated.",
      "First, write a one-to-two-sentence prose summary of what you're specifying.",
      `Then, on its own line, output exactly ${EDITS_MARKER} followed by a single fenced json code block with this exact shape (TWO edits — the markdown doc AND its structured JSON twin, both required):`,
      '{"edits": [' +
        '{"path": ".mobiusx/specs/<kebab-case-slug>.md", "action": "create", "content": "the complete markdown spec document"}, ' +
        '{"path": ".mobiusx/specs/<kebab-case-slug>.json", "action": "create", "content": "{\\"feature\\": \\"short title\\", \\"slug\\": \\"<kebab-case-slug>\\", \\"requirements\\": [{\\"id\\": \\"REQ-001\\", \\"category\\": \\"functional\\", \\"statement\\": \\"the requirement text, no id prefix\\", \\"acceptanceCriteria\\": [{\\"given\\": \\"...\\", \\"when\\": \\"...\\", \\"then\\": \\"...\\"}]}], \\"openQuestions\\": []}"}' +
      ']}',
      "Each requirement's \"category\" must be exactly the string \"functional\" or \"non-functional\" (never both, and never any other value). Use the exact same <kebab-case-slug> for both files' paths. The .json file's \"content\" is itself a JSON string (escaped exactly as shown) containing every REQ-NNN from the markdown doc with its category, statement, and acceptance criteria — this must stay in exact sync with the markdown; never list a REQ-NNN in one file but not the other. Choose a short, descriptive kebab-case slug for the filename based on the feature being specified (e.g. \"subscription-management\"). Always use action \"create\" for both files — never \"modify\" in this mode.",
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

    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in FIX mode (Autonomous Build/Test/Fix Loop, roadmap Phase 6) -- diagnosing and repairing a REAL verification failure, not responding to a free-form feature request.",
    DEBUGGABLE_CODE_RULE,
      AUTHENTICATED_FILE_DOWNLOADS_RULE,
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

  if (input.mode === "database") {
    // Database Engineering (roadmap Phase 8, source requirement §8):
    // schema/migration/ORM-model generation as its own reviewable
    // artifact class -- reuses the exact same propose-edits/review/apply
    // pipeline as "build" (see MODES_WITH_STRUCTURED_EDITS above), but the
    // prompt is specifically scoped to database artifacts and, critically,
    // instructed to follow whatever real ORM/DB convention the project
    // already uses (evidenced by relevantFiles below) rather than
    // inventing a new one -- the same "never guess, only react to what's
    // actually there" principle previewOps.ts and projectContext.ts use.
    // GET /db/consistency (dbOps.ts) checks the result afterward for real
    // schema<->ORM agreement rather than trusting the model's own claim.
    const dbFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in DATABASE mode (Database Engineering, roadmap Phase 8) -- proposing a schema, its forward migration, and ORM model changes as ONE coherent set, not scattered files inside a generic build request.",
    DEBUGGABLE_CODE_RULE,
      "First, inspect the files shown to you below (if any) for an EXISTING database/ORM convention already used in this project -- an ORM's model classes (e.g. SQLModel/SQLAlchemy/Prisma/Sequelize/TypeORM/Mongoose), an existing schema file, or a migrations directory. If you find one, follow that exact convention and file layout. If you find none, default to plain SQL DDL for PostgreSQL under \"db/schema.sql\" and a matching forward migration under \"db/migrations/<NNN>_<slug>.sql\" (zero-padded 3-digit NNN, incrementing from the highest existing migration number you were shown, or 001 if none) -- and say so explicitly in your prose summary (e.g. \"No existing ORM or schema convention was found, so this assumes plain PostgreSQL.\"). Never silently switch technology away from what the project already evidently uses.",
      "Every table you add or change in the schema/migration MUST have a corresponding entry in the ORM model file when this project uses an ORM -- never update one layer and leave the other stale. State the entities and their relationships in one to two prose sentences (a brief domain model) before the file list, so the schema's intent is reviewable on its own, not just its SQL.",
      "If the request requires a destructive operation (DROP TABLE, DROP COLUMN, TRUNCATE, a non-additive column type change), say so explicitly and plainly in your prose summary as a risk -- this codebase has no migration rollback/checkpoint mechanism yet (see roadmap Phase 15), so a destructive migration cannot be undone automatically once applied.",
      "CRITICAL OUTPUT FORMAT -- follow this exactly, even for a multi-file schema change:",
      "1. First write a brief prose summary (2-5 sentences): the domain model/entities, which convention you followed or assumed, and any destructive-operation risk. Do NOT put any file's contents in a markdown code fence in this summary.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing every file being created or changed (schema + migration + ORM model(s), as applicable), as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content, never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n. Do NOT double it to \\\\n.",
      dbFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${dbFullContentPaths.join(", ")}. Do not use "modify" for any other path -- propose a new migration file instead of editing an already-applied one.`
        : 'You were not shown the full content of any existing file, so prefer action "create" for new schema/migration/model files; only use "modify" for a path you are highly confident exists and whose current content you can safely infer is being fully replaced (rare -- prefer a new migration file when in doubt).',
      'Only use action "create" for a path you are confident does not already exist in this project.',
      relevantFilesContext(input, true),
    ].join("\n");
  }

  if (input.mode === "architecture") {
    // Architecture Generation (roadmap Phase 9, source requirement §7).
    //
    // Direct trigger: a beta tester reported generated architecture
    // diagrams were "very basic level." The root cause diagnosed here is
    // the same one Database mode hit in Phase 8 -- a model asked to draw
    // an architecture diagram from a one-line prompt and no real project
    // facts has nothing to draw but generic "Frontend -> Backend ->
    // Database" boxes, because that's the only information it has. A
    // better-worded prompt cannot fix a missing-facts problem. So this
    // mode's grounding is fundamentally different from every other mode:
    // instead of semantic-search snippets (relevantFiles), it is handed a
    // single pre-computed, evidence-cited bundle -- architectureEvidence,
    // gathered by apps/desktop-agent/src/architectureContext.ts from the
    // project's REAL detected tech stack, schema/ORM relationships, HTTP
    // routes, and external integrations -- and instructed to render that
    // bundle faithfully rather than invent around gaps in it. Where the
    // evidence is genuinely empty (no external integrations detected, no
    // infra/deployment files found), the instructions below require an
    // honest prose note in the generated doc instead of a fabricated box,
    // mirroring the "unknown"/"not_configured" honesty pattern already
    // used by projectContext.ts and dbOps.ts.
    const evidence = input.projectContext?.architectureEvidence;
    const architectureFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in ARCHITECTURE mode (Architecture Generation, roadmap Phase 9) -- producing a High-Level Design doc and a Low-Level Design doc, each with real Mermaid diagrams grounded strictly in the evidence bundle below, not generic or invented architecture.",
      "",
      "THE #1 RULE, non-negotiable: every box, arrow, table, route, and external system you draw MUST trace back to a specific field in the JSON evidence bundle below. Do not add a generic \"Load Balancer\", \"Cache\", \"Message Queue\", \"Auth Service\", or any other component that isn't actually evidenced -- these are exactly the kind of boilerplate-textbook boxes a beta tester flagged as \"very basic level\" and low quality. If the evidence bundle doesn't show it, it doesn't go in the diagram.",
      "",
      evidence
        ? architectureEvidenceContext(evidence)
        : "No pre-computed architecture evidence was available for this project (this should not normally happen -- treat it as a signal to produce only the most minimal, honestly-labeled diagrams, explicitly noting in prose that evidence gathering did not run).",
      "",
      "DIAGRAM REQUIREMENTS -- use Mermaid's plain flowchart/erDiagram/sequenceDiagram syntax (flowchart TD with labeled subgraphs for System Context/Container/Component levels), NOT the experimental C4Context/C4Container syntax, which renders unreliably in this app's Mermaid version:",
      "",
      "In docs/architecture/HLD.md:",
      '1. "System Context" diagram (```mermaid flowchart TD```): the system as one box, a "User" actor, and one box per entry in externalIntegrations (label each edge with that integration\'s evidenced purpose, e.g. its name). If externalIntegrations is empty, draw only the User -> System edge and add a one-sentence honest note: "No external third-party integrations were detected in this project\'s dependencies."',
      '2. "Container" diagram (```mermaid flowchart TD```): one box per entry in projectContext.components (using each component\'s real name/category/location), plus a box for the database if database.schemaTables or database.ormEntities is non-empty. Draw an edge between frontend and backend components labeled with the real protocol/origin from frontendBackendLinks when present (e.g. "HTTPS, CORS: http://localhost:3000"); if frontendBackendLinks is empty, label the edge "HTTP (origin not detected)" rather than inventing a specific one.',
      "3. A short prose paragraph identifying the real detected tech stack (frameworks/languages from projectContext.components) and stating plainly any part of the standard stack (auth, caching, deployment/infra) that was NOT detected, rather than omitting it silently.",
      "",
      "In docs/architecture/LLD.md:",
      '1. "Component" diagram (```mermaid flowchart TD```): break the backend component down into groups of its real routes from the routes array, grouped by common path prefix (e.g. all "/products*" routes as one component). Do not invent internal modules/services beyond what the routes evidence supports.',
      '2. "Sequence" diagram (```mermaid sequenceDiagram```): pick ONE real, representative route from the routes array (prefer a POST/PUT if any exist) and trace an actual request through User -> Frontend -> Backend -> Database (only include the Database participant if this route\'s handler plausibly touches persisted data, i.e. the project has database evidence at all). Use the route\'s real method and path as the message label. If routes is empty, skip this diagram and say explicitly in prose: "No HTTP routes were detected, so no request sequence could be traced."',
      '3. "ER" diagram (```mermaid erDiagram```): built strictly from database.relationships (for the FK-derived edges, labeled with each relationship\'s real `via` column pair) and database.schemaTables / database.ormEntities for the entities themselves. If both are empty, skip this diagram and state plainly: "No database schema or ORM entities were detected in this project."',
      '4. "Deployment" diagram: only include this diagram if the evidence bundle shows concrete infrastructure/deployment facts (it currently does not gather any -- this phase\'s evidence bundle has no infra signal). Since no deployment evidence is gathered yet, DO NOT draw a Deployment diagram -- instead write one honest sentence: "Deployment/infrastructure evidence is not yet gathered by this tool, so no Deployment diagram is included rather than guessing at hosting details."',
      "",
      "CRITICAL OUTPUT FORMAT -- follow this exactly:",
      "1. First write a brief prose summary (2-4 sentences) of the real system this documents, referencing the actual detected stack -- not a generic description that could apply to any project.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing BOTH files (docs/architecture/HLD.md and docs/architecture/LLD.md), as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "docs/architecture/HLD.md", "action": "modify" | "create", "content": "COMPLETE new file content"}, {"path": "docs/architecture/LLD.md", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content (including its Mermaid code fences as literal ```mermaid blocks inside the markdown), never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n. Do NOT double it to \\\\n.",
      architectureFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${architectureFullContentPaths.join(", ")}. Do not use "modify" for any other path.`
        : 'You were not shown the full content of an existing docs/architecture/HLD.md or docs/architecture/LLD.md, so use action "create" for both -- this most likely means neither file exists yet in this project.',
      relevantFilesContext(input, true),
    ].join("\n");
  }


  if (input.mode === "testing") {
    // Testing Engine (roadmap Phase 10, source requirement §15).
    //
    // verify.ts (Phase 6) only ever RAN a project's tests -- nothing in
    // this codebase generated them. Same root-cause diagnosis as Database
    // (Phase 8) and Architecture (Phase 9): a model asked to write tests
    // with zero real facts about this project's test framework has
    // nothing to go on but a guessed one, often the wrong ecosystem
    // entirely (e.g. a Jest test for a Python backend). This mode is
    // grounded in a dedicated evidence bundle (GET /testing-evidence, see
    // apps/desktop-agent/src/testingContext.ts) -- this project's REAL
    // detected test framework(s) (reusing Phase 7's own detection, never
    // re-guessed) and, when one exists, a real existing test file to
    // match style against -- PLUS the actual target file(s) to test,
    // shown below via the normal relevantFiles mechanism (the same
    // grounding build/fix already use), so tests are written against
    // real, visible code, never an imagined API.
    const testingEvidence = input.projectContext?.testingEvidence;
    const testingFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in TESTING mode (Testing Engine, roadmap Phase 10) -- writing real, runnable test file(s) for the code shown to you below.",
    DEBUGGABLE_CODE_RULE,
      "",
      "THE #1 RULE, non-negotiable: only write tests against functions, classes, routes, or exports that ACTUALLY APPEAR in the file content shown to you below -- never invent a function, parameter, or return shape you weren't shown. If you can't see what a piece of code does, test its actually-visible behavior, don't guess at intent beyond that.",
      "",
      testingEvidence
        ? testingEvidenceContext(testingEvidence)
        : "No pre-computed testing evidence bundle was available for this project (this should not normally happen) -- treat it as a signal to be extra conservative about which framework you assume, and say so plainly in your summary.",
      "",
      !testingEvidence || testingEvidence.testFrameworks.length === 0
        ? 'No test framework was detected anywhere in this project (see the evidence above). Do NOT invent one -- do not assume Jest/Vitest/Mocha for JavaScript or pytest/unittest for Python just because that would be a normal default elsewhere. Say so plainly in your prose summary (e.g. which package/dependency would need to be added, if you can tell from the file(s) shown) and OMIT the EDITS_MARKER + JSON block entirely -- there is nothing correct to propose without a real framework to target.'
        : "A test framework WAS detected above for at least part of this project. Only write tests in a framework/language pairing the evidence above actually supports (e.g. don't write a Jest test for Python code just because Jest was detected for this project's frontend) -- if the specific file(s) shown to you below are in a language/ecosystem with NO detected framework, say so plainly and omit the edits block for those files rather than guessing.",
      "If a real existing test file sample was shown to you above, follow its exact style: the same framework idioms, import layout, fixture/setup pattern, and assertion style -- extend this project's own convention, don't introduce a competing one.",
      "If NO existing test file sample was shown above (this project has no test files yet), use the detected framework's standard idiomatic convention instead: for pytest, a new file at <same-directory-as-the-module-under-test>/tests/test_<module>.py -- e.g. testing backend/main.py means creating backend/tests/test_main.py, NEVER a tests/ directory at the project root when the module under test lives in a subdirectory (a project-root tests/ directory is invisible to pytest when it is run from that subdirectory, which is where this project's pytest dependency and virtualenv actually live) -- or a sibling test_<name>.py directly next to the file under test if no tests/ directory exists yet either way. For a FastAPI app, use fastapi.testclient.TestClient against the real app instance shown to you, not a mocked one. For Jest/Vitest, a co-located <name>.test.ts(x) beside the file under test, or under __tests__/ if that directory already exists. For Mocha, a matching test/<name>.test.js file.",
      "When your test imports the module under test, match that module's OWN import style EXACTLY as shown in the file content above -- never assume a package layout the project doesn't actually have. Concretely for Python: if the target file itself uses plain top-level sibling imports (e.g. main.py contains \"from database import ...\", not \"from backend.database import ...\"), your test must import it the same plain way too -- \"from main import app\", NEVER \"from backend.main import app\" -- a package-qualified import like that only resolves if the project is actually installed/run as a package, which a FastAPI backend launched as \"uvicorn main:app\" from inside its own directory (and pytest invoked the same way, from that same directory) never is. The same principle applies to JS/TS: match the target file's own relative-import depth and module resolution style -- don't invent a path alias or absolute import it doesn't already use itself.",
      "If the ONLY test framework detected for this project's language is a browser/e2e tool (Playwright, Cypress) with no unit-test-capable framework alongside it, say so plainly and omit the edits block -- browser-driven test generation needs a running application to drive, which is roadmap Phase 12's job, not this mode's.",
      "Cover the real, meaningful behavior of the code shown to you: at minimum one passing-case test and one edge-case/error-case test per exported function, route, or class method that has real logic. Skip trivial getters or pure re-exports. Do not write a test that only asserts a function exists or returns non-null with no real check of its actual behavior -- that kind of test is exactly the low-value placeholder this phase exists to avoid.",
      "",
      "CRITICAL OUTPUT FORMAT -- follow this exactly:",
      "1. First write a brief prose summary (2-4 sentences) of what you're testing and which framework/convention you followed (or, per the rules above, why you're proposing nothing).",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing every test file you\'re creating or changing, as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path/to/test_file", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content, never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n (a single backslash followed by n). Do NOT double it to \\\\n (two backslashes) -- that writes literal backslash-n text into the file instead of a real line break.",
      testingFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${testingFullContentPaths.join(", ")} -- this includes an existing test file if one was shown to you, which you should EXTEND rather than replace with something narrower. Do not use "modify" for any other path.`
        : 'You were not shown the full content of any existing test file for this code, so use action "create" for a new, sensibly-named test file path -- unless the evidence above already showed you an existing test file to extend.',
      `Per the rules above, omit the ${EDITS_MARKER} marker and JSON block entirely if no real test framework covers the file(s) you were asked to test.`,
      relevantFilesContext(input, true),
    ].join("\n");
  }

  if (input.mode === "devops") {
    // DevOps/Infrastructure Generation (roadmap Phase 14, source
    // requirement §21 -- "Docker/Compose/K8s/Terraform + CI/CD pipeline
    // files, through the same edits pipeline as everything else," builds
    // on Phase 6).
    //
    // Same root-cause diagnosis every generation mode before it already
    // made (Database/Phase 8, Architecture/Phase 9, Testing/Phase 10): a
    // model asked to write infra files with zero real facts about this
    // project's actual services, locations, and build/test commands has
    // nothing to go on but generic, often-wrong boilerplate (a Dockerfile
    // that COPYs the wrong directory, a CI workflow running "npm test" a
    // project never defines). Grounded in a dedicated evidence bundle (GET
    // /devops-evidence, see apps/desktop-agent/src/devopsContext.ts) --
    // this project's real detected frontend/backend components and their
    // real locations (Phase 7), any infra it ALREADY has (shown in full so
    // the model proposes "modify" against something real, never a blind
    // "create" over infra that already works), and this project's own real
    // build/test/lint commands (reused verbatim from verify.ts, so the
    // generated CI pipeline runs literally what "Run Verification" runs).
    //
    // Kubernetes/Terraform are deliberately OUT of this mode's v1 output --
    // the evidence bundle gathers zero facts a K8s manifest or Terraform
    // plan would need (a target cluster, a cloud provider, a registry to
    // push images to), and inventing those specifics would be exactly the
    // kind of ungrounded boilerplate this codebase's whole discipline
    // exists to avoid (the same reasoning Architecture mode's Phase 9
    // prompt already applies to skip a Deployment diagram when no
    // deployment evidence exists). The instructions below make the model
    // say this honestly in its prose rather than silently narrowing scope.
    const devopsEvidence = input.projectContext?.devopsEvidence;
    const devopsFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    const dbComponents = (devopsEvidence?.projectContext.components ?? []).filter((c) => c.category === "database");
    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in DEVOPS mode (DevOps/Infrastructure Generation, roadmap Phase 14) -- proposing a Dockerfile per real detected service, a root docker-compose.yml wiring them together, and a CI pipeline file, all grounded strictly in the evidence bundle below.",
    DEBUGGABLE_CODE_RULE,
      "",
      "THE #1 RULE, non-negotiable: every Dockerfile, compose service, and CI step you propose MUST trace back to a real entry in the evidence bundle below (a detected component + its real location, an existing infra file, or a real verification command). Never invent a service, port, database, or build/test command the evidence doesn't actually show.",
      "",
      devopsEvidence
        ? devopsEvidenceContext(devopsEvidence)
        : "No pre-computed DevOps evidence bundle was available for this project (this should not normally happen) -- treat it as a signal to propose only the most minimal, honestly-labeled files, explicitly noting in prose that evidence gathering did not run.",
      "",
      "SECURITY AND OPERABILITY RULES (the DevOps Agent reviewer below will check these specifically):",
      "1. NEVER bake a secret, API key, password, or credential into a Dockerfile, compose file, or CI config -- reference it only via an environment variable (documented with a `.env.example` entry, never a real `.env` committed) or, in CI, the platform's own secrets mechanism (e.g. GitHub Actions `${{ secrets.NAME }}`).",
      "2. In docker-compose.yml, give every service a `deploy.resources.limits` (cpus and memory) with a sensible conservative starting value, and say in a comment that it's a starting point the user should tune.",
      "3. Run each container as a non-root user where the base image reasonably supports it (e.g. a Node image's built-in `node` user, or a dedicated `USER appuser` created in a Python image) -- never leave a container running as root without a stated reason.",
      "4. A CI workflow's token/permissions should be scoped to only what the job needs (e.g. an explicit `permissions: contents: read` block) rather than left at the repository's default.",
      "",
      "WHAT TO GENERATE:",
      devopsEvidence && devopsEvidence.projectContext.components.some((c) => c.category === "frontend" || c.category === "backend")
        ? "For EVERY detected frontend/backend component's location shown above: propose a Dockerfile at `<location>/Dockerfile` (or the project root's `Dockerfile` when location is \".\"). A component already listed under existingInfraFiles at that exact path means one already exists -- you were shown its full content below; propose \"modify\" only if it's genuinely missing something real (e.g. it doesn't match the component's actual detected framework), and say in prose you're leaving it as-is otherwise rather than needlessly rewriting a working file. For a Node-based component, use a multi-stage build (an install+build stage, then a lean runtime stage) and run its own detected package.json script (\"start\" if defined, else the same \"dev\" convention this app's own Preview feature uses -- see the evidence -- but note in a comment that a dev server is not a production-grade choice if no \"start\"/\"build\" script exists). For a Python/FastAPI component (evidenced by a `backend` category entry naming FastAPI, plus a requirements.txt/pyproject.toml at that location), use a `python:3.11-slim` base, `pip install --no-cache-dir -r requirements.txt`, and `CMD [\"uvicorn\", \"main:app\", \"--host\", \"0.0.0.0\", \"--port\", \"8000\"]` -- this app's own Preview feature runs a detected FastAPI backend exactly this way (uvicorn against main:app on port 8000), so this is a real, evidenced convention, not an invented one; say so explicitly if you're relying on this default rather than an explicit start command found in the evidence."
        : "No frontend or backend component was detected in the evidence above. Do not invent one to containerize -- say so plainly in your prose summary and propose nothing (omit the edits block entirely).",
      "Then propose a root `docker-compose.yml` with one service per Dockerfile you just proposed (each `build.context` pointing at that component's real location), wired together on a shared network.",
      dbComponents.length > 0
        ? dbComponents.some((c) => c.name === "SQLite")
          ? `A database component WAS detected (${dbComponents.map((c) => c.name).join(", ")}), but SQLite is file-based, not a server process -- there is NO official "sqlite" Docker image to run as its own service (do not invent one). Instead, mount a named volume into the backend service's own container at the directory its SQLite file lives in, and pass that file's path via an environment variable (never hardcoded) -- no separate database service or \`depends_on\` entry for it.`
          : `A database component WAS detected (${dbComponents.map((c) => c.name).join(", ")}) -- add a matching REAL official image service (e.g. \`postgres:16\` for PostgreSQL, \`mysql:8\` for MySQL, \`mongo:7\` for MongoDB -- never invent an image tag for an engine that has no official server image, like SQLite) with a named volume for its data directory and credentials supplied ONLY via environment variables (never hardcoded), and wire the app service(s) to depend on it via \`depends_on\`. If you use \`condition: service_healthy\` on a \`depends_on\` entry, you MUST also define a real \`healthcheck\` on that service (e.g. \`pg_isready\` for Postgres) -- otherwise use a plain \`depends_on\` list (which waits only for container start, not readiness) rather than an unsupported condition.`
        : "No database component was detected in the evidence above -- do not add a database service to the compose file; if the app genuinely needs one, say so as an open question in your prose rather than inventing a specific engine.",
      devopsEvidence && devopsEvidence.verificationSteps.length > 0
        ? `Then propose \`.github/workflows/ci.yml\`: a GitHub Actions workflow, triggered on push and pull_request, that checks out the repo and runs EXACTLY these real, already-evidenced commands (one job step per command, each \`working-directory\` set to its real cwd shown above) -- never a different or additional build/test/lint command: ${devopsEvidence.verificationSteps.map((s) => `"${s.command}" (in ${s.cwd}/)`).join("; ")}. Add a Node/Python setup step (actions/setup-node or actions/setup-python, matching the detected stack) before these steps.`
        : "No known build/test/lint command was found for this project (see verificationSteps above, empty) -- do not invent one (e.g. don't assume \`npm test\` just because that's a common default). Propose a minimal CI workflow that only checks out the repo and builds the Docker image(s) you just proposed, and say plainly in your prose summary that no real verification command was found to run in CI.",
      "State explicitly in your prose summary that Kubernetes manifests and Terraform are NOT included in this proposal, because no evidence exists yet for a target cluster, cloud provider, or container registry -- generating those from nothing would be exactly the kind of invented, unevidenced infrastructure this tool exists to avoid.",
      "",
      "CRITICAL OUTPUT FORMAT -- follow this exactly:",
      "1. First write a brief prose summary (3-6 sentences): which services you're containerizing, whether a database service was added, which real commands the CI pipeline runs (or why none could be), and the explicit Kubernetes/Terraform scope note above.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing every file being created or changed (Dockerfile(s) + docker-compose.yml + the CI workflow, as applicable), as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content, never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n. Do NOT double it to \\\\n.",
      devopsFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${devopsFullContentPaths.join(", ")}. Do not use "modify" for any other path.`
        : 'You were not shown the full content of any existing infra file, so use action "create" for every file you propose -- this most likely means none of them exist yet in this project.',
      'Only use action "create" for a path you are confident does not already exist in this project.',
      `Omit the ${EDITS_MARKER} marker and JSON block entirely if no frontend/backend component was detected at all (per the rule above) -- there is nothing real to containerize.`,
      relevantFilesContext(input, true),
    ].join("\n");
  }

  if (input.mode === "auth") {
    // Auth/RBAC Engineering (roadmap Phase 19, source requirement §12 --
    // "authentication and authorization engineering: RBAC, OAuth2, JWT
    // generation and verification"). Same root-cause diagnosis every
    // generation mode before it already made: a model asked to add
    // authentication with zero real facts about this project's actual
    // backend framework and whatever auth machinery already exists has
    // nothing to go on but generic, often-wrong boilerplate -- or worse,
    // a SECOND competing auth implementation alongside one that already
    // works. Grounded in a dedicated evidence bundle (GET /auth-evidence,
    // see apps/desktop-agent/src/authContext.ts) -- this project's real
    // detected auth library (if any), its real detected backend
    // location(s), and up to a few of its own real auth-shaped files
    // (shown in full so the model extends what's there instead of
    // introducing a rival implementation).
    const authEvidence = input.projectContext?.authEvidence;
    const authFullContentPaths = (input.projectContext?.relevantFiles ?? [])
      .filter((f) => f.content !== undefined)
      .map((f) => f.relPath);
    const hasBackend = (authEvidence?.backendComponents.length ?? 0) > 0;
    return memory + steering + archGuidance + [
      "You are the MobiusX Desktop AI Assistant in AUTH mode (Auth/RBAC Engineering, roadmap Phase 19) -- adding or extending JWT-based authentication and role-based authorization for this project's real detected backend, grounded strictly in the evidence bundle below.",
    DEBUGGABLE_CODE_RULE,
      "",
      "THE #1 RULE, non-negotiable: every middleware, route, and dependency you propose MUST trace back to this project's REAL detected backend framework and location shown in the evidence bundle below. Never invent a backend, framework, or file location the evidence doesn't actually show.",
      "",
      authEvidence
        ? authEvidenceContext(authEvidence)
        : "No pre-computed Auth evidence bundle was available for this project (this should not normally happen) -- treat it as a signal to propose only the most minimal, honestly-labeled change, explicitly noting in prose that evidence gathering did not run.",
      "",
      "SECURITY RULES (the Auth Agent reviewer below will check these specifically):",
      "1. NEVER store a password in plaintext or with a fast general-purpose hash (MD5/SHA-1/plain SHA-256) -- use a real password-hashing function (bcrypt/argon2/scrypt/PBKDF2, matching whatever this project's ecosystem makes conventional: passlib[bcrypt] for Python, bcrypt/argon2 npm packages for Node).",
      "2. Every JWT/session token MUST be actually verified (signature AND expiry) on every protected route -- never merely decoded/parsed and trusted. Sign with a secret/key read from an environment variable, never hardcoded.",
      "3. Distinguish AUTHENTICATION (is this a valid logged-in user at all) from AUTHORIZATION (does THIS user's role/ownership permit THIS specific action or resource) -- a route that checks only the former on data scoped to a specific user or role is incomplete; propose the ownership/role check too.",
      "4. Never bake a secret, signing key, or credential into source -- reference it only via an environment variable, documented with a `.env.example` entry (never a real `.env` committed).",
      "",
      "WHAT TO GENERATE:",
      hasBackend
        ? authEvidence!.existingAuthFiles.length > 0
          ? `This project already has real auth-shaped file(s), shown in full above (${authEvidence!.existingAuthFiles.map((f) => f.relPath).join(", ")}) -- EXTEND that existing implementation to satisfy this request. Propose "modify" only for those exact paths, or "create" for a genuinely new file (e.g. a new protected route) that plugs into the SAME existing convention (same token library, same secret-loading approach). Do not introduce a second, competing auth library or pattern alongside what's already there.`
          : authEvidence!.authComponents.length > 0
            ? `An auth dependency is already declared (${authEvidence!.authComponents.map((c) => c.name).join(", ")}) but no real implementation file was found -- propose a fresh implementation using THAT already-declared library (never a different one), wired into the real detected backend at ${authEvidence!.backendComponents.map((c) => c.location).join(", ")}.`
            : `No auth dependency is currently declared for this project's real detected backend at ${authEvidence!.backendComponents.map((c) => c.location).join(", ")}. Propose adding an idiomatic JWT library for that backend's real detected framework/language (e.g. python-jose or PyJWT for a Python/FastAPI backend, jsonwebtoken for a Node/Express backend) plus the middleware/dependency implementing it -- state explicitly in prose which library you're adding and why it fits this project's real detected stack.`
        : "No backend component was detected in the evidence above. Do not invent one to add authentication to -- say so plainly in your prose summary and propose nothing (omit the edits block entirely).",
      "",
      "CRITICAL OUTPUT FORMAT -- follow this exactly:",
      "1. First write a brief prose summary (3-6 sentences): what auth mechanism you're adding or extending, which real files you're changing, and how authorization (not just authentication) is enforced.",
      `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
      '3. Then exactly ONE fenced json code block containing every file being created or changed, as entries in a single "edits" array, in this exact shape:',
      '{"edits": [{"path": "relative/path", "action": "modify" | "create", "content": "COMPLETE new file content"}]}',
      '"content" must be the entire new file content, never a diff or partial snippet.',
      "When a file's content spans multiple lines, each line break must be encoded as exactly ONE JSON escape sequence: \\n. Do NOT double it to \\\\n.",
      authFullContentPaths.length > 0
        ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${authFullContentPaths.join(", ")}. Do not use "modify" for any other path.`
        : 'You were not shown the full content of any existing file, so use action "create" for every file you propose.',
      'Only use action "create" for a path you are confident does not already exist in this project.',
      `Omit the ${EDITS_MARKER} marker and JSON block entirely if no backend component was detected at all (per the rule above) -- there is nothing real to add authentication to.`,
      relevantFilesContext(input, true),
    ].join("\n");
  }

  const fullContentPaths = (input.projectContext?.relevantFiles ?? [])
    .filter((f) => f.content !== undefined)
    .map((f) => f.relPath);
  const commercePrompt = /\b(shop|store|storefront|e-?commerce|sell|selling|products?|catalog|cart|checkout)\b/i.test(input.prompt);
  const gardenPrompt = /\b(garden|gardening|plants?|flowers?|pots?|planters?|nursery)\b/i.test(input.prompt);

  return memory + steering + archGuidance + [
    "You are the MobiusX Desktop AI Assistant in BUILD mode.",
    DEBUGGABLE_CODE_RULE,
    // Optional pre-flight clarification (feature request: "MobiusX.ai
    // Desktop App should have interactivity (ask questions, and give
    // recommendations) similar to Claude before implementing the code").
    // Deliberately narrow and opt-in per request, not a mandatory step
    // before every Build task -- most "build/add/create X" requests are
    // clear enough to act on directly, and a model that stops to ask
    // questions on every obvious request would just slow the user down.
    // {"edits": []} (marker present, empty array) is the signal used here
    // rather than omitting the marker entirely, because the marker being
    // absent already means something else in this prompt: the model
    // failed to follow the required format at all (see the retry-and-
    // apologize handling in each runner). This keeps "I'm deliberately not
    // proposing files yet, see my questions above" distinguishable from
    // "I forgot the format" -- the UI treats them very differently.
    `Before writing any files, check whether this request actually gives you enough to build it correctly. If it is genuinely ambiguous or leaves out a decision a competent engineer would ask about before starting -- which of several reasonable approaches (auth strategy, database choice, UI layout), what fields a form/model needs, which existing page or flow this should plug into, and similar -- do NOT guess. Instead, write 2-4 short, specific clarifying questions in your prose response (and a brief recommendation for what you'd default to, if you have one), then still emit ${EDITS_MARKER} followed by a fenced json block containing exactly {"edits": []}. Once the user answers (their reply arrives as a follow-up in this same conversation), build normally from their answer. Reserve this for requests that are ACTUALLY ambiguous -- most concrete "build/add/create X" requests, especially ones matching a common, well-understood pattern, should go straight to writing files as usual. Do not ask questions just to be cautious, to hedge, or to avoid committing to a reasonable interpretation.`,
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
    "1. First write a brief prose summary (2-4 short sentences, at most 80 words total) of what you're building. Do NOT include an architecture diagram, long design explanation, file tree, individual file descriptions, or any file contents in this summary. Put requested run instructions in a concise README file.",
    `2. Then, on its own line by itself, output exactly ${EDITS_MARKER}`,
    "3. Then exactly ONE fenced json code block containing EVERY file you're creating or changing — however many files the project needs — as entries in a single \"edits\" array, in this exact shape:",
    '{"edits": [{"path": "relative/path.ts", "action": "modify" | "create", "content": "COMPLETE new file content"}, {"path": "another/relative/path.py", "action": "create", "content": "COMPLETE new file content"}]}',
    "Do not split files across multiple json blocks, and do not write any file's content anywhere except inside this one \"edits\" array (not in prose, not in a separate markdown code fence). A 10-file project means 10 entries in this one array, not 10 separate code blocks in your response.",
    "OUTPUT-BUDGET DISCIPLINE: prioritize complete, runnable source files over explanatory prose and unrequested boilerplate. Use a compact architecture that still implements the user's core requested flows; do not add speculative enterprise modules, duplicate examples, or multiple layers of wrappers. Preserve every explicitly requested core feature while keeping code direct and concise.",
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
    "PYTHON ASYNC SYNTAX: any function that contains or directly calls await must be declared with `async def`; this includes FastAPI route handlers that await ORM/database operations. Before returning Python edits, mentally compile them and verify there is no `await` in a synchronous `def` or at module scope.",
    "If that FastAPI backend will be called from a separately-hosted frontend (e.g. a Next.js dev server on a different port, as in a typical frontend/ + backend/ project layout), add CORS support in main.py -- import fastapi.middleware.cors.CORSMiddleware and configure it with allow_origin_regex=r\"^http://(localhost|127\\.0\\.0\\.1):\\d+$\" (NOT a hardcoded allow_origins=[\"http://localhost:3000\"], which breaks the moment the frontend's dev server lands on a different port -- a real, common occurrence, not a hypothetical) plus allow_credentials=True, allow_methods=[\"*\"], allow_headers=[\"*\"] -- this covers every local dev port without the security hole a bare allow_origins=[\"*\"] would open, and without the port-fragility of a single hardcoded origin.",
    buildModeTestingBlock(input.projectContext?.testingEvidence),
    // Added Oct 2026 after a direct quality comparison against Cursor on
    // the exact same "build me a website for my gardening business"
    // prompt: this gateway's build mode had no instruction either way
    // about application scope, so a model left to its own judgment (seen
    // concretely on openai/gpt-oss-120b via Groq) defaulted to the
    // smallest thing that technically satisfies the request -- one
    // index page, a product list endpoint, and an empty database with no
    // way to see real content without manually POSTing rows first. Cursor
    // (a different product, backed by a different/stronger model by
    // default) produced multiple pages and a populated database for the
    // identical prompt. Rather than assume a bigger/paid model is the only
    // fix, this closes the actual gap that's in this gateway's own
    // control: explicit scope and first-run-content guidance, so build
    // mode asks for a genuinely usable first version regardless of which
    // model runs it.
    "COMPLETENESS: when the request describes a real application or business site (a shop, dashboard, portal, booking flow, etc.) rather than a single trivial snippet, build a genuinely usable first version, not the smallest skeleton that technically satisfies the prompt. For a typical storefront/listing-style app in particular, that normally means more than one page -- e.g. a listing/home page AND at least one detail page (an individual item's own page) or other secondary page the request implies (cart, about, contact) -- with real navigation between them, not just one page with everything crammed in. Do not pad with pages or features the request doesn't call for, but match the scope a competent engineer would actually ship for this request, not the minimum that compiles.",
    "EMPLOYEE ONBOARDING APPS: when the request describes employee onboarding, implement a useful operational portal with clearly reachable Employee Details, Departments, Onboarding, and Reports views. The employee list and detail view should show realistic identity/contact, role, department, manager, start date, and onboarding status; detail should show onboarding tasks/checklist and progress. Departments should be a real browsable view with department leads and employee counts, and navigation or filters should connect departments to their employees. Reports should contain useful, data-backed summaries such as total employees, active onboarding, completion rate, and employees by department/status, with a readable table or chart and sensible date/status filtering where supported. Back these views with consistent API response schemas and persisted database records; seed a small, realistic, idempotent set of employees, departments, and onboarding tasks so the first run demonstrates all views. Keep summaries derived from the same records shown in the portal, validate API response shapes before rendering, and show loading, empty, and error states. Treat names such as Infosys as the requested organization context and visual direction, but do not invent claims of official affiliation or use fabricated credentials.",
    /\b(payroll|pay slip|payslip|salary calculation|salary processing)\b/i.test(input.prompt)
      ? "PAYROLL APPLICATIONS: preserve the requested frontend/backend/database as separate components (for Next.js + FastAPI + PostgreSQL, use frontend/ and backend/ with separate package.json and requirements.txt; never put Python packages such as fastapi, uvicorn, sqlalchemy, or psycopg in package.json; use one pip requirement per line and never list Python's built-in sqlite3 module). Implement real connected workflows for employee records, departments, attendance, payroll runs, salary calculations, deductions/bonuses/net pay, and reports/payslips; persist domain data through FastAPI and PostgreSQL, and derive reports from persisted records. Keep the first release compact, but do not substitute a generic landing page, fake in-memory user database, or disconnected mock dashboard for the requested payroll features. For authentication, use password hashing and role checks on protected API routes; load signing/encryption keys and DATABASE_URL from environment variables, provide only placeholder variable names in .env.example, and never hard-code secrets or claim encryption/authentication is production-ready unless implemented end to end. Validate request fields with explicit bounds and formats, and parameterize database inputs. Keep calculation rules in a clear backend module and include a small, transparent seed dataset only if it is clearly labeled as development data."
      : "",
    "FIRST-RUN CONTENT: if you create a new database-backed backend (SQLite or otherwise), also make the app show real content the first time it's opened, not an empty list. Either add a small idempotent seed step that runs on startup (check if the table is empty, then insert a handful of realistic example rows matching the request's domain -- e.g. several real-sounding products for a shop) or, for SQLite specifically, propose a seed script alongside the schema. An empty database on first load is a common, avoidable way a build looks broken when the code is actually fine.",
    "END-TO-END INTEGRATION: when this request includes both a frontend and backend, make the shipped user flows use the backend as their source of truth. Implement and connect the actual API routes, request/response schemas, persistence, and frontend API calls; keep shared field names and URL paths consistent across both sides. For separate local frontend/backend services, put the backend origin in one environment-configurable frontend setting (for Next.js, e.g. NEXT_PUBLIC_API_BASE_URL), use it consistently for every fetch, include an .env.example/default and document the ports and run commands. Never assume a common port is free or silently connect to another project's service; ensure the documented backend process listens on the configured origin. Check response.ok before consuming API data, validate that JSON has the expected shape (especially arrays before rendering with .map), and show a useful error state for HTTP errors, malformed responses, and network failures. Include a documented local run path and environment example, handle backend unavailable/empty/error states in the UI, and never silently substitute hard-coded frontend demo data for a failed API call. For Python seed data use Python literals (None/True/False), not JSON/JavaScript literals (null/true/false); mentally verify startup seeding by tracing initialization. Before returning the edits, mentally trace one realistic user action from the rendered page through the API to the database and back, and ensure every referenced file, import, route, and script exists in the proposed edits.",
    AUTHENTICATED_FILE_DOWNLOADS_RULE,
    "HONOR THE REQUESTED STACK: treat named frameworks, languages, and databases in the user's prompt as requirements. For example, if they ask for Next.js + FastAPI + SQLite, produce those technologies, connect them directly, and document how to run both services; do not quietly replace the backend with Next API routes, use a different database, or leave one stack component as a disconnected scaffold.",
    commercePrompt
      ? `STOREFRONT FLOW: this request describes selling products, so build a coherent small commerce experience rather than a static marketing page. Include a browsable catalog with useful category/search controls, individual product detail, and a cart that stays consistent across navigation. If you implement checkout, submit an order to the backend and persist it; do not claim to charge a card or provide real payment processing unless a payment provider was explicitly requested and configured. Keep stock/price totals authoritative on the backend. ${gardenPrompt ? "Use recognizable gardening categories and believable product names, prices, descriptions, and care/use details; make the visual direction feel like a considered garden nursery brand, not a generic template." : "Use believable domain-specific catalog content and a visual direction that fits the business, not a generic dashboard."}`
      : "PRODUCT FINISH: make the main task's central user journey work end to end, including validation and a clear success state. Keep the first release focused on the requested job; do not add unrelated features just to increase file or page count.",
    // Added Oct 2026 after a second direct quality comparison against
    // Cursor, this time on a REAL launched build (not just a prompt
    // diff): the same gardening-business prompt, run twice through this
    // gateway, now matched Cursor on completeness/seed data (the
    // COMPLETENESS/FIRST-RUN CONTENT rules above already worked) but still
    // lost on two concrete, observed axes. (1) Visual polish -- Cursor's
    // build used a deliberate green design-token palette, a serif/sans
    // type pairing, and a real Unsplash hero photo; this gateway's two
    // comparison builds either used no styling system at all or plain
    // undifferentiated CSS with zero imagery -- nothing in this prompt
    // asked for visual quality at all, only scope and seed data. (2)
    // Dependency version safety -- one of the two comparison builds
    // (openai/gpt-oss-120b via Groq, Next.js frontend) pinned
    // "typescript": "7.0.2" in package.json, a version that does not
    // exist; npm silently resolved it to some other installed version,
    // and the mismatch crashed Next's own startup-time TypeScript check
    // with "Cannot read properties of undefined (reading 'endsWith')" the
    // first time a real person tried to run the generated app -- a
    // completely avoidable failure that had nothing to do with the
    // request itself. Both rules below close a real, reproduced gap the
    // same way COMPLETENESS/FIRST-RUN CONTENT did -- not a style
    // preference, a fix for a specific observed failure.
    "VISUAL QUALITY: when the request produces a user-facing page or app (not an API-only backend or a one-off script), the first version should look like real, finished software, not an unstyled scaffold. Concretely: (1) pick ONE deliberate color system -- a small set of named, reused tokens (CSS custom properties, or a Tailwind theme extension if this ecosystem already uses Tailwind) consistent with the request's domain, rather than ad hoc hex values scattered per element. EXPLICIT USER DESIGN DIRECTIONS ALWAYS OVERRIDE DOMAIN CONVENTIONS AND EXAMPLES: if the user asks for blue, use a blue palette even for a gardening business; never silently substitute the stereotypical green palette. If no color is requested, choose an intentional palette that suits the domain; (2) use real content, never lorem-ipsum or literal \"[placeholder]\" text, and include at least one real photographic image anywhere the domain plausibly has one (a storefront, portfolio, listing, or landing page) -- reference a real, stable, publicly hosted image URL such as a specific `https://images.unsplash.com/photo-<id>?auto=format&fit=crop&w=<n>&q=80` URL (a real photo id, not a placeholder service or an invented path) rather than an empty box or a broken <img>; (3) give interactive elements (buttons, links, cards) real hover/focus/disabled states, not only the browser default; (4) make the layout genuinely responsive at common breakpoints, not fixed-width; (5) use a legible type scale with a clear size/weight distinction between headings and body text. Prefer a bundled local font when one already exists; otherwise use a considered system font stack (for example, a serif/sans pairing from `ui-serif` and `ui-sans-serif`) so offline builds remain reliable. In Next.js, use `next/font/google` only when build-time access to Google Fonts is known to work or the required fonts are already cached; never make a network font download a build requirement. Do not use a runtime Google Fonts link/import. For plain HTML/CSS, bundle fonts locally if available or use the system stack; (6) design a real empty/loading/error state for anything that fetches data, instead of a blank screen. A working-but-ugly first version is a worse first impression than one slightly smaller in scope that genuinely looks shipped -- treat this with the same weight as COMPLETENESS and FIRST-RUN CONTENT above, not as optional polish.",
    "DEPENDENCY VERSION SAFETY: every version string you write in a package.json, requirements.txt, pyproject.toml, or any other manifest must be one you are actually confident exists and is installable -- never a guessed, rounded-up, or \"next major\" version number (e.g. do not write `\"typescript\": \"7.0.2\"` unless you are genuinely certain TypeScript 7 has shipped as a stable release; when in doubt, use a caret range anchored to the newest major you're confident is real, such as `\"^5\"`, rather than inventing a specific patch version that merely sounds plausible). A hallucinated version is strictly worse than a slightly old one: the package manager will either fail to resolve it outright, or -- worse -- some unrelated real package will happen to satisfy that version string and get installed silently, producing a dependency the rest of your generated code was never actually written against. This is not a hypothetical: it has caused a generated Next.js app to crash on its very first `npm run dev`, before a single line of the actual feature code ever ran. When genuinely unsure of the exact newest version, a broad, safe caret/tilde range beats a precise-looking number you can't verify. For Python projects, ensure the chosen FastAPI/Pydantic/pydantic-core versions support the project's selected Python interpreter, especially newly released Python versions: old Pydantic pins may have no compatible pydantic-core wheel and pip can fail while trying to compile Rust sources. Prefer compatible minimum-version ranges over stale exact pins, rather than pinning early 2024-era FastAPI/Pydantic releases. If schemas use Pydantic EmailStr, include the email extra (`pydantic[email]`) or `email-validator` explicitly. For PostgreSQL on a current Python interpreter, choose a psycopg2-binary release that publishes a wheel for that Python version (use a compatible version range; old exact pins can force a native source build). Keep SQLAlchemy's PostgreSQL URL and driver aligned: `postgresql://` with psycopg2 should use SQLAlchemy 2.0.x, while psycopg 3 should use `postgresql+psycopg://` and declare `psycopg[binary]`. If using Passlib's legacy bcrypt handler, constrain bcrypt to a version supported by Passlib and verify the documented seed user's password path so a working wheel doesn't hide an auth-time runtime incompatibility. Apply the same wheel-availability check to every native-extension dependency before writing the manifest. Do not pin a package to a version range that excludes the interpreter-compatible release needed to install and run the generated app.",
    "NEXT.JS RUNTIME COMPATIBILITY: for Next.js 13 and later, use <Link href=\"...\">text</Link> without a nested <a>; move className and link attributes onto Link. Preserve legacy link markup only when the project explicitly depends on legacyBehavior.",
    "NEXT.JS FRESHNESS: when creating a brand-new Next.js app (or adding Next.js to a project that does not already use it), use the stable `latest` npm dist-tag for `next`, `react`, and `react-dom` rather than copying an older Next.js major/version from training data. Do not invent package-lock contents; let MobiusX's real `npm install` step resolve packages and create the lockfile. When modifying an existing Next.js project, preserve its declared versions and lockfile unless the user asks to upgrade. The official Next.js installation guide recommends installing `next@latest react@latest react-dom@latest` for a new app.",
    fullContentPaths.length > 0
      ? `Only use action "modify" for one of these exact paths, which you were shown in full below: ${fullContentPaths.join(", ")}. Do not use "modify" for any other path.`
      : 'You were not shown the full content of any existing file, so do not use action "modify" at all — only "create" a genuinely new path.',
    'Only use action "create" for a path you are confident does not already exist in this project.',
    `Omit the ${EDITS_MARKER} marker and JSON block ONLY if you genuinely cannot propose any concrete file — e.g. the request is too ambiguous to act on. If you CAN write real file contents (as in most "build/add/create X" requests), you MUST use the format above — writing the same content as prose or markdown code fences instead is not an acceptable substitute, since only the json "edits" array actually gets applied to the user's project.`,
    relevantFilesContext(input, true),
  ].join("\n");
}

/**
 * Compact instructions for Ollama creating a brand-new application. The
 * general Build prompt contains extensive cross-mode guidance that is useful
 * for cloud models but makes local CPU models spend minutes evaluating rules
 * unrelated to the requested project. Keep the essential output, stack,
 * completeness, and safety contracts while preserving the full prompt for
 * existing-project edits and every non-build mode.
 */
export function systemPromptForLocalBuild(input: RunnerInput): string {
  const hasProjectFiles = (input.projectContext?.relevantFiles?.length ?? 0) > 0;
  const blankProject = !hasProjectFiles && input.projectContext?.indexedChunkCount === 0;
  const stagedGeneration = input.stagedBuild !== undefined;
  // Staged greenfield builds accumulate their own generated checkpoint files
  // as context. They are still new-app generation, not an existing user code
  // base. Keep the compact local-model contract for those stages while
  // including the full checkpoint contents below; otherwise each resumed
  // stage receives the much larger general editing prompt and can answer with
  // a plan instead of the requested bounded file edits.
  if (input.mode !== "build" || (!blankProject && !stagedGeneration)) return systemPromptFor(input);

  const payroll = /\b(payroll|pay slip|payslip|salary calculation|salary processing)\b/i.test(input.prompt);
  if (stagedGeneration && input.stagedBuild?.id === "tests") {
    return [
      "You are MobiusX generating executable tests for one validated application stage. Keep reasoning private.",
      "Return only complete test files in the approved test paths. Do not edit application source, dependencies, schema, or deployment files.",
      "Use only the exact routes, schemas, roles, states and UI interactions in the supplied test task. Use real HTTP/browser behavior and isolated synthetic data. Assert persisted effects where configured.",
      "No placeholders, skipped tests, trivial assertions, fake persistence, invented routes, or credentials. Do not generate scenarios the supplied contracts cannot support.",
      BUILD_RESPONSE_CONTRACT_RULES,
    ].filter(Boolean).join("\n\n");
  }
  if (stagedGeneration) {
    return [
      "You are MobiusX, a coding agent implementing one bounded application stage. Keep private reasoning hidden; give concise progress and a short user-facing summary.",
      BUILD_RESPONSE_CONTRACT_RULES,
      "Treat the immutable PAC slice and stage task specification as authoritative. Implement only their target paths and acceptance criteria; preserve validated interfaces and use only declared dependencies. Return complete, runnable file contents with no placeholders, mock transactions, or unrelated files.",
      "Honor the user's requested stack and design. For FastAPI, make every await-bearing handler async, use the configured SQLAlchemy session dependency, validate external input, use parameterized ORM operations, enforce authentication/roles, and load secrets from environment configuration. For React, connect visible forms and actions to the real API and provide clear loading, error, and success states.",
      payroll ? "PAYROLL: keep required Employees/Departments, Attendance, Payroll, and Reports/Payslips screens reachable from navigation, with matching persisted API workflows and role checks." : "Prioritize the requested business workflow and use readable, responsive implementation.",
      input.archMode === "web" ? "Web app: keep the implementation lean and the user experience polished." : "",
      steeringContextBlock(input),
      assistantMemoryBlock(input),
      relevantFilesContext(input, true),
    ].filter(Boolean).join("\n\n");
  }
  return [
    "You are MobiusX, a practical coding agent. Build a complete, runnable first version of the application requested by the user. Keep analysis private; give only a short user-facing summary and real task progress.",
    BUILD_RESPONSE_CONTRACT_RULES,
    "Honor every named language, framework, and database. Implement the main workflows end to end with coherent frontend/backend contracts, persistent data, validation, and loading/error/empty states. Keep the UI polished, responsive, and consistent with explicit design directions. Use concise code and avoid unrelated boilerplate.",
    "For Python, every function containing `await` must be declared `async def`; this includes FastAPI route handlers that call async database/ORM methods. Do not emit `await` at module scope or inside a synchronous `def`.",
    "For a Next.js + Python/FastAPI application, keep frontend files under frontend/ and backend files under backend/. frontend/package.json is for JavaScript packages only; backend/requirements.txt is for Python packages only, with exactly one valid pip requirement per line (never a space-separated package list). Python's sqlite3 is part of the standard library and must not appear in requirements.txt. Never put FastAPI, Uvicorn, SQLAlchemy, Pydantic, or PostgreSQL drivers in package.json. Include separate run instructions and an .env.example containing placeholder variable names only. For Next.js 13+, do not render an <a> child inside <Link>; put className and other link attributes directly on <Link>.",
    "Never hard-code credentials, encryption keys, signing secrets, JWT keys, or real personal data. Load signing keys from environment configuration, document them in .env.example, and fail clearly when required secrets are unset; never include a plausible fallback secret in source code. MobiusX Preview can provision a project-specific development ENCRYPTION_KEY when source code explicitly requires it. In Next.js 13+, use <Link href=\"...\">text</Link> directly; do not nest an <a> inside <Link> and do not use legacyBehavior unless preserving an existing legacy link. Validate external requests with typed Pydantic schemas and explicit bounds/constraints (for example non-negative pay/hours and valid dates); use ORM filters or parameterized SQL, and never interpolate user input into SQL. Hash passwords and enforce role authorization on protected routes. Never claim a security feature exists unless implemented.",
    payroll
      ? "PAYROLL SCOPE: deliver usable frontend screens for Employees/Departments, Attendance, Payroll Runs, and Reports/Payslips. Each screen must be reachable from visible navigation and show domain data plus working actions/forms; a generic dashboard, one basic page, static feature cards, or placeholder buttons do not count. Keep frontend files concise and focus on these screens. Implement the matching FastAPI endpoints and PostgreSQL persistence; salary calculations must derive gross pay, deductions, bonuses, and net pay, and payroll processing must use transactions. Include Admin/Payroll Manager and Employee roles with actual protected routes. Keep a small, clearly development-only seed dataset if needed; do not replace workflows with fake in-memory authentication or disconnected mock data. Use compatible, installable dependency ranges and keep Python and npm manifests separate. `sqlite3` is part of Python's standard library; never list it in requirements.txt."
      : "Prioritize the core journey named in the request, with meaningful sample content where useful and working controls rather than placeholder buttons.",
    input.archMode === "web" ? "Web app style: lean implementation, polished user experience, no unnecessary enterprise infrastructure." : "",
    steeringContextBlock(input),
    assistantMemoryBlock(input),
    relevantFilesContext(input, true),
  ].filter(Boolean).join("\n\n");
}

/**
 * Embeds the pre-computed architecture evidence bundle (gathered by
 * apps/desktop-agent/src/architectureContext.ts, GET /architecture-evidence)
 * as a structured JSON block in the prompt -- this IS architecture mode's
 * grounding mechanism, in place of relevantFilesContext's semantic-search
 * snippets. Deliberately dumps the real fields the diagram instructions
 * above reference by name (components, schemaTables, ormEntities,
 * relationships, routes, externalIntegrations, frontendBackendLinks) so
 * the model can quote them directly rather than paraphrase from prose.
 */
function architectureEvidenceContext(evidence: NonNullable<RunnerInput["projectContext"]>["architectureEvidence"]): string {
  return [
    "REAL PROJECT EVIDENCE (architecture-evidence bundle, gathered directly from this project's own files -- treat every field below as ground truth, not a suggestion):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

/**
 * Testing Engine (roadmap Phase 10, source requirement §15). Same
 * dump-the-real-bundle-as-JSON approach as architectureEvidenceContext
 * above -- the model quotes real detected test frameworks / existing test
 * file content directly rather than paraphrasing from prose.
 */
function testingEvidenceContext(evidence: NonNullable<RunnerInput["projectContext"]>["testingEvidence"]): string {
  return [
    "REAL TESTING EVIDENCE (testing-evidence bundle -- gathered directly from this project's own detected dependencies and existing test files, treat every field below as ground truth, not a suggestion):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

/**
 * DevOps/Infrastructure Generation (roadmap Phase 14). Same
 * dump-the-real-bundle-as-JSON approach as architectureEvidenceContext/
 * testingEvidenceContext above -- the model quotes real detected
 * components, real existing infra file paths, and real verification
 * commands directly rather than paraphrasing from prose.
 */
function devopsEvidenceContext(evidence: NonNullable<RunnerInput["projectContext"]>["devopsEvidence"]): string {
  return [
    "REAL DEVOPS EVIDENCE (devops-evidence bundle -- gathered directly from this project's own detected components, existing infra files, and real verification commands, treat every field below as ground truth, not a suggestion):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

/**
 * Auth/RBAC Engineering (roadmap Phase 19). Same
 * dump-the-real-bundle-as-JSON approach as devopsEvidenceContext/
 * testingEvidenceContext above -- the model quotes the real detected auth
 * library (or its real absence), real backend location, and real existing
 * auth file content directly rather than paraphrasing from prose.
 */
function authEvidenceContext(evidence: NonNullable<RunnerInput["projectContext"]>["authEvidence"]): string {
  return [
    "REAL AUTH EVIDENCE (auth-evidence bundle -- gathered directly from this project's own detected dependencies, detected backend location(s), and any existing auth-shaped file, treat every field below as ground truth, not a suggestion):",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

/**
 * BUILD mode's conditional companion-test instruction (roadmap Phase 10,
 * source requirement §15's literal ask: test generation as "part of the
 * standard Build-mode output for new backend/frontend code"). Gated on
 * the SAME testingEvidence bundle Testing mode uses -- if this project has
 * no detected test framework at all, this explicitly tells the model NOT
 * to invent one rather than staying silent (silence would leave a model
 * free to guess), matching this codebase's "never guess, say so" pattern.
 */
function buildModeTestingBlock(evidence: NonNullable<RunnerInput["projectContext"]>["testingEvidence"]): string {
  if (!evidence || evidence.testFrameworks.length === 0) {
    return "TEST GENERATION (roadmap Phase 10): no test framework was detected for this project, so do not invent one or add a companion test file for this request -- just build what was asked.";
  }
  const frameworks = evidence.testFrameworks.map((f) => `${f.name} (in ${f.location}/)`).join(", ");
  return [
    testingEvidenceContext(evidence),
    `TEST GENERATION (roadmap Phase 10): this project has a detected test framework -- ${frameworks}. For every NEW backend or frontend source file you create in this request that contains real logic (not pure config, docs, or a migration), ALSO propose one companion test file in the SAME edits array, in that framework's convention (matching this project's existing test style shown just above, if any) -- covering at least the file's main real behavior, not just that it exists. Do not skip this just because the request didn't explicitly mention tests. Only ever use a framework already detected above for the matching language -- never a different one, and never for a language/ecosystem this project has no detected framework for.`,
  ].join("\n\n");
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
