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
 * dictated text. A directive whose task is edit/remove but whose command
 * carries a quoted span is the same model error in the other direction
 * (battery case 8f, rep 3: Omni tasks an add-line command as edit with no
 * verbatim, the worker paraphrases the quoted payload and d1 approves the
 * mismatch) — the quoted span is recovered there too, and the pipeline's
 * verbatim guard reroutes the turn to the harness-built add_text. Quotes
 * inside a genuinely edit-shaped command ("rename the title to …") still
 * never trigger recovery: the span must read as a dictated line, not a
 * reference — enforced by requiring the command to also carry an
 * insertion verb (add/append/insert/create/write). Only the first quoted
 * span is considered, and trivia (under 2 non-space characters) is not
 * dictation.
 */
const INSERTION_VERBS = /\b(add|append|insert|create|write)\b/i
export function recoverDictatedText(command: string, directive: Directive): string | null {
  if (typeof directive.verbatim === 'string' && directive.verbatim.trim().length > 0) {
    return null
  }
  const match = /"([^"]+)"|“([^”]+)”/.exec(command)
  const quoted = (match?.[1] ?? match?.[2] ?? '').trim()
  if (quoted.replace(/\s/g, '').length < 2) return null
  if (directive.task === 'insert' || directive.task === 'create') return quoted
  // Quoted span under an edit/remove task: only dictation-shaped commands
  // (insertion verb + quoted line) recover — references never do.
  if (!INSERTION_VERBS.test(command)) return null
  return quoted
 }
