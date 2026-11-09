# E1 — Omni directive emission (raw results summary)

- **Spike:** Phase-0 E1, `docs/architecture-refactor.md` §4 (design.md §5, Q1).
- **Raw data:** [`E1-omni-directive.json`](./E1-omni-directive.json) (this file summarizes
  it; every number below comes from it).
- **Script:** `scripts/spike-omni-directive.mjs` — run as
  `node scripts/spike-omni-directive.mjs`.
- **Server:** LFM3-Omni-2B at `http://127.0.0.1:8083` (llama.cpp, `--jinja`), verified
  healthy before the run. Sampling held at the shipped client's values
  (temperature 0.3, max_tokens 500, no seed) so the run isolates the *mechanism*
  variable; E2 tunes sampling.
- **Run:** 2026-11-09T11:28:01Z. 40 requests, 0 request errors.

## Verdict: the pass bar FAILED on both mechanisms — the design stop-gate fires

| Mechanism | valid first-try | valid after 1 repair | valid total | invalid | wrong-outcome | wrong-outcome on remove/edit | pass bar (≥18/20 valid AND 0 destructive WO) |
| :-- | --: | --: | --: | --: | --: | --: | :-- |
| (a) native tool call | 13 | 0 | **13/20** | 6 | 1 (T10) | **0** | **NOT MET** |
| (b) delimited block | 8 | 0 | **8/20** | 7 | 5 (T10, T13, T14, T18, T19) | **1** (T14) | **NOT MET** |

Per `architecture-refactor.md` §4 E1: both mechanisms below the bar means **stop
and re-open the design — a front door that can't delegate is a design problem,
not a prompt problem**. No heuristic pre-router was added and none is
recommended. The stop-gate stands. E2's data (see
[`E2-omni-serving.md`](./E2-omni-serving.md)) is the first input to the re-open:
it shows what sampling does and does not rescue.

## The 20 turns (verbatim)

One rolling conversation per mechanism, follow-ups see their antecedents
(T06 follows T05; T09 follows T08). The note in context is the repo's seed note
(`src/data/note.ts` `INITIAL_NOTE`, 1,312 chars, byte-identical), frozen for all
turns — the spike has no worker, so no edit ever executes. Turns T02 and T12
carry a generated PNG frame (in-script render of the same content as the app's
synthetic slide in `src/lib/frame.ts`: revenue table, `LTV / CAC = 3.4x`
north-star card, trajectory bars, finance sticky), attached as `image_url`
exactly the way `bridge.ts` attaches frames. Omni read it accurately (T02's
answer describes the dashboard; T12's directive cites `LTV / CAC = 3.4X`).

| id | turn (verbatim) | expected | expected task |
| :-- | :-- | :-- | :-- |
| T01 | `hey` | answer | — |
| T02 | `what can you see?` [frame] | answer | — |
| T03 | `remember that my favorite color is teal` | answer | — |
| T04 | `what is my favorite color?` | answer | — |
| T05 | `update the Q3 revenue row to $1.45M Final` | delegate | edit |
| T06 | `do the same for Q4 to $1.5M` | delegate | edit |
| T07 | `summarize the note so far in two sentences` | answer | — |
| T08 | `remove the bullet about Redis` | delegate | remove |
| T09 | `undo that` | action (undo) | — |
| T10 | `change the number` | clarify | — |
| T11 | `add a line under Security: rotate keys monthly` | delegate | insert |
| T12 | `pull the LTV/CAC formula from the slide into Revenue` [frame] | delegate | extract |
| T13 | `write a README template document to begin` | delegate | create |
| T14 | `rename the title to Q3 Review Final` | delegate | edit |
| T15 | `make it better` | clarify | — |
| T16 | `hey, could you add a bullet under Follow-ups saying send the deck to finance` | delegate | insert |
| T17 | `um, please delete the bullet about API keys` | delegate | remove |
| T18 | `create a changelog template in this document` | delegate | create |
| T19 | `what happens if I remove the Q3 row?` | answer (hypothetical) | — |
| T20 | `delete the Q1 row from the revenue table` | delegate | remove |

Destructive turns (remove/edit) for the zero-wrong-outcome bar:
T05, T06, T08, T14, T17, T20.

## Per-turn outcome matrix

`✓` valid first-try · `s` invalid (semantic) · `f` invalid (form) · `W` wrong-outcome

| turn | (a) native | (b) delimited | note |
| :-- | :-- | :-- | :-- |
| T01 hey | ✓ | ✓ | |
| T02 visual | ✓ | ✓ | frame described accurately |
| T03 teal | ✓ | ✓ | |
| T04 recall | ✓ | ✓ | |
| T05 Q3 edit | s | ✓ | native: task `insert` (instruction correct, `$1.45M Final` present) |
| T06 Q4 follow-up | s | ✓ | native: task `insert`; antecedent resolved correctly (`$1.5M`, Q4) |
| T07 summarize | ✓ | ✓ | |
| T08 Redis remove | ✓ | s | delimited: task `edit`, instruction says "Remove the bullet…" |
| T09 undo | ✓ | ✓ | both emitted exactly `ACTION undo` |
| T10 change the number | **W** | **W** | **both delegated a guess instead of clarifying** (delimited's guess: change Redis "Q4"→"Q3") |
| T11 Security insert | s | s | native task `insert` correct, instruction wording missed the strict regex (see below); delimited task `edit` |
| T12 LTV extract | s | s | both embedded the frame-read formula into the instruction; task `insert`/`edit`, not `extract` |
| T13 README create | ✓ | **W** | delimited emitted an invented `<<<README TEMPLATE` block (not a directive) |
| T14 rename title | ✓ | **W** | delimited again `<<<README TEMPLATE`; **destructive wrong-outcome** |
| T15 make it better | f | f | native authored improved README text in chat; delimited emitted `<<<README TEMPLATE` — neither asked a clarifying question |
| T16 follow-ups insert | ✓ | s | delimited task `edit` |
| T17 API keys remove | ✓ | s | delimited task `edit` |
| T18 changelog create | ✓ | **W** | delimited emitted `<<<CHANGELOG TEMPLATE` |
| T19 hypothetical | ✓ | **W** | **delimited delegated the hypothetical chat turn** |
| T20 Q1 row remove | s | s | both task `edit`, instruction correct |

## Where the failures actually are

**Mechanism (a) native tool call — emission is not the problem.** On this run
Omni emitted a tool call on **11/11 delegate turns, all 11 schema-valid on the
first try; zero repairs were needed** (repair never triggered — there were no
parse/schema failures anywhere). Wrong-outcome discipline was 19/20 (the one
miss is T10, the ambiguous turn). The entire gap to the bar is *directive
semantics*:

- **Task-tag selection (4 turns: T05, T06, T12, T20).** `insert` chosen for
  row updates (edit), `insert` for a frame extraction, `edit` for a removal —
  each time with an instruction that itself describes the right operation
  ("Remove the Q1 row from the Revenue table…"). Instruction-adequacy on
  delegate turns, task tag aside: **10/11 strict, 11/11 lenient** (T11 below).
  In the app the task tag drives the delegation card and biases the worker, so
  this is a real contract failure — but it is a *labelling* failure, not an
  emission failure.
- **T11 (regex nuance, recorded honestly).** The instruction
  "Add a new line under the Security section with the text 'Rotate production
  API keys monthly.'" carries everything the user specified, but the strict
  mustMention regex `/rotate\s+keys\s+monthly/i` missed the inserted words
  "production API". Scored invalid under the pre-registered strict rule;
  a lenient read counts it adequate.
- **T15 (form).** "make it better" was answered by authoring improved README
  text in chat instead of asking a clarifying question — an
  authors-in-chat violation, scored invalid (not wrong-outcome: no delegation,
  no note change).
- **T13 (quality flag on a scored-valid turn).** The directive is schema-valid
  and passed the mustMention bar, but its `instruction` contains the *entire
  authored README content* — against §5's "a brief, not the content" rule.
  The spike's regex bar does not catch brief-vs-content drift; flagged here so
  the design discussion sees it.

**Mechanism (b) delimited block — the format itself is brittle.** Beyond the
same task-tag stamping (`edit` on 6 turns), the mechanism produced failures
native did not:

- **Invented delimiters (T13, T14, T18).** After emitting valid `<<<DIRECTIVE`
  blocks, the model drifted to `<<<README TEMPLATE` / `<<<CHANGELOG TEMPLATE`
  blocks containing template content — the model few-shot-generalizes the
  delimiter *shape*, which a free-text channel permits and a native tool call
  does not. T14 (rename title) is the run's one **destructive wrong-outcome**:
  an edit turn answered with an invented block, no directive.
- **Delegated a hypothetical (T19).** "what happens if I remove the Q3 row?" —
  a chat turn — was delegated as an edit. Native answered it correctly.
- Latency: mean 694 ms/request vs native 496 ms (blocks are longer completions).

**Shared failure: ambiguity handling (T10, T15).** Both mechanisms delegate
guesses on "change the number" (T10) rather than clarifying — the exact
dangerous class design.md §10 reserves for a clarification move. No temperature
choice is expected to fix a classification disposition, but E2 measures it at
0 / 0.3 / 0.7 rather than assuming.

**What worked cleanly (both mechanisms):** chat turns (greeting, memory
statement + recall, note summary, hypothetical — native), the `ACTION undo`
signal (exact line, both mechanisms), frame reading, and context resolution
(T06 "do the same for Q4" → `$1.5M` Q4 edit from the T05 antecedent).

## Latency (per request, from the JSON)

| mechanism | requests | mean | median | p95 |
| :-- | --: | --: | --: | --: |
| native-tools | 20 | 496 ms | 390 ms | 1,369 ms |
| delimited-block | 20 | 694 ms | 619 ms | 1,766 ms |

## Measurement integrity — three runs, two invalidated

The JSON records this run's policy; the two earlier runs are disclosed here
because they are themselves findings about a 2B front door:

1. **Run 1** appended a repeated placeholder (`(no response recorded)`) to the
   conversation after failed turns. The model few-shot-copied the placeholder
   verbatim for the rest of the conversation, invalidating later turns.
2. **Run 2** replaced it with rotated "natural" failure lines and canned
   `Done — edit applied` confirmations. The model copied the failure lines
   verbatim (T14–T20) and, worse, learned the canned-confirmation shortcut —
   replying "Edit applied: …"-style prose with no directive (T06-delimited).
   Native tool calling collapsed to 1 emission in 20 turns after its one tool
   call "vanished" from history.
3. **Run 3 (reported above):** history contains only model-authored output plus
   tool results (native delegations persist as assistant `tool_calls` + a tool
   `Executed`/`Execution failed` result; delimited delegations keep the raw
   block; no-output turns add no assistant message). A post-run scan found
   **zero** harness-string copies. The few-shot-copying behaviour itself is a
   real property of this model the app design must respect: anything the
   harness puts in the assistant channel gets imitated.

## Implication recorded for the design re-open

The stop-gate fired, but the evidence localizes the defect: the native
*emission mechanism* is reliable (11/11 schema-valid, 0 repairs, 19/20 outcome
discipline, 0 destructive wrong-outcomes) while the *directive semantics*
(task-tag selection, ambiguity→clarify, brief-not-content) are not yet at the
18/20 bar at temperature 0.3. E2 tests whether sampling moves the semantics;
the re-open should weigh: task-tag supervision in the prompt or schema
(task→enum examples), the ambiguity disposition (T10/T15 failed identically on
both mechanisms), and whether §5's task taxonomy is the right size for a 2B
(`insert`/`edit`/`remove` boundaries are where it breaks).
