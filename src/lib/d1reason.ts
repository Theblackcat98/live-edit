/**
 * Human copy for a d1 verdict (design.md §7/§9). The check's `reason` field
 * is a machine string — `disapproved: target_support = unsupported` — kept
 * verbatim in traces and the rejected-traces log where it belongs. The chat
 * card and the trace verdict card show people a sentence instead: this
 * module maps verdict + failing question to that sentence without inventing
 * anything the check did not report.
 *
 * Detection is two-stage because `PendingEdit['d1']` carries no
 * `failingQuestion` (it is not persisted): when the typed field is absent,
 * the failing id is recovered from the reason string in packet order — the
 * same order d1check.ts uses to name the first failing question.
 */

import {
  CHOICE_QUESTION_ID,
  CLARITY_QUESTION_ID,
  CONFIDENCE_QUESTION_ID,
  NOUL_QUESTION_ID,
  TARGET_QUESTION_ID,
} from './d1check'

/** Packet order — the order d1check.ts names failing questions in. */
export const D1_QUESTION_PACKET_ORDER = [
  NOUL_QUESTION_ID,
  CHOICE_QUESTION_ID,
  CLARITY_QUESTION_ID,
  TARGET_QUESTION_ID,
  CONFIDENCE_QUESTION_ID,
] as const

/** One human sentence per failing question (design.md §7 wording). */
export const D1_FAILURE_SENTENCES: Record<string, string> = {
  [NOUL_QUESTION_ID]: 'The proposed edit does not do what you asked.',
  [CHOICE_QUESTION_ID]: 'The edit would remove or change note content you did not ask to touch.',
  [CLARITY_QUESTION_ID]: 'The request could be read more than one way.',
  [TARGET_QUESTION_ID]:
    'The note does not contain what the edit targets — a missing heading, absent lines, or an anchor with nothing to attach to.',
  [CONFIDENCE_QUESTION_ID]: 'd1 is not confident the edit will land as written.',
}

/** Prefixes of d1check.ts machine reasons that are not human copy. */
const MACHINE_REASON_PREFIXES = ['disapproved: ', 'approved: ', 'd1 bridge error: ', 'd1 answer unusable: ']

export interface D1ReasonInput {
  verdict: 'approved' | 'disapproved' | 'unavailable'
  /** The check's typed failing question; absent on persisted pendings. */
  failingQuestion?: string
  /** The machine reason string, as recorded on the check / pending edit. */
  reason?: string
}

/**
 * The human sentence for a held edit, or null when this module has nothing
 * better than the caller's existing fallback. Null never means "hide the
 * verdict" — it means "no known shape; show what you already have".
 */
export function humanD1Reason(input: D1ReasonInput): string | null {
  if (input.verdict === 'disapproved') {
    const id =
      input.failingQuestion && D1_FAILURE_SENTENCES[input.failingQuestion]
        ? input.failingQuestion
        : D1_QUESTION_PACKET_ORDER.find((candidate) => input.reason?.includes(candidate))
    return id ? D1_FAILURE_SENTENCES[id] : null
  }
  if (input.verdict === 'approved') {
    // Reachable on a card only via the §8 blast-radius hold: d1 itself said
    // yes; the harness held the edit because of its size, not its content.
    return 'd1 approved the edit itself — it is held only because a change this large never runs silently.'
  }
  // Unavailable: a bridge/parse failure is a machine string (generic line);
  // the blast-radius and low-RAM holds hand-write human reasons — pass those
  // through verbatim rather than paraphrasing them.
  if (input.reason && !MACHINE_REASON_PREFIXES.some((prefix) => input.reason!.startsWith(prefix))) {
    return input.reason
  }
  return 'The safety model could not be consulted, so the decision is yours.'
}
