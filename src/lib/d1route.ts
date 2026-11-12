import type { D1DecideFn } from './d1check'
import type { D1Question } from './bridge'
import { noteOutline } from './omni'

/**
 * The d1 turn router for the Audio-first flow. Audio answers in plain chat
 * (no tools); d1 reads the command, Audio's reply, and the note outline, and
 * decides whether this turn wants a note edit — and which operation class.
 * A routed edit becomes a harness directive (`instruction` is the verbatim
 * command; the worker grounds the span itself); anything else settles as
 * conversation. Ambiguity is a first-class outcome: low confidence or an
 * `ambiguous` intent never routes — the user rephrases, nothing executes.
 */

/** Question ids as sent to d1. */
export const ROUTE_INTENT_QUESTION_ID = 'turn_intent'
export const ROUTE_CONFIDENCE_QUESTION_ID = 'intent_confidence'

/** The `turn_intent` choice values. Edit values double as directive tasks. */
export const ROUTE_CONVERSATIONAL = 'conversational'
export const ROUTE_AMBIGUOUS = 'ambiguous'
export const ROUTE_TASKS = ['create', 'insert', 'edit', 'remove'] as const
export type RouteTask = (typeof ROUTE_TASKS)[number]

/** Minimum `intent_confidence` noul score for routing to the worker. */
export const ROUTE_CONFIDENCE_MIN = 0.5

export const D1_ROUTE_QUESTIONS: Record<string, D1Question> = {
  turn_intent: {
    type: 'choice',
    instructions:
      'Does the user want the note changed in this turn? Classify the command: conversational for greetings, questions, opinions, hypotheticals, and requests to read or discuss the note; create/insert/edit/remove for requests to change the note in any way; ambiguous when the command could reasonably be either conversation or an edit.',
    criteria: {
      conversational:
        'no note change is asked for — greeting, question, opinion, hypothetical, read-back, or discussion of the note as it stands',
      create: 'author a new document or section skeleton that does not exist yet',
      insert: 'add new content without replacing or deleting existing lines',
      edit: 'change content that already exists — reword, fix a value, rename, revise',
      remove: 'delete existing content — a bullet, a row, or a whole section',
      ambiguous: 'could reasonably be conversation or an edit — do not guess which',
    },
  },
  intent_confidence: {
    type: 'noul',
    instructions:
      'How confident is the turn_intent classification? Score 1.0 when the command unmistakably means the chosen intent, 0.0 when it is a guess between two or more readings.',
  },
}

export interface D1RouteInput {
  /** The user's command for this turn, verbatim. */
  command: string
  /** Audio's settled chat reply for this turn. */
  audioReply: string
  /** Current note outline (headings only) — routing needs shape, not content. */
  note: string
  /** Last completed edit run, for continuity; null when none yet. */
  lastRun: { command: string; status: string } | null
  /** The d1 bridge — the real `d1Decide` in the pipeline, a mock in tests. */
  d1Decide: D1DecideFn
}

export type RouteIntent = RouteTask | typeof ROUTE_CONVERSATIONAL | typeof ROUTE_AMBIGUOUS

export interface D1RouteResult {
  intent: RouteIntent
  /** d1's measured `intent_confidence` score; null when unreported. */
  confidence: number | null
  /** True when the turn routes to the worker: a task intent at/above threshold. */
  routesToWorker: boolean
  /** Wall-clock duration of the route check, in ms. */
  ms: number
  /** Prompt tokens d1 reported for the route packet; absent when unreported. */
  promptTokens?: number
}

/** The routing state as d1 reads it: command, reply, outline, continuity. */
export function buildRouteState(input: Omit<D1RouteInput, 'd1Decide'>): string {
  const lines = [
    'Turn routing for a note workspace. Decide whether this turn wants a note edit.',
    '',
    `User command (verbatim): ${JSON.stringify(input.command)}`,
    `Assistant reply (verbatim): ${JSON.stringify(input.audioReply)}`,
    `Note outline: ${noteOutline(input.note)}`,
    input.lastRun
      ? `Last completed run: "${input.lastRun.command}" → ${input.lastRun.status}`
      : 'No edits have been committed yet this session.',
  ]
  return lines.join('\n')
}

/** Ask d1 whether this turn routes to the worker. Never throws: failures route to chat. */
export async function runD1Route(input: D1RouteInput): Promise<D1RouteResult> {
  const started = performance.now()
  const elapsedMs = () => Number((performance.now() - started).toFixed(1))
  const usage = () => (promptTokens ? { promptTokens } : {})
  const toChat = (intent: RouteIntent, confidence: number | null): D1RouteResult => ({
    intent,
    confidence,
    routesToWorker: false,
    ms: elapsedMs(),
    ...usage(),
  })

  let intent: RouteIntent = ROUTE_CONVERSATIONAL
  let confidence: number | null = null
  let promptTokens = 0
  try {
    const decision = await input.d1Decide({
      state: buildRouteState(input),
      questions: D1_ROUTE_QUESTIONS,
    })
    promptTokens = decision.usage?.promptTokens ?? 0
    const intentAnswer = decision.answers[ROUTE_INTENT_QUESTION_ID]
    const raw =
      intentAnswer !== undefined && intentAnswer.type === 'choice' ? intentAnswer.choice : null
    if (
      raw === ROUTE_CONVERSATIONAL ||
      raw === ROUTE_AMBIGUOUS ||
      (ROUTE_TASKS as readonly string[]).includes(raw ?? '')
    ) {
      intent = raw as RouteIntent
    }
    const confidenceAnswer = decision.answers[ROUTE_CONFIDENCE_QUESTION_ID]
    confidence =
      confidenceAnswer !== undefined &&
      confidenceAnswer.type === 'noul' &&
      typeof confidenceAnswer.noul === 'number'
        ? confidenceAnswer.noul
        : null
  } catch {
    return toChat(ROUTE_CONVERSATIONAL, null)
  }

  if (confidence === null) return toChat(intent, null)
  if (intent === ROUTE_CONVERSATIONAL || intent === ROUTE_AMBIGUOUS) return toChat(intent, confidence)
  if (confidence < ROUTE_CONFIDENCE_MIN) return toChat(intent, confidence)
  return { intent, confidence, routesToWorker: true, ms: elapsedMs(), ...usage() }
}
