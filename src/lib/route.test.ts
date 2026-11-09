import { describe, expect, it } from 'vitest'
import type { D1Answer } from '../types'
import { routeFromAnswers } from './route'

/**
 * Audit TD-04: when d1's server omits the probability distribution, the typed
 * choice is still the decision — but its score must be null (unreported), never
 * an invented 0.7/0.6/0.9. Unreported satisfies every adoption-level consumer
 * (pruning, retry, critic membership) and fails only decisive gates.
 */
describe('routeFromAnswers: unreported distributions (audit TD-04)', () => {
  it('marks the chosen tool and action as null (unreported) when d1 omits probabilities', () => {
    const answers: Record<string, D1Answer> = {
      action: { type: 'choice', choice: 'file_mutation' },
      tool: { type: 'choice', choice: 'edit_text' },
    }
    const route = routeFromAnswers(answers)
    expect(route).not.toBeNull()
    expect(route?.action).toBe('file_mutation')
    // The typed choice still adopts as the primary tool.
    expect(route?.primaryTool).toBe('edit_text')
    expect(route?.actionConfidence).toBeNull()
    const chosen = route?.allowedTools.find((tool) => tool.name === 'edit_text')
    expect(chosen?.p).toBeNull()
    // Only the tool d1 actually picked is unreported; the others read as zeros
    // from the missing distribution and are pruned.
    const others = route?.allowedTools.filter((tool) => tool.name !== 'edit_text') ?? []
    expect(others).toEqual([])
  })

  it('keeps a live route with unreported probabilities instead of downgrading to the regex router', () => {
    const answers: Record<string, D1Answer> = {
      action: { type: 'choice', choice: 'file_mutation' },
      tool: { type: 'choice', choice: 'remove_text' },
    }
    expect(routeFromAnswers(answers)?.primaryTool).toBe('remove_text')
  })
})

describe('routeFromAnswers: measured distributions pass through verbatim (audit TD-04)', () => {
  it('never floors a measured score — the old Math.max(p, 0.6) inflation is gone', () => {
    const answers: Record<string, D1Answer> = {
      action: {
        type: 'choice',
        choice: 'file_mutation',
        probabilities: { file_mutation: 0.82, conversational_only: 0.18 },
      },
      tool: {
        type: 'choice',
        choice: 'edit_text',
        probabilities: { edit_text: 0.05, remove_text: 0.02, add_text: 0 },
      },
    }
    const route = routeFromAnswers(answers)
    expect(route?.actionConfidence).toBe(0.82)
    // The distribution's argmax (edit_text at a measured 0.05) is the primary
    // tool and its low measured score survives untouched — nothing lifts it to
    // a confident-looking 0.6.
    expect(route?.primaryTool).toBe('edit_text')
    expect(route?.allowedTools.find((tool) => tool.name === 'edit_text')?.p).toBe(0.05)
    expect(route?.allowedTools).toHaveLength(1)
  })

  it('passes multi-tool distributions through with real pruning', () => {
    const answers: Record<string, D1Answer> = {
      action: { type: 'choice', choice: 'file_mutation' },
      tool: {
        type: 'choice',
        choice: 'edit_text',
        probabilities: { edit_text: 0.71, remove_text: 0.2, add_text: 0.01 },
      },
    }
    const route = routeFromAnswers(answers)
    expect(route?.primaryTool).toBe('edit_text')
    expect(route?.allowedTools.find((tool) => tool.name === 'edit_text')?.p).toBe(0.71)
    expect(route?.allowedTools.find((tool) => tool.name === 'remove_text')?.p).toBe(0.2)
    expect(route?.allowedTools.find((tool) => tool.name === 'add_text')).toBeUndefined()
  })

  it('still returns null when nothing decodable arrived', () => {
    expect(routeFromAnswers({})).toBeNull()
    expect(routeFromAnswers({ action: { type: 'score', score: 0.5 } })).toBeNull()
    expect(
      routeFromAnswers({
        action: { type: 'choice', choice: 'nonsense_class' },
      }),
    ).toBeNull()
  })
})
