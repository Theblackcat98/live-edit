# LiquidScribe

> **Design: [`docs/design.md`](./docs/design.md) (2026-11-09) is the authoritative design spec.**
> It corrects the architecture this README originally described: the intended design is
> **Omni-first** — Omni converses and silently delegates, the 1.7B worker authors edits, and
> d1-Omni is a safety check whose rejections go to the user as pending edits (✓ / ✗). The code on
> `main` still implements the earlier supervisor-first pipeline; where the sections below describe
> shipped behaviour that conflicts with design.md, design.md wins and its §12 is the delta.

A local-first multimodal note workspace built around the LFM3 model trinity — **Omni 2B** as the
only model the user talks to (conversation, ASR/TTS, and silent delegation), **LFM3-1.7B** as the
worker that authors edits and tool calls from Omni's typed directives, and **d1-Omni-2B** as a
zero-output-token safety check on proposed tool calls.

Talk, show a slide, and watch the note change. In the target design every turn goes to Omni first;
a delegated edit is authored by the worker as an XML tool call, checked by d1, and then applied
atomically to a snapshot stack — or, when d1 disapproves, shown to the user as a pending edit to
accept or discard.

```
npm install
npm run dev      # http://localhost:5173
npm run build
npm run typecheck
```

## What is in the build

- **Visual context panel** — synthetic operating-review slide by default, with opt-in device camera
  or screen share preview. d1 ROI overlays and crop previews apply to the synthetic frame; live capture
  is labelled preview-only. Includes a live waveform, VAD state, and 2 fps metadata.
- **Live session** — transcript, voice capture (where the browser supports SpeechRecognition),
  spoken replies (opt-in), a four-command guided demo, and inline worker delegation cards linked to
  the decision trace.
- **Note workspace** — line-numbered Markdown document, supervisor target-span highlights, animated
  diffs, document/source views, a real source editor with commit/discard, and a snapshot history.
- **Supervisor rail** — the model roster, live routing / grounding / critic state, context budgets for
  all three views, and clickable snapshots.
- **Decision trace** — routing probabilities, pruned tool set, grounded span, ROI crop, worker
  `<think>` + raw XML, critic check matrix, execution diff, and a timing bar.
- **Execution engine** — real `add_text`, `edit_text`, `remove_text` and `extract_visual_to_note`
  tools with anchor checks, blast-radius checks, XML round-tripping and undo/redo.
- **Inputs** — synthetic slide, real camera/screen, typed commands, voice, or the guided demo.

## Runtime honesty

> **Current build vs. design.** The bullets below describe the supervisor-first pipeline the code
> on `main` runs today: d1 routes and grounds, a deterministic layer pre-authors edit content, and
> the worker transcribes it into XML. That is the divergence [`docs/design.md`](./docs/design.md)
> corrects — in the target design Omni is the front door, the worker authors and grounds its own
> calls, d1 only checks finished proposals (with the directive, context and frame in its packet),
> and a d1 rejection becomes a user-adjudicated pending edit instead of a dead end.

The app talks to **real local LFM3 servers** (llama.cpp, started by this repo's
`scripts/start-models.sh`; `scripts/stop-models.sh` stops them):

- **Voice ASR** — the mic is captured locally as 16 kHz WAV and transcribed by
  `LFM3-Omni-2B` (`/v1/audio/transcriptions` on :8083). The browser's
  SpeechRecognition is not used.
- **Chat replies** — conversational turns go to `LFM3-Omni-2B`
  (`/v1/chat/completions`), with the rasterized review slide attached so the
  model answers from actual pixels.
- **Routing** — `d1-Omni-2B` classifies every command (action + tool) over
  `/v1/systemone` in one zero-output-token forward pass, watching the slide.
- **Worker** — `LFM3-1.7B` decodes every text-mutation XML tool call live; the
  parser round-trips its output. `extract_visual_to_note` is deterministic —
  no vision worker needed (VL-2B was removed from the runtime).
- **Critic** — deterministic local gates (anchor exactness, blast radius, range
  bounds) are hard checks; when they pass, `d1-Omni-2B` adds a semantic
  zero-token verdict.
- **Grounding** — vague spoken references are grounded by a typed `d1-Omni` span
  question (`/v1/systemone`) over structural candidates (sections, paragraphs,
  bullets, table rows); literal quotes, line numbers and ordinals pre-empt the
  model call, and the deterministic keyword/quote search is only the fallback
  when d1 is down. **Execution** is the real in-tab diff engine with anchor
  checks and undo/redo.

The **Runtime truth** card in the supervisor rail continuously probes the three
endpoints (10 s cadence, refresh button) and labels each surface LIVE,
FALLBACK or ENGINE. The decision trace records which path each stage took per
run. If a model server is down, the affected stage falls back to a local
deterministic layer and the UI says so — nothing silently fakes a model call.
Stage timings are measured, and context budgets show real prompt-token usage
when models answer. Live camera and screen frames reach the bridge through
`resolveSceneFrame` — d1 routing, Omni chat and visual extraction all see them;
the rasterized synthetic slide is the fallback when no capture is active.

## Try these

| Say / type | What happens |
| --- | --- |
| `Update the Q3 revenue row to $1.45M Final` | d1 grounds line 17, the worker emits `edit_text`, the critic verifies, the table row changes. |
| `Remove the bullet about Redis` | Destructive safety check, then one exact line removed. |
| `Pull the LTV/CAC formula from the slide into Revenue` | ROI crop → LaTeX block inserted under section 2. |
| `What can you see?` | Omni answers from the demo review frame; no mutation. |
| `Delete that part` | Ambiguity gate: d1 asks which span, with quick reply chips. |
| `Undo that` | Snapshot rollback bypasses the worker entirely. |
| `Add a note about the support backlog` | Pinned insertion at the document tail. |
| `Change the deadline in the second paragraph to Friday` | The critic holds an over-broad replacement; nothing is written. |

Use the **Demo** button in the Live session header to run a four-command guided sequence.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘ / Ctrl K` | Focus the command bar |
| `Enter` | Send a command |
| `⌘ / Ctrl Z` | Restore previous snapshot |
| `⌘ / Ctrl ⇧ Z` | Reapply next snapshot |
| `⌘ / Ctrl Enter` | Apply a Markdown source draft |
| `Esc` | Close the trace drawer or help dialog |

## Architecture

```
src/
  components/   visual stage, session, note workspace, supervisor rail, trace drawer
  data/         seed note, synthetic scene, model roster, tool catalog
  lib/          supervisor heuristics (legacy layer — see docs/design.md §12), worker XML, tool engine, markdown parser, speech
  state/        orchestrator hook, history stack, context accounting
  styles/       design tokens + application styles
```

The document execution engine never regenerates the whole file. Each tool call is checked against the
grounded span and the exact anchor before the line range is spliced. A failed anchor or a critic
rejection leaves the note untouched. Snapshots are kept in memory for undo/redo; source edits create
their own snapshots.

## Limits

- The Omni-first design in [`docs/design.md`](./docs/design.md) is **not implemented yet**: the
  shipped pipeline is supervisor-first (d1/heuristic routing before Omni, deterministic content
  authoring, dead-end critic rejections). Known symptom: on a non-empty note, "write a README
  template document to begin" inserts that literal phrase instead of drafting a README, because
  the deterministic layer copies the words after the verb as the content. design.md §12 scopes
  the refactor; §13 is its acceptance criteria.
- The repo starts the trinity with `scripts/start-models.sh` (idempotent: Omni `:8083`,
  d1-Omni `:8085`, `LFM3-1.7B` `:8080`; `scripts/stop-models.sh` stops them). Without them the
  affected stages run their local deterministic fallbacks and the rail's Runtime truth card shows
  what is down.
- Camera/screen capture requires browser permissions and a secure context (localhost works).
  Live camera and screen frames feed the models (`resolveSceneFrame`); the rasterized
  synthetic review frame is used only when no capture is active.
- Voice capture records locally and is transcribed by the local Omni model; typing always works.
  Spoken replies use the browser's `speechSynthesis` (presentation only, no inference).
- Notes live in this browser tab and the app does not upload them. The workspace persists across
  reloads (localStorage).
- The synthetic visual scene is a fixed prop: revenue table, north-star formula, quarterly bars and a
  finance sticky note.
- The runtime rail shows the active worker (`LFM3-1.7B`) and each endpoint's live/fallback state.
- Below 820px the layout collapses to the note workspace; at ≤780px a phone
  surface takes over — Session / Note / Runtime tabs, a persistent bottom command
  bar (mic + input + send), 44px touch targets, and an auto-switch to the note
  tab when an edit lands.

## Verification

`npm run typecheck` and `npm run build` pass. On 2026-11-08 the live bridge was exercised in
headless Chrome (CDP-driven) against the running trinity servers:

- Conversational turn answered by Omni-2B from the rasterized slide (correct table values,
  formula, sticky note) — the canned-template reply did not appear.
- "Update the Q3 revenue row to $1.45M Final": d1 routed live (`file mutation` P 0.60),
  grounding repair re-picked `edit_text` after d1's `add_text` pick failed to ground, VL-2B
  decoded the XML, d1 critic verified, the row changed, and Ctrl+Z restored it.
- Voice: a WAV fed through Chrome's fake microphone was captured (16 kHz), auto-stopped on
  silence, transcribed by Omni (`/v1/audio/transcriptions`) and drove the same pipeline to a
  committed edit, recorded as `VOICE · 0:20` in the transcript.
- Runtime truth card probed 3/3 endpoints LIVE; a fresh page load recorded zero console
  errors. Killing a server flips the card to FALLBACK and the affected stage uses its local
  deterministic path.

On 2026-11-08 the QA battery (`npm run qa`, 33 cases after §10 hardening + the typed
span-grounding cases) ran fully green — 33/33 PASS, zero console errors, zero page
exceptions — over the three-server trinity (Omni :8083, d1-Omni :8085, LFM3-1.7B :8080).
It covers natural-phrasing template creation ("The document is empty now, begin by
writing a readme template .md doc"), chat-hygiene (no `<tool_call>`/`<function=` leakage
in replies), blast-radius rejection, undo/redo, persistence, spoken-style phrasing, and
vague-reference span grounding over live d1 (`remove that section about API keys` → the
Security section, `d1-span` provenance).

See [`plan.md`](./plan.md) for the build history and [`docs/design.md`](./docs/design.md) for the
corrected, authoritative design. The QA cases above verify the shipped supervisor-first
behaviour; design.md §13 defines the acceptance cases for the Omni-first refactor (including the
README-template case on a non-empty note, which the current battery does not cover).

The workspace is optimised for a desktop viewport around 1280–1600px wide. Narrower viewports collapse
the supervisor rail first, then the visual/session column; at ≤780px the phone tab layout keeps voice
capture and note edits one thumb away.
