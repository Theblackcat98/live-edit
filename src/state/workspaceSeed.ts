import type { ContextUsage, Message } from '../types'
import { INITIAL_NOTE } from '../data/note'
import { estimateTokens, makeId } from '../lib/utils'

const initialNoteTokens = estimateTokens(INITIAL_NOTE)

/** Context-usage estimate on a fresh session, before any turn runs. */
export const INITIAL_CONTEXT: ContextUsage = {
  omni: initialNoteTokens + 620,
  d1: initialNoteTokens * 2 + 1450,
  worker: Math.round(initialNoteTokens * 0.35) + 900,
}

/** The two messages a fresh session starts with. */
export function initialMessages(): Message[] {
  const now = Date.now()
  return [
    {
      id: makeId('msg'),
      role: 'system',
      kind: 'notice',
      text: 'Session ready · local runtime · audio input ready',
      at: now - 800,
    },
    {
      id: makeId('msg'),
      role: 'assistant',
      author: 'harness',
      kind: 'greeting',
      text: "I'm reading your note. Tell me what to change.",
      at: now - 400,
    },
  ]
}
