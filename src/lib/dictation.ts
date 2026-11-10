import type { Directive } from '../types'

/**
 * Dictation backstop (battery case 8f): the dictation exception (§11)
 * fires when the directive carries `verbatim`, but that field is populated
 * by the front-door model — and on the 8f turn the model omitted it, so
 * quoted exact text went through a live worker decode and landed
 * paraphrased. The signal the model missed is deterministic in the user's
 * own command: the quoted span itself.
 *
 * When a directive has no verbatim and its task inserts new text
 * (insert/create), a quoted span in the raw command is recovered as the
 * dictated text. Edit/remove tasks never trigger recovery — quotes there
 * are references ("rename the title to …"), not dictation. Only the first
 * quoted span is considered, and trivia (under 2 non-space characters) is
 * not dictation.
 */
export function recoverDictatedText(command: string, directive: Directive): string | null {
  if (typeof directive.verbatim === 'string' && directive.verbatim.trim().length > 0) {
    return null
  }
  if (directive.task !== 'insert' && directive.task !== 'create') return null
  const match = /"([^"]+)"|“([^”]+)”/.exec(command)
  const quoted = (match?.[1] ?? match?.[2] ?? '').trim()
  if (quoted.replace(/\s/g, '').length < 2) return null
  return quoted
}
