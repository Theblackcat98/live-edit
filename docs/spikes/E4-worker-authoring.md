# E4 — Worker authoring capability (raw results)

Phase-0 spike E4, `docs/architecture-refactor.md` §4. Question: given the
`design.md` §6 worker packet (typed directive + context packet + **full
line-numbered note** + full 4-tool catalog), how often does LFM3-1.7B emit a
parseable, correctly grounded tool call on the **first attempt** — and what
does it cost?

- **Run:** 2026-11-09T11:14:18.585Z, live server `http://127.0.0.1:8080`
  (LFM3-1.7B, llama.cpp, `/health` = `ok`), sequential requests, 250 ms apart,
  180 s per-request timeout.
- **Script:** `scripts/spike-worker-authoring.mjs` — 12 fixture directives,
  non-streaming `POST /v1/chat/completions`, model alias `lfm3-1.7b`
  (the bridge's alias for :8080). Sampler mirrors the shipped worker attempt
  loop (`useWorkspace.ts`): attempt 1 `temperature 0.3 / max_tokens 3000`,
  retry `temperature 0.4 / max_tokens 3000`.
- **Raw results:** `docs/spikes/E4-worker-authoring.json` — every number below
  is read from that file. Failures are recorded as failures.

## Fixtures

The QA battery's edit commands (`scripts/qa-suite.mjs`) plus the
`design.md` §13.1 README case on both notes and the §13.2 follow-up:

| id | command | note | context packet |
| :-- | :-- | :-- | :-- |
| F01 | update the Q3 revenue row to $1.45M Final (QA 6) | seed (43 lines) | — |
| F02 | remove the bullet about Redis (QA 7) | seed | — |
| F03 | add a line under Security: rotate keys monthly (QA 8) | seed | — |
| F04 | hey, could you add a bullet under Follow-ups saying send the deck to finance (QA 19) | seed | — |
| F05 | Rename the title to Q3 Review Final (QA 20) | seed | — |
| F06 | um, please delete the bullet about API keys (QA 21) | seed | — |
| F07 | pull the LTV/CAC formula from the slide into Revenue (QA 9, D2 `frame_extract`) | seed | — |
| F08 | write a README template document to begin (**§13.1**) | seed | — |
| F09 | write a README template document to begin (**§13.1**) | bare `# Untitled` (2 lines) | — |
| F10 | do the same for Q4 to $1.5M (**§13.2** follow-up) | seed after 3 applied turns (42 lines) | 3 prior edit turns as `{user command, directive summary, diff summary}` |
| F11 | remove that section about API keys (QA 23 shape) | seed | — |
| F12 | add a fourth risk about vendor concentration to the Risks list | seed | — |

Each fixture's prompt (per `design.md` §6): a system prompt instructing the
worker to AUTHOR the content, ground its own span (line numbers + exact anchor
from the note), and emit exactly **one** XML tool call in the repo's existing
contract (`worker.ts` `renderToolCallXml` syntax, so `xml.ts` parser rules
apply); the typed directive (`design.md` §5 shape, plus `frame_extract` on F07
per decision D2); the context packet; the FULL line-numbered note; and all 4
tool schemas rendered exactly as `worker.ts` renders them. The directive's
`task` is a hint, not a filter — the worker picks the tool from the full
catalog.

**Repo rules are duplicated in-script, not imported.** `src/` is TypeScript
and cannot be loaded by a dependency-free `.mjs`; the script copies verbatim:
`src/lib/xml.ts` (`parseToolCallXml`, `KNOWN_TOOLS` — the scoring parser IS the
repo parser rule-for-rule), `src/lib/doc.ts`
(`splitLines`/`normalizeWhitespace`/`findHeading`), `src/lib/tools.ts`
(`removalCapFor`, `EDIT_RETENTION_RATIO` — informational blast radius),
`src/data/tools.ts` (`TOOL_DEFS`), `src/data/note.ts` (`NOTE_PATH`,
`INITIAL_NOTE`). Scoring per fixture: **parse** (repo parser returns a known
tool) → **params** (all required params present, non-empty, typed per
`TOOL_DEFS` + `executeTool` guards) → **anchor** (range bounds +
whitespace-normalized equality against the note's actual lines at the stated
range, `design.md` §8 gate) → **latency** (wall-clock ms). On any failure:
exactly ONE retry with the parse/anchor error appended to the conversation.

## Headline

**Pass bar ≥85% fully valid first-try: NOT MET — 41.7% (5/12).**

| criterion (first attempt, n=12) | result | rate |
| :-- | :-- | :-- |
| XML parse | 10/12 | 83.3% |
| required params complete | 6/12 | 50.0% |
| anchor exact (bounds + normalized match) | 6/12 | 50.0% |
| **fully valid (parse + params + anchor)** | **5/12** | **41.7%** |
| valid after the one-retry policy | 6/12 | 50.0% |

First-try fully valid: F05, F06, F09, F10, F11. Retry recovery: **1 of 7
retried (14.3%)** — only F01, whose failure class (anchor near-miss) is the one
the retry message answers with exact correction data. The bar is not met even
counting retries.

## Per-fixture results

Latency is wall-clock ms; "tool" is the parsed call's tool (— = no parseable
call); match = tool matches the directive's expected tool.

| id | tool (a1) | parse | params | anchor | latency a1 | retry | outcome |
| :-- | :-- | :-- | :-- | :-- | --: | :-- | :-- |
| F01 | edit_text | ok | ok | **mismatch** (line 17 right, anchor text wrong) | 6,789 | 1,506 ms → **fully valid** | recovered |
| F02 | edit_text | ok | **fail** (empty `new_text` on a remove intent) | ok | 3,038 | 3,559 ms → same failure | not recovered |
| F03 | — | **fail** (3,000-tok truncation, no call) | fail | fail | 20,580 | 13,687 ms → `<function=tool_name>` literal | not recovered |
| F04 | edit_text | ok | **fail** (`position`/`anchor`/`content` inside an `edit_text` shell) | fail | 11,445 | 5,749 ms → same failure | not recovered |
| F05 | edit_text | ok | ok | ok (lines 1–1) | 1,687 | — | **valid first try** |
| F06 | remove_text | ok | ok | ok (line 41) | 5,817 | — | **valid first try** |
| F07 | — | **fail** (3,000-tok truncation) | fail | fail | 13,094 | 11,242 ms → schema mix | not recovered |
| F08 | edit_text | ok | **fail** (schema mix) | fail | 11,482 | 13,238 ms → truncation | not recovered |
| F09 | edit_text | ok | ok | ok (lines 1–1, anchor `# Untitled`) | 9,503 | — | **valid first try** |
| F10 | edit_text | ok | ok | ok (line 18, Q4 row) | 4,381 | — | **valid first try** |
| F11 | remove_text | ok | ok | ok (lines 39–43, whole Security section) | 10,482 | — | **valid first try** |
| F12 | edit_text | ok | **fail** (schema mix) | fail | 17,677 | 18,251 ms → truncation | not recovered |

Tool gravity: of the 10 first-try parsed calls, **8 were `edit_text`** and 2
`remove_text`; `add_text` and `extract_visual_to_note` were never chosen. Five
of the ten matched the directive's expected tool. F09 is valid-but-different:
the worker replaced the `# Untitled` placeholder line with the README via
`edit_text` (params complete, anchor exact) instead of `add_text` — the
directive's `task` hint was indeed not a filter. The one recoverable retry was
an anchor error; the retry did not fix a single schema-mix or truncation
failure (F03's retry literally echoed `<function=tool_name>` from the retry
message's format template).

## Failure taxonomy (from the raw outputs)

1. **Output-budget truncation** (F03 a1, F07 a1, F08 retry, F12 retry — 4
   attempts, `output_tokens` = 3,000 exactly, 13.1–20.6 s each): the model
   reasons at length inside its thinking and the 3,000-token cap lands before
   the `<tool_call>` closes. The repo's shipped worker comment already records
   ~2K-token thinking on the *windowed* prompt; the fuller packet did not
   shrink it.
2. **Tool/parameter schema mix** (F04, F07 retry, F08 a1, F12 a1): an
   `edit_text` function block carrying `add_text`'s parameter vocabulary
   (`position`/`anchor`/`content`). Parse survives (the name is a known tool);
   the params gate rejects. The authored content itself is often present and
   on-brief — the failure is mechanical, not authoring.
3. **Remove-as-empty-edit** (F02 ×2): `edit_text` anchored exactly on the
   Redis bullet with an empty `new_text` — a removal expressed through the
   wrong tool; `executeTool` rejects an empty replacement.
4. **Anchor near-miss** (F01 a1): correct line (17), complete params, anchor
   text not exact → **the one retry recovery**, using the appended actual-text
   correction.

All misses are caught by the deterministic gates — nothing in this run would
have corrupted the note silently; every invalid call fails a gate the same way
`executeTool` fails it live.

## Latency (the watch item)

| | min | median | max |
| :-- | --: | --: | --: |
| first attempt (n=12) | 1,687 ms | 9,503 ms | 20,580 ms |
| all attempts (n=19) | 1,506 ms | 10,482 ms | 20,580 ms |

Prompt size for the fuller packet: 4,043–4,773 chars, **978–1,643 prompt
tokens** per first attempt (seed-note fixtures 1,414–1,527; the bare-note F09
978; the 3-turn-packet F10 1,643; retries run 1,529–3,778 with the appended
attempt). Median first-try latency 9.5 s sits **inside** today's 7–14 s
envelope at the same 3,000-token budget — the fuller note + catalog did not,
by itself, blow up the session's feel. The latency risk is concentrated in the
reasoning-heavy failures: attempts that hit the 3,000-token cap cost 13–21 s
and then still fail. Fast successes (F05 1.7 s, F10 4.4 s, F01's cached retry
1.5 s at 1,613 prompt tokens) show prefix caching absorbing the packet
repeat.

## Context packet check (design.md §6, §13.2)

F10 ("do the same for Q4 to $1.5M", 3 prior edit turns in the packet) landed
fully valid first try in 4.4 s: `edit_text` lines 18–18, anchor
`| Q4 | $1.35M | Forecast |`, new_text `| Q4 | $1.5M | Final |` — the value,
the Status-column mirroring and the exact row all resolved from the distilled
packet. The §13.2 follow-up bet holds.

## README samples — verbatim, for human judgment

Both §13.1 fixtures, recorded exactly as authored (no quality grading here;
structural notes are factual only).

### F08 — seed note ("write a README template document to begin")

Provenance: attempt 1's `new_text` — that call parsed but was **params-invalid**
(`edit_text` shell with `position: prepend`, no line span), so this content
never passed the gates. The retry truncated. 841 chars, verbatim:

```markdown
# README

## Overview
This is a template for the quarterly business review held on 14 November. It provides an overview of revenue quality, product execution, and decisions needed before the board meeting. Figures are provisional until finance sign-off.

## Getting Started
- Review the executive summary.
- Ensure finance confirms Q3 revenue by Friday.
- Prepare for board meeting discussions.

## Usage
This README serves as a structural guide to capture sections such as executive summary, revenue data, product notes, risks, follow-ups, and security actions in each quarter's review.

## Contributing
Contributors are encouraged to add new quarters or update existing entries. Use the same section headings and bullet style.

## License
This project is licensed under the applicable open source license. See the LICENSE file for details.
```

### F09 — bare `# Untitled` note (same command)

Provenance: attempt 1, **fully valid** (`edit_text` lines 1–1, anchor
`# Untitled`). 368 chars, verbatim:

```markdown
# README

## Overview
This document provides an overview of the quarterly review project and its objectives.

## Getting Started
Follow the steps below to begin the review process...

## Usage
Describe how to use the tools or data within this note...

## Contributing
Guidelines for contributing ideas, code, or updates...

## License
[Insert license information here]
```

## What this spike establishes

- The §6 packet works mechanically: the 1.7B reads the full numbered note and
  grounds real spans against it (6 exact-anchor hits, including a 5-line
  section removal and the bare-note README swap), and the §13.2 follow-up
  resolves from the distilled context packet. Authoring happens — F08's
  invalid-attempt README is on-brief content.
- The bar is missed on mechanics, not grounding alone: 3,000-token reasoning
  truncation (never a call), `edit_text` gravity that drags insert/remove
  intents into the wrong schema (parse-ok, params-fail), and a retry policy
  that only recovers the error class it can spell out exactly (anchor text).
  41.7% first-try / 50% after policy against an 85% bar — E4 fails as run,
  and the failure taxonomy is the actionable output: output-budget/reasoning
  length, tool-schema disambiguation in the packet, and a retry message
  format that cannot be echoed literally are the Phase-3 levers. The plan's
  own risk note (§12) holds: with the anchor gate live, every miss here is an
  honest error, not corruption.
