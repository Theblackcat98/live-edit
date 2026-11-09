export interface DocHeading {
  line: number
  level: number
  title: string
  raw: string
}

export interface ListItem {
  line: number
  marker: string
  text: string
}

export type MarkdownBlock =
  | {
      kind: 'heading'
      line: number
      endLine: number
      level: number
      title: string
      raw: string
    }
  | {
      kind: 'paragraph'
      line: number
      endLine: number
      text: string
      lines: { line: number; text: string }[]
    }
  | {
      kind: 'list'
      line: number
      endLine: number
      ordered: boolean
      items: ListItem[]
    }
  | {
      kind: 'table'
      line: number
      endLine: number
      header: string[]
      rows: { line: number; cells: string[] }[]
    }
  | {
      kind: 'quote'
      line: number
      endLine: number
      text: string
    }
  | {
      kind: 'code'
      line: number
      endLine: number
      lang: string
      code: string
    }
  | {
      kind: 'math'
      line: number
      endLine: number
      code: string
    }
  | {
      kind: 'hr'
      line: number
      endLine: number
    }
  | {
      kind: 'blank'
      line: number
      endLine: number
    }

export interface DocParagraph {
  line: number
  endLine: number
  text: string
}

export function splitLines(note: string): string[] {
  return note.split('\n')
}

/**
 * Stable content hash of a note (FNV-1a, hex). Used to detect staleness:
 * a pending edit (design.md §9) records the hash of the note its call was
 * authored against, and adjudication compares it against the current note
 * before the hard gates re-run. Deliberately tiny and deterministic — this
 * is an equality check, not a security primitive.
 */
export function noteHash(note: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < note.length; index += 1) {
    hash ^= note.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function parseHeading(raw: string): DocHeading | null {
  const match = raw.match(/^(#{1,6})\s+(.*)$/)
  if (!match) return null
  return {
    line: 0,
    level: match[1].length,
    title: match[2].trim(),
    raw,
  }
}

export function getHeadings(note: string): DocHeading[] {
  const lines = splitLines(note)
  const headings: DocHeading[] = []
  lines.forEach((line, index) => {
    const heading = parseHeading(line)
    if (heading) {
      headings.push({ ...heading, line: index + 1 })
    }
  })
  return headings
}

export function findHeading(note: string, query: string): DocHeading | null {
  const headings = getHeadings(note)
  const normalizedQuery = normalizeWhitespace(query).toLowerCase()
  if (!normalizedQuery) return null

  const exact = headings.find(
    (heading) => heading.title.toLowerCase() === normalizedQuery,
  )
  if (exact) return exact

  const strippedQuery = normalizedQuery.replace(/^#+\s*/, '')
  if (/^\d+$/.test(strippedQuery)) {
    const section = headings.find((heading) => {
      const match = heading.title.match(/^(\d+)\.\s/)
      return match ? Number(match[1]) === Number(strippedQuery) : false
    })
    return section ?? null
  }
  const contains = headings.find((heading) => {
    const title = heading.title.toLowerCase()
    return (
      title.includes(strippedQuery) ||
      strippedQuery.includes(title.replace(/^\d+\.\s*/, ''))
    )
  })
  if (contains) return contains

  const sectionNumber = strippedQuery.match(/^(?:section\s+)?(\d+)$/)
  if (sectionNumber) {
    return (
      headings.find((heading) =>
        heading.title.toLowerCase().startsWith(`${sectionNumber[1]}.`),
      ) ?? null
    )
  }

  const words = strippedQuery.split(/\s+/).filter((word) => word.length > 2)
  if (!words.length) return null
  let best: { heading: DocHeading; score: number } | null = null
  for (const heading of headings) {
    const title = heading.title.toLowerCase()
    const score = words.reduce(
      (total, word) => total + (title.includes(word) ? word.length : 0),
      0,
    )
    if (score > 0 && (!best || score > best.score)) {
      best = { heading, score }
    }
  }
  return best?.heading ?? null
}

export function findSectionEnd(note: string, heading: DocHeading): number {
  const lines = splitLines(note)
  for (let index = heading.line; index < lines.length; index += 1) {
    const next = parseHeading(lines[index])
    if (next && next.level <= heading.level) {
      return index + 1
    }
  }
  return lines.length + 1
}

export function lineAt(note: string, line: number): string {
  return splitLines(note)[line - 1] ?? ''
}

export function lineRangeExcerpt(note: string, startLine: number, endLine: number): string {
  return splitLines(note)
    .slice(startLine - 1, endLine)
    .join('\n')
    .trim()
}

export function getParagraphs(note: string): DocParagraph[] {
  const lines = splitLines(note)
  const paragraphs: DocParagraph[] = []
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const isPlain =
      line.trim() !== '' &&
      !/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||```|---|\*\*\*)/.test(line)
    if (isPlain && start === -1) start = index
    if ((!isPlain || index === lines.length - 1) && start !== -1) {
      const end = isPlain && index === lines.length - 1 ? index : index - 1
      paragraphs.push({
        line: start + 1,
        endLine: end + 1,
        text: lines.slice(start, end + 1).join('\n').trim(),
      })
      start = -1
    }
  }
  return paragraphs
}

export function getListItems(note: string): ListItem[] {
  const lines = splitLines(note)
  const items: ListItem[] = []
  lines.forEach((line, index) => {
    const match = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
    if (match) {
      items.push({ line: index + 1, marker: match[1], text: match[2].trim() })
    }
  })
  return items
}

export function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s+/.test(line)
}

export function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

export function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')
}

export function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

export function findLineByText(
  note: string,
  needle: string,
): { line: number; text: string } | null {
  const normalizedNeedle = normalizeWhitespace(needle).toLowerCase()
  if (!normalizedNeedle) return null
  const lines = splitLines(note)
  const foundIndex = lines.findIndex((line) =>
    normalizeWhitespace(line).toLowerCase().includes(normalizedNeedle),
  )
  if (foundIndex === -1) return null
  return { line: foundIndex + 1, text: lines[foundIndex] }
}

export function collapseBlankLines(lines: string[]): string[] {
  const collapsed: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && collapsed[collapsed.length - 1]?.trim() === '') continue
    collapsed.push(line)
  }
  while (collapsed.length && collapsed[0].trim() === '') collapsed.shift()
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === '') collapsed.pop()
  return collapsed
}

export function parseMarkdown(note: string): MarkdownBlock[] {
  const lines = splitLines(note)
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const raw = lines[index]
    const lineNumber = index + 1

    if (raw.trim() === '') {
      let end = index
      while (end + 1 < lines.length && lines[end + 1].trim() === '') end += 1
      blocks.push({ kind: 'blank', line: lineNumber, endLine: end + 1 })
      index = end + 1
      continue
    }

    const fence = raw.match(/^```(\w*)\s*$/)
    if (fence) {
      const lang = fence[1] ?? ''
      const codeLines: string[] = []
      let end = index + 1
      while (end < lines.length && !/^```\s*$/.test(lines[end])) {
        codeLines.push(lines[end])
        end += 1
      }
      blocks.push({
        kind: 'code',
        line: lineNumber,
        endLine: Math.min(end + 1, lines.length),
        lang,
        code: codeLines.join('\n'),
      })
      index = end + 1
      continue
    }

    if (raw.trim() === '$$') {
      const mathLines: string[] = []
      let end = index + 1
      while (end < lines.length && lines[end].trim() !== '$$') {
        mathLines.push(lines[end])
        end += 1
      }
      blocks.push({
        kind: 'math',
        line: lineNumber,
        endLine: Math.min(end + 1, lines.length),
        code: mathLines.join('\n'),
      })
      index = end + 1
      continue
    }

    const heading = parseHeading(raw)
    if (heading) {
      blocks.push({
        kind: 'heading',
        line: lineNumber,
        endLine: lineNumber,
        level: heading.level,
        title: heading.title,
        raw,
      })
      index += 1
      continue
    }

    if (isTableRow(raw)) {
      const header = parseTableRow(raw)
      const rows: { line: number; cells: string[] }[] = []
      let end = index
      if (
        index + 1 < lines.length &&
        isTableRow(lines[index + 1]) &&
        isTableSeparator(lines[index + 1])
      ) {
        end = index + 2
        while (end < lines.length && isTableRow(lines[end])) {
          rows.push({ line: end + 1, cells: parseTableRow(lines[end]) })
          end += 1
        }
      } else {
        end += 1
        while (end < lines.length && isTableRow(lines[end])) {
          rows.push({ line: end + 1, cells: parseTableRow(lines[end]) })
          end += 1
        }
      }
      blocks.push({
        kind: 'table',
        line: lineNumber,
        endLine: end,
        header,
        rows,
      })
      index = end
      continue
    }

    if (/^\s*>\s?/.test(raw)) {
      const quoteLines: string[] = []
      let end = index
      while (end < lines.length && /^\s*>\s?/.test(lines[end])) {
        quoteLines.push(lines[end].replace(/^\s*>\s?/, ''))
        end += 1
      }
      blocks.push({
        kind: 'quote',
        line: lineNumber,
        endLine: end,
        text: quoteLines.join(' '),
      })
      index = end
      continue
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(raw)) {
      const items: ListItem[] = []
      let end = index
      while (end < lines.length) {
        const match = lines[end].match(/^\s*([-*+]|\d+\.)\s+(.*)$/)
        if (!match) break
        items.push({ line: end + 1, marker: match[1], text: match[2].trim() })
        end += 1
      }
      blocks.push({
        kind: 'list',
        line: lineNumber,
        endLine: end,
        ordered: /^\s*\d+\./.test(raw),
        items,
      })
      index = end
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      blocks.push({ kind: 'hr', line: lineNumber, endLine: lineNumber })
      index += 1
      continue
    }

    const paragraphLines: { line: number; text: string }[] = []
    let end = index
    while (end < lines.length) {
      const candidate = lines[end]
      if (
        candidate.trim() === '' ||
        parseHeading(candidate) ||
        /^```/.test(candidate) ||
        candidate.trim() === '$$' ||
        /^\s*>\s?/.test(candidate) ||
        isTableRow(candidate) ||
        /^\s*([-*+]|\d+\.)\s+/.test(candidate) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(candidate)
      ) {
        break
      }
      paragraphLines.push({ line: end + 1, text: candidate })
      end += 1
    }
    blocks.push({
      kind: 'paragraph',
      line: lineNumber,
      endLine: end,
      text: paragraphLines.map((entry) => entry.text).join('\n'),
      lines: paragraphLines,
    })
    index = end
  }

  return blocks
}

export function blockIntersects(
  block: { line: number; endLine: number },
  start: number,
  end: number,
): boolean {
  return block.line <= end && block.endLine >= start
}

export function replaceLineRange(
  note: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const lines = splitLines(note)
  const insert = replacement.split('\n')
  return [...lines.slice(0, startLine - 1), ...insert, ...lines.slice(endLine)].join('\n')
}

export function removeLineRange(note: string, startLine: number, endLine: number): string {
  const lines = splitLines(note)
  const remaining = [...lines.slice(0, startLine - 1), ...lines.slice(endLine)]
  return collapseBlankLines(remaining).join('\n') + '\n'
}

export function insertLines(
  note: string,
  afterLine: number,
  content: string,
): { note: string; startLine: number; endLine: number } {
  const lines = splitLines(note)
  const contentLines = content.split('\n')
  const prefix = lines.slice(0, afterLine)
  const suffix = lines.slice(afterLine)
  if (prefix.length && prefix[prefix.length - 1].trim() !== '') prefix.push('')
  if (suffix.length && suffix[0]?.trim() !== '') suffix.unshift('')
  const nextLines = [...prefix, ...contentLines, ...suffix]
  return {
    note: nextLines.join('\n'),
    startLine: prefix.length + 1,
    endLine: prefix.length + contentLines.length,
  }
}
