/**
 * Undo/redo are deterministic snapshot directives, never model decisions
 * (design.md §2/§9). Both flows pre-check the command before any model runs,
 * so "undo that" is a pipeline action even when the model would have answered
 * it conversationally.
 */

import { detectSnapshotDirective } from '../snapshotDirective'
import type { PipelineDeps, TurnContext } from './turnContext'

/**
 * The deterministic undo/redo pre-check (battery case 10b): returns the action
 * the command names, or null for a normal turn.
 */
export function snapshotPrecheck(command: string): 'undo' | 'redo' | null {
  return detectSnapshotDirective(command)
}

/** Undo/redo: snapshot rollback short-circuits the model stages. */
export async function runSnapshotDirective(
  deps: PipelineDeps,
  ctx: TurnContext,
  action: 'undo' | 'redo',
): Promise<void> {
  const { traceLocal, publish, finish } = ctx
  deps.setStageStates({ A: 'done', B: 'skipped', C: 'skipped' })
  deps.setStage('executing')
  deps.setFlowModel(null)
  const directiveStarted = performance.now()
  const delta = action === 'undo' ? -1 : 1
  const restored = deps.restoreHistory(deps.historyIndexRef.current + delta)
  traceLocal.timings.execute = Number((performance.now() - directiveStarted).toFixed(1))
  if (!restored.ok) {
    traceLocal.status = 'conversational'
    deps.addMessage({
      role: 'assistant',
      author: 'harness',
      kind: 'result',
      text:
        action === 'undo'
          ? 'There is nothing to undo yet — the note is at its first snapshot.'
          : 'There is nothing to redo. The note is already at the latest snapshot.',
      runId: traceLocal.id,
    })
    finish('conversational')
    return
  }
  traceLocal.execution = {
    ok: true,
    message: restored.message,
    tool: action,
    note: restored.note,
    durationMs: traceLocal.timings.execute,
    snapshotId: restored.snapshot?.id,
  }
  publish()
  const confirmation =
    action === 'undo'
      ? `Reverted to “${restored.snapshot?.label}”. The note is back to the previous verified snapshot — no model inference needed.`
      : `Reapplied “${restored.snapshot?.label}”. Snapshot ${deps.historyIndexRef.current} is active again.`
  deps.addMessage({
    role: 'assistant',
    author: 'harness',
    kind: 'result',
    text: confirmation,
    runId: traceLocal.id,
  })
  deps.speakReply(confirmation)
  finish('verified')
}
