import type { Suggestion } from '../types'
import { truncate } from './utils'

/**
 * Command suggestions derived from the note the user is actually editing —
 * never hardcoded to a demo document.
 */
export function buildSuggestions(note: string): Suggestion[] {
  const lines = note.split('\n')
  const suggestions: Suggestion[] = [
    {
      icon: 'eye',
      label: 'What is in the note?',
      command: 'What is in the note?',
      mode: 'submit',
    },
  ]

  const tableRow = lines.find(
    (line) => /^\s*\|.*\d/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line),
  )
  if (tableRow) {
    const cells = tableRow
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
    if (cells.length) {
      suggestions.push({
        icon: 'table',
        label: `Update “${truncate(cells[0], 16)}”`,
        command: `Update the ${cells[0]} row to `,
        mode: 'draft',
      })
    }
  }

  const bullet = lines.find((line) => /^\s*[-*+]\s+\S/.test(line))
  if (bullet) {
    const text = bullet.replace(/^\s*[-*+]\s+/, '').trim()
    suggestions.push({
      icon: 'remove',
      label: `Remove “${truncate(text, 20)}”`,
      command: `Remove the bullet about ${text.split(/\s+/).slice(0, 4).join(' ')}`,
      mode: 'submit',
    })
  }

  const heading = lines.find((line) => /^#{2,6}\s+\S/.test(line))
  if (heading) {
    const title = heading.replace(/^#+\s+/, '').trim()
    suggestions.push({
      icon: 'scan',
      label: `Add under “${truncate(title, 18)}”`,
      command: `Add a note under ${title}: `,
      mode: 'draft',
    })
  }

  return suggestions
}
