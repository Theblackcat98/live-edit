# E2 — Omni serving/sampling (raw results summary)

- **Spike:** Phase-0 E2, `docs/architecture-refactor.md` §4 (design.md Q3).
- **Raw data:** [`E2-omni-serving.json`](./E2-omni-serving.json) (this file
  summarizes it; every number below comes from it).
- **Script:** `scripts/spike-omni-serving.mjs` — run as
  `node scripts/spike-omni-serving.mjs` (after E1).
- **Server:** LFM3-Omni-2B at `http://127.0.0.1:8083` (llama.cpp, `--jinja`),
  healthy. 6 configs = temperature 0 / 0.3 / 0.7 × note cap 3,600 chars / full
  note, on E1's winning mechanism (**native tools**, valid_total 13 vs 8 — the
  pass bar was met by neither, see
  [`E1-omni-directive.md`](./E1-omni-directive.md)). Same 20 turns, same
scoring, same one-repair rule as E1. 121 requests total, 113 completions
returned, 8 HTTP 500s (below), 0 timeouts.

## Chosen configuration

| setting | value | justification (all numbers from this run) |
| :-- | :-- | :-- |
| mechanism | **native tool call** | E1: 11/11 schema-valid emissions, 0 repairs, 0 destructive wrong-outcomes vs delimited 8/20 + invented delimiters |
| temperature | **0.3** | outcome accuracy identical across temps (15/20 at 0, 0.3, 0.7 — table below); chat replies effectively identical (quotes below); the run's only conversation-level collapse (8 consecutive server 500s) happened under temperature 0; 0.7 buys nothing over 0.3 |
| max_tokens | **700** (raised from 500) | measured: 1 truncation (`finish_reason=length`) in 113 completions at 500 — a create-directive whose tool-call arguments were cut mid-JSON and became unparseable. 700 is inference-driven headroom (labelled: not a measured config), matching `bridge.ts`'s existing 700 default |
| note cap | **keep 3,600 chars** | honest no-op finding: the seed note is 1,312 chars, below the cap, so cap/full configs received byte-identical context — this dimension is **untested for longer notes**; keep the cap, revisit with a longer-note run |
| serving flags | **remove `--reasoning off`; keep `--jinja`** | verdict + evidence below |

The chosen config's numbers (t0.3, either cap): **15/20 valid, 0 destructive
wrong-outcomes, 0 request errors, mean 402–408 ms/request, p95 985–991 ms, 0
truncations.** The script's mechanical suggestion was `t0-full` (latency
tiebreak 401 vs 402 ms — noise); this doc overrides to **0.3** on the
robustness argument above. That judgment is human, the numbers are not.

**The chosen configuration does not clear E1's bar** (15/20 < 18/20): the
stop-gate stands. Sampling did not move the semantic failures — see below.

## Outcome accuracy per config (same scoring classes as E1)

| config | temp | note | valid (first+repair) | invalid | wrong-outcome | destructive WO | errors | mean ms/req | p95 ms | truncations |
| :-- | :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| t0-cap3600 | 0 | 3,600 (no-op) | 7/20 | 4 | 1 (T10) | 0 | **8** | 492 | 2,109 | 1 |
| t0-full | 0 | full (no-op) | **15/20** | 3 | 2 (T10, T15) | 0 | 0 | 401 | 1,109 | 0 |
| t0.3-cap3600 | 0.3 | 3,600 (no-op) | **15/20** | 3 | 2 (T10, T15) | 0 | 0 | 402 | 991 | 0 |
| t0.3-full | 0.3 | full (no-op) | **15/20** | 3 | 2 (T10, T15) | 0 | 0 | 408 | 985 | 0 |
| t0.7-cap3600 | 0.7 | 3,600 (no-op) | **15/20** | 3 | 2 (T10, T15) | 0 | 0 | 408 | 990 | 0 |
| t0.7-full | 0.7 | full (no-op) | **15/20** | 3 | 2 (T10, T15) | 0 | 0 | 407 | 994 | 0 |

Zero repairs converted into validity anywhere (`valid_after_repair` = 0 in all
six configs) — no schema failures occurred to repair.

**The failure set is temperature-invariant.** All five healthy configs fail the
exact same five turns: T05, T06, T12 (task tagged `insert` where edit/extract
was expected — instructions correct) and T10, T15 (ambiguous turns delegated as
guesses instead of clarified). Temperature is not the lever for E1's gap; the
re-open must address task-tag semantics and the ambiguity disposition directly.

## The t0-cap3600 incident (mechanism-level finding)

At T13 ("write a README template document to begin") the model's tool-call
arguments ran past max_tokens: `finish_reason=length`, JSON truncated mid-string
(parse error at column 1512), unparseable client-side → the repair retry
generated malformed JSON that **llama.cpp itself refused to parse, returning
HTTP 500** — and every subsequent turn T14–T20 then 500'd on the first attempt
(greedy decoding never left the basin; with the error turns leaving no
assistant output in history, the context also lost its last successful
tool-call pattern).

Two consequences for the design:

1. **max_tokens must cover create-directives** (long instructions) — the one
   truncation observed was exactly a `create`; hence the 700 recommendation.
2. **The repair loop has a blind spot with native tool calls**: when the
   *server* rejects the generated call (HTTP 500), the client never receives
   the raw text, so design.md §5's "append the schema error and retry once"
   cannot include the malformed attempt. The app's `omni.ts` must treat
   server-side tool-parse failures as their own error class (retry bare, or
   surface as an Omni-reported failure), not as a repairable schema error.

## Reply quality on chat turns (verbatim, from the JSON)

Replies are near-identical across temperatures; no temp produced livelier or
more correct conversation on this turn set. Quotes (t0.3-full; other configs in
the JSON):

- T01 `hey` — every config, verbatim identical: `"Hey! What would you like to
  do with the note?"`
- T02 `what can you see?` — `"I can see a screenshot of a finance operating
  review dashboard titled "Q3 Operating Review – Revenue & Operating
  Efficiency" (Confidential, dated 14 November). The key sections visible are:
  - **Revenue by Quarter**: Q1 $0.92M (Cl…"` — accurate frame reading at every
  temperature.
- T03 `remember that my favorite color is teal` — `"Got it — teal is your
  favorite color. I'll keep that in mind for any future interactions."`
  (identical at 0 and 0.7)
- T04 `what is my favorite color?` — `"Your favorite color is teal."`
  (identical at 0 and 0.7)
- T07 `summarize the note so far in two sentences` — grounded, correct figures
  (18% QoQ, 112% NRR), identical wording at 0 and 0.3/0.7.
- T19 `what happens if I remove the Q3 row?` — temp 0: `"…The Q4 row would
  remain, but the overall Revenue summary would be incomplete."` vs 0.3/0.7:
  `"…the North Star section (which references Q3) will no longer have the
  LTV/CAC formula and target…"` — the only visible phrasing divergence, both
  correct; no quality difference.

Judgment (human, labelled as such): all temperatures produce factual, grounded,
on-point replies; there is no conversational-quality argument for any
temperature on this evidence, so the tiebreak is robustness (above) → 0.3.

## Note-cap dimension: honest no-op

`applyNoteCap` was applied per config; the seed note (1,312 chars) never
exceeded 3,600, so **both members of each temperature pair received
byte-identical note context**. The pairs at 0.3/0.7 produced identical outcomes;
the temp-0 pair differed only via server nondeterminism (below). A cap verdict
for realistic longer notes requires a longer-note run — recorded as not
measured, not as "cap doesn't matter."

## Determinism observation (temperature 0)

The two temp-0 configs had identical inputs, and T01–T10 produced identical
outcomes, then **T11 diverged** (invalid vs valid) and the conversations never
re-converged (T11 → T13's truncation in one branch, 15/20 in the other). With
greedy decoding this is server-side nondeterminism (batching/prefix-cache state
across sequential runs). Practical note for the app: **temperature 0 does not
buy reproducibility on this stack**, which further weakens any argument for it.

## `--reasoning off` verdict: NO-OP — recommend REMOVE

Evidence (all recorded in the JSON):

- `/props` → `default_generation_settings.params.reasoning_format = "none"`,
  `reasoning_in_content = false`.
- `/props` → `chat_template_caps.supports_reasoning_effort = false` (the
  template has no reasoning-effort support at all).
- Live scan of all **113 completions** in this spike: **0** non-empty
  `reasoning_content` fields, **0** `<think` substrings in content. (The bridge
  already reads `reasoning_content`; it has never carried anything.)
- The model is a non-reasoning model per its model card (the expectation
  stated in `architecture-refactor.md` §4 E2; verified here rather than
  assumed).

Verdict: on this build the flag disables a parser that would never fire.
Keeping it implies a capability that does not exist; removing it cannot change
behaviour. Recommend removing `--reasoning off` from the omni member of
`scripts/start-models.sh` in P2 (the file is untouched by this spike).
Keep `--jinja` — it is what enables the native tool-call path E1/E2 measured.

## Carry-forward for the design re-open (with E1)

1. The stop-gate stands: best observed configuration is 15/20 vs the 18/20 bar.
2. Temperature is not the lever — the failure set is invariant across
   0 / 0.3 / 0.7.
3. Actionable defects, in evidence order: task-tag selection (insert-vs-edit,
   insert-vs-extract, edit-vs-remove with correct instructions), ambiguity →
   delegate-guess (T10/T15, both mechanisms, all temperatures), brief-vs-content
   drift on create (E1 T13), and the server-500 blind spot in the repair story.
4. What sampling *did* show: latency is flat (~400 ms mean at every
   temperature), chat quality is stable, and temp 0 adds a greedy-basin risk
   with no compensating determinism — hence 0.3.
