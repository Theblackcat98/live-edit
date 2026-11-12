/**
 * The one turn outcome the pipeline branches on. Each flow adapts its model
 * client's raw result into this shape, so the branch logic never reads a
 * client-specific result type.
 *
 * `call` is the worker-chat path's parsed tool call (the model chose the tool
 * itself); `directive` is the Audio path's typed delegation. Exactly one is
 * present on a delegate outcome.
 */

import type { Directive, OmniTurnResult } from '../../types'
import type { ParsedToolCall } from '../xml'
import type { WorkerChatTurnResult } from '../workerChat'

export type ChatOutcome = 'answer' | 'clarify' | 'delegate' | 'action'

export interface ChatTurnResult {
  outcome: ChatOutcome
  /** Sanitized visible text for answer/clarify. */
  text?: string
  /** The worker-chat path's parsed call (present iff outcome = delegate). */
  call?: ParsedToolCall
  /** The Audio path's validated directive (present iff outcome = delegate). */
  directive?: Directive
  /** The Audio path's harness action (present iff outcome = action). */
  action?: 'undo' | 'redo'
  ms: number
  promptTokens?: number
  outputTokens?: number
  /** Omni repair diagnostics (validation error + raw arguments), when any. */
  repair?: { error: string; rawArguments: string }
  /** The reply stopped at the max_tokens cap (finish_reason "length"). */
  truncated?: boolean
  /** Worker-chat reasoning channel, when the reply emitted one. */
  think?: string
}

/** Adapt one Audio-first turn result. */
export function chatTurnFromOmni(result: OmniTurnResult): ChatTurnResult {
  return {
    outcome: result.outcome,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.directive ? { directive: result.directive } : {}),
    ...(result.action ? { action: result.action } : {}),
    ...(result.repair ? { repair: result.repair } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ms: result.ms,
    ...(result.promptTokens ? { promptTokens: result.promptTokens } : {}),
    ...(result.outputTokens ? { outputTokens: result.outputTokens } : {}),
  }
}

/**
 * Adapt one worker-chat turn result. An unusable reply (`invalid`) has no
 * outcome to branch on: the caller retries once, then fails honestly — so the
 * adapter reports null instead of inventing a fifth branch.
 */
export function chatTurnFromWorker(result: WorkerChatTurnResult): ChatTurnResult | null {
  if (result.outcome === 'invalid') return null
  return {
    outcome: result.outcome,
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.call ? { call: result.call } : {}),
    ...(result.think !== undefined ? { think: result.think } : {}),
    ms: result.ms,
    ...(result.promptTokens ? { promptTokens: result.promptTokens } : {}),
    ...(result.outputTokens ? { outputTokens: result.outputTokens } : {}),
  }
}
