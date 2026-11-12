import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutionDiff, Message, Snapshot, Toast } from '../types'
import { INITIAL_NOTE } from '../data/note'
import type { PersistedWorkspace } from '../lib/storage'
import type { RunResultSnapshot } from '../lib/pipeline'
import { makeId } from '../lib/utils'

type AddMessage = (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => string

interface HistoryArgs {
  persisted: PersistedWorkspace | null
  busyRef: { current: boolean }
  addMessage: AddMessage
  setDiff: (diff: ExecutionDiff | null) => void
  setSourceMode: (value: boolean) => void
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void
}

export interface WorkspaceHistoryApi {
  note: string
  /** Latest note text, readable synchronously by callbacks that outlive a render. */
  noteRef: { current: string }
  history: Snapshot[]
  historyIndex: number
  historyRef: { current: Snapshot[] }
  historyIndexRef: { current: number }
  commitNote: (nextNote: string, label: string, tool: string) => Snapshot
  restoreHistory: (targetIndex: number) => RunResultSnapshot
  undo: () => void
  redo: () => void
  restoreSnapshot: (id: string) => void
  applySourceEdit: (note: string) => boolean
  newNote: () => void
}

function initialSnapshot(): Snapshot {
  return {
    id: makeId('snap'),
    at: Date.now(),
    label: 'Session start',
    note: INITIAL_NOTE,
    tool: 'baseline',
    automatic: false,
  }
}

/**
 * The document and its snapshot stack: the note text, the undo/redo rail,
 * and the mutations that write both (verified edits, manual source edits,
 * new notes). `commitNote` and `restoreHistory` are also handed to the turn
 * pipeline, so the stack stays the single source of truth for a turn's
 * rollback.
 */
export function useWorkspaceHistory({
  persisted,
  busyRef,
  addMessage,
  setDiff,
  setSourceMode,
  notify,
}: HistoryArgs): WorkspaceHistoryApi {
  const initialSnapshotRef = useRef<Snapshot | null>(null)
  if (!initialSnapshotRef.current) initialSnapshotRef.current = initialSnapshot()

  const [note, setNote] = useState(persisted?.note ?? INITIAL_NOTE)
  const [history, setHistory] = useState<Snapshot[]>(() =>
    persisted?.snapshots.length ? persisted.snapshots : [initialSnapshotRef.current as Snapshot],
  )
  const [historyIndex, setHistoryIndex] = useState(() =>
    persisted?.snapshots.length ? persisted.snapshots.length - 1 : 0,
  )

  const noteRef = useRef(note)
  const historyRef = useRef(history)
  const historyIndexRef = useRef(historyIndex)

  useEffect(() => {
    noteRef.current = note
  }, [note])
  useEffect(() => {
    historyRef.current = history
  }, [history])
  useEffect(() => {
    historyIndexRef.current = historyIndex
  }, [historyIndex])

  const commitNote = useCallback(
    (nextNote: string, label: string, tool: string): Snapshot => {
      const base = historyRef.current
      const index = historyIndexRef.current
      const snapshot: Snapshot = {
        id: makeId('snap'),
        at: Date.now(),
        label,
        note: nextNote,
        tool,
        automatic: true,
      }
      const nextHistory = [...base.slice(0, index + 1), snapshot].slice(-40)
      const nextIndex = nextHistory.length - 1
      historyRef.current = nextHistory
      historyIndexRef.current = nextIndex
      setHistory(nextHistory)
      setHistoryIndex(nextIndex)
      noteRef.current = nextNote
      setNote(nextNote)
      return snapshot
    },
    [],
  )

  const restoreHistory = useCallback((targetIndex: number): RunResultSnapshot => {
    const currentHistory = historyRef.current
    const target = currentHistory[targetIndex]
    if (!target) {
      return { ok: false, message: 'No snapshot exists at that position.', note: noteRef.current }
    }
    historyIndexRef.current = targetIndex
    setHistoryIndex(targetIndex)
    noteRef.current = target.note
    setNote(target.note)
    setDiff(null)
    setSourceMode(false)
    return {
      ok: true,
      message: `Restored “${target.label}”.`,
      snapshot: target,
      note: target.note,
    }
  }, [setDiff, setSourceMode])

  const undo = useCallback(() => {
    if (busyRef.current) {
      notify('Still working', 'Wait for the current turn to finish.', 'neutral')
      return
    }
    const result = restoreHistory(historyIndexRef.current - 1)
    if (!result.ok) {
      notify('Nothing to undo', 'The note is already at its first snapshot.')
      return
    }
    notify('Snapshot restored', result.message, 'success')
  }, [busyRef, notify, restoreHistory])

  const redo = useCallback(() => {
    if (busyRef.current) {
      notify('Still working', 'Wait for the current turn to finish.', 'neutral')
      return
    }
    const result = restoreHistory(historyIndexRef.current + 1)
    if (!result.ok) {
      notify('Nothing to redo', 'The note is already at its latest snapshot.')
      return
    }
    notify('Snapshot reapplied', result.message, 'success')
  }, [busyRef, notify, restoreHistory])

  const restoreSnapshot = useCallback(
    (id: string) => {
      if (busyRef.current) {
        notify('Still working', 'Wait for the current turn to finish.', 'neutral')
        return
      }
      const index = historyRef.current.findIndex((snapshot) => snapshot.id === id)
      if (index < 0) return
      const result = restoreHistory(index)
      if (result.ok) notify('Snapshot restored', result.message, 'success')
    },
    [busyRef, notify, restoreHistory],
  )

  const applySourceEdit = useCallback(
    (nextNote: string): boolean => {
      if (busyRef.current) {
        notify('Still working', 'Wait for the current turn to finish before editing.', 'neutral')
        return false
      }
      if (nextNote === noteRef.current) return false
      commitNote(nextNote, 'Manual source edit', 'manual')
      setDiff(null)
      addMessage({
        role: 'system',
        kind: 'notice',
        text: 'Manual source edit committed · new snapshot',
      })
      notify('Source edit committed', 'A local snapshot was added to the history rail.', 'success')
      return true
    },
    [addMessage, busyRef, commitNote, notify, setDiff],
  )

  const newNote = useCallback(() => {
    if (busyRef.current) {
      notify(
        'Still working',
        'Wait for the current turn to finish before starting a new note.',
        'neutral',
      )
      return
    }
    commitNote('# Untitled\n\n', 'New note', 'manual')
    setDiff(null)
    setSourceMode(false)
    notify(
      'New note',
      'A blank note replaced the document. Undo restores the previous note.',
      'success',
    )
  }, [busyRef, commitNote, notify, setDiff, setSourceMode])

  return {
    note,
    noteRef,
    history,
    historyIndex,
    historyRef,
    historyIndexRef,
    commitNote,
    restoreHistory,
    undo,
    redo,
    restoreSnapshot,
    applySourceEdit,
    newNote,
  }
}
