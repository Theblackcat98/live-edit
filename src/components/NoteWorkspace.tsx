import { useEffect, useRef, useState } from 'react'
import {
  Braces,
  Code2,
  FileText,
  FilePlus2,
  History,
  Redo2,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import type { ExecutionDiff, Snapshot, SpanTarget, Trace } from '../types'
import { countWords, cx, estimateTokens, relativeTime } from '../lib/utils'
import { MarkdownDocument } from './MarkdownDocument'
import { SourceEditor } from './SourceEditor'

interface NoteWorkspaceProps {
  note: string
  title: string
  path: string
  span: SpanTarget | null
  diff: ExecutionDiff | null
  busy: boolean
  sourceMode: boolean
  setSourceMode: (value: boolean) => void
  applySourceEdit: (note: string) => boolean
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  newNote: () => void
  history: Snapshot[]
  historyIndex: number
  trace: Trace | null
  openTrace: () => void
  nowTick: number
}

export function NoteWorkspace({
  note,
  title,
  path,
  span,
  diff,
  busy,
  sourceMode,
  setSourceMode,
  applySourceEdit,
  canUndo,
  canRedo,
  undo,
  redo,
  newNote,
  history,
  historyIndex,
  trace,
  openTrace,
  nowTick,
}: NoteWorkspaceProps) {
  const [draft, setDraft] = useState(note)
  const [dirty, setDirty] = useState(false)
  const [stale, setStale] = useState(false)
  const lastSyncedNote = useRef(note)

  useEffect(() => {
    if (!dirty) {
      setDraft(note)
      lastSyncedNote.current = note
      setStale(false)
      return
    }
    if (note !== lastSyncedNote.current) {
      lastSyncedNote.current = note
      setStale(true)
    }
  }, [note, dirty])

  const handleChange = (value: string) => {
    setDraft(value)
    setDirty(value !== note)
    if (value === note) setStale(false)
  }

  const handleApply = () => {
    if (!dirty || busy) return
    if (applySourceEdit(draft)) {
      setDirty(false)
      setStale(false)
    }
  }

  const handleDiscard = () => {
    setDraft(note)
    setDirty(false)
    setStale(false)
  }

  const handleReload = () => {
    setDraft(note)
    setDirty(false)
    setStale(false)
    lastSyncedNote.current = note
  }

  const tokens = estimateTokens(note)
  const words = countWords(note)
  const snapshot = history[historyIndex]
  const editedLabel =
    historyIndex > 0 ? `Edited ${relativeTime(snapshot?.at ?? Date.now(), nowTick)}` : 'Baseline snapshot'

  return (
    <section className="card note-card">
      <header className="note-header">
        <div className="note-identity">
          <span className="note-file-icon">
            <FileText size={15} />
          </span>
          <div className="note-title-stack">
            <div className="note-title-line">
              <h2>{title}</h2>
              <span className="note-format-chip mono">MD</span>
              <span className={cx('note-save-state', busy && 'is-working')}>
                <span className={cx('status-dot', busy ? 'is-accent is-pulsing' : 'is-green')} />
                {busy ? 'Worker active' : 'Local snapshot'}
              </span>
            </div>
            <span className="note-path mono">{path}</span>
          </div>
        </div>

        <div className="note-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={newNote}
            disabled={busy}
            aria-label="New note"
            title="New note (snapshots the current note first, so undo restores it)"
          >
            <FilePlus2 size={14} />
          </button>
          <div className="note-history-buttons">
            <button
              type="button"
              className="icon-button"
              onClick={undo}
              disabled={!canUndo || busy}
              aria-label="Undo last change"
              title="Undo (⌘/Ctrl + Z)"
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={redo}
              disabled={!canRedo || busy}
              aria-label="Redo change"
              title="Redo (⌘/Ctrl + Shift + Z)"
            >
              <Redo2 size={14} />
            </button>
          </div>
          <div className="note-header-divider" />
          <div className="view-switch" role="tablist" aria-label="Note view">
            <button
              type="button"
              role="tab"
              aria-selected={!sourceMode}
              aria-label="Document view"
              title="Document view"
              className={cx('view-tab', !sourceMode && 'is-active')}
              onClick={() => setSourceMode(false)}
            >
              <FileText size={11} />
              <span className="view-tab-label">Document</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sourceMode}
              aria-label="Markdown source view"
              title="Markdown source view"
              className={cx('view-tab', sourceMode && 'is-active')}
              onClick={() => setSourceMode(true)}
            >
              <Code2 size={11} />
              <span className="view-tab-label">Markdown</span>
              {dirty && <span className="view-dirty-dot" title="Uncommitted draft" />}
            </button>
          </div>
          <button
            type="button"
            className="icon-button note-trace-button"
            onClick={openTrace}
            disabled={!trace}
            aria-label="Open decision trace"
            title="Open decision trace"
          >
            <Braces size={14} />
          </button>
        </div>
      </header>

      <div className={cx('note-tray', sourceMode && 'is-source')}>
        {span && !sourceMode && (
          <div className="document-target-pill animate-pop-in">
            <span className="status-dot is-accent" />
            <span className="mono">
              d1 target · L{span.startLine}
              {span.endLine !== span.startLine ? `–${span.endLine}` : ''}
            </span>
            <span className="document-target-conf mono">
              P {span.confidence.toFixed(2)}
            </span>
          </div>
        )}
        {diff && !span && !sourceMode && (
          <div className="document-target-pill is-diff animate-pop-in">
            <span className="status-dot is-green" />
            <span className="mono">
              Applied · +{diff.added} / −{diff.removed}
            </span>
            <span className="document-target-conf mono">verified</span>
          </div>
        )}

        {sourceMode ? (
          <SourceEditor
            note={note}
            draft={draft}
            dirty={dirty}
            stale={stale}
            busy={busy}
            onChange={handleChange}
            onApply={handleApply}
            onDiscard={handleDiscard}
            onReload={handleReload}
          />
        ) : (
          <div className="document-scroll" data-testid="note-document">
            <MarkdownDocument note={note} span={span} diff={diff} />
          </div>
        )}
      </div>

      <footer className="note-footer">
        <span className="note-footer-stat">
          <span className="mono">{tokens.toLocaleString()}</span> tokens
        </span>
        <span className="note-footer-stat">
          <span className="mono">{words.toLocaleString()}</span> words
        </span>
        <span className="note-footer-sep" />
        <span className="note-footer-stat">{editedLabel}</span>
        <div className="note-footer-spacer" />
        <span className="note-footer-stat note-footer-snapshot">
          <History size={11} />
          Snapshot <span className="mono">{historyIndex}</span> of{' '}
          <span className="mono">{history.length - 1}</span>
        </span>
        <span className="note-footer-sep" />
        <span className="note-footer-local">
          <ShieldCheck size={11} />
          Local
        </span>
      </footer>
    </section>
  )
}
