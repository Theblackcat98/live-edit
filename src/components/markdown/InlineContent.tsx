import { useMemo } from 'react'
import type { ReactNode } from 'react'
import katex from 'katex'
import { cx } from '../../lib/utils'

/** Inline markdown: bold, italic, code, links. */
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

export function Inline({ text }: { text: string }) {
  return <>{inlineNodes(text)}</>
}

export function MathBlock({ code }: { code: string }) {
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

export function ListItemContent({ text }: { text: string }) {
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
