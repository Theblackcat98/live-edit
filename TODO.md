# TODOs

LiquidScribe is functional end to end on the three-model trinity: LFM3-Audio-2B
(interface — chat/ASR/TTS, :8086), d1-Omni-2B (decision — route/critic, :8085)
and LFM3-1.7B (tool-call worker, :8080). Turns are text-only; no video or
frames are resolved or attached. (LFM3-Omni-2B :8083 is the legacy front door;
LFM3-VL-2B :8081 was removed from the runtime on 2026-11-08.)

**Design correction (2026-11-09, interface renamed 2026-11-10, d1 router added 2026-11-11):**
[`docs/design.md`](docs/design.md) is the authoritative spec — **Audio-first**:
Audio (LFM3-Audio-2B) converses, d1-Omni routes edit turns to the worker and
safety-checks the finished call, the 1.7B worker authors edits from the routed
typed directive, and d1 rejections become user-adjudicated pending edits. The
roles in the paragraph above describe the *shipped* supervisor-first pipeline,
not the target design; the Audio-first turn loop has landed as the default
`audio` run mode, and design.md §13 is its acceptance criteria.

Landed: streaming chat with multi-turn memory and barge-in, d1 typed grounding
(structural span extraction, 2026-11-08), persistent workspace, rejected-trace
JSONL export, "New note", §10 MVP hardening (b1693ab), the phone-width command
surface (≤780px Session/Note/Runtime tabs + persistent composer), the
floor-adaptive VAD gate (2026-11-08), the Omni-first pipeline (default `audio`
run mode), user-selectable run modes (`audio` / `omni` legacy / `worker-d1` /
`lowram`, 2026-11-09), the persistent hands-free mic toggle with barge-in, the
video/frame drop (text-only turns, audio-only panel, 2026-11-10), and the d1
turn router that routes `audio` turns to the worker (2026-11-11).
`npm run typecheck`, `npm run build` and `npm test` pass. The QA battery is
**RED** — see the first item under Next implementation work; plan.md §9.6 is
the authoritative build status for the pre-run-mode pipeline, and the §7 phase
list is the original roadmap.

## Verification (needs a human — real hardware ears/voice)

Both passes were automated as far as this workstation allows
(`scripts/hardware-voice-check.mjs`; measurements and WAVs under
`/tmp/lscribe-voice/`). The product side is fixed and verified: the old fixed
speech gate (RMS 0.045) sat above real-mic processed speech (measured
0.0136–0.0384), so auto-stop only fired via the 20 s cap and the long mostly
silent blob wrecked ASR. The gate is now floor-adaptive
(`max(0.004, 2.2 × noise floor)` with onset/warmup guards, 1.2 s trailing
silence stop) and quiet captures get a peak-safe ASR gain lift; Omni
transcribes the natural model voice correctly ("Update the Q3 revenue row
status to final."). The stop button cuts playback in ~27 ms and the speaker
toggle mutes TTS (0 `/tts` requests).

What no agent could close on this host: every speaker→mic path attenuates
>60 dB (a full-scale 1 kHz tone at 150% volume lands +1.5 dB over the mic
noise floor; the HDMI audio connector reports disconnected; the ZhuHai USB
sink drives no audible transducer), so the over-the-air loop cannot be
machine-verified here.

Tracked as GitHub Issues #7 (real-mic pass) and #8 (real-speaker pass).

## Next implementation work

- [ ] **Fix the red QA battery** (blocks the design.md §13 acceptance target).
      Two concrete causes:
      (1) **Audio-first decision quality** — Audio sometimes delegates chat
      turns, answers mutation turns conversationally, or emits directives the
      harness rejects, so cases fail or burn their turn in repair/clarify
      loops.
      (2) **Schema/validator misalignment** — `DELEGATE_EDIT_TOOL` does not
      mark `target.description` as required, while `validateDirective`
      hard-rejects a target without a non-empty description. Valid-looking Audio
      output therefore lands in repair/clarify loops. **Fixed 2026-11-09** on
      `fix/no-silent-failures-delete-supervisor`: the schema now requires
      `target.description`; the battery re-run on the workstation is the
      remaining verification for this item.
      Also present: an occasional llama.cpp 500 on tools requests (the known
      "server-tool-parse" class). The 2026-11-10 audio-first run recorded
      **Total 43 | PASS 18 | FAIL 25 | KNOWN-BUG 0** (356.6 s); failing cases:
      6, 8, 8f, 10b, 11, 12, 12b, 12c, 12d, 16a, 17a, 18, 21, 23, 25, 26,
      27, 27b, 28, 29, 30, 31, 32, 33, 34. Last fully-green battery: 2026-11-08, 33/33,
      against the then-shipped supervisor-first pipeline — not current
      evidence. Acceptance: design.md §13 green on the current `audio` default.
      That 2026-11-10 run pre-dates the 2026-11-11 d1 turn router, which
      restructured the `audio` turn (Audio answers in plain chat with tools
      disabled; d1 routes edit turns to the worker) — its cause (1) describes
      the pre-router flow, so the battery needs a fresh run for current
      failures.
- [ ] **Close out the Audio-first refactor** (docs/design.md; the phased plan
      doc docs/architecture-refactor.md was removed 2026-11-09 and filed as
      GitHub issues). The Audio-first turn loop has landed and is
      the default `audio` run mode: typed delegation directives (native tool
      call + one repair retry on the legacy `omni` path), the worker packet
      (directive + last-3-edit
      context packet + full line-numbered note), d1 reduced to the §7 safety
      check, the pending-edit store + ✓ / ✗ adjudication UI, and the
      deterministic layer demoted to hard gates. On 2026-11-11 the `audio`
      turn gained the d1 route: Audio answers in plain chat (tools disabled),
      d1 routes edit turns to the worker, and the harness builds the directive
      from the route verdict; the §7 check itself grew to five typed questions
      (intent clarity, target support, execution confidence joined the original
      two). What remains is acceptance:
      the §13 battery is red (see the first item). The legacy supervisor-first
      path, `supervisor.ts`, and the `OMNI_FIRST` flag were deleted 2026-11-09
      (ahead of the green battery, at the user's call) together with the
      reliability fixes: the `delegate_edit` target schema now requires
      `description` (aligned with `validateDirective` — the misalignment was
      root cause (2) of the red battery below), repair-failure clarifies
      disclose the failure instead of reading as a plain question, and
      `lowram` edits are held as pending edits (no decision model → no
      silent execution).
- [ ] **LoRA/tool-call SFT pass on rejected traces** (plan.md §7 Phase 5,
      §9.6, §9.8 item 5). The rejected-trace JSONL export already produces the
      training data; run a lightweight LoRA fine-tune of LFM3-1.7B on a single
      GPU. Acceptance: the tuned worker keeps the QA battery green or better,
      with fewer malformed or rejected calls. *(Descoped 2026-11-08 at user
      request. The LFM3-1.7B HF weights are already local at
      `~/Documents/Models/lfm3/hf/LFM3-1.7B` if this is revisited.)*

## Ops notes

- Required servers: `scripts/start-models.sh` (idempotent) starts text :8080,
      omni :8083, d1-omni :8085 and audio :8086 (pid files in
      `~/Documents/Models/logs/lfm3/`); `scripts/stop-models.sh` stops them.
      Both are wrappers over `scripts/model-manager.mjs` (single source of
      truth: member specs, pid files, health waits; per-member
      `start|stop d1-omni` form). There is no :8081 server or probe any more.
- **Model manager daemon** (2026-11-10): `npm run models:manager` serves
      `GET /status`, `POST /start`, `POST /stop` on `127.0.0.1:8199`
      (CORS-open, loopback-only, models outlive the daemon). When it runs, a
      mode switch with missing/loaded-spare models asks first
      (`ModelSwitchDialog`): starts the roster the mode needs, stops spares
      only opt-in, polls health (90 s; d1 Q8_0 slowest), then applies the
      mode — a member that never answers still switches with an honest error
      toast. Daemon down → old behavior (switch now, degrade honestly).
- **Run modes** (2026-11-09): `audio` (default; Audio 2B :8086
      chat/ASR/TTS, 1.7B :8080 authors tool calls, d1-Omni :8085 safety check →
      pending edit on disapproval), `omni` (legacy Omni-first; Omni :8083
      chat/ASR/TTS, 1.7B :8080 authors tool calls, d1-Omni :8085 safety check),
      `worker-d1` (1.7B :8080 chats and authors XML tool calls;
      d1-Omni :8085 decides edit safety: approve → execute, disapprove/
      unavailable → pending edit; ASR/TTS ride :8085; Omni out of the loop),
      `lowram` (LFM3-1.7B only; hard gates + engine dry-run, then held as a
      pending edit for the user — no d1, and no silent execution without a
      decision model; mic disabled, browser TTS). Switch in the
      TopBar on desktop or the **Runtime truth card** on the phone surface
      (≤780px, where the TopBar control is hidden). Persisted under localStorage
      `liquidscribe.runmode.v1`; captured at turn start and busy-guarded.
- **Hands-free mic**: `micOn` is the persistent toggle, not one capture. ON
      listens continuously; each VAD-segmented utterance is transcribed over the
      mode's Omni-architecture endpoint and submitted, then capture re-arms
      (guards re-checked). OFF finishes and submits the in-flight capture and
      never restarts. `micActive` (not `micOn`) is the live recorder that drives
      the composer ring/waveform and `data-capturing`; `stopMic` (reset/unmount)
      is the only abandon-without-submit path. Voice onset fires
      `VoiceRecorder.onVoiceStart` once per capture and cuts TTS.
- `npm run qa` is the 43-assertion Audio-first CDP battery (turns are
      text-only: the visual-question case 5 and the slide-extract case 9 are
      gone with the video/frame drop). It needs the dev
      server on :5173 and the trinity up. Warm the dev server with a curl first;
      a cold Vite dependency optimization can lose the suite's first navigation
      race. See the red-battery item under Next implementation work for the
      current known failures.
- `scripts/hardware-voice-check.mjs` automates the two hardware passes over
      real mic/speakers (no fake media; `--skip-mic` / `--skip-speaker` split;
      artifacts in `/tmp/lscribe-voice/`).
- The 1.7B (:8080) and Audio (:8086) servers run
      `--reasoning on --reasoning-preserve`; Omni (:8083) and d1 (:8085) do not. The 1.7B worker gets a 6000-token
      budget and two attempts because it reasons at length inside `<think>`.
      The old VL `chat_template_kwargs: {"enable_thinking": false}` path was
      removed with VL-2B; revisit that knob only if a future worker cannot
      close `<think>`.
- The 1.7B worker decodes ~7–14 s per mutation —
      expected, not a hang. Two malformed attempts end the turn with an honest
      error and nothing written: the deterministic template emitter was deleted
      (2026-11-09), so no fallback authors content.
- The Vite dev server occasionally serves stale transforms after external or
      rapid file writes; `touch` the edited files or restart `npm run dev`.

## Known rough edges

- Chat context: the full note is sent only on note-related turns (§10 WS2);
      other turns get a title + H2 outline. Note-related turns still resend the
      full note, with prefix caching absorbing most of it.
- Speech fallbacks still depend on browser support when a model server is down.
- The Demo button still runs the scripted demo-document sequence (intentional
      affordance).
- Vite HMR can serve a stale module graph after removing exports across files —
      restart `npm run dev` when imports change.
- Voice on this workstation: the speaker→mic acoustic path is unusable
      (>60 dB attenuation — hardware, not app). The Brio 101 mic hears best of
      the three capture devices; the Realtek USB mic is ~11 dB deafer.
