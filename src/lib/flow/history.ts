/**
 * Prior-turn history for the two chat flows, built from the transcript and the
 * recorded runs:
 *
 * - Omni/Audio history (design.md §6): answer turns contribute their visible
 *   reply; delegation turns contribute the recorded directive as a tool
 *   record — never harness prose, never another turn's internals.
 * - Worker-chat history: recent (command, reply) pairs replayed as chat turns.
 */

import type { Message, Trace } from '../../types'
import type { OmniHistoryTurn } from '../omni'

/**
 * Recent (user command, assistant reply) pairs replayed as chat turns.
 * A turn with no visible assistant reply contributes only its command.
 */
export interface ChatTurn {
  command: string
  reply?: string
}

/** How many prior turns the conversational model sees. */
export const CHAT_MEMORY_TURNS = 6

/**
 * Pair each user message with the last assistant reply before the next user
 * message. A trailing user turn (the command being submitted) has no reply yet
 * and is therefore never replayed as history.
 */
export function conversationTurns(messages: Message[], limit: number): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'user' || !message.text.trim()) continue
    let reply: Message | null = null
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor]
      if (candidate.role === 'user') break
      if (candidate.role === 'assistant' && candidate.text.trim()) reply = candidate
    }
    turns.push({
      command: message.text,
      reply: reply?.text,
    })
  }
  return turns.slice(-limit)
}

/**
 * Audio's history (design.md §6), assembled from the transcript and the
 * recorded runs: answer turns contribute their visible reply; delegation
 * turns contribute the recorded directive as a tool record — never harness
 * prose, never another turn's internals.
 */
export function buildOmniHistory(messages: Message[], runs: Trace[]): OmniHistoryTurn[] {
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const turns: OmniHistoryTurn[] = []
  let current: OmniHistoryTurn | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      current = { command: message.text }
      turns.push(current)
      continue
    }
    if (!current) continue
    // Delegation cards are 'tool' messages; replies are 'assistant' ones.
    if (message.role !== 'assistant' && message.role !== 'tool') continue
    const run = message.runId ? runsById.get(message.runId) : undefined
    if (message.delegation && run?.directive && !current.delegation) {
      current.delegation = {
        tool: 'delegate_edit',
        arguments: JSON.stringify(run.directive),
        result: run.status === 'verified' ? 'Executed' : 'Execution failed',
      }
    } else if (!current.reply && !current.delegation && message.text && message.kind !== 'error') {
      // Execution/result confirmations belong to a run (runId set) — they
      // are harness prose, never model-authored chat. Accept one as the
      // turn's reply only when it carries no run pairing (an unpaired
      // confirmation has no delegation to hang off, so dropping it would
      // lose the turn entirely); a run-paired confirmation whose run also
      // produced a delegation card contributes nothing beyond the tool
      // record (battery case 21: replaying it visibly taught the front
      // door plain-text delegation, measured 4/4 server-side).
      const pairedRun = message.runId ? runsById.get(message.runId) : undefined
      if (message.role === 'assistant' && message.runId && pairedRun?.directive) continue
      current.reply = message.text
    }
  }
  return turns.filter((turn) => turn.command.trim().length > 0)
}

/** Last completed edit run, as both chat flows report it for continuity. */
export interface LastEditRun {
  command: string
  status: string
  /** The run's execution message, when it has one. */
  message?: string
}

/**
 * The last run that actually attempted an edit. Conversational/chat turns
 * carry no edit state, and replaying one ("Last completed run: hey →
 * conversational") teaches the front door that chat turns are delegations
 * (measured: greeting delegated 3/3 with the line present, answered 3/3
 * without it). Only verified and pending runs (real edit attempts) count.
 */
export function lastEditRun(runs: Trace[]): LastEditRun | null {
  const run = runs.find((candidate) => candidate.status === 'verified' || candidate.status === 'pending')
  if (!run) return null
  return {
    command: run.command,
    status: run.status,
    ...(run.execution?.message ? { message: run.execution.message } : {}),
  }
}
