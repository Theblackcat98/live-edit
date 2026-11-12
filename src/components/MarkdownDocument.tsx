import { useEffect, useMemo, useRef } from 'react'
import type { ExecutionDiff } from '../types'
import {
  blockIntersects,
  parseMarkdown,
  splitLines,
  type MarkdownBlock,
} from '../lib/doc'
import { cx } from '../lib/utils'
import { Inline, ListItemContent, MathBlock } from './markdown/InlineContent'

interface MarkdownDocumentProps {
  note: string
  diff: ExecutionDiff | null
}

export function MarkdownDocument({ note, diff }: MarkdownDocumentProps) {
  const blocks = useMemo(() => parseMarkdown(note), [note])
  const paperRef = useRef<HTMLDivElement | null>(null)
  const lineCount = useMemo(() => splitLines(note).length, [note])
  const diffRange = diff && diff.after.length > 0
    ? { start: diff.startLine, end: diff.startLine + diff.after.length - 1 }
    : null

  useEffect(() => {
    if (!diff) return
    const timer = window.setTimeout(() => {
      const paper = paperRef.current
      if (!paper) return
      const target = Array.from(paper.querySelectorAll<HTMLElement>('[data-line]')).find(
        (row) => Number(row.dataset.line) >= diff.startLine,
      )
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [diff])

  const blockDiff = (block: MarkdownBlock) =>
    Boolean(diffRange && blockIntersects(block, diffRange.start, diffRange.end))

  return (
    <div className="doc-paper" ref={paperRef}>
      <div className="doc-paper-head">
        <span className="doc-running-head mono">quarterly-review.md</span>
        <span className="doc-running-meta mono">{lineCount} lines</span>
      </div>

      {blocks.map((block) => {
        if (block.kind === 'blank') return null
        const key = `${block.kind}-${block.line}`

        if (block.kind === 'heading') {
          const section = block.title.match(/^(\d+)\.\s+(.*)$/)
          const title = (
            <Inline text={section ? section[2] : block.title} />
          )
          return (
            <div
              key={key}
              className={cx(
                'doc-block',
                'doc-heading-block',
                `doc-h${block.level}`,
                blockDiff(block) && 'is-diff',
              )}
              data-line={block.line}
              data-end-line={block.endLine}
            >
              <span className="doc-line-no">{block.line}</span>
              <div className="doc-heading-body">
                {section && <span className="doc-section-no mono">{section[1].padStart(2, '0')}</span>}
                {block.level === 1 ? (
                  <h1>{title}</h1>
                ) : block.level === 2 ? (
                  <h2>{title}</h2>
                ) : block.level === 3 ? (
                  <h3>{title}</h3>
                ) : (
                  <h4>{title}</h4>
                )}
              </div>
            </div>
          )
        }

        if (block.kind === 'paragraph') {
          return (
            <div
              key={key}
              className={cx('doc-block', 'doc-paragraph', blockDiff(block) && 'is-diff')}
              data-line={block.line}
              data-end-line={block.endLine}
            >
              <span className="doc-line-no">{block.line}</span>
              <div className="doc-body">
                <p>
                  <Inline text={block.text.replace(/\n/g, ' ')} />
                </p>
              </div>
            </div>
          )
        }

        if (block.kind === 'list') {
          return (
            <div
              key={key}
              className="doc-list"
              data-line={block.line}
              data-end-line={block.endLine}
            >
              {block.items.map((item) => {
                const itemDiff =
                  Boolean(diffRange) &&
                  item.line >= diffRange!.start &&
                  item.line <= diffRange!.end
                return (
                  <div
                    key={`${key}-${item.line}`}
                    className={cx(
                      'doc-block',
                      'doc-list-row',
                      itemDiff && 'is-diff',
                    )}
                    data-line={item.line}
                    data-end-line={item.line}
                  >
                    <span className="doc-line-no">{item.line}</span>
                    <div className="doc-body">
                      {block.ordered ? (
                        <span className="doc-list-marker doc-list-number mono">
                          {item.marker}
                        </span>
                      ) : (
                        <span className="doc-list-marker" aria-hidden="true" />
                      )}
                      <ListItemContent text={item.text} />
                    </div>
                  </div>
                )
              })}
            </div>
          )
        }

        if (block.kind === 'table') {
          const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.cells.length))
          return (
            <div
              key={key}
              className="doc-table-wrap"
              data-line={block.line}
              data-end-line={block.endLine}
              style={{ ['--table-columns' as string]: String(columnCount) }}
            >
              <div className="doc-table" role="table">
                <div
                  className={cx('doc-table-row', 'doc-table-header')}
                  role="row"
                  data-line={block.line}
                  data-end-line={block.line}
                >
                  <span className="doc-line-no">{block.line}</span>
                  {block.header.map((cell, index) => (
                    <div key={`${key}-h-${index}`} className="doc-table-cell" role="columnheader">
                      <Inline text={cell} />
                    </div>
                  ))}
                </div>
                {block.rows.map((row) => {
                  const rowDiff =
                    Boolean(diffRange) &&
                    row.line >= diffRange!.start &&
                    row.line <= diffRange!.end
                  return (
                    <div
                      key={`${key}-${row.line}`}
                      className={cx(
                        'doc-table-row',
                        rowDiff && 'is-diff',
                      )}
                      role="row"
                      data-line={row.line}
                      data-end-line={row.line}
                    >
                      <span className="doc-line-no">{row.line}</span>
                      {row.cells.map((cell, index) => (
                        <div key={`${key}-${row.line}-${index}`} className="doc-table-cell" role="cell">
                          <Inline text={cell} />
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        }

        if (block.kind === 'quote') {
          return (
            <div
              key={key}
              className={cx('doc-block', 'doc-quote', blockDiff(block) && 'is-diff')}
              data-line={block.line}
              data-end-line={block.endLine}
            >
              <span className="doc-line-no">{block.line}</span>
              <div className="doc-body">
                <blockquote>
                  <Inline text={block.text} />
                </blockquote>
              </div>
            </div>
          )
        }

        if (block.kind === 'code') {
          return (
            <div
              key={key}
              className={cx('doc-block', 'doc-code-block', blockDiff(block) && 'is-diff')}
              data-line={block.line}
              data-end-line={block.endLine}
            >
              <span className="doc-line-no">{block.line}</span>
              <div className="doc-body">
                <div className="doc-code-frame">
                  <span className="doc-code-lang mono">{block.lang || 'code'}</span>
                  <pre className="doc-code">
                    <code>{block.code}</code>
                  </pre>
                </div>
              </div>
            </div>
          )
        }

        if (block.kind === 'math') {
          return (
            <div
              key={key}
              className={cx('doc-block', 'doc-math-block', blockDiff(block) && 'is-diff')}
              data-line={block.line}
              data-end-line={block.endLine}
            >
              <span className="doc-line-no">{block.line}</span>
              <div className="doc-body">
                <MathBlock code={block.code} />
              </div>
            </div>
          )
        }

        if (block.kind === 'hr') {
          return (
            <div key={key} className="doc-hr" data-line={block.line} data-end-line={block.endLine}>
              <span className="doc-line-no">{block.line}</span>
              <span className="doc-hr-line" />
            </div>
          )
        }

        return null
      })}

      <div className="doc-end-mark" aria-hidden="true">
        <span />
        <span className="mono">END</span>
      </div>
    </div>
  )
}
