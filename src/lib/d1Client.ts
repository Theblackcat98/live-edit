/**
 * d1 decision model (`POST /v1/systemone`): typed questions in, typed answers
 * out. Used by the safety check and by span grounding.
 */

import type { D1Answer } from '../types'
import { isRecord, readNumber, readString } from './utils'
import { BridgeError, ENDPOINTS, fetchJson, modelUrl } from './endpoints'
import { usageOf, type TokenUsage } from './completion'

export type D1Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string }

export interface D1DecideResult {
  answers: Record<string, D1Answer>
  ms: number
  usage: TokenUsage
}

export function parseD1Answer(value: unknown): D1Answer | undefined {
  if (!isRecord(value)) return undefined
  switch (readString(value, 'type')) {
    case 'choice': {
      const choice = readString(value, 'choice')
      if (!choice) return undefined
      const probabilities: Record<string, number> = {}
      if (isRecord(value.probabilities)) {
        for (const [key, prob] of Object.entries(value.probabilities)) {
          if (typeof prob === 'number') probabilities[key] = prob
        }
      }
      return { type: 'choice', choice, probabilities }
    }
    case 'score': {
      const score = readNumber(value, 'score')
      return score == null ? undefined : { type: 'score', score }
    }
    case 'noul': {
      const noul = readNumber(value, 'noul')
      return noul == null ? undefined : { type: 'noul', noul }
    }
    default:
      return undefined
  }
}

export async function d1Decide(payload: {
  state?: string
  questions: Record<string, D1Question>
  /** Per-call deadline; span grounding uses a tighter budget than routing. */
  timeoutMs?: number
}): Promise<D1DecideResult> {
  const spec = ENDPOINTS.find((candidate) => candidate.id === 'd1omni')
  if (!spec) throw new BridgeError('d1 endpoint missing')
  const started = performance.now()
  const body: Record<string, unknown> = { questions: payload.questions }
  if (payload.state != null && payload.state.length) body.state = payload.state
  const result = await fetchJson(modelUrl(spec.port, '/v1/systemone'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: payload.timeoutMs ?? 30_000,
  })
  const answers: Record<string, D1Answer> = {}
  if (isRecord(result) && isRecord(result.answers)) {
    for (const [id, value] of Object.entries(result.answers)) {
      const answer = parseD1Answer(value)
      if (answer) answers[id] = answer
    }
  }
  if (!Object.keys(answers).length) throw new BridgeError('d1 returned no usable answers')
  return {
    answers,
    ms: Number((performance.now() - started).toFixed(1)),
    usage: usageOf(result),
  }
}
