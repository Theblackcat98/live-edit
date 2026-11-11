# Live-edit — turn state diagram (corrected design, 2026-11-09)

State view of a live-edit turn **under the corrected Audio-first design in
[`design.md`](./design.md)**: the workspace sits in Listening, every turn goes
to Audio, and a turn either resolves in Audio (answer, clarification), or flows
through silent delegation to the worker, the hard gates and the d1 check, and
— on disapproval — the PendingUser state, where the user adjudicates with
✓ / ✗. Snapshot rollback is a harness action with no model in the loop. This
supersedes the 2026-11-08 state diagram of the shipped supervisor-first
pipeline (Routing / Grounding / Critic gate states). Mermaid stateDiagram-v2,
validated with `mermaid.parse()` (Mermaid 11, diagram type: stateDiagram) on
2026-11-09. The target design is **not yet implemented** (design.md §12).

```mermaid
stateDiagram-v2
    state "Listening — user talking" as Listening
    state "Audio turn — hearing, deciding" as AudioTurn
    state "Worker authoring — directive + context + note" as WorkerAuthoring
    state "d1 check — approve or disapprove the call" as D1Check
    state "Pending user — diff shown, check or X" as PendingUser
    state "Executing — hard gates, apply, snapshot" as Executing

    [*] --> Listening
    Listening --> AudioTurn: voice (ASR by Audio) or typed turn
    AudioTurn --> Listening: Audio answers directly, no delegation
    AudioTurn --> Listening: Audio asks a clarifying question
    AudioTurn --> WorkerAuthoring: Audio silently delegates (typed directive)
    WorkerAuthoring --> D1Check: worker emits a tool call, hard gates pass
    WorkerAuthoring --> Listening: worker cannot form a call — Audio reports it
    D1Check --> Executing: d1 approves
    D1Check --> PendingUser: d1 disapproves — proposal, not a dead end
    D1Check --> PendingUser: d1 unreachable — user decides instead
    PendingUser --> Executing: user taps check (hard gates re-run)
    PendingUser --> Listening: user taps X — proposal discarded, logged
    Executing --> Listening: snapshot committed, Audio confirms to user
    Listening --> Listening: undo — snapshot rollback, no models
```
