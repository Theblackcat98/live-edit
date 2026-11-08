import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import katex from 'katex'
import type { ExecutionDiff, SpanTarget } from '../types'
import {
  blockIntersects,
  parseMarkdown,
  splitLines,
  type MarkdownBlock,
} from '../lib/doc'
import { cx } from '../lib/utils'

interface MarkdownDocumentProps {
  note: string
  span: SpanTarget | null
  diff: ExecutionDiff | null
}

const INLINE_TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

function inlineNodes(text: string): ReactNode[] {
  INLINE_TOKEN.lastIndex = 0
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = INLINE_TOKEN.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const token = match[0]
    key += 1
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      nodes.push(
        link ? (
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          token
        ),
      )
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    } else {
      nodes.push(token)
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function Inline({ text }: { text: string }) {
  return <>{inlineNodes(text)}</>
}

function MathBlock({ code }: { code: string }) {
  const markup = useMemo(() => {
    try {
      return katex.renderToString(code, {
        displayMode: true,
        throwOnError: false,
        strict: false,
      })
    } catch {
      return null
    }
  }, [code])

  if (!markup) {
    return (
      <pre className="doc-code">
        <code>{code}</code>
      </pre>
    )
  }
  return <div className="doc-math" dangerouslySetInnerHTML={{ __html: markup }} />
}

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span className={cx('doc-checkbox', checked && 'is-checked')} aria-hidden="true">
      {checked ? '✓' : ''}
    </span>
  )
}

function ListItemContent({ text }: { text: string }) {
  const task = text.match(/^\[( |x|X)\]\s+(.*)$/)
  if (task) {
    return (
      <span className="doc-list-text">
        <Checkbox checked={task[1].toLowerCase() === 'x'} />
        <Inline text={task[2]} />
      </span>
    )
  }
  return (
    <span className="doc-list-text">
      <Inline text={text} />
    </span>
  )
}

export function MarkdownDocument({ note, span, diff }: MarkdownDocumentProps) {
  const blocks = useMemo(() => parseMarkdown(note), [note])
  const paperRef = useRef<HTMLDivElement | null>(null)
  const lineCount = useMemo(() => splitLines(note).length, [note])
  const diffRange = diff && diff.after.length > 0
    ? { start: diff.startLine, end: diff.startLine + diff.after.length - 1 }
    : null

  useEffect(() => {
    if (!span) return
    const timer = window.setTimeout(() => {
      const paper = paperRef.current
      if (!paper) return
      const rows = Array.from(paper.querySelectorAll<HTMLElement>('[data-line]'))
      let target = rows.find(
        (row) => Number(row.dataset.line) === span.startLine,
      )
      if (!target) {
        target = rows.find((row) => {
          const start = Number(row.dataset.line)
          const end = Number(row.dataset.endLine ?? row.dataset.line)
          return span.startLine >= start && span.startLine <= end
        })
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [span?.startLine, span?.endLine, span])

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

  const blockTarget = (block: MarkdownBlock) =>
    Boolean(span && blockIntersects(block, span.startLine, span.endLine))
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
                blockTarget(block) && 'is-target',
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
              className={cx('doc-block', 'doc-paragraph', blockTarget(block) && 'is-target', blockDiff(block) && 'is-diff')}
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
                const itemTarget =
                  Boolean(span) && item.line >= span!.startLine && item.line <= span!.endLine
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
                      itemTarget && 'is-target',
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
                  const rowTarget =
                    Boolean(span) && row.line >= span!.startLine && row.line <= span!.endLine
                  const rowDiff =
                    Boolean(diffRange) &&
                    row.line >= diffRange!.start &&
                    row.line <= diffRange!.end
                  return (
                    <div
                      key={`${key}-${row.line}`}
                      className={cx(
                        'doc-table-row',
                        rowTarget && 'is-target',
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
              className={cx('doc-block', 'doc-quote', blockTarget(block) && 'is-target', blockDiff(block) && 'is-diff')}
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
              className={cx('doc-block', 'doc-code-block', blockTarget(block) && 'is-target', blockDiff(block) && 'is-diff')}
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
              className={cx('doc-block', 'doc-math-block', blockTarget(block) && 'is-target', blockDiff(block) && 'is-diff')}
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
