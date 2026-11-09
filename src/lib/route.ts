/**
 * Live-route assembly: turns d1-Omni's /v1/systemone answers into a
 * RouteDecision. Pure — extracted from the workspace hook so the null
 * probability semantics are testable without React.
 */
import type { ActionClass, D1Answer, RouteDecision, ToolName, ToolScore } from '../types'

const ACTION_CLASSES: ActionClass[] = ['conversational_only', 'file_mutation', 'ambiguous_request']
const ROUTE_TOOLS: ToolName[] = ['edit_text', 'remove_text', 'add_text', 'extract_visual_to_note']

export function routeFromAnswers(answers: Record<string, D1Answer>): RouteDecision | null {
  const actionAnswer = answers.action
  if (!actionAnswer || actionAnswer.type !== 'choice') return null
  const action = actionAnswer.choice
  if (!action || !ACTION_CLASSES.includes(action as ActionClass)) return null

  const toolAnswer = answers.tool
  const probabilities =
    toolAnswer && toolAnswer.type === 'choice' ? (toolAnswer.probabilities ?? {}) : {}
  // d1's typed choice is the decision even when the server omits the
  // distribution. Reading only `probabilities` turned a confident live route
  // into `null` and silently downgraded the turn to the regex router.
  const chosenTool =
    toolAnswer &&
    toolAnswer.type === 'choice' &&
    ROUTE_TOOLS.includes(toolAnswer.choice as ToolName)
      ? (toolAnswer.choice as ToolName)
      : undefined
  const hasProbabilities = Object.values(probabilities).some((value) => value > 0)
  // When d1 reported no distribution, the chosen tool's score is null
  // (unreported) — never an invented number. The choice still adopts; the
  // trace renders it as unreported.
  const scored: ToolScore[] = ROUTE_TOOLS.map((name) => ({
    name,
    p: hasProbabilities ? (probabilities[name] ?? 0) : chosenTool === name ? null : 0,
  }))
  // Unreported (null) sorts as the adopted choice; it only ever belongs to the
  // tool d1 actually picked.
  const ranked = scored.sort((a, b) => (b.p ?? 1) - (a.p ?? 1))
  const best = ranked[0]
  const bestScore = best?.p ?? null
  if (action !== 'conversational_only' && (!best || (bestScore !== null && bestScore <= 0))) {
    return null
  }

  const primaryTool = action === 'conversational_only' ? undefined : best.name
  // Measured scores pass through verbatim — no floor inflates a number d1
  // actually reported, and an unreported choice stays null (null satisfies
  // every adoption-level gate downstream: pruning, retry, critic membership).
  const allowedTools =
    action === 'file_mutation'
      ? ranked.filter((tool) => tool.p === null || tool.p > 0.02)
      : []

  return {
    action: action as ActionClass,
    actionConfidence: actionAnswer.probabilities?.[action] ?? null,
    allowedTools,
    primaryTool,
    reason: `d1-Omni-2B typed decision over /v1/systemone: ${action}.`,
  }
}
