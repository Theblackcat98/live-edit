# TODOs

LiquidScribe is functional end to end on the three-model trinity: LFM3-Omni-2B
(interface — chat/ASR/TTS, :8083), d1-Omni-2B (decision — route/critic, :8085)
and LFM3-1.7B (tool-call worker, :8080). `extract_visual_to_note` is
deterministic. LFM3-VL-2B (:8081) was removed from the runtime on 2026-11-08.

**Design correction (2026-11-09):** [`docs/design.md`](docs/design.md) is now
the authoritative spec — **Omni-first**: Omni converses and silently delegates
with a typed directive, the 1.7B worker authors edits, d1-Omni is a safety
check only, and d1 rejections become user-adjudicated pending edits. The roles
in the paragraph above describe the *shipped* supervisor-first pipeline, not
the target design; the refactor is the top item under Next implementation
work, and design.md §12/§13 are its scope and acceptance criteria.

Landed: streaming chat with multi-turn memory and barge-in, d1 typed grounding
(structural span extraction, 2026-11-08), persistent workspace, rejected-trace
JSONL export, camera/screen frames into the bridge, "New note", §10 MVP
hardening (b1693ab), the phone-width command surface (≤780px Session/Note/
Runtime tabs + persistent composer), and the floor-adaptive VAD gate
(2026-11-08). The QA battery is now 33 cases and green with zero console
errors; `npm run typecheck` and `npm run build` pass. plan.md §9.6 is the
authoritative build status; the §7 phase list is the original roadmap.

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

- [ ] Real-mic pass (human voice; speakers not required): speak a command at
      the default mic (the Brio 101 webcam mic measures best; the Realtek USB
      mic is ~11 dB deafer), confirm auto-stop ~1.2 s after you stop talking,
      and check the transcript quality.
- [ ] Real-speaker pass (human ears): with the speaker toggle on, confirm the
      TTS reply is audible (the sink demonstrably receives the stream at
      −16 dBFS RMS — if the room stays silent, check the ZhuHai USB amp/
      wiring or switch the default sink), then stop mid-reply and toggle off.

## Next implementation work

- [ ] **Omni-first refactor** (docs/design.md). Replace the supervisor-first
      pipeline with the corrected design: Omni-first turn loop, typed
      delegation directives, worker packet (directive + last-3-edit-turns
      context packet + full line-numbered note), d1 reduced to the §7 safety
      check (directive + command + call/diff + frame packet), pending-edit
      store + ✓ / ✗ adjudication UI, deterministic layer demoted to hard
      gates only (no content authoring, no routing). First step is design.md
      Q1: verify Omni directive emission (native tool call vs. structured
      block) on the local llama.cpp build. Acceptance: design.md §13 battery,
      incl. the README-template case on a non-empty note.
- [ ] **LoRA/tool-call SFT pass on rejected traces** (plan.md §7 Phase 5,
      §9.6, §9.8 item 5). The rejected-trace JSONL export already produces the
      training data; run a lightweight LoRA fine-tune of LFM3-1.7B on a single
      GPU. Acceptance: the tuned worker keeps the QA battery green or better,
      with fewer malformed or rejected calls. *(Descoped 2026-11-08 at user
      request. The LFM3-1.7B HF weights are already local at
      `~/Documents/Models/lfm3/hf/LFM3-1.7B` if this is revisited.)*

## Ops notes

- Required servers: `scripts/start-models.sh` (idempotent) starts text :8080,
      omni :8083 and d1-omni :8085 (pid files in
      `~/Documents/Models/logs/lfm3/`); `scripts/stop-models.sh` stops them.
      There is no :8081 server or probe any more.
- `npm run qa` is the 33-case CDP battery. It needs the dev server on :5173 and
      the trinity up. Warm the dev server with a curl first; a cold Vite
      dependency optimization can lose the suite's first navigation race.
- `scripts/hardware-voice-check.mjs` automates the two hardware passes over
      real mic/speakers (no fake media; `--skip-mic` / `--skip-speaker` split;
      artifacts in `/tmp/lscribe-voice/`).
- llama.cpp servers run `--reasoning on`. The 1.7B worker gets a 3000-token
      budget and two attempts because it reasons at length inside `<think>`.
      The old VL `chat_template_kwargs: {"enable_thinking": false}` path was
      removed with VL-2B; revisit that knob only if a future worker cannot
      close `<think>`.
- The 1.7B worker decodes ~7–14 s per mutation at a 3000-token budget —
      expected, not a hang. Two malformed attempts fall back to the
      deterministic template emitter, so a run never fails on worker
      availability.
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
