/**
 * The shared verify/execute tail: delegation card, hard gates, engine dry-run,
 * d1 safety check, then execute — or a pending edit when d1 disapproves or is
 * unavailable; `d1Check: false` (low-RAM) always holds instead of executing.
 */

import type {
  DelegationInfo,
  Directive,
  ExecutionDiff,
  PendingEdit,
  TurnHold,
  WorkerCall,
} from '../../types'
import { executeTool } from '../tools'
import { sectionScaleCollapse } from '../blastGate'
import { checkExecutionOutcome } from '../executionCheck'
import { buildD1State, noteHash } from '../context'
import { runHardGates } from '../gates'
import { runD1Check } from '../d1check'
import { createPendingEdit } from '../pending'
import { d1Decide } from '../bridge'
import { splitLines } from '../doc'
import { recordRejectedCall, type PipelineDeps, type RejectedFlowLabel, type TurnContext } from './turnContext'

export interface VerifyOptions {
  d1Check: boolean
  snapshotLabel?: string
  flowLabel?: RejectedFlowLabel
}

/** The card a held call settles on. */
export interface HoldDetails {
  diff: ExecutionDiff
  d1: PendingEdit['d1']
  confidence: number | null
  heldText: string
  notifyDetail: string
  hold: TurnHold
  overrideBlastRadius?: true
}

/** Hold a gate-passing call as a pending edit for the user's decision. */
function holdForUserDecision(
  deps: PipelineDeps,
  ctx: TurnContext,
  delegation: DelegationInfo,
  delegationId: string,
  directive: Directive,
  call: WorkerCall,
  details: HoldDetails,
): void {
  const { diff, d1, confidence, heldText, notifyDetail, hold, overrideBlastRadius } = details
  const { traceLocal, publish, finish } = ctx
  // Insertion calls carry no line range, so record the insertion neighbourhood.
  const insertion =
    call.name === 'add_text'
      ? (() => {
          const lines = splitLines(ctx.noteAtStart)
          const startLine = diff.startLine
          return {
            startLine,
            precedingLine: startLine >= 2 ? (lines[startLine - 2] ?? null) : null,
            followingLine: lines[startLine - 1] ?? null,
          }
        })()
      : undefined
  const pending = createPendingEdit({
    directive,
    call,
    diff,
    noteHash: noteHash(ctx.noteAtStart),
    ...(insertion ? { insertion } : {}),
    d1,
    ...(overrideBlastRadius ? { overrideBlastRadius: true } : {}),
  })
  traceLocal.hold = hold
  publish()
  deps.addPendingEdit(pending)
  deps.patchMessage(delegationId, {
    delegation: { ...delegation, status: 'pending', confidence },
  })
  traceLocal.status = 'pending'
  deps.addMessage({
    role: 'assistant', author: 'harness', kind: 'notice',
    text: heldText,
    runId: traceLocal.id,
  })
  deps.notify('Edit waiting for your decision', notifyDetail, 'neutral')
  deps.speakReply('That edit needs your call. It is waiting under pending edits.')
  finish('pending')
}

export async function verifyAndExecute(
  deps: PipelineDeps,
  ctx: TurnContext,
  directive: Directive,
  call: WorkerCall,
  options: VerifyOptions = { d1Check: true },
): Promise<void> {
  const { command, noteAtStart, traceLocal, runtime, publish, finish } = ctx
  const flowLabel = options.flowLabel ?? 'audio-first pipeline'

  const delegation: DelegationInfo = {
    runId: traceLocal.id,
    tool: call.name,
    status: 'checking',
    modelLabel: runtime.worker === 'dictation' ? 'dictation' : '1.7B',
    thought: directive.instruction,
  }
  const delegationId = deps.addMessage({
    role: 'tool',
    text: '',
    runId: traceLocal.id,
    delegation,
  })

  // --- hard gates (design.md §8): correctness refusals are never adjudicable.
  // A blast-radius-only failure is held for the user instead (approval runs
  // with the cap waived, on record). Stage C is d1, absent in low-RAM mode.
  deps.setStageStates({ A: 'done', B: 'done', C: options.d1Check ? 'running' : 'skipped' })
  deps.setStage('verifying')
  const gates = runHardGates(noteAtStart, call)
  if (!gates.pass) {
    const detail = gates.failures.map((failure) => failure.detail).join(' ')
    const blastOnly =
      gates.failures.length > 0 &&
      gates.failures.every(
        (failure) => failure.gate === 'destructive_safety' || failure.gate === 'blast_radius',
      )
    if (blastOnly) {
      // Dry-run with the cap waived: the user sees what the override would do.
      const overridePreview = executeTool(noteAtStart, call, { overrideBlastRadius: true })
      if (overridePreview.ok && overridePreview.diff) {
        holdForUserDecision(deps, ctx, delegation, delegationId, directive, call, {
          diff: overridePreview.diff,
          d1: {
            verdict: 'unavailable',
            noul: null,
            destructiveSafety: null,
            reason: `${detail} Approving executes the removal with the limit waived — you decide.`,
          },
          confidence: null,
          heldText: `I won't run that removal silently: ${detail} It removes ${
            overridePreview.diff.removed
          } of ${splitLines(noteAtStart).length} note lines. It is held under Pending edits — approve it there to run it anyway, or discard it.`,
          notifyDetail: 'Blast-radius hold: removal beyond the limit, awaiting your decision.',
          hold: { kind: 'blast-radius', reason: detail },
          overrideBlastRadius: true,
        })
        return
      }
    }
    deps.patchMessage(delegationId, { delegation: { ...delegation, status: 'rejected' } })
    recordRejectedCall(deps, ctx, directive, call, `Hard gates failed: ${detail}`, null, flowLabel)
    traceLocal.hold = { kind: 'hard-gate', reason: detail }
    publish()
    deps.addMessage({
      role: 'assistant', author: 'harness', kind: 'error',
      text: `I stopped before execution. A deterministic hard gate refused this call: ${detail} The note was not touched.`,
      runId: traceLocal.id,
    })
    deps.notify('Hard gate refusal', detail, 'error')
    finish('rejected')
    return
  }

  // Dry-run the engine for the diff the safety check (and any pending card) renders.
  const preview = executeTool(noteAtStart, call)
  if (!preview.ok || !preview.diff) {
    deps.patchMessage(delegationId, { delegation: { ...delegation, status: 'rejected' } })
    recordRejectedCall(deps, ctx, directive, call, preview.message, null, flowLabel)
    traceLocal.hold = { kind: 'engine', reason: preview.message }
    publish()
    deps.addMessage({
      role: 'assistant', author: 'harness', kind: 'error',
      text: `I stopped before writing. ${preview.message} The note was not changed.`,
      runId: traceLocal.id,
    })
    deps.notify('Execution stopped', preview.message, 'error')
    // A dry-run refusal is a refusal, not a failure: the harness declined the
    // call before writing, so the run settles 'rejected' (battery case 12c).
    finish('rejected')
    return
  }

  // --- no decision model in this mode: the user decides ---------------------
  // Low-RAM runs no d1, so the gate-passing call is held, never executed.
  if (!options.d1Check) {
    holdForUserDecision(deps, ctx, delegation, delegationId, directive, call, {
      diff: preview.diff,
      d1: {
        verdict: 'unavailable',
        noul: null,
        destructiveSafety: null,
        reason:
          'Low-RAM mode runs no decision model (d1), so no edit executes silently in this mode — this one needs your decision.',
      },
      confidence: null,
      heldText:
        'Low-RAM mode runs no safety-check model, so this edit is held for your decision under Pending edits instead of executing on its own. The note was not touched.',
      notifyDetail: 'No decision model in low-RAM mode; held for adjudication.',
      hold: {
        kind: 'no-decision-model',
        reason: 'Low-RAM mode runs no decision model (d1) — every gate-passing edit is held for the user.',
      },
    })
    return
  }

  // --- d1 safety check (design.md §7): its only job -------------------------
  deps.setFlowModel('d1')
  const noteLines = splitLines(noteAtStart)
  const noteLineCount = noteLines.length - (noteLines[noteLines.length - 1] === '' ? 1 : 0)
  const userCommands = deps.messagesRef.current.filter((message) => message.role === 'user')
  const lastUserTurn =
    userCommands.length >= 2 ? userCommands[userCommands.length - 2].text : undefined
  const check = await runD1Check({
    state: buildD1State({
      directive,
      command,
      call: { name: call.name, params: call.params },
      diff: preview.diff,
      lastUserTurn,
      noteLineCount,
    }),
    d1Decide,
  })
  traceLocal.d1Check = check
  traceLocal.timings.critic = check.ms ?? 0
  runtime.critic = check.verdict === 'unavailable' ? 'fallback' : 'live'
  if (check.promptTokens) ctx.liveUsage.d1 = check.promptTokens
  publish()

  if (check.verdict !== 'approved') {
    holdForUserDecision(deps, ctx, delegation, delegationId, directive, call, {
      diff: preview.diff,
      d1: {
        verdict: check.verdict,
        noul: check.noul,
        destructiveSafety: check.destructiveSafety,
        intentClarity: check.intentClarity,
        targetSupport: check.targetSupport,
        executionConfidence: check.executionConfidence,
        ...(check.reason ? { reason: check.reason } : {}),
      },
      confidence: check.noul,
      heldText:
        check.verdict === 'unavailable'
          ? 'The safety check was unavailable, so this edit is held for your decision rather than decided automatically. It is waiting under Pending edits — the note was not touched.'
          : 'The safety check disapproved this edit, but it passed every deterministic gate, so it is held for your decision under Pending edits instead of being dropped. The note was not touched.',
      notifyDetail:
        check.verdict === 'unavailable'
          ? 'd1 unavailable; held for adjudication.'
          : 'd1 disapproved; held for adjudication.',
      hold: {
        kind: 'd1',
        reason: check.reason ?? `d1 verdict: ${check.verdict}.`,
      },
    })
    return
  }

  // --- §8 blast-radius hold (issue #58; battery cases 12c/29): d1 approval is
  // necessary but not sufficient for a section-scale collapse.
  const collapse = sectionScaleCollapse(noteAtStart, preview.diff, call.name, directive.task, command)
  if (collapse) {
    holdForUserDecision(deps, ctx, delegation, delegationId, directive, call, {
      diff: preview.diff,
      d1: {
        verdict: check.verdict,
        noul: check.noul,
        destructiveSafety: check.destructiveSafety,
        ...(check.reason ? { reason: check.reason } : {}),
      },
      confidence: check.noul,
      heldText: `This edit ${collapse.reason}. That class of edit never runs silently (§8), so it is held for your decision under Pending edits — the note was not touched.`,
      notifyDetail: 'Blast-radius hold (§8): section-scale collapse held for adjudication despite d1 approval.',
      hold: { kind: 'blast-collapse', reason: collapse.reason },
    })
    return
  }

  // --- d1 approved: execute (the silent path, guarded by the decision model) --
  const confidence = check?.noul ?? null

  // --- outcome tripwires (battery case 8): 'verified' must mean the result
  // matches what was asked; a content mismatch is a visible failure.
  const outcome = checkExecutionOutcome(noteAtStart, directive, call, preview)
  if (outcome.kind === 'missing-content') {
    deps.patchMessage(delegationId, { delegation: { ...delegation, status: 'rejected' } })
    const reason = `Execution outcome check failed: ${outcome.reason}`
    recordRejectedCall(deps, ctx, directive, call, reason, confidence, flowLabel)
    traceLocal.hold = { kind: 'outcome', reason: outcome.reason }
    publish()
    deps.addMessage({
      role: 'assistant', author: 'harness', kind: 'error',
      text: `I stopped before writing. ${outcome.reason} The note was not changed.`,
      runId: traceLocal.id,
    })
    deps.notify('Execution stopped', outcome.reason, 'error')
    finish('failed')
    return
  }
  if (outcome.kind === 'no-change') {
    deps.patchMessage(delegationId, {
      delegation: { ...delegation, status: 'executed', confidence },
    })
    deps.addMessage({
      role: 'assistant', author: 'harness', kind: 'result',
      text: preview.message,
      runId: traceLocal.id,
    })
    finish('conversational')
    return
  }

  deps.setStageStates({ A: 'done', B: 'done', C: options.d1Check ? 'done' : 'skipped' })
  deps.patchMessage(delegationId, {
    delegation: { ...delegation, status: 'verified', confidence },
  })
  deps.setStage('executing')
  deps.setFlowModel('worker')
  const execStarted = performance.now()
  const execution = preview
  traceLocal.timings.execute = Number((performance.now() - execStarted).toFixed(1))
  traceLocal.execution = execution
  // Snapshot labels surface in user-visible messages (case 25: no stage nouns).
  const snapshot = deps.commitNote(
    execution.note,
    `${options.snapshotLabel ?? 'Audio edit'} · ${call.name}`,
    call.name,
  )
  execution.snapshotId = snapshot.id
  deps.setDiff(execution.diff ?? null)
  deps.patchMessage(delegationId, {
    delegation: { ...delegation, status: 'executed', confidence },
  })
  traceLocal.status = 'verified'
  publish()
  deps.addMessage({
    role: 'assistant', author: 'harness', kind: 'result',
    text: execution.message,
    runId: traceLocal.id,
  })
  deps.speakReply(execution.message)
  finish('verified')
  deps.scheduleHighlightClear()
}
