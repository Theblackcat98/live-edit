# TODOs

LiquidScribe is functional end to end on the three-model trinity: LFM3-Omni-2B
(interface — chat/ASR/TTS, :8083), d1-Omni-2B (decision — route/critic, :8085)
and LFM3-1.7B (tool-call worker, :8080). `extract_visual_to_note` is
deterministic. LFM3-VL-2B (:8081) was removed from the runtime on 2026-11-08.

Landed: streaming chat with multi-turn memory and barge-in, d1 typed grounding,
persistent workspace, rejected-trace JSONL export, camera/screen frames into
the bridge, "New note". §10 MVP hardening (d1 tool choice honored, thresholds
unified, Omni chat contract + sanitizer, natural-phrasing document creation)
landed in b1693ab with a 31/31 green QA battery. VL-2B removal keeps the
battery at 31/31 with :8081 absent; `npm run typecheck` and `npm run build`
pass. plan.md §9.6 is the authoritative build status; the §7 phase list is
the original roadmap.

## Verification (needs a human — real hardware ears/voice)

- [ ] Real-mic pass: speak a command, confirm auto-stop on pause, and check Omni
      transcription quality with a real voice (the espeak test heard "rose" for
      "row").
- [ ] Real-speaker pass: model TTS audibility, stop button mid-sentence, speaker
      toggle.

## Next implementation work

- [ ] **Structural span grounding** (plan.md §4 Stage B, §9.5). Replace the
      local keyword/quote search and hand-pinned special cases in
      `findSpanForMutation` (`src/lib/supervisor.ts`) with d1-Omni-2B typed span
      extraction. Acceptance: vague spoken references ("that section about API
      keys") resolve to exact `[start_char, end_char]` / line spans, and the
      special cases can be deleted without QA regressions.
- [ ] **LoRA/tool-call SFT pass on rejected traces** (plan.md §7 Phase 5,
      §9.6, §9.8 item 5). The rejected-trace JSONL export already produces the
      training data; run a lightweight LoRA fine-tune of LFM3-1.7B on a single
      GPU. Acceptance: the tuned worker keeps the 31/31 QA battery green or
      better, with fewer malformed or rejected calls.
- [ ] **Real mobile command surface** (plan.md §9.8 item 4). The workspace
      persists and the note editor is usable below 820px, but the live session,
      command bar and runtime rail collapse to desktop/tablet affordances.
      Acceptance: a phone-width surface can capture a voice command and show
      the resulting edit.

## Ops notes

- Required servers: `scripts/start-models.sh` (idempotent) starts text :8080,
      omni :8083 and d1-omni :8085 (pid files in
      `~/Documents/Models/logs/lfm3/`); `scripts/stop-models.sh` stops them.
      There is no :8081 server or probe any more.
- `npm run qa` is the 31-case CDP battery. It needs the dev server on :5173 and
      the trinity up. Warm the dev server with a curl first; a cold Vite
      dependency optimization can lose the suite's first navigation race.
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

- Span grounding is still local keyword/quote search plus special cases (for
  example the title→H1 pin in `findSpanForMutation`); every vague phrasing
  risks becoming another special case. Tracked as the first implementation item
  above.
- Chat context: the full note is sent only on note-related turns (§10 WS2);
  other turns get a title + H2 outline. Note-related turns still resend the
  full note, with prefix caching absorbing most of it.
- Speech fallbacks still depend on browser support when a model server is down.
- The Demo button still runs the scripted demo-document sequence (intentional
  affordance).
- Vite HMR can serve a stale module graph after removing exports across files —
  restart `npm run dev` when imports change (observed once with `SUGGESTIONS`
  removal).
