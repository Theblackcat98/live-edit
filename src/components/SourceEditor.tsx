import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { AlertTriangle, Check, Code2, RotateCcw } from 'lucide-react'
import { cx } from '../lib/utils'

interface SourceEditorProps {
  note: string
  draft: string
  dirty: boolean
  stale: boolean
  busy: boolean
  onChange: (value: string) => void
  onApply: () => void
  onDiscard: () => void
  onReload: () => void
}

export function SourceEditor({
  note,
  draft,
  dirty,
  stale,
  busy,
  onChange,
  onApply,
  onDiscard,
  onReload,
}: SourceEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1 })

  const lines = useMemo(() => draft.split('\n'), [draft])
  const lineCount = lines.length
  const characterCount = draft.length

  const updateCursor = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    const before = draft.slice(0, textarea.selectionStart)
    const split = before.split('\n')
    setCursor({ line: split.length, column: (split[split.length - 1]?.length ?? 0) + 1 })
  }

  const syncScroll = () => {
    const textarea = textareaRef.current
    const gutter = gutterRef.current
    if (textarea && gutter) gutter.scrollTop = textarea.scrollTop
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (dirty && !busy) onApply()
    }
    window.requestAnimationFrame(updateCursor)
  }

  return (
    <div className="source-page">
      <div className="source-toolbar">
        <div className="source-title">
          <Code2 size={13} />
          <span>Markdown source</span>
          {dirty && <span className="source-dirty-dot" title="Uncommitted draft" />}
        </div>
        <div className="source-toolbar-meta mono">
          {lineCount} lines · {characterCount.toLocaleString()} chars · Ln {cursor.line}, Col{' '}
          {cursor.column}
        </div>
        <div className="source-actions">
          {dirty && (
            <button type="button" className="button button-quiet" onClick={onDiscard} disabled={busy}>
              <RotateCcw size={11} />
              Discard
            </button>
          )}
          <button
            type="button"
            className="button button-primary source-apply"
            onClick={onApply}
            disabled={!dirty || busy}
            title="Commit draft (⌘/Ctrl + Enter)"
          >
            <Check size={11} />
            Apply changes
          </button>
        </div>
      </div>

      {stale && (
        <div className="source-stale">
          <AlertTriangle size={12} />
          <span>The worker changed the note while this draft was open.</span>
          <button type="button" className="source-stale-action" onClick={onReload}>
            Load latest
          </button>
        </div>
      )}

      <div className="source-editor">
        <div className="source-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <span key={index} className={cx('source-line-no', index + 1 === cursor.line && 'is-current')}>
              {index + 1}
            </span>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="source-textarea"
          value={draft}
          onChange={(event) => {
            onChange(event.target.value)
            window.requestAnimationFrame(updateCursor)
          }}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onSelect={updateCursor}
          spellCheck={false}
          wrap="off"
          aria-label="Markdown source editor"
        />
      </div>

      <div className="source-status">
        <span className="mono">
          {dirty ? 'Draft not committed' : 'Source matches the active snapshot'}
        </span>
        <span className="source-status-note">
          {busy ? 'Worker is busy — apply is paused' : '⌘/Ctrl + Enter to apply'}
        </span>
        <span className="mono">
          {note === draft ? 'No changes' : `${draft.length - note.length >= 0 ? '+' : ''}${draft.length - note.length} chars`}
        </span>
      </div>
    </div>
  )
}
