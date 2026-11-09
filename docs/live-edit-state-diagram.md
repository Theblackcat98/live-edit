# Live-edit — turn state diagram (corrected design, 2026-11-09)

State view of a live-edit turn **under the corrected Omni-first design in
[`design.md`](./design.md)**: the workspace sits in Listening, every turn goes
to Omni, and a turn either resolves in Omni (answer, clarification), or flows
through silent delegation to the worker, the hard gates and the d1 check, and
— on disapproval — the PendingUser state, where the user adjudicates with
✓ / ✗. Snapshot rollback is a harness action with no model in the loop. This
supersedes the 2026-11-08 state diagram of the shipped supervisor-first
pipeline (Routing / Grounding / Critic gate states). Mermaid stateDiagram-v2,
validated with `mermaid.parse()` (Mermaid 11, diagram type: stateDiagram) on
2026-11-09. The target design is **not yet implemented** (design.md §12).

```mermaid
stateDiagram-v2
    state "Listening — user talking, frame live" as Listening
    state "Omni turn — hearing, seeing, deciding" as OmniTurn
    state "Worker authoring — directive + context + note" as WorkerAuthoring
    state "d1 check — approve or disapprove the call" as D1Check
    state "Pending user — diff shown, check or X" as PendingUser
    state "Executing — hard gates, apply, snapshot" as Executing

    [*] --> Listening
    Listening --> OmniTurn: voice (ASR by Omni) or typed turn
    OmniTurn --> Listening: Omni answers directly, no delegation
    OmniTurn --> Listening: Omni asks a clarifying question
    OmniTurn --> WorkerAuthoring: Omni silently delegates (typed directive)
    WorkerAuthoring --> D1Check: worker emits a tool call, hard gates pass
    WorkerAuthoring --> Listening: worker cannot form a call — Omni reports it
    D1Check --> Executing: d1 approves
    D1Check --> PendingUser: d1 disapproves — proposal, not a dead end
    D1Check --> PendingUser: d1 unreachable — user decides instead
    PendingUser --> Executing: user taps check (hard gates re-run)
    PendingUser --> Listening: user taps X — proposal discarded, logged
    Executing --> Listening: snapshot committed, Omni confirms to user
    Listening --> Listening: undo — snapshot rollback, no models
```
