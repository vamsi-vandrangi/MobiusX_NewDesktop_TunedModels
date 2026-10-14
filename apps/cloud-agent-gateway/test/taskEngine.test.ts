import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store — and, now that startTask() consults it for multi-model
// default-model resolution, settings — at isolated temp dirs before
// importing anything that reads them, and clear every model-provider env
// var so these tests exercise the "nothing configured -> demo runner"
// path deterministically regardless of what's set in the host shell.
const dataDir = await mkdtemp(join(tmpdir(), "mobiusx-cloud-test-"));
process.env.MOBIUSX_CLOUD_DATA_DIR = dataDir;
const settingsDir = await mkdtemp(join(tmpdir(), "mobiusx-cloud-settings-test-"));
process.env.MOBIUSX_SETTINGS_DIR = settingsDir;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_MODEL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.XKIRO_API_KEY;
delete process.env.APINEX_API_KEY;

const { startTask, getTask, cancelTask, shouldBypassLayaForExplicitBuild } = await import("../src/taskEngine.js");
const { listTasks } = await import("../src/store.js");
const { resetLayaAvailabilityForTests } = await import("../src/runners/layaRouter.js");

function waitUntilDone(id: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      const task = await getTask(id);
      if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("task did not complete in time"));
        return;
      }
      setTimeout(tick, 50);
    };
    void tick();
  });
}

test("startTask with no Anthropic env runs the demo runner end-to-end", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;

  const summary = await startTask({ mode: "plan", prompt: "reduce payment timeout retries" });
  assert.equal(summary.runner, "demo");
  assert.equal(summary.status, "queued");

  await waitUntilDone(summary.id);

  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.status, "completed");
  assert.ok(task!.steps.length >= 2);
  assert.ok(task!.steps.every((s) => s.status === "completed"));
  assert.match(task!.output, /demo runner/);
  assert.match(task!.output, /reduce payment timeout retries/);
});

test("explicit provider remains pinned while Laya classifies the task locally", async (t) => {
  resetLayaAvailabilityForTests();
  let layaCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/v1/systemone")) {
      layaCalls += 1;
      return new Response("MLX runner unavailable", { status: 500 });
    }
    throw new Error(`Unexpected fetch in test: ${String(url)}`);
  });
  const summary = await startTask({ mode: "plan", prompt: "Plan a small settings update", model: { provider: "demo", model: "demo" } });
  assert.equal(summary.runner, "demo", "Laya classification must not replace an explicit provider selection");
  assert.equal(layaCalls, 1, "Laya should classify explicit-provider tasks too");
  assert.match(summary.modelNote ?? "", /Laya returned HTTP 500/);
  await waitUntilDone(summary.id);
});

test("explicit Build model bypasses Laya and preserves the selected provider", async (t) => {
  resetLayaAvailabilityForTests();
  delete process.env.MOBIUSX_BYPASS_LAYA_FOR_EXPLICIT_BUILD;
  let layaCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).endsWith("/v1/systemone")) {
      layaCalls += 1;
      return new Response("MLX runner unavailable", { status: 500 });
    }
    throw new Error(`Unexpected fetch in test: ${String(url)}`);
  });

  const summary = await startTask({
    mode: "build",
    prompt: "Build a small application",
    model: { provider: "demo", model: "demo" },
  });
  assert.equal(summary.runner, "demo");
  assert.equal(summary.model, "demo");
  assert.equal(layaCalls, 0, "an explicit Build choice must not contact Laya");
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.ok(task?.steps.some((step) => /Laya bypassed for explicit Build/.test(step.label)));
});

test("the Laya Build bypass can be disabled without changing other routing modes", async () => {
  const explicitBuild = { mode: "build" as const, model: { provider: "demo" as const, model: "demo" }, autoCloud: false };
  assert.equal(shouldBypassLayaForExplicitBuild(explicitBuild, {}), true);
  assert.equal(shouldBypassLayaForExplicitBuild(explicitBuild, { MOBIUSX_BYPASS_LAYA_FOR_EXPLICIT_BUILD: "false" }), false);
  assert.equal(shouldBypassLayaForExplicitBuild({ ...explicitBuild, mode: "plan" }, {}), false);
  assert.equal(shouldBypassLayaForExplicitBuild({ ...explicitBuild, autoCloud: true }, {}), false);
});

test("Auto Cloud fails over on provider HTTP errors and reaches the next configured free model", async (t) => {
  process.env.GROQ_API_KEY = "groq-test";
  process.env.OPENROUTER_API_KEY = "openrouter-test";
  process.env.XKIRO_API_KEY = "xkiro-test";
  t.after(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.XKIRO_API_KEY;
  });

  const editResponse = [
    "I built a small garden storefront.",
    "===MOBIUSX_EDITS===",
    "```json",
    JSON.stringify({ edits: [{ path: "index.html", action: "create", content: "<main>Garden shop</main>" }] }),
    "```",
  ].join("\n");
  const groqPlan = "A simple blue-themed gardening shop with a Buy button placeholder.";
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/v1/systemone")) return new Response("unsupported", { status: 500 });
    if (target.includes("api.groq.com")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: groqPlan } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (target.includes("openrouter.ai")) return new Response(JSON.stringify({ error: { message: "model endpoint unavailable" } }), { status: 404 });
    if (target.includes("api.xkiro.com")) {
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      if (!requestBody.stream) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: "approve", summary: "Review complete.", concerns: [] }) } }] }), { status: 200 });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: editResponse } }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected provider request: ${target}`);
  });

  const summary = await startTask({ mode: "build", prompt: "Build a gardening website", autoCloud: true });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.status, "completed");
  assert.equal(task!.runner, "xkiro");
  assert.equal(task!.edits?.[0]?.path, "index.html");
  assert.match(task!.output, /groq\/openai\/gpt-oss-120b failed/i);
  assert.match(task!.output, /openrouter\/inclusionai\/ling-3\.0-flash-vl:free failed/i);
  assert.doesNotMatch(task!.output, /A simple blue-themed gardening shop/i, "failed provider prose must not be shown as the completed response");
  assert.match(task!.output, /I built a small garden storefront/i, "the successful fallback's response should be surfaced");
});

test("listTasks reflects created tasks, most recent first", async () => {
  const first = await startTask({ mode: "ask", prompt: "first" });
  await waitUntilDone(first.id);
  const second = await startTask({ mode: "ask", prompt: "second" });
  await waitUntilDone(second.id);

  const tasks = await listTasks();
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id));
});

test("build mode never claims the gateway itself writes to disk", async () => {
  const summary = await startTask({ mode: "build", prompt: "add retry jitter" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.match(task!.output, /gateway never writes to disk itself/);
});

test("build mode proposes a clearly-labeled demo edit that only desktop-agent could apply", async () => {
  const summary = await startTask({ mode: "build", prompt: "add retry jitter" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.edits?.length, 1);
  const edit = task!.edits![0];
  assert.equal(edit.action, "create");
  assert.equal(edit.path, "MOBIUSX_DEMO_EDIT.md");
  assert.match(edit.content, /not real AI-generated code/);
});

test("ask and plan modes never propose edits", async () => {
  for (const mode of ["ask", "plan"] as const) {
    const summary = await startTask({ mode, prompt: "explain this function" });
    await waitUntilDone(summary.id);
    const task = await getTask(summary.id);
    assert.equal(task!.edits, undefined);
  }
});

test("build mode edits get a clearly-labeled demo second-pass review", async () => {
  const summary = await startTask({ mode: "build", prompt: "add retry jitter" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.review?.verdict, "approve");
  assert.match(task!.review!.summary, /demo reviewer/);
});

test("plan mode never gets a review (it never proposes edits at all)", async () => {
  const summary = await startTask({ mode: "plan", prompt: "something" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.review, undefined);
});

test("spec mode DOES get a review as of roadmap Phase 11 -- the Documentation persona", async () => {
  // Previously spec mode was excluded from review entirely (a real,
  // documented scope cut). Phase 11 (source §26) closed that gap so the
  // new Documentation persona has a real, reachable mode to review -- see
  // runners/personas.ts's module comment and anthropicRunner.ts's doc
  // comment on the review-trigger condition for why this changed.
  const summary = await startTask({ mode: "spec", prompt: "something" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.review?.verdict, "approve");
  assert.equal(task!.review?.persona, "documentation");
  assert.match(task!.review!.summary, /demo reviewer/);
});

test("spec mode proposes a clearly-labeled demo spec under .mobiusx/specs/", async () => {
  const summary = await startTask({ mode: "spec", prompt: "subscription management" });
  await waitUntilDone(summary.id);
  const task = await getTask(summary.id);
  assert.equal(task!.edits?.length, 1);
  const edit = task!.edits![0];
  assert.equal(edit.action, "create");
  assert.equal(edit.path, ".mobiusx/specs/demo-spec.md");
  assert.match(edit.content, /not a real requirements analysis/);
  assert.match(edit.content, /## Functional Requirements/);
  assert.match(edit.content, /## Acceptance Criteria/);
});

test("cancelTask aborts a running demo task and marks it cancelled, not failed", async () => {
  const summary = await startTask({ mode: "build", prompt: "long-running thing to cancel" });
  assert.equal(summary.status, "queued");

  // Cancel almost immediately — before the demo runner's first scripted step
  // (350-700ms) has a chance to finish — to prove the abort actually
  // interrupts in-flight work rather than the task just running to completion.
  const cancelled = cancelTask(summary.id);
  assert.equal(cancelled, true);

  await waitUntilDone(summary.id);

  const task = await getTask(summary.id);
  assert.ok(task);
  assert.equal(task!.status, "cancelled");
  assert.ok(!task!.output.includes("does not modify files automatically")); // never reached the completed output
});

test("cancelTask on an unknown or already-finished task returns false", async () => {
  assert.equal(cancelTask("no-such-task-id"), false);

  const summary = await startTask({ mode: "ask", prompt: "quick one" });
  await waitUntilDone(summary.id);
  assert.equal(cancelTask(summary.id), false); // already completed by the time we get here
});

test("startTask redacts secrets from relevantFiles context before the runner ever sees them", async () => {
  const summary = await startTask({
    mode: "ask",
    prompt: "what does this file do?",
    projectContext: {
      projectPath: "/fake/project",
      relevantFiles: [
        { relPath: "config.ts", snippet: 'export const AWS_KEY = "AKIAABCDEFGHIJKLMNOP";' },
        { relPath: "safe.ts", snippet: "export const add = (a: number, b: number) => a + b;" },
      ],
    },
  });
  await waitUntilDone(summary.id);

  const task = await getTask(summary.id);
  assert.ok(task);
  // The redaction step should be recorded, and be the first step.
  const redactionStep = task!.steps.find((s) => s.label.includes("Redacted"));
  assert.ok(redactionStep, "expected a redaction step to be recorded");
  assert.equal(task!.steps[0].id, redactionStep!.id);
  assert.match(redactionStep!.label, /aws-access-key/);

  // The demo runner's own output (which echoes back projectContext.relevantFiles' relPaths, not
  // their contents) never had the raw secret text to begin with, but assert the negative anyway
  // as a guard against a future runner change accidentally leaking it.
  assert.ok(!task!.output.includes("AKIAABCDEFGHIJKLMNOP"));
});
