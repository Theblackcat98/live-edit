# TODOs

Remaining work, newest context first. The app is functional: live trinity (Omni-2B
chat/ASR/TTS on :8083, VL-2B worker on :8081, d1-Omni-2B supervisor on :8085), honest
Runtime truth panel, voice capture → Omni ASR → grounded pipeline.

## Verification (needs a human)

- [ ] Real-mic pass: speak a command, confirm auto-stop on pause, Omni transcription
      quality with a real voice (espeak test heard "rose" for "row").
- [ ] Real-speaker pass: model TTS audibility, stop button mid-sentence, speaker toggle.
- [ ] Trace run strip: browse >2 runs after a real session.

## Functionality

- [ ] Stream Omni chat replies (currently one blocking POST; first token lands after full
      generation — short replies are ~1–4 s, visual turns longer).
- [ ] Multi-turn dialogue memory: only the last run is injected; Omni does not see prior
      assistant turns. Add a rolling conversation window to `buildChatMessages`.
- [ ] Barge-in: stop spoken audio automatically when the user starts a new command.
- [ ] "New note" affordance: start from a blank document (New chat already exists; the
      note itself is editable via the source editor but there is no blank-slate button).
- [ ] Camera/screen frames into the bridge (plan.md §10 step 3): attach real frames
      instead of the rasterized synthetic slide when device/screen mode is active.
- [ ] 256K `LFM3-1.7B` worker swap for 64K+ text refactors (plan.md §Limits).
- [ ] d1 typed grounding: when the deterministic span search returns competing
      candidates, let d1 choose between them over `/v1/systemone`.
- [ ] Persistent workspace storage across reloads (plan.md: IndexedDB or local store).
- [ ] Log rejected critic traces for the domain LoRA pass (plan.md §10 step 5).

## Known rough edges

- Vite HMR can serve a stale module graph after removing exports across files — restart
  `npm run dev` when imports change (observed once with `SUGGESTIONS` removal).
- The Demo button still runs the scripted demo-document sequence (intentional affordance).
- Chat context window: full note is resent every turn (prefix caching absorbs most of it).
