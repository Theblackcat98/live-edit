/**
 * The pending-edit store (design.md §9, architecture-refactor.md §9 step 1):
 * creation from a d1-disapproved/unavailable proposal, user adjudication
 * with the staleness rule, the FIFO queue, and the persistence shape
 * (decision D3 — pendings survive a reload, capped at the 10 most recent
 * non-resolved entries).
 *
 * Pure store logic — no React, no I/O. The store DECIDES; it never EXECUTES.
 * Executing an approved edit is the CALLER's job (the P5 wiring): an
 * `applied` adjudication carries the gate-validated `call` and the wiring
 * runs it through `executeTool` + `commitNote` exactly like an approved edit
 * from the old pipeline — same snapshot labelling, with the tool name in the
 * snapshot label (design.md §9: "pass → execute, snapshot, card resolves to
 * applied"). A `stale`/`discarded` adjudication writes nothing anywhere; the
 * CALLER appends the proposal (directive, call, d1 verdict) to the
 * rejected-traces JSONL (§9.5, architecture-refactor.md §9 step 5) — the
 * store only says so in the reason string; it does no logging itself.
 *
 * Staleness (design.md §8): on ✓ the hard gates re-run against the *current*
 * note via `runHardGates`. ANY hard-gate failure resolves the edit `stale`
 * with nothing written. Per §8's note-version rule, anchor exactness is what
 * decides — the recorded authoring hash explains the failure honestly: when
 * the current note hashes differently from the authoring hash, the reason
 * says the note changed ("the text this edit was written against has
 * changed", §8's wording); when the hash still matches but a gate fails
 * anyway, the reason says that instead — the store never claims drift it
 * cannot show.
 */

import type {
  Directive,
  DirectiveTarget,
  ExecutionDiff,
  PendingEdit,
  ToolName,
  WorkerCall,
  WorkerSampler,
} from '../types'
import { runHardGates } from './gates'
import { isRecord, makeId, readNumber, readString } from './utils'

/** makeId gives `pending-<Date.now base36>-<module counter base36>` — unique per creation, no Math.random (refactor grep gate). */
const ID_PREFIX = 'pending'

/**
 * Persistence cap (decision D3, architecture-refactor.md §9 step 2): at most
 * the 10 most recent non-resolved pendings are saved.
 */
export const MAX_PERSISTED_PENDING_EDITS = 10

/** Everything `createPendingEdit` needs; `d1` is already narrowed to the verdicts that route a call to adjudication. */
export interface PendingEditInput {
  /** The Omni directive that produced this proposal (recorded verbatim, §9). */
  directive: Directive
  /** The parsed worker tool call under adjudication. */
  call: WorkerCall
  /** The diff rendered against the note version the call was authored against. */
  diff: ExecutionDiff
  /** Hash of the note the call was authored against; staleness compares against the current note. */
  noteHash: string
  /**
   * The d1 result that routed this call here. Only `disapproved`/`unavailable`
   * can appear (an approved call executes directly and never becomes a
   * pending edit); the narrowed type makes an 'approved' verdict unrepresentable.
   */
  d1: PendingEdit['d1']
}

/**
 * The outcome of one user adjudication (design.md §9). This is the contract
 * the P5 wiring codes against:
 * - `applied` → execute `call` via executeTool + commitNote (same snapshot
 *   labelling as approved edits, tool name in the label), then resolve the
 *   card with `edit`.
 * - `stale` → nothing written; show `reason`; card resolves (§9: stale
 *   resolves the card); append the proposal to the rejected-traces log.
 * - `discarded` → nothing written; append the proposal to the rejected-traces
 *   log; card resolves.
 */
export interface PendingAdjudication {
  /** How the adjudication resolved. Never 'pending' — adjudication always resolves. */
  status: Exclude<PendingEdit['status'], 'pending'>
  /** The edit with its status updated (a new object; the input edit is never mutated). */
  edit: PendingEdit
  /** User-facing explanation (stale: which gate failed and why; discard: rejected-trace note). */
  reason: string
  /**
   * The gate-validated call to execute, present iff status = 'applied'.
   * Execution is the caller's job (executeTool + commitNote, same snapshot
   * labelling as approved edits) — the store never executes.
   */
  call?: WorkerCall
}

/**
 * Create a pending edit from a d1-rejected/unavailable proposal. The id is
 * deterministic per creation (Date.now + a module counter via makeId — no
 * Math.random); createdAt is the creation wall-clock in epoch ms. The edit
 * starts `pending` and modifies nothing — not the note, not the snapshot
 * stack, not the undo chain (design.md §9).
 */
export function createPendingEdit(input: PendingEditInput): PendingEdit {
  return {
    id: makeId(ID_PREFIX),
    createdAt: Date.now(),
    directive: input.directive,
    call: input.call,
    diff: input.diff,
    noteHash: input.noteHash,
    d1: input.d1,
    status: 'pending',
  }
}

/**
 * Adjudicate a pending edit (design.md §9 UI contract). Pure: the input edit
 * is never mutated — the result carries a new `edit` with the resolved
 * status, and the caller replaces the queued entry.
 *
 * - discard → `discarded`, nothing else happens in the store; the reason
 *   notes that the CALLER logs the proposal to the rejected-traces JSONL
 *   (§9.5) — the store performs no logging (pure, no I/O).
 * - apply → `runHardGates` re-runs against `currentNote` (§8: re-run on
 *   approval). Pass → `applied` with the validated call returned for the
 *   caller to execute (executeTool + commitNote, same snapshot labelling as
 *   approved edits). ANY failure → `stale`, nothing written, reason names the
 *   failed gate(s) and, when the note hash differs from the authoring hash,
 *   says the note changed — "the text this edit was written against has
 *   changed" (§8's wording).
 */
export function adjudicate(
  edit: PendingEdit,
  decision: 'apply' | 'discard',
  currentNote: string,
  deps: { noteHash: (note: string) => string },
): PendingAdjudication {
  if (decision === 'discard') {
    return {
      status: 'discarded',
      edit: { ...edit, status: 'discarded' },
      reason:
        `Pending edit ${edit.id} discarded; nothing was written. ` +
        'The caller appends the proposal (directive, call, d1 verdict) to the rejected-traces log (design.md §9.5).',
    }
  }

  // Hard gates re-run on approval (design.md §8), against the CURRENT note,
  // with no span override — the pending-edit world is worker-grounds-itself,
  // so anchor exactness compares against the note's own lines at the range.
  const gates = runHardGates(currentNote, edit.call)

  if (gates.pass) {
    return {
      status: 'applied',
      edit: { ...edit, status: 'applied' },
      reason:
        'Hard gates re-ran clean against the current note. ' +
        'The caller executes the call via executeTool + commitNote — same snapshot labelling as approved edits, with the tool name.',
      call: edit.call,
    }
  }

  const failedGates = gates.failures.map((failure) => failure.gate).join(', ')
  const details = gates.failures.map((failure) => failure.detail).join(' ')
  const currentHash = deps.noteHash(currentNote)
  const drifted = currentHash !== edit.noteHash
  const reason = drifted
    ? `Hard gates re-ran on approval and ${failedGates} failed — ${details} ` +
      `The note changed since the edit was authored (hash ${edit.noteHash} → ${currentHash}): ` +
      'the text this edit was written against has changed. ' +
      'Nothing was written; ask Omni to redo the edit against the current note.'
    : `Hard gates re-ran on approval and ${failedGates} failed — ${details} ` +
      'The note hash still matches the authoring hash, so this is a gate-rule failure rather than drift. ' +
      'Nothing was written.'

  return {
    status: 'stale',
    edit: { ...edit, status: 'stale' },
    reason,
  }
}

/**
 * FIFO append (design.md §9: pendings queue in arrival order; a new turn
 * never silently clears them). Pure array op — returns a new array.
 */
export function enqueue(existing: PendingEdit[], edit: PendingEdit): PendingEdit[] {
  return [...existing, edit]
}

/**
 * Persistence shape (decision D3): resolved pendings (applied / discarded /
 * stale) are NOT persisted — stale is also dropped on save, because per
 * design.md §9 a stale gate failure resolves the card, so there is nothing
 * left to adjudicate after a reload. Of the remaining pending entries, the
 * 10 most recent are kept (the queue's tail — arrival order, since enqueue
 * is FIFO). Pure; returns a new array.
 */
export function toStorable(edits: PendingEdit[]): PendingEdit[] {
  return edits
    .filter((edit) => edit.status === 'pending')
    .slice(-MAX_PERSISTED_PENDING_EDITS)
}

/**
 * Reload shape (decision D3): validate every entry defensively — malformed
 * entries are dropped, never thrown — so an old or corrupt payload cannot
 * brick the workspace (storage.ts's best-effort discipline, applied per
 * entry instead of per payload). Only genuinely `pending` entries come back:
 * a resolved status in a persisted payload means stale data by this schema's
 * own rules, and is dropped with the rest of the junk.
 */
export function fromStorable(raw: unknown): PendingEdit[] {
  if (!Array.isArray(raw)) return []
  const edits: PendingEdit[] = []
  for (const entry of raw) {
    const edit = parseStoredEdit(entry)
    if (edit) edits.push(edit)
  }
  return edits
}

// --- defensive parsing (outside-controlled JSON; one bad field drops the entry) ---

function isToolName(value: unknown): value is ToolName {
  return value === 'add_text' || value === 'edit_text' || value === 'remove_text'
}

function isDirectiveTask(value: unknown): value is Directive['task'] {
  return value === 'create' || value === 'insert' || value === 'edit' || value === 'remove'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseDirective(raw: unknown): Directive | null {
  if (!isRecord(raw)) return null
  if (!isDirectiveTask(raw.task) || typeof raw.instruction !== 'string') return null
  let target: DirectiveTarget | undefined
  if (raw.target !== undefined) {
    if (!isRecord(raw.target) || typeof raw.target.description !== 'string') return null
    const heading = raw.target.heading
    if (heading !== null && typeof heading !== 'string') return null
    target = { description: raw.target.description, heading: heading ?? null }
  }
  if (raw.verbatim !== undefined && raw.verbatim !== null && typeof raw.verbatim !== 'string') return null
  if (raw.constraints !== undefined && !isStringArray(raw.constraints)) return null
  return {
    task: raw.task,
    instruction: raw.instruction,
    ...(target !== undefined ? { target } : {}),
    ...(raw.verbatim !== undefined ? { verbatim: raw.verbatim as string | null } : {}),
    ...(raw.constraints !== undefined ? { constraints: raw.constraints } : {}),
  }
}

function parseWorkerCall(raw: unknown): WorkerCall | null {
  if (!isRecord(raw)) return null
  if (!isToolName(raw.name) || !isRecord(raw.params)) return null
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw.params)) {
    if (typeof value !== 'string') return null
    params[key] = value
  }
  if (
    typeof raw.thought !== 'string' ||
    typeof raw.xml !== 'string' ||
    typeof raw.noteView !== 'string' ||
    !isStringArray(raw.promptHints) ||
    !isFiniteNumber(raw.rawTokens) ||
    !isFiniteNumber(raw.toolSchemasInjected)
  ) {
    return null
  }
  let sampler: WorkerSampler | undefined
  if (raw.sampler !== undefined) {
    if (
      !isRecord(raw.sampler) ||
      !isFiniteNumber(raw.sampler.temperature) ||
      !isFiniteNumber(raw.sampler.maxTokens)
    ) {
      return null
    }
    sampler = { temperature: raw.sampler.temperature, maxTokens: raw.sampler.maxTokens }
  }
  return {
    name: raw.name,
    params,
    thought: raw.thought,
    xml: raw.xml,
    rawTokens: raw.rawTokens,
    promptHints: raw.promptHints,
    toolSchemasInjected: raw.toolSchemasInjected,
    noteView: raw.noteView,
    ...(sampler !== undefined ? { sampler } : {}),
  }
}

function parseDiff(raw: unknown): ExecutionDiff | null {
  if (!isRecord(raw)) return null
  if (
    !isFiniteNumber(raw.startLine) ||
    !isStringArray(raw.before) ||
    !isStringArray(raw.after) ||
    !isFiniteNumber(raw.added) ||
    !isFiniteNumber(raw.removed)
  ) {
    return null
  }
  return {
    startLine: raw.startLine,
    before: raw.before,
    after: raw.after,
    added: raw.added,
    removed: raw.removed,
  }
}

function parseD1(raw: unknown): PendingEdit['d1'] | null {
  if (!isRecord(raw)) return null
  if (raw.verdict !== 'disapproved' && raw.verdict !== 'unavailable') return null
  if (raw.noul !== null && !isFiniteNumber(raw.noul)) return null
  const safety = raw.destructiveSafety
  if (safety !== null && safety !== 'safe' && safety !== 'unintended_data_loss') return null
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return null
  return {
    verdict: raw.verdict,
    noul: raw.noul,
    destructiveSafety: safety,
    ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
  }
}

function parseStoredEdit(raw: unknown): PendingEdit | null {
  if (!isRecord(raw)) return null
  const id = readString(raw, 'id')
  if (!id) return null
  const createdAt = readNumber(raw, 'createdAt')
  if (createdAt === undefined || !Number.isFinite(createdAt)) return null
  if (raw.status !== 'pending') return null
  const directive = parseDirective(raw.directive)
  const call = parseWorkerCall(raw.call)
  const diff = parseDiff(raw.diff)
  const d1 = parseD1(raw.d1)
  const noteHash = readString(raw, 'noteHash')
  if (!directive || !call || !diff || !d1 || !noteHash) return null
  return {
    id,
    createdAt,
    directive,
    call,
    diff,
    noteHash,
    d1,
    status: 'pending',
  }
}
