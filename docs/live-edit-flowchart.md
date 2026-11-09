# Live-edit — command flowchart (corrected design, 2026-11-09)

Decision-flow view of one live-edit command **under the corrected Omni-first
design in [`design.md`](./design.md)**: the user talks to Omni, Omni answers or
silently delegates a typed directive to the 1.7B worker, the worker authors the
tool call, hard gates and then d1 check it, and a d1 disapproval becomes a
pending edit the user adjudicates — plus the model-free undo lane. This
supersedes the 2026-11-08 flowchart of the shipped supervisor-first pipeline
(d1 routing, deterministic span/content authoring). Mermaid flowchart,
validated with `mermaid.parse()` (Mermaid 11, diagram type: flowchart-v2) on
2026-11-09. The target design is **not yet implemented** (design.md §12).

```mermaid
flowchart TD
    Start(["User turn — voice or typed, frame attached when relevant"]) --> Voice{"Voice input?"}
    Voice -->|Yes| ASR["Omni-2B transcribes the WAV<br/>via /v1/audio/transcriptions"]
    Voice -->|No| OMNI
    ASR --> OMNI["Omni turn — conversation, frame,<br/>note state. Only user-facing model"]
    OMNI --> Decide{"Omni decides"}
    Decide -->|Answer| Reply["Omni replies in chat / TTS"]
    Reply --> Done(["Turn ends"])
    Decide -->|Unclear| Clarify["Omni asks a clarifying question"]
    Clarify --> Done
    Decide -->|Delegate — silent| Directive["Typed directive intercepted by harness<br/>delegation card shown in UI"]
    Directive --> Packet["Worker packet assembled<br/>directive + last-3-edit-turns context packet<br/>+ full line-numbered note"]
    Packet --> Worker["LFM3-1.7B worker AUTHORS the edit<br/>and emits one XML tool call"]
    Worker -->|Cannot form a call| Fail["Omni tells the user<br/>no fallback authors content"]
    Fail --> Done
    Worker --> Gates{"Hard gates — schema, bounds,<br/>exact anchor, blast radius"}
    Gates -->|Fail| Stale["Edit returned with explanation<br/>never a check / X choice"]
    Stale --> Done
    Gates -->|Pass| D1{"d1-Omni safety check<br/>directive + command + call + diff + frame"}
    D1 -->|Approves| Apply["Execution engine applies the edit<br/>atomically and pushes a snapshot"]
    D1 -->|Disapproves| Pending["Pending edit — diff + d1 reason shown"]
    D1 -->|Unreachable| Pending
    Pending --> UserPick{"User adjudicates"}
    UserPick -->|Check| ReGates{"Hard gates re-run<br/>against the current note"}
    ReGates -->|Pass| Apply
    ReGates -->|Fail| Stale
    UserPick -->|X| Discard["Proposal discarded<br/>logged to rejected traces"]
    Discard --> Done
    Apply --> Confirm["Omni confirms from the execution result"]
    Confirm --> Updated(["Note updated in place"])
    Undo(["User says undo"]) --> Rollback["Snapshot rollback<br/>harness action — bypasses worker and d1"]
    Rollback --> Restored(["Previous note restored"])
```
