import { describe, expect, it } from 'vitest'
// Source text of every module that produces displayed/gated numbers: the
// honesty guarantee is static (no Math.random may exist in src/lib + src/state),
// so the sources are imported raw and grepped.
import bridgeSource from './bridge.ts?raw'
import docSource from './doc.ts?raw'
import frameSource from './frame.ts?raw'
import routeSource from './route.ts?raw'
import speechSource from './speech.ts?raw'
import storageSource from './storage.ts?raw'
import suggestionsSource from './suggestions.ts?raw'
import supervisorSource from './supervisor.ts?raw'
import toolsSource from './tools.ts?raw'
import utilsSource from './utils.ts?raw'
import workerSource from './worker.ts?raw'
import xmlSource from './xml.ts?raw'
import workspaceSource from '../state/useWorkspace.ts?raw'
import type { RouteDecision, SpanTarget, WorkerCall } from '../types'
import { INITIAL_NOTE } from '../data/note'
import { lineRangeExcerpt } from './doc'
import { executeTool } from './tools'
import {
  buildPlan,
  conversationalReply,
  critique,
  isVagueMutation,
  normalizeCommand,
  resolveGroundingSpan,
  routeCommand,
  VAGUE_MUTATION,
} from './supervisor'
import { buildWorkerCall, renderToolCallXml } from './worker'

describe('normalizeCommand', () => {
  it('strips leading filler and hedge phrases down to the imperative', () => {
    expect(normalizeCommand('please update the Q3 revenue row to $1.45M')).toBe(
      'update the Q3 revenue row to $1.45M',
    )
    expect(normalizeCommand('Hey, okay, remove the bullet about Redis')).toBe(
      'remove the bullet about Redis',
    )
    expect(normalizeCommand('Okay um, please just go ahead and add a line about Rust')).toBe(
      'add a line about Rust',
    )
  })

  it('strips scene-setting clauses before the command body', () => {
    expect(normalizeCommand('The document is empty now, please write a readme')).toBe(
      'write a readme',
    )
  })

  it('trims the ends and collapses internal whitespace', () => {
    expect(normalizeCommand('  update   the   revenue\n row  ')).toBe('update the revenue row')
    expect(normalizeCommand('change the API-key bullet to rotate keys by 15 November')).toBe(
      'change the API-key bullet to rotate keys by 15 November',
    )
  })

  it('reaches a fixed point, so normalizing an already-clean command is a no-op', () => {
    const once = normalizeCommand(
      'Okay, the note is blank, please go ahead and add a bullet about onboarding',
    )
    expect(once).toBe('add a bullet about onboarding')
    expect(normalizeCommand(once)).toBe(once)
  })
})

// --- shared pipeline fixtures -------------------------------------------------

function spanAt(note: string, startLine: number, endLine: number, phrase?: string): SpanTarget {
  return {
    startLine,
    endLine,
    excerpt: lineRangeExcerpt(note, startLine, endLine),
    confidence: 0.95,
    reason: 'test span',
    phrase,
  }
}

function mutationRoute(tool: 'edit_text' | 'remove_text'): RouteDecision {
  return {
    action: 'file_mutation',
    actionConfidence: 0.95,
    allowedTools: [{ name: tool, p: 0.9 }],
    primaryTool: tool,
    reason: 'test route',
  }
}

function manualCall(
  name: 'edit_text' | 'remove_text',
  params: Record<string, string>,
): WorkerCall {
  return {
    name,
    params,
    thought: 'test call',
    xml: renderToolCallXml(name, params),
    rawTokens: 12,
    promptHints: [],
    toolSchemasInjected: 0,
    noteView: '',
  }
}

/**
 * The real deterministic pipeline pieces, in pipeline order, with every model
 * endpoint down: buildPlan → resolveGroundingSpan(live:false) → buildWorkerCall
 * → critique → (on verify) executeTool.
 */
async function runDeterministicPipeline(command: string, note = INITIAL_NOTE) {
  const clean = normalizeCommand(command)
  const route = routeCommand(clean)
  if (!route.primaryTool) throw new Error(`no primary tool routed for "${command}"`)
  let plan = buildPlan(clean, route, note)
  const grounding = await resolveGroundingSpan(clean, note, plan, route.primaryTool, {
    live: false,
  })
  if (grounding.span) plan = { ...plan, span: grounding.span }
  if (grounding.planPatch) plan = { ...plan, ...grounding.planPatch }
  const call = buildWorkerCall(clean, route, plan, note)
  if (!call) throw new Error(`no worker call built for "${command}"`)
  const critic = critique(note, route, plan.span, call)
  const execution = critic.verdict === 'verified' ? executeTool(note, call, plan.span) : null
  return { route, plan, call, critic, execution }
}

// --- audit TD-01: span confinement + anchor-vs-span ---------------------------

describe('critique: execution is confined to the grounded span (TD-01)', () => {
  it('rejects an 8-line removal aimed at a 1-line grounded span', () => {
    const span = spanAt(INITIAL_NOTE, 25, 25) // the Redis bullet
    const call = manualCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '22',
      end_line: '29',
      target_excerpt: span.excerpt,
    })
    const result = critique(INITIAL_NOTE, mutationRoute('remove_text'), span, call)
    expect(result.verdict).toBe('rejected')
    const grounded = result.checks.find((check) => check.label === 'target_grounded')
    expect(grounded?.pass).toBe(false)
    expect(grounded?.detail).toContain('not confined')
  })

  it("rejects a self-consistent invented range: the anchor must match the supervisor's span", () => {
    const span = spanAt(INITIAL_NOTE, 24, 26) // the three product bullets
    const call = manualCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '24',
      end_line: '24',
      old_text_anchor: '3. Hiring depends on the revised Q4 plan.',
      new_text: '- Shipped the old workspace permissions model.',
    })
    const result = critique(INITIAL_NOTE, mutationRoute('edit_text'), span, call)
    expect(result.verdict).toBe('rejected')
    const anchor = result.checks.find((check) => check.label === 'anchor_exact')
    expect(anchor?.pass).toBe(false)
    // The range itself is confined, so the rejection isolates the anchor rule.
    const grounded = result.checks.find((check) => check.label === 'target_grounded')
    expect(grounded?.pass).toBe(true)
  })

  it('still verifies a call that sits inside the span with a matching anchor', () => {
    const span = spanAt(INITIAL_NOTE, 17, 17)
    const call = manualCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '17',
      end_line: '17',
      old_text_anchor: '| Q3 | $1.2M | Pending |',
      new_text: '| Q3 | $1.45M | Final |',
    })
    const result = critique(INITIAL_NOTE, mutationRoute('edit_text'), span, call)
    expect(result.verdict).toBe('verified')
  })
})

// --- audit TD-44: deterministic blast radius -----------------------------------

describe('deterministic pipeline: blast radius holds at any target size (TD-44)', () => {
  it('QA 12c: "Replace the Risks section with tiny" is rejected in fallback mode', async () => {
    const { plan, critic } = await runDeterministicPipeline('Replace the Risks section with tiny')
    // The spoken "section" reference grounds the heading with its body…
    expect(plan.span?.startLine).toBe(28)
    expect(plan.span ? plan.span.endLine - plan.span.startLine : 0).toBeGreaterThanOrEqual(4)
    // …so the two-word payload collapses it and the critic rejects.
    expect(critic.verdict).toBe('rejected')
    const blast = critic.checks.find((check) => check.label === 'blast_radius')
    expect(blast?.pass).toBe(false)
  })
})

// --- regression: the good paths still verify -----------------------------------

describe('deterministic pipeline: good paths still verify (regression)', () => {
  it('verifies and executes a normal table-row edit', async () => {
    const { critic, execution } = await runDeterministicPipeline(
      'Update the Q3 revenue row to $1.45M Final',
    )
    expect(critic.verdict).toBe('verified')
    expect(execution?.ok).toBe(true)
    expect(execution?.note).toContain('| Q3 | $1.45M | Final |')
  })

  it('verifies and executes a quoted phrase edit surgically', async () => {
    const { critic, execution } = await runDeterministicPipeline('Replace "$1.2M" with "$1.45M"')
    expect(critic.verdict).toBe('verified')
    expect(execution?.ok).toBe(true)
    expect(execution?.note).toContain('| Q3 | $1.45M | Pending |')
  })

  it('verifies and executes removing the Redis bullet', async () => {
    const { critic, execution } = await runDeterministicPipeline('Remove the bullet about Redis')
    expect(critic.verdict).toBe('verified')
    expect(execution?.ok).toBe(true)
    expect(execution?.note).not.toContain('Redis')
  })

  it('grounds and executes an insertion under a heading', async () => {
    const { critic, execution } = await runDeterministicPipeline(
      'add a line under Security: rotate keys monthly',
    )
    expect(critic.verdict).toBe('verified')
    expect(execution?.ok).toBe(true)
    expect(execution?.note).toContain('Rotate keys monthly')
    expect(execution?.note).not.toContain('under Security:')
  })

  it('grounds and executes a visual extraction under Revenue', async () => {
    const { critic, execution } = await runDeterministicPipeline(
      'Pull the LTV/CAC formula from the slide into Revenue',
    )
    expect(critic.verdict).toBe('verified')
    expect(execution?.ok).toBe(true)
    expect(execution?.note).toContain('LTV / CAC')
  })

  it('routes undo/redo as directives that bypass plan and critic', () => {
    expect(routeCommand('undo that').directive).toBe('undo')
    expect(routeCommand('please revert').directive).toBe('undo')
    expect(routeCommand('redo it').directive).toBe('redo')
    expect(routeCommand('apply that again').directive).toBe('redo')
    const undoRoute = routeCommand('undo that')
    expect(buildPlan('undo that', undoRoute, INITIAL_NOTE)).toEqual({})
  })
})

// --- audit TD-43: vague-reference guardrail predicate ---------------------------

describe('vague-mutation guardrail predicate (TD-43)', () => {
  it('exports VAGUE_MUTATION and matches deictic mutation references', () => {
    expect(VAGUE_MUTATION.test('delete that')).toBe(true)
    expect(isVagueMutation('delete that part')).toBe(true)
    expect(isVagueMutation('change it')).toBe(true)
    expect(isVagueMutation('remove this')).toBe(true)
    expect(isVagueMutation('Replace that with a shorter version')).toBe(true)
    expect(isVagueMutation('fix it to say fewer words')).toBe(true)
    expect(isVagueMutation('clean up that section')).toBe(true)
  })

  it('normalizes before matching, so filler and hedges do not hide the reference', () => {
    expect(isVagueMutation('hey, okay, delete that')).toBe(true)
    expect(isVagueMutation('please just remove this')).toBe(true)
    expect(isVagueMutation('  update   it  ')).toBe(true)
  })

  it('does not flag commands with a concrete object', () => {
    expect(isVagueMutation('delete the Risks section')).toBe(false)
    expect(isVagueMutation('update the Q3 revenue row to $1.45M Final')).toBe(false)
    expect(isVagueMutation('Replace "$1.2M" with "$1.45M"')).toBe(false)
    expect(isVagueMutation('remove the bullet about Redis')).toBe(false)
    expect(isVagueMutation('what did you change?')).toBe(false)
  })

  it('mirrors the local router: vague commands clarify instead of mutating', () => {
    const remove = routeCommand('delete that part')
    expect(remove.action).toBe('ambiguous_request')
    expect(remove.primaryTool).toBe('remove_text')
    const edit = routeCommand('change it to something shorter')
    expect(edit.action).toBe('ambiguous_request')
    expect(edit.primaryTool).toBe('edit_text')
  })
})

// --- audit TD-03: deterministic scores, no fabricated distributions -------------

describe('deterministic scores (audit TD-03)', () => {
  it('routeCommand returns deep-equal scores for the same command on every run', () => {
    const first = routeCommand('Update the Q3 revenue row to $1.45M Final')
    const second = routeCommand('Update the Q3 revenue row to $1.45M Final')
    expect(second).toEqual(first)
    // Flat heuristic values, stable across runs — no simulated spread.
    expect(first.actionConfidence).toBe(0.9)
    expect(first.allowedTools[0]).toEqual({ name: 'edit_text', p: 0.88 })
  })

  it('the whole fallback pipeline is reproducible: two runs deep-equal', async () => {
    const first = await runDeterministicPipeline('Update the Q3 revenue row to $1.45M Final')
    const second = await runDeterministicPipeline('Update the Q3 revenue row to $1.45M Final')
    expect(second.route).toEqual(first.route)
    expect(second.plan).toEqual(first.plan)
    expect(second.call).toEqual(first.call)
    expect(second.critic).toEqual(first.critic)
  })

  it('src/lib and src/state contain no Math.random call', () => {
    const sources: Record<string, string> = {
      'src/lib/bridge.ts': bridgeSource,
      'src/lib/doc.ts': docSource,
      'src/lib/frame.ts': frameSource,
      'src/lib/route.ts': routeSource,
      'src/lib/speech.ts': speechSource,
      'src/lib/storage.ts': storageSource,
      'src/lib/suggestions.ts': suggestionsSource,
      'src/lib/supervisor.ts': supervisorSource,
      'src/lib/tools.ts': toolsSource,
      'src/lib/utils.ts': utilsSource,
      'src/lib/worker.ts': workerSource,
      'src/lib/xml.ts': xmlSource,
      'src/state/useWorkspace.ts': workspaceSource,
    }
    const offenders = Object.entries(sources)
      .filter(([, source]) => /Math\.random/.test(source))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})

// --- audit TD-03: the local critic never invents probabilities -------------------

describe('critic honesty (audit TD-03)', () => {
  it('a passing call verifies with null pCorrect/pSafe — the checks alone decide', () => {
    const span = spanAt(INITIAL_NOTE, 17, 17)
    const call = manualCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '17',
      end_line: '17',
      old_text_anchor: '| Q3 | $1.2M | Pending |',
      new_text: '| Q3 | $1.45M | Final |',
    })
    const result = critique(INITIAL_NOTE, mutationRoute('edit_text'), span, call)
    expect(result.verdict).toBe('verified')
    expect(result.pCorrect).toBeNull()
    expect(result.pSafe).toBeNull()
  })

  it('a failing call rejects with null pCorrect/pSafe — a rolled number never gates', () => {
    const span = spanAt(INITIAL_NOTE, 25, 25) // the Redis bullet
    const call = manualCall('remove_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '22',
      end_line: '29',
      target_excerpt: span.excerpt,
    })
    const result = critique(INITIAL_NOTE, mutationRoute('remove_text'), span, call)
    expect(result.verdict).toBe('rejected')
    expect(result.pCorrect).toBeNull()
    expect(result.pSafe).toBeNull()
  })

  it('an unreported tool score still counts as routed membership', () => {
    const span = spanAt(INITIAL_NOTE, 17, 17)
    const call = manualCall('edit_text', {
      file_path: 'notes/quarterly-review.md',
      start_line: '17',
      end_line: '17',
      old_text_anchor: '| Q3 | $1.2M | Pending |',
      new_text: '| Q3 | $1.45M | Final |',
    })
    // d1 chose edit_text without a distribution: p is null, not a number.
    const route = mutationRoute('edit_text')
    const unreported: RouteDecision = {
      ...route,
      primaryTool: 'remove_text',
      allowedTools: [{ name: 'edit_text', p: null }],
    }
    const result = critique(INITIAL_NOTE, unreported, span, call)
    const toolMatch = result.checks.find((check) => check.label === 'tool_match')
    expect(toolMatch?.pass).toBe(true)
  })
})

// --- audit TD-13/TD-05: template calls are labelled, sampler claims are real ----

describe('worker template honesty (audit TD-13/TD-05)', () => {
  it('labels template calls as deterministic and claims no sampler', async () => {
    const { call } = await runDeterministicPipeline('Update the Q3 revenue row to $1.45M Final')
    expect(call.thought).toContain('No model decode ran')
    // A sampler is recorded only for genuinely live decodes.
    expect(call.sampler).toBeUndefined()
    const hints = call.promptHints.join(' ')
    expect(hints).not.toMatch(/top_k|repetition_penalty/)
    expect(hints).toContain('no decode request sent')
  })
})

// --- audit TD-18: the chat fallback describes only what it can know -------------

describe('conversationalReply frame honesty (audit TD-18)', () => {
  const ASK = 'What do you see?'

  it('describes the slide only when the attached frame is the synthetic one', () => {
    const reply = conversationalReply(ASK, INITIAL_NOTE, null, 'synthetic-slide')
    expect(reply).toContain('synthetic Q3 operating review slide')
  })

  it('declines to describe a live frame — visual description needs the Omni server', () => {
    for (const source of ['live-camera', 'live-screen'] as const) {
      const reply = conversationalReply(ASK, INITIAL_NOTE, null, source)
      expect(reply).toContain('cannot honestly describe')
      expect(reply).not.toContain('operating review slide')
    }
  })

  it('says nothing is attached when no frame exists', () => {
    expect(conversationalReply(ASK, INITIAL_NOTE, null, 'none')).toContain('No frame is attached')
  })

  it('reports the static roster budget, never the invented 5.1 GB live figure', () => {
    const reply = conversationalReply('status update', INITIAL_NOTE, null)
    expect(reply).not.toContain('5.1 GB')
    expect(reply).toContain('static roster budget')
    expect(reply).toContain('not a live measurement')
  })
})
