import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutionDiff, Message, PendingEdit, RejectedTraceRecord, Snapshot, Toast } from '../types'
import type { PersistedWorkspace } from '../lib/storage'
import {
  adjudicate,
  enqueue,
  fromStorable,
  type PendingAdjudication,
} from '../lib/pending'
import { noteHash } from '../lib/context'
import { executeTool } from '../lib/tools'

type AddMessage = (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => string

interface PendingArgs {
  persisted: PersistedWorkspace | null
  busyRef: { current: boolean }
  noteRef: { current: string }
  commitNote: (nextNote: string, label: string, tool: string) => Snapshot
  setDiff: (diff: ExecutionDiff | null) => void
  scheduleHighlightClear: () => void
  addMessage: AddMessage
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void
  /** Append to the rejected-traces log; the trace module owns that state. */
  appendRejectedTrace: (record: RejectedTraceRecord) => void
}

export interface WorkspacePendingApi {
  pendingEdits: PendingEdit[]
  addPendingEdit: (pending: PendingEdit) => void
  applyPendingEdit: (id: string) => void
  dismissPendingEdit: (id: string) => void
}

/**
 * The rejected-traces record for a resolved pending edit (§9.5). Grounding
 * is honestly marked `pending-adjudication`: the user, not a grounding
 * pass, made this call.
 */
export function pendingResolutionRecord(edit: PendingEdit, reason: string): RejectedTraceRecord {
  return {
    at: Date.now(),
    command: edit.directive.instruction,
    route: { tool: edit.call.name, provenance: 'pending edit adjudication' },
    grounding: { source: 'pending-adjudication' },
    workerXml: edit.call.xml,
    critic: { verdict: 'rejected', reason, pCorrect: edit.d1.noul },
    directive: edit.directive,
    // §9.5: the record carries the proposal — directive, call, AND the d1
    // verdict that routed it to adjudication (battery case 32: the verdict
    // was dropped here even though the type has the field).
    d1: edit.d1,
  }
}

/**
 * Pending-edit adjudication (design.md §9). Adjudication is not a turn: it
 * respects the same busy gate as undo and never runs the pipeline. The store
 * (lib/pending) decides; this hook executes an approved call and keeps the
 * records. The rejected-traces log belongs to the trace module, so records
 * reach it through the orchestrator's append callback.
 */
export function useWorkspacePending({
  persisted,
  busyRef,
  noteRef,
  commitNote,
  setDiff,
  scheduleHighlightClear,
  addMessage,
  notify,
  appendRejectedTrace,
}: PendingArgs): WorkspacePendingApi {
  // Reloaded pendings pass through pending.ts's defensive per-entry
  // validation — a malformed entry drops out instead of bricking the queue.
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>(() =>
    fromStorable(persisted?.pendingEdits ?? []),
  )
  const pendingEditsRef = useRef<PendingEdit[]>(pendingEdits)

  useEffect(() => {
    pendingEditsRef.current = pendingEdits
  }, [pendingEdits])

  const addPendingEdit = useCallback((pending: PendingEdit) => {
    setPendingEdits((previous) => enqueue(previous, pending))
  }, [])

  const resolvePending = useCallback(
    (id: string, decision: 'apply' | 'discard') => {
      const edit = pendingEditsRef.current.find((entry) => entry.id === id)
      if (!edit || edit.status !== 'pending') return
      const outcome: PendingAdjudication = adjudicate(edit, decision, noteRef.current, { noteHash })
      setPendingEdits((previous) =>
        previous.map((entry) => (entry.id === id ? outcome.edit : entry)),
      )
      if (outcome.status === 'applied' && outcome.call) {
        const execution = executeTool(
          noteRef.current,
          outcome.call,
          edit.overrideBlastRadius ? { overrideBlastRadius: true } : {},
        )
        if (!execution.ok) {
          // The store gate-validated the call; the engine refusing anyway is
          // a drift between the two — surface it honestly, write nothing.
          setPendingEdits((previous) =>
            previous.map((entry) =>
              entry.id === id ? { ...entry, status: 'stale' as const } : entry,
            ),
          )
          appendRejectedTrace(
            pendingResolutionRecord(outcome.edit, `Engine refused at execution: ${execution.message}`),
          )
          addMessage({
            role: 'assistant',
            author: 'harness',
            kind: 'error',
            text: `That pending edit passed the gates but the engine refused it: ${execution.message} Nothing was written.`,
          })
          return
        }
        commitNote(execution.note, `Pending edit approved · ${outcome.call.name}`, outcome.call.name)
        setDiff(execution.diff ?? null)
        scheduleHighlightClear()
        addMessage({
          role: 'assistant',
          author: 'harness',
          kind: 'result',
          text: `Applied the pending ${outcome.call.name} edit you approved.`,
        })
        notify('Pending edit applied', execution.message, 'success')
        return
      }
      // stale or discarded: nothing written; the proposal joins the
      // rejected-traces log (§9.5).
      appendRejectedTrace(
        pendingResolutionRecord(
          outcome.edit,
          outcome.status === 'discarded'
            ? 'Discarded by the user at adjudication (design.md §9).'
            : outcome.reason,
        ),
      )
      addMessage({
        role: 'assistant',
        author: 'harness',
        kind: 'notice',
        text:
          outcome.status === 'stale'
            ? `That pending edit went stale and was not applied. ${outcome.reason}`
            : 'Discarded the pending edit. The note was not touched.',
      })
      if (outcome.status === 'stale') notify('Pending edit went stale', outcome.reason, 'error')
    },
    [addMessage, appendRejectedTrace, commitNote, noteRef, notify, scheduleHighlightClear, setDiff],
  )

  const applyPendingEdit = useCallback(
    (id: string) => {
      if (busyRef.current) {
        notify('Worker is busy', 'Wait for the current turn to finish before applying a pending edit.', 'neutral')
        return
      }
      resolvePending(id, 'apply')
    },
    [busyRef, notify, resolvePending],
  )

  const dismissPendingEdit = useCallback(
    (id: string) => {
      resolvePending(id, 'discard')
    },
    [resolvePending],
  )

  return { pendingEdits, addPendingEdit, applyPendingEdit, dismissPendingEdit }
}
