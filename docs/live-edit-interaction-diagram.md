# Live-edit — user and model interaction diagram (corrected design, 2026-11-09)

How a turn travels from the user to Audio, and — when Audio delegates — to the
1.7B worker and the d1 safety check, **under the corrected Audio-first design
in [`design.md`](./design.md)** (interface model: LFM3-Audio-2B :8086; the
2026-11-10 decision made Audio the default front door — turns are text-only,
no camera or screen frames). Sequence diagram in Mermaid, validated with
`mermaid.parse()` (Mermaid 11, diagram type: sequence) on 2026-11-09. This
supersedes the 2026-11-08 diagram of the shipped supervisor-first pipeline:
there is no supervisor participant in this design — the harness is plumbing
(parsing, packets, hard gates, execution), and it never routes intent or
authors content. The target design is **not yet implemented** (design.md §12).

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Live-edit UI / harness<br/>(useWorkspace)
    participant AUDIO as LFM3-Audio-2B<br/>interface model, port 8086
    participant WRK as LFM3-1.7B<br/>worker model, port 8080
    participant D1 as d1-Omni-2B<br/>safety check, port 8085
    participant ENG as Execution engine<br/>(doc + snapshots)

    Note over User, UI: Input — talk or type
    User->>UI: Voice command (mic) or typed command
    opt Voice input
        UI->>AUDIO: 16 kHz WAV via /v1/audio/transcriptions
        AUDIO-->>UI: Transcript
    end
    UI->>AUDIO: Turn + conversation + note state

    alt Audio answers directly
        AUDIO-->>UI: Streamed reply
        opt Spoken replies on
            UI->>AUDIO: Reply text via /tts
            AUDIO-->>User: Spoken reply
        end
    else Audio needs clarification
        AUDIO-->>User: Clarifying question — no delegation yet
    else Audio delegates (silent tool call)
        AUDIO-->>UI: Typed directive (intercepted, never shown as text)
        UI-->>User: Delegation card — tool + one-line intent
        UI->>WRK: Directive + context packet (last 3 edit turns as outcomes) + full line-numbered note
        WRK-->>UI: XML tool call — worker authored the content and grounded its span
        alt Worker cannot form a call (2 attempts)
            UI->>AUDIO: Delegation failed
            AUDIO-->>User: Audio reports it — nothing is fabricated
        else Call formed
            UI->>UI: Hard gates — schema, bounds, exact anchor, blast radius
            alt Hard gate fails
                UI-->>User: Explanation — never a check / X choice
            else Gates pass
                UI->>D1: Directive + command + call + diff via /v1/systemone
                alt d1 approves
                    D1-->>UI: Approve (zero output tokens)
                    UI->>ENG: Apply edit atomically, push snapshot
                    ENG-->>UI: Execution result
                    UI->>AUDIO: Result as system event
                    AUDIO-->>User: Confirmation in Audio's words
                else d1 disapproves or is unreachable
                    D1-->>UI: Disapprove + scores + reason (or silence)
                    UI-->>User: Pending edit card — diff, d1 reason, check / X
                    alt User taps check
                        User->>UI: Check
                        UI->>UI: Hard gates re-run against the current note
                        UI->>ENG: Apply edit atomically, push snapshot
                        ENG-->>UI: Execution result
                        UI->>AUDIO: Result as system event
                        AUDIO-->>User: Confirmation in Audio's words
                    else User taps X
                        User->>UI: X
                        UI->>UI: Discard proposal, append to rejected traces
                    end
                end
            end
        end
    end

    opt User says undo
        User->>UI: Undo that
        UI->>ENG: Snapshot rollback (harness action, no models)
        ENG-->>User: Previous note restored
    end
```
