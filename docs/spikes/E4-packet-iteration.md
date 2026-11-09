# E4-packet — Phase-3 packet-prompt iteration (measured against the live worker)

Phase-3 validation of the packet-based worker prompt
(`architecture-refactor.md` §7 step 2). Question: with the prompt shipped in
`src/lib/worker.ts` (`buildPacketWorkerMessages` / `buildWorkerRetryMessages`
/ `PACKET_WORKER_SYSTEM_PROMPT`), how often does LFM3-1.7B emit a parseable,
correctly grounded call **first-try** across E4's same 12 fixtures — and what
does the max_tokens budget cost? Bar: **≥85% (≥10/12) fully valid first-try**
(E4 baseline: 5/12 = 41.7%).

- **Harness:** `scripts/spike-worker-packet-check.mjs` — E4's scoring rule for
  rule (parse via the repo's `parseToolCallXml`, params per `TOOL_DEFS` +
  `executeTool` guards, anchor = bounds + whitespace-normalized equality,
  wall-clock latency, one retry per failure), E4's 12 fixtures verbatim. The
  prompt under test is **compiled from `src/` and imported, not duplicated**:
  the script builds `src/lib/worker.ts` (+ xml/doc/data modules) to CommonJS
  with the repo's own `tsc` at startup and calls the real builders, so every
  number below was produced by the exact code that ships. The retry is driven
  by the real `buildWorkerRetryMessages` with the concrete error composed from
  the attempt's scores (truncation-aware parse errors, anchor corrections with
  the note's actual text, the attempted tool's full parameter list).
- **Server:** live `http://127.0.0.1:8080` (`/health` = ok), model alias
  `lfm3-1.7b`, sequential requests ~250 ms apart, 180 s timeout. Attempt 1
  temperature 0.3; retry 0.4 (the repo's attempt-2 bump). All runs on
  2026-11-09.
- **Raw results:** `docs/spikes/E4-packet-iteration.json` — every number below
  is read from that file, which was appended by the script per run. Failed
  iterations are recorded as failures.

## Headline

**Pass bar ≥85% first-try: MET — v3 prompt @ 6,000 max_tokens scores 11/12
(91.7%), and the confirmation re-run of the identical configuration scores
12/12 (100%).** Combined across both 6,000-token runs: 23/24 (95.8%)
first-try, 24/24 after the one-retry policy. E4's baseline was 5/12 (41.7%)
first-try, 6/12 (50%) after retry.

## Iteration history (one line each — full data in the .json)

| # | label | prompt delta | max_tokens | first-try | after retry |
| :-- | :-- | :-- | --: | :-- | :-- |
| 1 | `v1-callfirst-3000` | call-first reply contract; per-tool param ownership; gutter rule; remove_text rule; XML example per tool | 3,000 | **7/12 (58.3%)** | 12/12 |
| 2 | `v2-nodeck-6000` | + "no re-analysis / no multi-tool drafting"; `under_heading` semantics spelled out; examples labelled syntax-only | 6,000 | **9/12 (75.0%)** | 12/12 |
| 3 | `v3-prose-examples-6000` | examples became PROSE value-lists (v2's XML examples were read as the model's own prior assistant turns) | 6,000 | **11/12 (91.7%)** — bar met | 12/12 |
| 4 | `v3b-prose-examples-3000` | identical prompt, budget pulled back to probe the floor | 3,000 | **7/12 (58.3%)** | 12/12 |
| 5 | `v3c-confirm-6000` | identical to v3 — confirmation re-run against a lucky sample | 6,000 | **12/12 (100%)** | 12/12 (nothing retried) |

Per-criterion (first attempt), final configuration = runs 3 + 5 combined
(n=24) and separately:

| criterion | v3 (run 3) | v3c (run 5) | E4 baseline |
| :-- | :-- | :-- | :-- |
| XML parse | 11/12 (91.7%) | 12/12 (100%) | 10/12 (83.3%) |
| required params | 11/12 (91.7%) | 12/12 (100%) | 6/12 (50.0%) |
| anchor exact | 11/12 (91.7%) | 12/12 (100%) | 6/12 (50.0%) |
| **fully valid** | **11/12 (91.7%)** | **12/12 (100%)** | **5/12 (41.7%)** |
| valid after one retry | 12/12 | 12/12 (no retries needed) | 6/12 (50.0%) |

Retry recovery across all five runs: **14/14 (100%)** of retried failures
recovered (E4: 1/7, 14.3%). Every retried failure in these runs was a
`finish=length` truncation, and every one was corrected by the
concrete-error retry message (which names the truncation and orders the call
first); nothing was ever recovered by re-sending the same prompt.

## What each E4 failure class cost, and what fixed it

1. **Tool/parameter schema mix** (E4: 4 attempts) — **eliminated**. Zero
   occurrences in any of the 60 first attempts across all runs. Fixes: each
   schema block carries ONLY its own parameter list with an explicit
   "a parameter from another tool is rejected" line; the system prompt states
   per-tool parameter ownership; filled prose examples weld each function
   name to its vocabulary; `add_text`/`extract_visual_to_note` are now chosen
   freely (v3 run: add_text ×4, edit_text ×3, remove_text ×3, extract ×1 —
   E4 saw add_text/extract **never** chosen).
2. **Output-budget truncation** (E4: 4 attempts) — **mostly eliminated, at a
   measured budget cost** (below). Root causes found and fixed in sequence:
   (a) the model deliberates in the content channel; the reply contract now
   forbids restating/re-analyzing and demands the call start immediately;
   (b) v2's complete XML examples in the catalog were **read by the 1.7B as
   its own prior assistant turns** ("the conversation shows previous attempts
   by me with add_text, edit_text, remove_text…") and re-litigated until the
   cap — prose value-list examples ended that class entirely (v3: 1 truncation
   left in 12; v3c: 0).
3. **Remove-as-empty-edit** (E4: F02 ×2) — **eliminated**: "Deleting is
   remove_text — never edit_text with an empty new_text" plus the ownership
   recap; F02 passed first-try in all five runs (remove_text, exact anchor).
4. **Anchor near-miss incl. gutter bleed** (E4: F01) — **eliminated**: the
   numbering gutter rule ("the ` │ ` gutter and its number are not note
   text") plus anchors-copied-exactly instruction; **zero anchor misses in
   all 60 first attempts across the five runs**. The actual-text anchor
   correction in the retry builder was therefore never needed live here —
   it is unit-tested, and E4 already proved that format recovers the class
   (F01).
5. **Retry echoing the template** (E4: F03 echoed `<function=tool_name>`) —
   **eliminated**: the retry message is prose — exact error, the note's
   actual text on an anchor miss, the attempted tool's full parameter list,
   the ownership recap — and contains no fill-in skeleton; 13/13 retries
   recovered with zero echoes.

## max_tokens decision and its measured cost

**6,000 (up from 3,000), both attempts; documented in
`PACKET_WORKER_SAMPLER` in worker.ts.** The budget is load-bearing, not
padding: at 3,000 the v3 prompt still truncates content-channel deliberation
mid-flight (v1: 5 truncations; v3b: 5 truncations incl. fixtures that passed
at 6,000), because the 1.7B plans at length before committing to the call —
v3's F03/F04/F12 succeeded only because 6,000 gave the deliberation room to
finish and close the call (output tokens 4,585–5,968 on those).

Cost (first-attempt latency, 12 fixtures):

| budget | min | median | max | first-try valid |
| :-- | --: | --: | --: | :-- |
| 3,000 (v3b) | 1,945 ms | 8,219 ms | 17,333 ms | 7/12 (58.3%) |
| 6,000 (v3) | 4,564 ms | 11,504 ms | 30,107 ms | 11/12 (91.7%) |
| 6,000 (v3c) | 1,887 ms | 8,803 ms | 24,618 ms | 12/12 (100%) |

Median cost ≈ +3 s vs the 3,000 budget; the deliberating tail now reaches
25–30 s instead of failing at 13 s. Successful early calls are unaffected
(finish=stop at 271–2,590 output tokens on the fast half). Prompt cost of the
packet: 1,763–2,424 prompt tokens per first attempt (seed-note fixtures
2,199–2,424; bare-note F09 1,763; E4's packet was 978–1,643) — the fuller
catalog (per-tool use-when lines, prose examples, ownership recap) is the
delta, and prefix caching absorbs it on retries.

## Remaining failure classes (final prompt, honest list)

- **Long-content repetition loop (F09-class, 1 occurrence in 24):** the one
  v3 failure — README-on-bare-note started the call immediately but looped
  inside `new_text` to the 6,000 cap. It recovered on retry in that run and
  passed first-try in the confirmation run; the class is real but rare and
  the retry policy covers it. Mitigation candidates if it resurfaces:
  repetition penalty on the worker sampler, or a retry sampler bump.
- **Deliberation latency, not validity:** fixtures that deliberate to
  4.5–6k output tokens are valid but slow (up to ~30 s). This is the price
  of the 6,000 budget; Omni's delegation-card acknowledgement (P2) is the
  UX cover.
- **Example-content bleed (cosmetic, gate-invisible):** in one v1 README
  output the add_text example's risk-line phrasing surfaced inside authored
  README text. Mechanical validity is unaffected; d1's content check (P4) is
  the designed backstop. Not observed in v3/v3c recorded samples.

## What this establishes for the wiring phase

- The design.md §6 packet + authoring prompt clears the E4 bar on the live
  worker: **≥85% first-try across two independent runs (91.7%, 100%)**, with
  the one-retry policy taking every observed failure to 12/12.
- `PACKET_WORKER_SAMPLER` (worker.ts) carries the measured budget decision;
  the pipeline's worker stage should adopt it when it switches to
  `buildPacketWorkerMessages` / `buildWorkerRetryMessages`.
- Harness reusability: `scripts/spike-worker-packet-check.mjs` re-runs the
  12 fixtures against any future prompt edit (`--label`, `--max-tokens`,
  `--retry-max-tokens`) and appends to this record — iteration evidence
  stays mechanical.
