# Phase 24 — Workspace UX: checklist, resizable panes, token alerts, pre-flight Q&A

Not a roadmap-numbered phase — this batch came directly from Vamsi using
the desktop app and filing eight items at once: two bug reports (dropdown
overflow, AI Assistant tabs not responding to clicks) and six feature
requests. Scoped with the user before building (`AskUserQuestion`): he
picked all four buildable feature requests, and picked "optional
pre-flight in Build mode" over a hard-gated clarification step for the
interactivity request. Two items in the original batch weren't code
changes: "did we implement transfer learning" (no — answered directly,
and explained why it's a poor fit for a provider-routing platform) and
"how does Emergent do this on the web" (researched via a dispatched
agent, delivered as a findings summary, not implemented against).

## Bug fixes

- **AI Assistant tabs not responding to clicks.** Root-caused through
  elimination: static review found nothing, and a background
  (accessibility-driven) click reproduction was inconclusive. Only a
  genuine full-screen OS-level click reproduced it reliably — the first
  click after the window regains focus was being consumed as a focus
  event, not a real click. This is `acceptsFirstMouse` defaulting to
  `false` on macOS `BrowserWindow`. Fixed with one option in
  `apps/desktop/src/main/main.js`. Re-verified after this session's
  restart: minimized the window, restored it via the Dock, then clicked
  the desktop background and immediately clicked the "Ask" tab as the
  very first click — it switched immediately (confirmed via screenshot).
- **Home page's model dropdown overflowing its frame.** A flexbox
  `min-width: auto` default on the `<select>` resisted shrinking below
  its widest `<option>`'s content width. Fixed with `min-width: 0` plus
  `flex-shrink: 0` on the adjacent mode buttons. Live-verified via
  screenshot (send button now visible, dropdown properly sized).

## Features

**Todo/progress checklist.** Each edits card now tracks its own
Apply → Verify → (Diagnose & Fix, added lazily on failure) steps as a
struck-through checklist, matching the Claude/Cursor pattern the request
named. `buildEditsCard()` gained a `setChecklistStep(label, status)`
helper wired into the Apply, Verify, Diagnose, and browser-validate
handlers.

**Resizable 3-pane workspace.** Drag handles between tree/center and
center/assistant panes; widths persist per the same `localStorage`
convention the app already uses for Recent Projects
(`mobiusx.workspacePaneWidths`).

**Token usage alerts.** `TokenUsage` threaded through the protocol
(`packages/protocol/src/cloud.ts`) and captured from each runner's real
provider response — never estimated:
- OpenAI-compatible (OpenRouter/Groq): `stream_options.include_usage`
  on the request, read from the final SSE usage chunk.
- Anthropic: `input_tokens` from `message_start`, cumulative
  `output_tokens` from `message_delta`.
- Ollama: `prompt_eval_count`/`eval_count` from the final NDJSON
  `done:true` line — reported without `contextWindow`, deliberately,
  since a local model's window varies by the user's own
  Modelfile/quantization and can't be guessed.

`contextWindowFor()` (new, `apps/cloud-agent-gateway/src/runners/contextWindows.ts`)
is a best-effort substring-matched lookup table (~25 known model
families). An unmatched model returns `undefined`, and the renderer's
`showUsageAlertIfNeeded()` silently no-ops rather than computing a
percentage against a guessed limit — same "honest absence over a wrong
number" discipline as Phase 23's env-var scanner.

**Optional pre-flight clarification (Build mode).** The model can now
reply with 2-4 clarifying questions and no edits, instead of guessing on
an ambiguous request. The hard part was not breaking the existing
automatic retry, which exists for a different failure: a model that
never attempts the `EDITS_MARKER` format at all. `parseBuildResponse`
now returns `hadMarker: boolean` so the two cases are distinguishable —
`hadMarker: false` (format never attempted) still retries automatically;
`hadMarker: true` with zero edits (a deliberate `{"edits": []}`) shows a
new "(Waiting on your answer above...)" note instead of retrying or
showing the old "this happens on some free models" apology, which no
longer fires for this case.

**Debuggable-code prompt rule.** A standing instruction ("always
generate code human engineers can debug") added to the fix/database/
testing/devops/auth/build prompt modes in `promptShared.ts`.

**Sticky AI Assistant tabs.** `.assistant-panel--full` now has a bounded
`height: 100%; overflow: hidden`, so the feed scrolls inside the panel
instead of the whole page carrying the mode tabs off-screen.

## Live evidence

All five UI-facing changes were exercised against the real running app
(not just unit tests), using both the background accessibility bridge
and genuine full-screen OS control:

- **Checklist** — ran a real Build task (GreenThumbGarden project,
  ambiguous "Add a notifications feature to this app" prompt, GPT-OSS 20B
  via Groq). Watched "Apply changes" go from pending to struck-through
  with a checkmark on click, "Run verification" turn into a red ✗ when
  the real `pytest` run genuinely failed (confirmed against the Backend
  Agent's own stated concern about the test fixture), and a new
  "Diagnose & Fix" step appear once verification failed —
  `recomputeFailingSteps()`'s lazy-add path.
- **Resizable panes** — dragged the tree/center handle via the
  accessibility bridge; screenshot confirmed the panel visibly widened.
- **Token alerts** — real conversations in this session never crossed a
  threshold (GPT-OSS 20B's 128K window is large), so the three banner
  variants were verified directly: opened DevTools, confirmed
  `showUsageAlertIfNeeded` is intentionally panel-scoped (not on
  `window`, so unreachable by name from the console — correct
  encapsulation, not a bug), then appended real `.usage-alert-{50,75,90}`
  elements to the actual `.assistant-feed` node with the shipped class
  names. Screenshot confirmed all three render with distinct
  color-coded severity (neutral/amber/red).
- **Pre-flight clarification** — tried twice. First attempt used the
  free `inclusionai/ling-3.0-flash-vl` OpenRouter model, which produced
  visibly rambling, unterminated chain-of-thought text and never
  resolved (a pre-existing model-reliability issue with that specific
  free model, unrelated to this feature — confirmed stuck via three
  screenshots taken 8s/15s/30s apart with byte-for-byte identical
  content, both through the background bridge and genuine full-screen
  control). Switched to GPT-OSS 20B via Groq and resubmitted: that model
  judged the request answerable and proposed files directly rather than
  asking questions — a legitimate model-judgment outcome for an
  "optional" pre-flight, not a failure of the feature. What *did* get
  exercised end-to-end on that response: one proposed edit was dropped
  because the model tried to modify a file it wasn't shown in full, and
  the UI correctly reported it via the new `hadMarker`-aware messaging
  ("1 proposed edit(s) omitted...") instead of silently retrying.
- **Sticky tabs** — scrolled the feed after the notifications-feature
  conversation had enough content to scroll; screenshot confirmed the
  mode tabs and model dropdown stayed fixed while the feed content moved
  underneath.
- **acceptsFirstMouse** — re-verified above, against the current
  restarted build (the original reproduction predated this fix).

Full test suite: 53/53 gateway tests passing (`npm test --workspace=apps/cloud-agent-gateway`),
`node --check` clean on both touched desktop files.

## Scope not built

- The pre-flight clarification path is model-judgment-driven by design
  (per the user's own choice of "optional" over a hard gate) — it will
  not trigger on every ambiguous request, only when the model itself
  decides to ask rather than guess. This is expected, not a gap.
- Token alerts only fire for providers/models this session's lookup
  table recognizes; a genuinely unknown or newly released model id shows
  no alert at all rather than a wrong one, matching the existing
  "evidence, not invention" discipline used elsewhere in this codebase
  (e.g. Phase 23's env-var scanner).
