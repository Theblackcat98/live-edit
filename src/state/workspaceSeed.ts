import type { ContextUsage, Message } from '../types'
import { makeId } from '../lib/utils'

/**
 * Context usage on a fresh session: nothing measured yet. Each slot is
 * filled from the prompt size a model server reports on its first call —
 * the rail never shows an invented number as usage.
 */
export const INITIAL_CONTEXT: ContextUsage = { omni: 0, d1: 0, worker: 0 }

/** The two messages a fresh session starts with. */
export function initialMessages(): Message[] {
  const now = Date.now()
  return [
    {
      id: makeId('msg'),
      role: 'system',
      kind: 'notice',
      text: 'Session ready · local runtime',
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
