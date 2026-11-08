# TODOs

The app is functional end to end: live trinity plus the 1.7B long-context text
worker (Omni-2B chat/ASR/TTS on :8083, VL-2B worker on :8081, d1-Omni-2B
supervisor on :8085, LFM3-1.7B on :8080), streaming chat replies with multi-turn
memory and barge-in, d1 typed grounding, persistent workspace, rejected-trace
JSONL export, camera/screen frames into the bridge, "New note" affordance.
Milestone landed as commit b1c76ec.

## Verification (needs a human — real hardware ears/voice)

- [ ] Real-mic pass: speak a command, confirm auto-stop on pause, Omni transcription
      quality with a real voice (espeak test heard "rose" for "row").
- [ ] Real-speaker pass: model TTS audibility, stop button mid-sentence, speaker toggle.

## Ops notes

- Four model servers run: omni :8083, vl :8081, d1-omni :8085 (started outside the
  family script — no pid files, stdout on a pty; `./lfm3.sh stop` will NOT manage
  them) and text :8080 (family convention, pid in `~/Documents/Models/logs/lfm3/text.pid`).
  If the box reboots, restart vl/omni/d1 via `./lfm3.sh vl|omni|d1-omni` or your own
  process manager.
- llama.cpp servers run `--reasoning on`; per-request
  `chat_template_kwargs: {"enable_thinking": false}` is what the VL tool-call turn
  uses — keep that if worker prompts change (measured: thinking-on never closed
  `<think>` at any budget).
- The Vite dev server occasionally serves stale transforms after external/rapid
  file writes; `touch` the edited files or restart `npm run dev`.
- The 1.7B swap decodes ~9–14 s at a 3000-token budget on fat notes — expected,
  not a hang.

## Known rough edges

- Vite HMR can serve a stale module graph after removing exports across files — restart
  `npm run dev` when imports change (observed once with `SUGGESTIONS` removal).
- The Demo button still runs the scripted demo-document sequence (intentional affordance).
- Chat context window: full note is resent every turn (prefix caching absorbs most of it).
