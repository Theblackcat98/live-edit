# LiquidScribe

> **Design: [`docs/design.md`](./docs/design.md) (2026-11-09, Audio-first per the 2026-11-10 decision) is the authoritative design spec.**
> It corrects the architecture this README originally described: the intended design is
> **Audio-first** — Audio converses and silently delegates, the 1.7B worker authors edits, and
> d1-Omni is a safety check whose rejections go to the user as pending edits (✓ / ✗). That
> Audio-first turn loop is implemented and is the default run mode; the earlier supervisor-first
> pipeline and its `OMNI_FIRST` flag were deleted (2026-11-09) — there is no legacy path.
> design.md §13 is still the acceptance target — its QA battery is not yet green (see Verification).

A local-first note workspace built around the local model trinity — **LFM3-Audio-2B** as the
only model the user talks to (conversation, ASR/TTS, and silent delegation), **LFM3-1.7B** as the
worker that authors edits and tool calls from Audio's typed directives, and **d1-Omni-2B** as a
zero-output-token safety check on proposed tool calls. (LFM3-Omni-2B :8083 is the legacy front
door.) All turns are text-only; no video or frames are resolved or attached.

Talk and watch the note change. In the default run mode every turn goes to Audio first;
a delegated edit is authored by the worker as an XML tool call, checked by d1, and then applied
atomically to a snapshot stack — or, when d1 disapproves, shown to the user as a pending edit to
accept or discard. The other run modes swap the chat model or drop the safety check; see
[Run modes](#run-modes).

```
npm install
npm run dev      # http://localhost:5173
npm run build
npm run typecheck
```

## What is in the build

- **Audio context panel** — live waveform, VAD state, and capture status. No camera, screen,
  or synthetic frames anywhere in the build.
- **Live session** — transcript; a persistent hands-free voice toggle (ON listens continuously:
  each VAD-segmented utterance is transcribed over the run mode's audio server and
  submitted, then capture re-arms; OFF finishes and submits the in-flight capture and never
  restarts; the ring and waveform track the live recorder, not the toggle); spoken replies (opt-in)
  cut on voice onset (barge-in); a two-command guided demo; and inline worker delegation cards
  linked to the decision trace.
- **Note workspace** — line-numbered Markdown document, target-span highlights, animated
  diffs, document/source views, a real source editor with commit/discard, and a snapshot history.
- **Runtime rail** — the model roster, live chat / worker / safety-check state, context budgets
  for all three views, clickable snapshots, and the run-mode switch.
- **Decision trace** — the run mode, Audio's typed directive, the worker's thinking + raw XML,
  the d1 check matrix, execution diff, and a timing bar.
- **Execution engine** — real `add_text`, `edit_text` and `remove_text`
  tools with anchor checks, blast-radius checks, XML round-tripping and undo/redo.
- **Inputs** — typed commands, voice, or the guided demo.

## Runtime honesty

> **Run modes change the roster.** The bullets below describe the default `audio` mode — the
> Audio-first turn loop from [`docs/design.md`](./docs/design.md): Audio is the front door and
> silently delegates, the worker authors and grounds its own call from a typed directive, and
> d1-Omni only checks the finished proposal (a disapproval or an unavailable check becomes a
> pending edit). In `worker-d1` the 1.7B also answers chat; in `lowram` d1 and the audio servers are
> absent entirely. See [Run modes](#run-modes) for the per-mode endpoints.

The app talks to **real local LFM3 servers** (llama.cpp, started by this repo's
`scripts/start-models.sh`; `scripts/stop-models.sh` stops them):

- **Voice ASR** — the mic is captured locally as 16 kHz WAV and transcribed by
  the mode's audio server (`/v1/audio/transcriptions`):
  `LFM3-Audio-2B` on :8086 in `audio` (default), `LFM3-Omni-2B` on :8083 in legacy
  `omni`, `d1-Omni-2B` on :8085 in `worker-d1`.
  `lowram` runs no audio server, so the mic is honestly disabled.
  The browser's SpeechRecognition is not used.
- **Chat replies** — in `audio`, conversational turns go to `LFM3-Audio-2B`
  (`/v1/chat/completions`), text-only. `omni` (legacy) chats with `LFM3-Omni-2B`;
  `worker-d1` and `lowram` chat with `LFM3-1.7B` instead (XML tool-call protocol,
  streamed, ` thinking` stripped, one invalid-format retry); their replies are
  labelled with that author.
- **Safety check** — `d1-Omni-2B` answers one zero-output-token approval
  question over `/v1/systemone` for each finished tool call (directive, context
  packet, call/diff — text only). It does not route or author
  content.
- **Worker** — `LFM3-1.7B` authors every text-mutation XML tool call live from
  Audio's typed directive and the context packet; the parser round-trips its
  output.
- **Hard gates** — deterministic local gates (anchor exactness, blast radius,
  range bounds) are non-overridable; a refusal cannot be adjudicated. When they
  pass, d1 adds a semantic zero-token verdict (skipped in `lowram`, where the
  gates plus the engine dry-run are the whole decision).
- **Grounding** — the worker grounds its own call from the directive and the
  line-numbered note; a wrong or missing anchor is caught by the hard gates
  before execution. **Execution** is the real in-tab diff engine with anchor
  checks and undo/redo; d1's rejection is a pending edit, never a dead end.

The **Runtime truth** card in the supervisor rail continuously probes the three
endpoints (10 s cadence, refresh button) and labels each surface LIVE,
FALLBACK or ENGINE. It also shows the active run mode and carries the same
three-state mode switch as the TopBar — on the phone surface (≤780px) it is the
only switch. The decision trace records which path each stage took per run. If a
model server is down, the affected stage falls back to a local deterministic
layer and the UI says so — nothing silently fakes a model call. Stage timings
are measured, and context budgets show real prompt-token usage when models
answer. All turns are text-only; no camera, screen, or synthetic frames are
resolved or attached.

## Try these

| Say / type | What happens |
| --- | --- |
| `Update the Q3 revenue row to $1.45M Final` | Omni delegates; the worker authors `edit_text`; d1 approves; the table row changes. |
| `Remove the bullet about Redis` | Destructive safety check, then one exact line removed. |
| `Delete that part` | Ambiguity gate: Omni asks which span, with quick reply chips. |
| `Undo that` | Snapshot rollback bypasses the worker entirely. |
| `Add a note about the support backlog` | Pinned insertion at the document tail. |
| `Change the deadline in the second paragraph to Friday` | The safety check holds an over-broad replacement; nothing is written. |

Use the **Demo** button in the Live session header to run a two-command guided sequence.

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
  lib/          run modes, Omni/worker turns, tool engine, markdown parser, speech,
                hard gates, d1 check, pending-edit store
  state/        orchestrator hook, history stack, context accounting
  styles/       design tokens + application styles
```

The document execution engine never regenerates the whole file. Each tool call is checked against the
targeted span and the exact anchor before the line range is spliced. A failed anchor or a hard-gate
refusal leaves the note untouched; a d1 disapproval holds the call as a pending edit instead of
dropping it. Snapshots are kept in memory for undo/redo; source edits create their own snapshots.

## Run modes

The run mode chooses which local model(s) serve a turn. Switch it with the TopBar
segmented control on desktop, or in the Runtime truth card on the phone surface
(≤780px), where the TopBar control is hidden. The choice persists in
localStorage under `liquidscribe.runmode.v1`; an absent, corrupt or unknown
value loads as `audio`. The mode is captured once at turn start, so a switch
mid-turn cannot swap models under an in-flight turn; switching while a turn is
busy is refused with a toast, and each accepted switch writes a transcript
notice naming the mode and its endpoints.

| Mode | Chat | Tool calls | Safety / speech |
| --- | --- | --- | --- |
| `audio` (default) | `LFM3-Audio-2B` :8086 | `LFM3-1.7B` :8080 authors from Audio's typed directive | `d1-Omni-2B` :8085 checks; disapproval or unavailability → pending edit. ASR/TTS :8086. |
| `omni` (legacy) | `LFM3-Omni-2B` :8083 | `LFM3-1.7B` :8080 authors from Omni's typed directive | `d1-Omni-2B` :8085 checks; disapproval or unavailability → pending edit. ASR/TTS :8083. |
| `worker-d1` | `LFM3-1.7B` :8080 | the same 1.7B authors (XML protocol) | d1-Omni decides edit safety: approve → execute; disapprove or unavailable → pending edit. ASR/TTS ride :8085. |
| `lowram` | `LFM3-1.7B` :8080 only | the 1.7B; deterministic hard gates + engine dry-run, then held as a pending edit | no d1 — with no decision model running, no edit executes silently, so the user approves each one. Mic disabled ("Voice needs an audio server"); TTS uses the browser voice. |

- In `worker-d1` the 1.7B streams its reply, ` thinking` is stripped from the
  visible bubble, and one invalid-format tool call is retried; prose replies
  carry the `LFM3-1.7B` author label. Omni is out of the loop, but ASR/TTS use
  :8085 because d1-Omni is the same Omni architecture.
- `lowram` never contacts d1 or Audio: a tool call that passes the hard gates and
  the engine dry-run is held as a pending edit for the user's ✓ / ✗ — silent
  execution is the decision model's job, and this mode runs none. All modes are
  text-only.

## Limits

- The Omni-first design in [`docs/design.md`](./docs/design.md) is implemented as the default
  `omni` run mode, but its §13 acceptance battery is **not yet green** — the decision-quality and
  schema/validator failures recorded under Verification pre-date the run-mode work. §13 remains
  the acceptance target.
- The repo starts the trinity with `scripts/start-models.sh` (idempotent: Audio `:8086`,
  d1-Omni `:8085`, `LFM3-1.7B` `:8080`; `scripts/stop-models.sh` stops them). Without them the
  affected stages run their local deterministic fallbacks and the rail's Runtime truth card shows
  what is down.
- All turns are text-only. No camera, screen frames, or synthetic slides exist in the build;
  the Audio context panel shows capture status and the waveform only.
- Voice capture records locally and is transcribed by the run mode's audio server
  (:8086 in `audio`, :8083 in legacy `omni`, :8085 in `worker-d1`; disabled in `lowram`); typing always works.
  The mic is a persistent hands-free toggle: each silence-segmented utterance is transcribed and
  submitted, then listening resumes automatically until you tap the mic off (a mode with no
  speech server, an offline endpoint or a failed start stops it with an honest toast). Turning it
  off finishes and submits the in-flight capture and never restarts. Responding voice cuts a spoken
  reply (barge-in). Spoken replies use the browser's `speechSynthesis` when no model TTS endpoint
  is live, and always in `lowram` (presentation only, no inference).
- Notes live in this browser tab and the app does not upload them. The workspace persists across
  reloads (localStorage).
- The runtime rail shows the active worker (`LFM3-1.7B`) and each endpoint's live/fallback state.
- Below 820px the layout collapses to the note workspace; at ≤780px a phone
  surface takes over — Session / Note / Runtime tabs, a persistent bottom command
  bar (mic + input + send), 44px touch targets, and an auto-switch to the note
  tab when an edit lands.

## Verification

`npm run typecheck`, `npm run build` and `npm test` pass. On 2026-11-08 the live
bridge was exercised in headless Chrome (CDP-driven) against the running trinity servers:

- Conversational turn answered by Omni-2B (no canned-template reply).
- "Update the Q3 revenue row to $1.45M Final": d1 routed live, the 1.7B
  decoded the XML, d1 critic verified, the row changed, and Ctrl+Z restored it.
- Voice: a WAV fed through Chrome's fake microphone was captured (16 kHz), auto-stopped on
  silence, transcribed by Omni (`/v1/audio/transcriptions`) and drove the same pipeline to a
  committed edit, recorded as `VOICE · 0:20` in the transcript.
- Runtime truth card probed 3/3 endpoints LIVE; a fresh page load recorded zero console
  errors. Killing a server flips the card to FALLBACK and the affected stage uses its local
  deterministic path.

On 2026-11-08 the QA battery (`npm run qa`) last ran fully green — 33/33 PASS, zero console
errors, zero page exceptions — over the three-server trinity. That run was against the
then-shipped supervisor-first pipeline, before the Omni-first refactor; it is **not** current
evidence for `main`. It covered natural-phrasing template creation, chat hygiene (no
`<tool_call>`/`<function=` leakage), blast-radius rejection, undo/redo, persistence, spoken-style
phrasing, and vague-reference span grounding over live d1.

See [`plan.md`](./plan.md) for the build history and [`docs/design.md`](./docs/design.md) for the
authoritative design. The battery now targets the Omni-first pipeline (45 assertions); design.md
§13 remains the acceptance target, including the README-template case on a non-empty note.

On 2026-11-09, after the run-mode/mic/video drop, `npm run typecheck`, `npm run build` and
`npm test` (18 files, 290 tests) passed, and one `npm run qa` run over the trinity recorded
**Total 45 | PASS 19 | FAIL 26 | KNOWN-BUG 0** (333.0 s, 2 console errors, 0 page exceptions;
both errors are the expected `ERR_CONNECTION_REFUSED` to :8085 during case 30's intentional
d1-down window). Failing cases: 2, 3, 5, 6, 7, 8, 8f, 9, 10b, 11, 12, 12b, 12d, 12e, 20, 21, 24,
25, 26, 27, 27b, 28, 29, 32, 33, 34.

**The battery is RED, and this pre-dates both workstreams.** A baseline run of unmodified `HEAD`
(`git archive` → scratch Vite) reproduced the same failure classes for the same commands. They
fall into two groups:

- **Omni-first decision quality** — Omni delegates chat/greeting turns (case 2 fails with "The
  worker could not produce a valid tool call for Omni's directive"), answers mutation turns
  conversationally (7, 8, 20, 21, 27, 27b settle `conversational`; 11/26 ask nothing when a
  clarification was required), and mis-grounds some removals (24).
- **Schema/validator misalignment plus a server 500** — `DELEGATE_EDIT_TOOL` does not mark
  `target.description` as required while `validateDirective` hard-rejects a target without a
  non-empty description, so valid-looking Omni output can land in repair/clarify loops; the known
  "server-tool-parse" llama.cpp 500 appears occasionally on tools requests.
- Pending-path cases 32/33/34 fail on their precondition because the preceding command settles
  `verified` instead of disapproval — itself a §8 violation — not because the pending card cannot
  hold state.

On 2026-11-09 the hands-free mic and run-mode switch were also exercised in headless
Chrome with fake media (CDP): 17/17 run-mode assertions, 12/12 mic-toggle assertions and 15/15
phone-surface assertions passed. A spoken WAV through Chrome's fake microphone produced two
VAD-segmented utterances, each transcribed by Audio and submitted as a `VOICE` turn, with capture
re-arming automatically while the toggle stayed on; tapping the mic off finished the in-flight
utterance and stopped the loop (12 s observed with no capture and no new turn); switching to low-RAM
mid-listen stopped capture with the "Voice needs an audio server" toast; zero console errors or
page exceptions.

design.md §13 remains the acceptance target; no green battery is claimed here.

The workspace is optimised for a desktop viewport around 1280–1600px wide. Narrower viewports collapse
the supervisor rail first, then the visual/session column; at ≤780px the phone tab layout keeps voice
capture and note edits one thumb away.
