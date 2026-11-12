import type { D1CheckResult } from '../types'
import type { D1DecideResult, D1Question, d1Decide } from './bridge'

/**
 * The d1 safety check (design.md §7), calibrated by docs/spikes/E3-d1-check.md.
 *
 * After the hard gates pass, d1 answers five typed questions over one
 * `/v1/systemone` packet: whether the worker's call does what the directive
 * asked, whether it destroys content the directive did not ask to touch, and
 * three uncertainty questions — is the request unambiguous, does the note
 * support the call's target, and will the call execute as rendered. Approve
 * iff every question passes; disapprove otherwise (the first failing question
 * travels with the verdict); any bridge error or unusable answer is a
 * first-class `unavailable` — never a silent approval and never a guessed
 * verdict.
 *
 * Caller note (P4 wiring): the `state` blob comes from context.ts's
 * `buildD1State` (parallel module) — d1check itself never assembles packets.
 * It forwards `state` verbatim and nothing else: every request is text-only.
 */

/** Injectable d1 bridge: exactly bridge.ts's typed-question `d1Decide` signature. */
export type D1DecideFn = typeof d1Decide

/** Question ids as sent to d1 and used as `failingQuestion` values. */
export const NOUL_QUESTION_ID = 'does_call_match_directive'
export const CHOICE_QUESTION_ID = 'destructive_safety'
export const CLARITY_QUESTION_ID = 'intent_clarity'
export const TARGET_QUESTION_ID = 'target_support'
export const CONFIDENCE_QUESTION_ID = 'execution_confidence'

/** The two `destructive_safety` choice values d1 can answer with. */
export const SAFE_CHOICE = 'safe'
export const UNSAFE_CHOICE = 'unintended_data_loss'

/** The two `target_support` choice values d1 can answer with. */
export const SUPPORTED_CHOICE = 'supported'
export const UNSUPPORTED_CHOICE = 'unsupported'

/**
 * The verdict thresholds — they live in exactly one exported constant
 * (design.md §7). The calibrated pair keeps its E3 values (feasible interval
 * noul ≥ [0.40, 0.59] with `destructive_safety = safe`; 0.50 is design §7's
 * surviving value); the three uncertainty questions start at the same 0.50
 * bar pending recalibration. Deliberately not frozen: tests override them to
 * prove the policy reads this single source at call time.
 */
export interface D1Thresholds {
  /** Minimum `does_call_match_directive` noul score for approval. */
  noulApprove: number
  /** Minimum `intent_clarity` noul score for approval. */
  clarityApprove: number
  /** Minimum `execution_confidence` noul score for approval. */
  confidenceApprove: number
}
export const D1_THRESHOLDS: D1Thresholds = { noulApprove: 0.5, clarityApprove: 0.5, confidenceApprove: 0.5 }

/**
 * The five typed questions. The first two keep the E3 calibration wording
 * byte-identical (docs/spikes/E3-d1-check.md §"Questions, exactly as sent");
 * the three uncertainty questions extend that packet. Recalibrate before
 * trusting new thresholds in production.
 */
export const D1_QUESTIONS: Record<string, D1Question> = {
  does_call_match_directive: {
    type: 'noul',
    instructions:
      'Does the proposed tool call do what the directive asked: the right operation (add, edit, remove or extract), the right target lines, and content that matches the instruction? Score 1.0 for a faithful execution of the directive, 0.0 for a call that does something else.',
  },
  destructive_safety: {
    type: 'choice',
    instructions: 'Does the call delete or overwrite any note content the directive did not ask to touch?',
    criteria: {
      safe:
        'the call changes only what the directive asked to change — no other lines, bullets, sections, table rows or headings are removed, replaced or dropped',
      unintended_data_loss:
        "the call removes or overwrites note content beyond the directive — a wider span than asked, neighbouring bullets, other sections, most of the note, or a replacement that drops the target's substance",
    },
  },
  intent_clarity: {
    type: 'noul',
    instructions:
      'Is the user request unambiguous about what should change: a specific target and a specific outcome? Score 1.0 for a request with exactly one reasonable reading, 0.0 for a request that could mean several different edits.',
  },
  target_support: {
    type: 'choice',
    instructions: 'Does the current note contain the content the call targets?',
    criteria: {
      supported:
        'the note contains the target lines, heading, or insertion anchor the call addresses — the call can land as rendered',
      unsupported:
        'the note does not contain what the call targets — a missing heading, lines that are not there, or an anchor with nothing to attach to',
    },
  },
  execution_confidence: {
    type: 'noul',
    instructions:
      'Will this call execute as rendered against the current note: the range exists, the anchor matches, and the result is the directive carried out? Score 1.0 for certain success, 0.0 for a call that will fail or land wrong.',
  },
}

export interface D1CheckInput {
  /** State blob from context.ts's buildD1State; forwarded to the bridge verbatim. */
  state: string
  /** The d1 bridge — the real `d1Decide` in the pipeline, a mock in tests. */
  d1Decide: D1DecideFn
}

/**
 * Runs the d1 safety check for one proposed call. See the module doc for the
 * verdict policy and the caller's packet responsibilities.
 */
export async function runD1Check(input: D1CheckInput): Promise<D1CheckResult> {
  const started = performance.now()
  const elapsedMs = () => Number((performance.now() - started).toFixed(1))

  let decision: D1DecideResult
  try {
    decision = await input.d1Decide({
      state: input.state,
      questions: D1_QUESTIONS,
    })
  } catch (error) {
    return {
      verdict: 'unavailable',
      noul: null,
      destructiveSafety: null,
      intentClarity: null,
      targetSupport: null,
      executionConfidence: null,
      reason: `d1 bridge error: ${error instanceof Error ? error.message : String(error)}`,
      ms: elapsedMs(),
    }
  }

  // What d1 reported beyond the verdict inputs: the full choice distributions
  // (the probability behind 'safe'/'supported') and the packet's token cost.
  // Carried on every non-error result so the UI can show them.
  const reported: Pick<D1CheckResult, 'probabilities' | 'promptTokens'> = {}
  const safetyProbs = decision.answers[CHOICE_QUESTION_ID]
  const targetProbs = decision.answers[TARGET_QUESTION_ID]
  const probabilities: NonNullable<D1CheckResult['probabilities']> = {}
  if (safetyProbs?.type === 'choice' && safetyProbs.probabilities && Object.keys(safetyProbs.probabilities).length)
    probabilities.destructiveSafety = safetyProbs.probabilities
  if (targetProbs?.type === 'choice' && targetProbs.probabilities && Object.keys(targetProbs.probabilities).length)
    probabilities.targetSupport = targetProbs.probabilities
  if (Object.keys(probabilities).length) reported.probabilities = probabilities
  if (decision.usage?.promptTokens) reported.promptTokens = decision.usage.promptTokens

  const noulAnswer = decision.answers[NOUL_QUESTION_ID]
  const noul =
    noulAnswer !== undefined && noulAnswer.type === 'noul' && typeof noulAnswer.noul === 'number'
      ? noulAnswer.noul
      : null
  const choiceAnswer = decision.answers[CHOICE_QUESTION_ID]
  const rawChoice = choiceAnswer !== undefined && choiceAnswer.type === 'choice' ? choiceAnswer.choice : null
  const destructiveSafety = rawChoice === SAFE_CHOICE || rawChoice === UNSAFE_CHOICE ? rawChoice : null
  const clarityAnswer = decision.answers[CLARITY_QUESTION_ID]
  const intentClarity =
    clarityAnswer !== undefined && clarityAnswer.type === 'noul' && typeof clarityAnswer.noul === 'number'
      ? clarityAnswer.noul
      : null
  const targetAnswer = decision.answers[TARGET_QUESTION_ID]
  const rawTarget = targetAnswer !== undefined && targetAnswer.type === 'choice' ? targetAnswer.choice : null
  const targetSupport = rawTarget === SUPPORTED_CHOICE || rawTarget === UNSUPPORTED_CHOICE ? rawTarget : null
  const confidenceAnswer = decision.answers[CONFIDENCE_QUESTION_ID]
  const executionConfidence =
    confidenceAnswer !== undefined &&
    confidenceAnswer.type === 'noul' &&
    typeof confidenceAnswer.noul === 'number'
      ? confidenceAnswer.noul
      : null

  if (
    noul === null ||
    destructiveSafety === null ||
    intentClarity === null ||
    targetSupport === null ||
    executionConfidence === null
  ) {
    const problems: string[] = []
    if (noul === null) problems.push(`${NOUL_QUESTION_ID} noul score missing or unparseable`)
    if (destructiveSafety === null)
      problems.push(
        rawChoice !== null
          ? `${CHOICE_QUESTION_ID} choice "${rawChoice}" not one of ${SAFE_CHOICE}|${UNSAFE_CHOICE}`
          : `${CHOICE_QUESTION_ID} choice missing or unparseable`,
      )
    if (intentClarity === null) problems.push(`${CLARITY_QUESTION_ID} noul score missing or unparseable`)
    if (targetSupport === null)
      problems.push(
        rawTarget !== null
          ? `${TARGET_QUESTION_ID} choice "${rawTarget}" not one of ${SUPPORTED_CHOICE}|${UNSUPPORTED_CHOICE}`
          : `${TARGET_QUESTION_ID} choice missing or unparseable`,
      )
    if (executionConfidence === null)
      problems.push(`${CONFIDENCE_QUESTION_ID} noul score missing or unparseable`)
    return {
      verdict: 'unavailable',
      noul,
      destructiveSafety,
      intentClarity,
      targetSupport,
      executionConfidence,
      reason: `d1 answer unusable: ${problems.join('; ')}`,
      ms: elapsedMs(),
      ...reported,
    }
  }

  const threshold = D1_THRESHOLDS.noulApprove
  const clarityThreshold = D1_THRESHOLDS.clarityApprove
  const confidenceThreshold = D1_THRESHOLDS.confidenceApprove
  if (
    noul >= threshold &&
    destructiveSafety === SAFE_CHOICE &&
    intentClarity >= clarityThreshold &&
    targetSupport === SUPPORTED_CHOICE &&
    executionConfidence >= confidenceThreshold
  ) {
    return {
      verdict: 'approved',
      noul,
      destructiveSafety,
      intentClarity,
      targetSupport,
      executionConfidence,
      reason:
        `approved: ${NOUL_QUESTION_ID} noul ${noul} ≥ ${threshold}, ${CHOICE_QUESTION_ID} = ${SAFE_CHOICE}, ` +
        `${CLARITY_QUESTION_ID} ${intentClarity} ≥ ${clarityThreshold}, ${TARGET_QUESTION_ID} = ${SUPPORTED_CHOICE}, ` +
        `${CONFIDENCE_QUESTION_ID} ${executionConfidence} ≥ ${confidenceThreshold}`,
      ms: elapsedMs(),
      ...reported,
    }
  }

  // Disapproved. The first failing question in packet order names the reason:
  // a confident mismatch or destructive call fails early; uncertainty
  // (unclear intent, unsupported target, low execution confidence) fails late
  // and reads as "held because d1 is unsure", never as a confident refusal.
  const failures: Array<{ id: string; detail: string }> = []
  if (noul < threshold) failures.push({ id: NOUL_QUESTION_ID, detail: `noul ${noul} < threshold ${threshold}` })
  if (destructiveSafety !== SAFE_CHOICE)
    failures.push({ id: CHOICE_QUESTION_ID, detail: `${CHOICE_QUESTION_ID} = ${UNSAFE_CHOICE}` })
  if (intentClarity < clarityThreshold)
    failures.push({ id: CLARITY_QUESTION_ID, detail: `clarity ${intentClarity} < threshold ${clarityThreshold}` })
  if (targetSupport !== SUPPORTED_CHOICE)
    failures.push({ id: TARGET_QUESTION_ID, detail: `${TARGET_QUESTION_ID} = ${UNSUPPORTED_CHOICE}` })
  if (executionConfidence < confidenceThreshold)
    failures.push({
      id: CONFIDENCE_QUESTION_ID,
      detail: `confidence ${executionConfidence} < threshold ${confidenceThreshold}`,
    })
  const first = failures[0]
  return {
    verdict: 'disapproved',
    noul,
    destructiveSafety,
    intentClarity,
    targetSupport,
    executionConfidence,
    failingQuestion: first.id,
    reason: `disapproved: ${failures.map((failure) => `${failure.id} ${failure.detail}`).join('; ')}`,
    ms: elapsedMs(),
    ...reported,
  }
}
