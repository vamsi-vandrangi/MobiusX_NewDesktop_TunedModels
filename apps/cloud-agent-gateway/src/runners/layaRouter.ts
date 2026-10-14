import type { AgentMode, AppArchitectureMode, ProjectContext } from "@mobiusx/protocol";

export type AutoModelTier = "fast" | "balanced" | "powerful";
export type WorkloadKind = "chat" | "coding" | "data_extraction" | "image_generation";

export interface LayaRouteInput {
  mode: AgentMode;
  prompt: string;
  archMode?: AppArchitectureMode;
  projectContext?: ProjectContext;
}

export interface LayaRouteDecision {
  kind: WorkloadKind;
  tier: AutoModelTier;
  note: string;
  source: "laya" | "rules";
}

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const ROUTE_TIMEOUT_MS = 2_500;
const MAX_ROUTE_PROMPT_CHARS = 500;
const UNAVAILABLE_CACHE_MS = 60_000;
let unavailableUntil = 0;

/** Clear transient endpoint-health state between isolated tests. */
export function resetLayaAvailabilityForTests(): void {
  unavailableUntil = 0;
}

/**
 * Laya is a local typed-decision model, not a chat model. It classifies the
 * workload and estimates its complexity, then MobiusX applies capability,
 * cost and availability rules to choose a text model. A deterministic mode-
 * based route is used when Ollama/Laya is unavailable or returns uncertain
 * output. No prompt or project context is sent to a hosted router.
 */
export async function routeWithLaya(input: LayaRouteInput): Promise<LayaRouteDecision> {
  if (Date.now() < unavailableUntil) return rulesRoute(input, "Laya's Ollama endpoint is unsupported; update Ollama to 0.40+ and run `ollama pull laya`.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const state = {
      task_mode: input.mode,
      app_style: input.archMode ?? "web",
      // Laya is a small classifier with a documented 512-token budget for
      // each question, including state and criteria. Routing needs only the
      // request's intent; large source excerpts waste that budget and can
      // destabilize older local builds.
      request: input.prompt.slice(0, MAX_ROUTE_PROMPT_CHARS),
    };
    const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.MOBIUSX_LAYA_MODEL ?? "laya",
        state,
        keep_alive: "10m",
        questions: {
          workload: {
            type: "choice",
            instructions: "Choose the main kind of work requested.",
            criteria: {
              chat: "Explain, plan, or advise without changing project files.",
              coding: "Create, modify, debug, review, or test software files.",
              data_extraction: "Extract or transform supplied records into structured data.",
              image_generation: "Create an image or visual asset as the main output.",
            },
          },
          complexity: {
            type: "score",
            instructions: "Estimate the scope and effort needed for a correct result.",
            criteria: [
              "Small answer or one localized code change.",
              "Several steps or files with some validation.",
              "Large multi-file application or complex, security-sensitive work.",
            ],
          },
        },
      }),
    });
    if (!response.ok) {
      const unsupported = response.status === 404 || response.status === 405;
      // A server-side failure (the installed MLX runner can panic while
      // Ollama itself remains healthy) is also a known unavailable state.
      // Cache it briefly so every task does not pay the same timeout/failure.
      if (unsupported || response.status >= 500) unavailableUntil = Date.now() + UNAVAILABLE_CACHE_MS;
      const errorDetail = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
      const detail = errorDetail ? ` ${errorDetail}` : "";
      return rulesRoute(input, unsupported
        ? `Laya's Ollama endpoint is unsupported; update Ollama to 0.40+ and run \`ollama pull laya\`. HTTP ${response.status}.${detail}`
        : `Laya returned HTTP ${response.status}.${detail}`);
    }

    const body = await response.json() as {
      answers?: {
        workload?: { choice?: unknown; confidence?: unknown };
        complexity?: { score?: unknown; confidence?: unknown };
      };
    };
    const workload = body.answers?.workload;
    const complexity = body.answers?.complexity;
    const choices: WorkloadKind[] = ["chat", "coding", "data_extraction", "image_generation"];
    if (!workload || !choices.includes(workload.choice as WorkloadKind) || typeof workload.confidence !== "number" || workload.confidence < 0.55 || typeof complexity?.score !== "number") {
      return rulesRoute(input, "Laya returned an uncertain route.");
    }

    const reportedKind = workload.choice as WorkloadKind;
    // A task mode that writes or verifies code is authoritative. Garden and
    // storefront prompts commonly mention product photos, plant imagery, or
    // logos; a small classifier can mistake those assets for the main task
    // and label the request image_generation even though MobiusX has no image
    // generation runner. Keep the request on the software-build path and let
    // the generated frontend reference ordinary image assets as part of code.
    const codeProducingMode = [
      "build", "fix", "database", "devops", "auth", "architecture", "testing", "spec",
    ].includes(input.mode);
    const kind: WorkloadKind = codeProducingMode ? "coding" : reportedKind;
    let score = Math.max(0, Math.min(2, complexity.score));
    // The task mode and application style are stronger evidence than a small
    // classifier's estimate: never send file-writing work to the cheapest tier.
    if (input.mode === "build" || input.mode === "fix" || input.mode === "database" || input.mode === "devops" || input.mode === "auth" || input.mode === "architecture" || input.mode === "testing" || input.mode === "spec") score = Math.max(score, 1);
    if (input.archMode === "enterprise" || input.archMode === "embedded") score = Math.max(score, 2);

    const tier: AutoModelTier = score < 0.75 ? "fast" : score < 1.65 ? "balanced" : "powerful";
    const imageNote = kind === "image_generation" ? " No image-generation model is configured, so the selected text model can provide guidance but cannot render an image." : "";
    return {
      kind,
      tier,
      source: "laya",
      note: codeProducingMode && reportedKind !== "coding"
        ? `Laya classified the request as ${reportedKind.replaceAll("_", " ")}, but the selected ${input.mode} mode requires software edits; MobiusX routed it as coding and selected the ${tier} model tier.`
        : `Laya classified this as ${kind.replaceAll("_", " ")} and selected the ${tier} model tier.${imageNote}`,
    };
  } catch (error) {
    // Local Ollama may be stopped, too old for /v1/systemone, or still
    // loading the model. Never block task execution on the router.
    const reason = (error as Error).name === "AbortError"
      ? "Laya routing timed out."
      : "Ollama could not serve Laya; make sure Ollama is running and `laya` is installed.";
    return rulesRoute(input, reason);
  } finally {
    clearTimeout(timeout);
  }
}

function rulesRoute(input: LayaRouteInput, reason = "Laya is unavailable."): LayaRouteDecision {
  const text = input.prompt.toLowerCase();
  const forcedCode = ["build", "fix", "database", "devops", "auth", "architecture", "testing", "spec"].includes(input.mode);
  const kind: WorkloadKind = forcedCode
    ? "coding"
    : /\b(extract|classify|parse|convert|csv|json schema|structured data|invoice fields|entities from)\b/.test(text)
      ? "data_extraction"
      : /\b(generate|create|draw|make)\b.{0,40}\b(image|illustration|logo|visual asset)\b/.test(text)
        ? "image_generation"
        : /\b(code|coding|implement|debug|fix|refactor|repository|project files)\b/.test(text)
          ? "coding"
          : "chat";
  let tier: AutoModelTier = "fast";
  if (forcedCode || kind === "coding") tier = "balanced";
  if (input.archMode === "enterprise" || input.archMode === "embedded" || /\b(multi.?file|microservices|real.?time|safety.?critical|security|production)\b/.test(text)) tier = "powerful";
  const imageNote = kind === "image_generation" ? " No image-generation model is configured; the text model can only provide guidance." : "";
  return { kind, tier, source: "rules", note: `${reason} MobiusX used its ${tier} task rules.${imageNote}` };
}
