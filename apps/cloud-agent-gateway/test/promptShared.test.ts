import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStructuredProseStreamer, systemPromptFor, systemPromptForLocalBuild, EDITS_MARKER, parseBuildResponse, PUBLIC_PROGRESS_RULE } from "../src/runners/promptShared.js";
import type { RunnerInput } from "../src/runners/types.js";

function baseInput(overrides: Partial<RunnerInput> = {}): RunnerInput {
  return { taskId: "t1", mode: "build", prompt: "hello", modelId: "test-model", ...overrides };
}

test("structured responses stream prose but suppress the edit marker and machine-readable payload", () => {
  const emitted: string[] = [];
  const streamer = createStructuredProseStreamer((delta) => emitted.push(delta));
  streamer.push(`Building your app.\n${EDITS_MARKER.slice(0, 8)}`);
  streamer.push(`${EDITS_MARKER.slice(8)}\n{"edits":[{"path":"secret.json"}]}`);
  assert.equal(streamer.finish(), "Building your app.\n");
  assert.equal(emitted.join(""), "Building your app.\n");
  assert.doesNotMatch(emitted.join(""), /MOBIUSX_EDITS|secret\.json/);
});

test("every mode keeps private reasoning hidden and uses only public progress", () => {
  for (const mode of ["ask", "plan", "build", "fix", "database", "architecture", "testing", "devops", "auth"] as const) {
    assert.ok(systemPromptFor(baseInput({ mode })).includes(PUBLIC_PROGRESS_RULE));
  }
});

test("build mode system prompt asks for a genuinely complete app, not the smallest skeleton", () => {
  // Regression guard for the Oct 2026 Cursor-vs-MobiusX quality gap: the
  // same "build me a gardening business website" prompt produced one
  // bare index page + an empty database on MobiusX (openai/gpt-oss-120b
  // via Groq) versus multiple pages + a populated database on Cursor.
  // The build-mode prompt previously said nothing about application scope
  // or first-run content at all, so a model's own instinct to minimize
  // was never counteracted. These two instructions close that gap.
  const prompt = systemPromptFor(baseInput());
  assert.match(prompt, /COMPLETENESS/);
  assert.match(prompt, /more than one page/);
  assert.match(prompt, /FIRST-RUN CONTENT/);
  assert.match(prompt, /seed/i);
});

test("compact Ollama payroll prompt requires real, navigable frontend modules", () => {
  const prompt = systemPromptForLocalBuild(baseInput({
    prompt: "Build an employee payroll management app with Next.js, FastAPI, and PostgreSQL.",
    projectContext: { projectPath: "/tmp/payroll-test", relevantFiles: [], indexedChunkCount: 0 },
  }));
  assert.match(prompt, /Employees\/Departments, Attendance, Payroll Runs, and Reports\/Payslips/);
  assert.match(prompt, /one basic page/);
  assert.match(prompt, /matching FastAPI endpoints and PostgreSQL persistence/);
  assert.match(prompt, /never include a plausible fallback secret/i);
  assert.match(prompt, /explicit bounds\/constraints/i);
  assert.match(prompt, /sqlite3 is part of Python(?:'s)? standard library|Python's sqlite3 is part of the standard library/i);
  assert.match(prompt, /every function containing `await` must be declared `async def`/i);
});

test("staged local generation keeps the compact build prompt while retaining complete checkpoint context", () => {
  const input = baseInput({
    prompt: "Build a customer onboarding app with React, FastAPI, PostgreSQL, and approval workflow.",
    stagedBuild: { id: "backend", index: 3, total: 6, final: false },
    projectContext: {
      projectPath: "/tmp/customer-onboarding",
      relevantFiles: [{ relPath: "backend/models.py", content: "class Customer(Model): pass\n", snippet: "class Customer(Model)" }],
      indexedChunkCount: 1,
    },
  });
  const compact = systemPromptForLocalBuild(input);
  const general = systemPromptFor(input);
  assert.ok(compact.length < general.length / 2, `staged prompt should remain compact (${compact.length} vs ${general.length} chars)`);
  assert.match(compact, /class Customer\(Model\): pass/);
  assert.match(compact, /one bounded application stage/);
  assert.match(compact, /immutable PAC slice and stage task specification/);
});

test("other modes (e.g. auth) are unaffected by the build-mode completeness guidance", () => {
  const prompt = systemPromptFor(baseInput({ mode: "auth" }));
  assert.doesNotMatch(prompt, /COMPLETENESS:/);
  assert.doesNotMatch(prompt, /FIRST-RUN CONTENT:/);
});

test("build mode system prompt demands real visual polish, not an unstyled scaffold", () => {
  // Regression guard for the Oct 2026 Cursor-vs-MobiusX LIVE build
  // comparison (gardening-flow-test-01 vs. Cursor's greenleaf-garden on
  // the same prompt, both actually launched on the user's machine):
  // completeness/seed-data already matched Cursor, but the generated UI
  // had no deliberate color system, no real imagery, and no type scale --
  // nothing in this prompt asked for visual quality, only scope.
  const prompt = systemPromptFor(baseInput());
  assert.match(prompt, /VISUAL QUALITY/);
  assert.match(prompt, /color system/);
  assert.match(prompt, /images\.unsplash\.com\/photo-/);
  assert.match(prompt, /hover\/focus/);
  assert.match(prompt, /empty\/loading\/error state/);
});

test("an explicit blue palette wins over the gardening domain's usual green convention", () => {
  const prompt = systemPromptFor(baseInput({ prompt: "Build a gardening shop website with a blue color theme." }));
  assert.match(prompt, /EXPLICIT USER DESIGN DIRECTIONS ALWAYS OVERRIDE DOMAIN CONVENTIONS/);
  assert.match(prompt, /use a blue palette even for a gardening business/);
  assert.doesNotMatch(prompt, /generic green dashboard/);
});

test("build mode system prompt forbids hallucinated dependency versions", () => {
  // Regression guard for the real observed failure this session: a
  // generated frontend's package.json pinned "typescript": "7.0.2" (a
  // version that does not exist), npm silently resolved something else
  // for it, and the mismatch crashed Next.js's own startup TypeScript
  // check the first time a person actually ran "npm run dev" -- a
  // launch-blocking bug the prompt never previously guarded against.
  const prompt = systemPromptFor(baseInput());
  assert.match(prompt, /DEPENDENCY VERSION SAFETY/);
  assert.match(prompt, /hallucinated version/);
  assert.match(prompt, /7\.0\.2/);
});

test("other modes (e.g. auth) are unaffected by the build-mode visual-quality/version-safety guidance", () => {
  const prompt = systemPromptFor(baseInput({ mode: "auth" }));
  assert.doesNotMatch(prompt, /VISUAL QUALITY:/);
  assert.doesNotMatch(prompt, /DEPENDENCY VERSION SAFETY:/);
});

test("archMode 'web' explicitly ties lean scope to visual quality, not an excuse to skip it", () => {
  const prompt = systemPromptFor(baseInput({ archMode: "web" }));
  assert.match(prompt, /not actually lean, it's just unfinished/);
});

// Oct 2026 addition: the Assistant panel's Web App / Enterprise App
// architecture-mode toggle. These guard the three real states
// archModeGuidanceBlock can produce, and that the toggle is genuinely
// cross-cutting (not just a build-mode thing) -- see its own doc comment
// in promptShared.ts for why ask/plan are included deliberately.
test("archMode 'web' injects lean/web-app guidance into the prompt", () => {
  const prompt = systemPromptFor(baseInput({ archMode: "web" }));
  assert.match(prompt, /ARCHITECTURE MODE: Web Application/);
  assert.match(prompt, /speed-to-market/);
  assert.doesNotMatch(prompt, /ARCHITECTURE MODE: Enterprise Application/);
});

test("archMode 'enterprise' injects multi-tier, security, persistence, and delivery guidance", () => {
  const prompt = systemPromptFor(baseInput({ archMode: "enterprise" }));
  assert.match(prompt, /ARCHITECTURE MODE: Enterprise Application/);
  assert.match(prompt, /REST endpoints/);
  assert.match(prompt, /GraphQL/);
  assert.match(prompt, /gRPC/);
  assert.match(prompt, /Spring Boot, ASP.NET Core, Django, or Quarkus/);
  assert.match(prompt, /MVC, Clean Architecture, DDD/);
  assert.match(prompt, /SOLID/);
  assert.match(prompt, /Hibernate, Entity Framework, Prisma, Django ORM/);
  assert.match(prompt, /transaction boundaries/);
  assert.match(prompt, /JWT, OAuth2\/OIDC/);
  assert.match(prompt, /SQL injection/);
  assert.match(prompt, /CSRF/);
  assert.match(prompt, /circuit breakers/);
  assert.match(prompt, /GitHub Actions, GitLab CI, or Jenkins/);
  assert.match(prompt, /Terraform or Kubernetes/);
  assert.match(prompt, /Do not invent infrastructure/);
  assert.doesNotMatch(prompt, /ARCHITECTURE MODE: Web Application/);
});

test("omitting archMode entirely leaves the prompt byte-for-byte unaffected by the toggle", () => {
  const withUndefined = systemPromptFor(baseInput());
  const explicitlyUndefined = systemPromptFor(baseInput({ archMode: undefined }));
  assert.doesNotMatch(withUndefined, /ARCHITECTURE MODE:/);
  assert.equal(withUndefined, explicitlyUndefined);
});

test("archMode guidance is cross-cutting -- it also applies to ask and plan, not just build-like modes", () => {
  const askPrompt = systemPromptFor(baseInput({ mode: "ask", archMode: "enterprise" }));
  assert.match(askPrompt, /ARCHITECTURE MODE: Enterprise Application/);
  const planPrompt = systemPromptFor(baseInput({ mode: "plan", archMode: "web" }));
  assert.match(planPrompt, /ARCHITECTURE MODE: Web Application/);
});

test("archMode guidance is placed before the mode-specific instructions, like steering context", () => {
  const prompt = systemPromptFor(baseInput({ archMode: "web", mode: "ask" }));
  const archIdx = prompt.indexOf("ARCHITECTURE MODE: Web Application");
  const askIdx = prompt.indexOf("answering a developer's question");
  assert.ok(archIdx !== -1 && askIdx !== -1, "expected both the arch-mode block and the ask-mode instruction to be present");
  assert.ok(archIdx < askIdx, "arch-mode guidance must come before the mode-specific instruction");
});

// Assistant Memory (Oct 2026 addition) -- see assistantMemoryBlock's doc
// comment in promptShared.ts. Mirrors the steering-context injection
// pattern (not itself under test here, but the same "absent when not set,
// prepended when it is" contract) at the ProjectContext.assistantMemoryContext
// field instead.
test("assistant memory context is absent from the prompt when not set", () => {
  const prompt = systemPromptFor(baseInput());
  assert.doesNotMatch(prompt, /standing memory of this user/);
});

test("assistant memory context, when present, is injected and comes before steering and arch-mode guidance", () => {
  const prompt = systemPromptFor(
    baseInput({
      mode: "ask",
      archMode: "web",
      projectContext: {
        projectPath: "/tmp/proj",
        assistantMemoryContext: "--- memory/preferences.md ---\n- Prefers FastAPI over Flask",
        steeringContext: "--- .mobiusx/steering/architecture.md ---\nLayered architecture.",
      },
    }),
  );
  assert.match(prompt, /standing memory of this user/);
  assert.match(prompt, /Prefers FastAPI over Flask/);
  const memoryIdx = prompt.indexOf("Prefers FastAPI over Flask");
  const steeringIdx = prompt.indexOf("Layered architecture");
  const archIdx = prompt.indexOf("ARCHITECTURE MODE: Web Application");
  assert.ok(memoryIdx !== -1 && steeringIdx !== -1 && archIdx !== -1, "expected memory, steering, and arch-mode blocks to all be present");
  assert.ok(memoryIdx < steeringIdx, "memory must come before steering (who you're working with, then this project's own rules)");
  assert.ok(steeringIdx < archIdx, "steering must still come before arch-mode guidance, unchanged from before this feature");
});

test("assistant memory context is cross-cutting -- applies to every mode, not just build-like ones", () => {
  const askPrompt = systemPromptFor(baseInput({ mode: "ask", projectContext: { projectPath: "/tmp/proj", assistantMemoryContext: "- Likes concise answers" } }));
  assert.match(askPrompt, /Likes concise answers/);
  const planPrompt = systemPromptFor(baseInput({ mode: "plan", projectContext: { projectPath: "/tmp/proj", assistantMemoryContext: "- Likes concise answers" } }));
  assert.match(planPrompt, /Likes concise answers/);
});

// Regression guard for the Oct 2026 "editsCount 0 despite 14647 completion
// tokens" bug: a real Claude build task generated a large, genuinely
// complete multi-file response (well under the max_tokens ceiling, so not
// a truncation case) and still ended up with zero edits applied. Root
// cause -- confirmed by reading the shipped code, not guessed -- was the
// old fence-extraction regex being non-greedy, so it stopped at the FIRST
// ``` it found after the opening fence. A proposed README.md (or any
// markdown file) whose own content legitimately contains a ``` code block
// triggers exactly this: the JSON gets truncated mid-string and
// JSON.parse throws, silently dropping every edit. This test reproduces
// that exact shape (a "create" edit for README.md whose content has its
// own fenced code block) and asserts the edit survives.
test("parseBuildResponse survives a proposed file whose own content contains a nested ``` code fence", () => {
  const readmeContent = "# Garden Shop\n\nInstall:\n```bash\nnpm install\n```\n\nThat's it.\n";
  const editsPayload = { edits: [{ path: "README.md", action: "create", content: readmeContent }] };
  const text = ["I'll build the app.", EDITS_MARKER, "```json", JSON.stringify(editsPayload), "```"].join("\n");
  const { prose, edits, droppedCount, hadMarker } = parseBuildResponse(text, baseInput());
  assert.equal(hadMarker, true);
  assert.equal(prose, "I'll build the app.");
  assert.equal(droppedCount, 0);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, "README.md");
  assert.equal(edits[0].content, readmeContent);
});

test("parseBuildResponse matches complete modify targets case-insensitively and preserves canonical path casing", () => {
  const text = [EDITS_MARKER, JSON.stringify({ edits: [{ path: "Backend/MODELS.py", action: "modify", content: "class Customer: pass\n" }] })].join("\n");
  const result = parseBuildResponse(text, baseInput({ projectContext: { projectPath: "/tmp/project", relevantFiles: [{ relPath: "backend/models.py", content: "class User: pass\n" }] } }));
  assert.equal(result.droppedCount, 0);
  assert.deepEqual(result.edits.map(({ path, action }) => ({ path, action })), [{ path: "backend/models.py", action: "modify" }]);
});

test("P0.6a reproducer: an auth route absent from the checkpoint becomes a safe create edit", () => {
  // Captured from failed clean run edf92fb3-76ee-4e1f-9278-a6284946acbf:
  // the model returned a full auth route for backend/routes/auth.py with
  // action=modify although the route did not exist in the validated artifact
  // manifest. The old parser rejected it as not present in full context.
  const response = [EDITS_MARKER, JSON.stringify({ edits: [{
    path: "backend/routes/auth.py",
    action: "modify",
    content: "from fastapi import APIRouter\nrouter = APIRouter()\n@router.post('/auth/login')\nasync def login(): return {'access_token': 'x'}\n",
  }] })].join("\n");
  const unscoped = parseBuildResponse(response, baseInput());
  assert.equal(unscoped.edits.length, 0, "the original parser behavior rejects an absent modify target");
  assert.deepEqual(unscoped.rejectedEditPaths, ["backend/routes/auth.py"]);

  const scoped = parseBuildResponse(response, baseInput({
    stagedBuild: { index: 3, total: 6, id: "backend", final: false, subtask: {
      id: "auth-api",
      targetPaths: ["backend/routes/auth.py"],
      acceptanceCriteria: ["Expose POST /auth/login"],
      targetFileOperations: [{ path: "backend/routes/auth.py", action: "create" }],
    } },
  }));
  assert.equal(scoped.droppedCount, 0);
  assert.deepEqual(scoped.edits.map(({ path, action }) => ({ path, action })), [{ path: "backend/routes/auth.py", action: "create" }]);
});

test("staged edits reject create/modify action drift and stale full-content hashes", () => {
  const content = "class AuthRouter: pass\n";
  const sha = createHash("sha256").update(content).digest("hex");
  const response = [EDITS_MARKER, JSON.stringify({ edits: [{ path: "backend/routes/auth.py", action: "modify", content: "class AuthRouter: pass\n" }] })].join("\n");
  const stale = parseBuildResponse(response, baseInput({
    projectContext: { relevantFiles: [{ relPath: "backend/routes/auth.py", content }] },
    stagedBuild: { index: 3, total: 6, id: "backend", final: false, subtask: {
      id: "auth-api", targetPaths: ["backend/routes/auth.py"], acceptanceCriteria: [],
      targetFileOperations: [{ path: "backend/routes/auth.py", action: "modify", expectedContentSha256: "stale" }],
    } },
  }));
  assert.deepEqual(stale.edits, []);
  assert.deepEqual(stale.rejectedEditPaths, ["backend/routes/auth.py"]);
  const valid = parseBuildResponse(response, baseInput({
    projectContext: { relevantFiles: [{ relPath: "backend/routes/auth.py", content }] },
    stagedBuild: { index: 3, total: 6, id: "backend", final: false, subtask: {
      id: "auth-api", targetPaths: ["backend/routes/auth.py"], acceptanceCriteria: [],
      targetFileOperations: [{ path: "backend/routes/auth.py", action: "modify", expectedContentSha256: sha }],
    } },
  }));
  assert.deepEqual(valid.edits.map((edit) => edit.path), ["backend/routes/auth.py"]);
});

// Regression guard for the Oct 2026 "zero edits, zero warning" bug found
// live in THIS session, one step past the bug above: a real claude-sonnet-4-5
// build task (run right after the VISUAL QUALITY/DEPENDENCY VERSION SAFETY
// rules were added) streamed for 2+ minutes, genuinely included
// EDITS_MARKER, and still produced zero files on disk -- confirmed by
// inspecting the real project folder on the user's machine (nothing but
// MobiusX's own .mobiusx/ metadata). Root cause: every candidateJsonTexts()
// strategy failed to JSON.parse (the classic cause is the response hitting
// its token ceiling mid-JSON, so the array/string is cut off, not
// malformed-but-complete), and the old code returned droppedCount: 0 for
// this -- identical to the "model deliberately proposed {"edits": []}"
// case -- so every caller's `if (droppedCount > 0)` check stayed silent,
// and openAiCompatibleRunner.ts actively mislabeled it as "waiting on your
// answer." These tests pin the fix: a genuine parse failure must be
// distinguishable from a deliberate empty array via `parseFailed`.
test("parseBuildResponse flags parseFailed when the marker is present but the JSON after it is truncated mid-response", () => {
  // Simulates hitting max_tokens mid-JSON: the edits array opens, one file
  // is mostly written, then the response just stops -- no closing fence,
  // no closing brace, exactly what a token-ceiling cutoff produces.
  const truncated = [
    "I'll build the full site now.",
    EDITS_MARKER,
    "```json",
    '{"edits": [{"path": "frontend/src/app/page.tsx", "action": "create", "content": "export default function Home() {\\n  return <div>Welcome to the gard',
  ].join("\n");
  const { prose, edits, droppedCount, hadMarker, parseFailed } = parseBuildResponse(truncated, baseInput());
  assert.equal(hadMarker, true);
  assert.equal(parseFailed, true);
  assert.equal(edits.length, 0);
  assert.equal(droppedCount, 0);
  assert.equal(prose, "I'll build the full site now.");
});

test("parseBuildResponse does NOT flag parseFailed for a deliberate, well-formed empty edits array", () => {
  // The real pre-flight-clarification case (the BUILD prompt's own
  // {"edits": []} instruction): valid JSON, genuinely zero edits. Must stay
  // distinguishable from the truncation case above so callers don't retry
  // or warn about a response that was never broken in the first place.
  const askingQuestions = [
    "Before I build this, should orders require login, or support guest checkout?",
    EDITS_MARKER,
    "```json",
    '{"edits": []}',
    "```",
  ].join("\n");
  const { edits, droppedCount, hadMarker, parseFailed } = parseBuildResponse(askingQuestions, baseInput());
  assert.equal(hadMarker, true);
  assert.equal(parseFailed, false);
  assert.equal(edits.length, 0);
  assert.equal(droppedCount, 0);
});

test("parseBuildResponse does NOT flag parseFailed when the marker is simply absent", () => {
  // Distinct from both cases above -- no marker at all (model described
  // a plan in prose and never attempted the format) is its own existing
  // signature (hadMarker: false) and must stay that way, not get folded
  // into parseFailed.
  const planOnly = "I'll build a Next.js frontend with a FastAPI backend.";
  const { hadMarker, parseFailed } = parseBuildResponse(planOnly, baseInput());
  assert.equal(hadMarker, false);
  assert.equal(parseFailed, false);
});
