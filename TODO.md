# TODOs

The app is functional end to end on the three-model trinity: LFM3-Omni-2B
(interface — chat/ASR/TTS, :8083), d1-Omni-2B (decision — route/critic,
:8085) and LFM3-1.7B (tool-call worker, :8080). LFM3-VL-2B (:8081) is optional:
visual ROI crops, and the worker fallback when the 1.7B is down. Streaming chat
replies with multi-turn memory and barge-in, d1 typed grounding, persistent
workspace, rejected-trace JSONL export, camera/screen frames into the bridge,
"New note" affordance. Milestone landed as commit b1c76ec; the 1.7B-default
worker swap in 345a042; the §10 MVP hardening (d1 tool choice honored,
thresholds unified, Omni chat contract + sanitizer, natural-phrasing document
creation) landed with a 31/31 green QA battery — see plan.md §10.

## Verification (needs a human — real hardware ears/voice)

- [ ] Real-mic pass: speak a command, confirm auto-stop on pause, Omni transcription
      quality with a real voice (espeak test heard "rose" for "row").
- [ ] Real-speaker pass: model TTS audibility, stop button mid-sentence, speaker toggle.

## Ops notes

- Required servers: `scripts/start-models.sh` (idempotent) starts text :8080, omni :8083
      and d1-omni :8085 (pid files in `~/Documents/Models/logs/lfm3/`); `scripts/stop-models.sh`
      stops them. VL :8081 stays optional — start it with `~/Documents/Models/lfm3.sh vl` when
      you need visual crops, or a fully green QA 1b (its runtime probe logs
      ERR_CONNECTION_REFUSED console noise while it is down).
- llama.cpp servers run `--reasoning on`; per-request
      `chat_template_kwargs: {"enable_thinking": false}` is what the VL tool-call turn
      uses — keep that if worker prompts change (measured: thinking-on never closed
      `<think>` at any budget).
- The Vite dev server occasionally serves stale transforms after external/rapid
      file writes; `touch` the edited files or restart `npm run dev`. A cold dev server
      (fresh dependency optimization) can also lose the QA suite's first navigation
      race — warm it with a curl before `npm run qa`.
- The 1.7B worker decodes ~7–14 s at a 3000-token budget per mutation (it reasons
      at length inside <think>) — expected, not a hang. Two malformed attempts fall
      back to the deterministic template emitter, so a run never fails on the worker.

## Known rough edges

- Span grounding is still local keyword/quote search plus hand-pinned special cases
  (e.g. the title→H1 pin in `findSpanForMutation`, supervisor.ts); d1's typed
  span extraction (plan Stage B) never replaced it. Every vague spoken phrasing
  risks becoming another special case — the structural fix is unfinished.
- Vite HMR can serve a stale module graph after removing exports across files — restart
  `npm run dev` when imports change (observed once with `SUGGESTIONS` removal).
- The Demo button still runs the scripted demo-document sequence (intentional affordance).
- Chat context: the full note is sent only on note-related turns (§10 WS2); other turns
  get a title + H2 outline.

## Backlog (optional, not started)

- LoRA/tool-call SFT pass on rejected traces (plan.md §9.6, §9.8 item 5) — the
  rejected-trace JSONL export already produces the training data.
- A real mobile command surface (plan.md §9.8 item 4).
