import type {
  ContextPacket,
  Directive,
  RouteDecision,
  ToolName,
  WorkerCall,
} from '../types'
import type { SupervisorPlan } from './supervisor'
import { tokenViewForWorker } from './supervisor'
import type { ChatMessage } from './bridge'
import { NOTE_PATH } from '../data/note'
import { TOOL_DEFS } from '../data/tools'
import { estimateTokens, truncate } from './utils'

function parameter(name: string, value: string | number): string {
  return `<parameter=${name}>\n${value}\n</parameter>`
}

/** Canonical rendering of the XML tool-call contract. */
export function renderToolCallXml(
  name: WorkerCall['name'],
  params: Record<string, string | number>,
): string {
  const body = Object.entries(params)
    .map(([key, value]) => parameter(key, value))
    .join('\n')
  return `<tool_call>\n<function=${name}>\n${body}\n</function>\n</tool_call>`
}

// P3 wiring: deleted when the pipeline switches to packet prompts
export const WORKER_SYSTEM_PROMPT = `You are the tool-call worker inside a local note-editing pipeline. The supervisor (d1) has already classified the command, grounded a target span in the note and pruned the tool set. Your single job: emit exactly one tool call in the XML contract.

<tool_call>
<function=edit_text>
<parameter=file_path>
notes/q3-review.md
</parameter>
<parameter=start_line>
17
</parameter>
</function>
</tool_call>

Rules:
- Think briefly inside <think></think>, then emit exactly one <tool_call> block and stop.
- Use the supervisor's grounded span and exact anchor. Never regenerate the whole file.
- Use only the schemas provided below. Do not invent tools or parameters.`

// P3 wiring: deleted when the pipeline switches to packet prompts
// (tokenViewForWorker's ±3-line window and the supervisor hints below are the
// shipped-build defect design.md §12 lists; buildPacketWorkerMessages replaces both.)
export function buildWorkerMessages(
  command: string,
  route: RouteDecision,
  plan: SupervisorPlan,
  note: string,
): ChatMessage[] {
  const schemas = TOOL_DEFS.filter((tool) => tool.name === route.primaryTool)
    .map((tool) => {
      const params = tool.params
        .map(
          (param) =>
            `  ${param.name} (${param.type}${param.required ? ', required' : ''}): ${param.description}`,
        )
        .join('\n')
      return `<schema function=${tool.name}>\n${tool.description}\n${params}\n</schema>`
    })
    .join('\n')

  const hints: string[] = []
  if (plan.span) {
    hints.push(
      `Grounded span: lines ${plan.span.startLine}–${plan.span.endLine} · confidence ${
        plan.span.confidence === null ? 'unreported' : plan.span.confidence.toFixed(2)
      } · exact current text: "${plan.span.excerpt}"`,
    )
  }
  if (plan.addPosition) {
    hints.push(`Insertion: position=${plan.addPosition}${plan.addAnchor ? ` anchor=${plan.addAnchor}` : ''}`)
  }
  if (plan.newText) {
    hints.push(`Supervisor-proposed replacement: "${plan.newText}"`)
  }
  if (plan.addContent) {
    hints.push(`Supervisor-proposed content (insert verbatim):\n${plan.addContent}`)
  }

  const userText = [
    `Command: ${command}`,
    route.primaryTool ? `Tool to call: ${route.primaryTool}` : '',
    hints.length ? `Supervisor hints:\n- ${hints.join('\n- ')}` : '',
    `\nTool schema:\n${schemas}`,
    '\nLine-numbered note window (full file withheld):',
    tokenViewForWorker(note, plan.span, null),
    '\nEmit one tool call now.',
  ]
    .filter(Boolean)
    .join('\n')

  const content = userText
  return [
    { role: 'system', content: WORKER_SYSTEM_PROMPT },
    { role: 'user', content },
  ]
}

/**
 * Honest deterministic description of a template-built call. These calls are
 * emitted by code, not decoded by a model, so the "thought" states what built
 * them — it never impersonates a first-person worker monologue.
 */
function templateThoughtFor(
  _command: string,
  route: RouteDecision,
  plan: SupervisorPlan,
): string {
  const tool = route.primaryTool
  if (tool === 'edit_text' && plan.span) {
    return `Deterministic template call: the supervisor's grounded span (lines ${plan.span.startLine}–${plan.span.endLine}) is replaced with the supervisor-parsed text. No model decode ran.`
  }
  if (tool === 'remove_text' && plan.span) {
    return `Deterministic template call: the supervisor's grounded span (lines ${plan.span.startLine}–${plan.span.endLine}) is removed within the blast-radius limit. No model decode ran.`
  }
  if (tool === 'add_text') {
    return `Deterministic template call: the supervisor-pinned content is inserted at the ${plan.addPosition ?? 'append'} position${plan.addAnchor ? ` (anchor “${plan.addAnchor}”)` : ''}. No model decode ran.`
  }
  if (tool === 'extract_visual_to_note') {
    return `Deterministic visual extraction: the supervisor's ${plan.bbox?.label ?? 'ROI'} crop is converted to ${plan.visualFormat} under “${plan.anchorHeading}”. Visual extraction never calls the worker model.`
  }
  return 'Deterministic template call built from the supervisor hints. No model decode ran.'
}

// P3 wiring: deleted when the pipeline switches to packet prompts
export function buildWorkerCall(
  command: string,
  route: RouteDecision,
  plan: SupervisorPlan,
  note: string,
): WorkerCall | null {
  const tool = route.primaryTool
  if (!tool) return null

  let params: Record<string, string | number> = { file_path: NOTE_PATH }
  if (tool === 'edit_text') {
    if (!plan.span || !plan.newText) return null
    params = {
      file_path: NOTE_PATH,
      start_line: plan.span.startLine,
      end_line: plan.span.endLine,
      old_text_anchor: plan.span.excerpt,
      new_text: plan.newText,
    }
  } else if (tool === 'remove_text') {
    if (!plan.span) return null
    params = {
      file_path: NOTE_PATH,
      start_line: plan.span.startLine,
      end_line: plan.span.endLine,
      target_excerpt: plan.span.excerpt,
    }
  } else if (tool === 'add_text') {
    if (!plan.addContent) return null
    params = {
      file_path: NOTE_PATH,
      position: plan.addPosition ?? 'append',
      ...(plan.addAnchor ? { anchor: plan.addAnchor } : {}),
      content: plan.addContent,
    }
  } else if (tool === 'extract_visual_to_note') {
    if (!plan.anchorHeading || !plan.visualFormat || !plan.extractedMarkdown) return null
    params = {
      file_path: NOTE_PATH,
      visual_format: plan.visualFormat,
      anchor_heading: plan.anchorHeading,
      extracted_markdown: plan.extractedMarkdown,
    }
  }

  const stringParams = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  )
  const xml = renderToolCallXml(tool, params)
  const thought = templateThoughtFor(command, route, plan)
  const promptHints: string[] = [
    `Allowed tool pruned to ${tool} (1 schema injected)`,
    'deterministic template · no decode request sent',
  ]
  if (plan.span) {
    promptHints.push(
      `Target span: lines ${plan.span.startLine}–${plan.span.endLine} · P=${
        plan.span.confidence === null ? 'unreported' : plan.span.confidence.toFixed(2)
      }`,
    )
    promptHints.push(`Exact anchor: ${truncate(plan.span.excerpt, 80)}`)
  }
  if (plan.bbox) {
    promptHints.push(`ROI crop: ${plan.bbox.label} · P=${plan.bbox.confidence.toFixed(2)}`)
  }
  if (plan.anchorHeading) promptHints.push(`Anchor heading: ${plan.anchorHeading}`)
  promptHints.push('Line-numbered note window injected; full file withheld')

  const call: WorkerCall = {
    name: tool,
    params: stringParams,
    thought,
    xml,
    rawTokens: estimateTokens(thought + xml),
    promptHints,
    toolSchemasInjected: 1,
    noteView: '',
  }
  call.noteView = tokenViewForWorker(note, plan.span, call)
  return call
}

// --- Phase-3 packet worker prompt (design.md §6) ------------------------------
// The worker AUTHORS and GROUNDS: the directive is a brief, not content; the
// full line-numbered note travels with the prompt (tokenViewForWorker's ±3
// window is the shipped defect); all four tools travel so the worker CHOOSES
// (the directive's task is a hint, not a filter). Targets every class in the
// E4 failure taxonomy: schema mixing (per-tool parameter ownership), output
// truncation (call-first reply contract), gutter bleed (anchors exclude the
// numbering column), remove-as-empty-edit, and template-echo retries (the
// retry message is prose — no fill-in XML skeleton to copy literally).

/**
 * Directive plus the Phase-3 `frame_extract` field (decision D2): Omni — the
 * only model that sees the frame — reads the frame and packs the extracted
 * Markdown here; the 1.7B worker is text-only and places it. Mirrored into
 * design.md §5 when P3 lands.
 */
export interface PacketDirective extends Directive {
  frame_extract?: string
}

export interface PacketWorkerPromptInput {
  directive: PacketDirective
  /** design.md §6 context packet: last ≤3 completed edit turns, oldest first. */
  contextPacket: ContextPacket
  /** The full note text, unnumbered — the builder numbers every line. */
  note: string
  /** Defaults to NOTE_PATH; the catalog teaches file_path from it. */
  notePath?: string
}

/**
 * Measured sampler for packet worker decodes (docs/spikes/E4-packet-iteration.md,
 * 2026-11-09, live :8080, 12 E4 fixtures): 3,000 max_tokens truncates the
 * 1.7B's content-channel deliberation mid-flight (7/12 first-try); 6,000 lets
 * the deliberators finish and close the call (11/12, then 12/12 on the
 * confirmation re-run). Cost: median latency +~3 s (8.8–11.5 s vs 5.8–8.2 s)
 * and a deliberating tail that reaches 25–30 s; successful early calls are
 * unaffected (finish=stop well under the cap). Retry keeps the repo's
 * attempt-2 temperature bump.
 */
export const PACKET_WORKER_SAMPLER = {
  attempt1: { temperature: 0.3, maxTokens: 6000 },
  retry: { temperature: 0.4, maxTokens: 6000 },
} as const

/** Coarse directive-task → tool hint. A hint, never a filter (design.md §6). */
const TASK_TOOL_HINT: Record<Directive['task'], ToolName> = {
  create: 'add_text',
  insert: 'add_text',
  edit: 'edit_text',
  remove: 'remove_text',
  extract: 'extract_visual_to_note',
}

export const PACKET_WORKER_SYSTEM_PROMPT = `You are the edit worker in a local note-editing app. A conversation model heard the user and sent you a directive — a brief, not the text. You author the edit end to end: you write the new content yourself, you choose the target lines yourself from the numbered note, and you emit exactly one tool call.

HOW TO REPLY — the reply starts with <tool_call> (or with one short <think> block) and ends with </tool_call>. Nothing else.
- Call syntax: inside <tool_call> put one <function=TOOL_NAME> block; inside it, one <parameter=NAME> block per parameter, the value between the opening and closing tags. Omit parameters your call does not use.
- Do NOT restate or re-analyze anything in the reply: no quoting the directive, the note, or the catalog; no drafting calls for several tools; no JSON. The gates read only the tool call — every other word risks truncating it.
- If you reason at all, it is a <think> block of at most three short lines, then the call, then stop.

AUTHORING
- The directive's "instruction" says what the user wants; it is a brief. You write the actual note text yourself, matching it (sections named, values given, list and table style of the note).
- The one exception: when "verbatim" holds text, insert that exact text as given.
- Never copy the user's command words into the note.

GROUNDING
- The user message carries the whole note with every line numbered, like " 17 │ | Q3 | $1.2M | Pending |". The leading number and the " │ " gutter are NOT note text; the note text starts after the gutter.
- old_text_anchor and target_excerpt must repeat the note's text at your chosen lines exactly — the gutter and its number excluded.
- start_line / end_line / anchor line numbers come from that gutter.

TOOL CHOICE — every parameter name belongs to exactly one tool; never mix:
- add_text inserts NEW lines (new bullet, row, section, whole document). Its parameters: file_path, position, anchor, content.
- edit_text REPLACES existing lines (fix a value, reword a row, rename a heading or the title). Its parameters: file_path, start_line, end_line, old_text_anchor, new_text. new_text is never empty.
- remove_text DELETES existing lines (a bullet, a row, a whole section). Its parameters: file_path, start_line, end_line, target_excerpt. Deleting is this tool — never edit_text with an empty new_text.
- extract_visual_to_note places the directive's frame_extract markdown under a heading. Its parameters: file_path, visual_format, anchor_heading, extracted_markdown.
Decide in one line, then commit: new content → add_text; changing existing words → edit_text; deleting → remove_text; placing frame_extract → extract_visual_to_note. The simplest correct tool is the right tool.
Before emitting, check that every parameter you wrote appears in your chosen tool's list above.`

/**
 * Line-numbered rendering of a full note — tokenViewForWorker's gutter format
 * (`NNN │ text`, 1-based, every line), minus the window. This is the numbering
 * discipline the packet prompt reuses (design.md §6: full note, not ±3 lines).
 */
export function numberNoteLines(note: string): string {
  return note
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(3, ' ')} │ ${line}`)
    .join('\n')
}

/** One crisp when-to-use line per tool — E4's tool-gravity antidote. */
const TOOL_USE_WHEN: Record<ToolName, string> = {
  add_text:
    'adding new lines to the note — a new bullet, row, paragraph, section, or a whole new document — without replacing or deleting existing lines',
  edit_text:
    'changing text that already exists in the note — fixing a value, rewording a row or bullet, renaming a heading or the title',
  remove_text:
    'deleting existing lines from the note — a bullet, a table row, or a whole section',
  extract_visual_to_note:
    'the directive carries frame_extract (markdown the conversation model read off the live frame) and asks to place it in the note',
}

/**
 * Filled example per tool, in PROSE (name=value), not as a <tool_call> block:
 * v2 of the prompt showed the 1.7B reading complete XML examples in the
 * catalog as its own prior assistant turns ("the conversation shows previous
 * attempts by me") and re-deliberating them until truncation. Prose values
 * weld the function name to its parameter vocabulary without imitating a
 * call. Values are consistent with the seed note.
 */
/**
 * Filled examples use a DIFFERENT domain (a cooking note) on purpose:
 * battery gate run 1 caught the worker copying the old seed-note examples
 * into real edits — case 20 wrote the example's old anchor as the new
 * title, and 12e bled seed content into an empty document. Examples teach
 * format; they must never offer copyable content for the actual note.
 */
function packetToolExample(tool: ToolName, notePath: string): string {
  switch (tool) {
    case 'add_text':
      return `file_path="${notePath}" · position="under_heading" · anchor="3. Method" · content="3. Rest the dough for 20 minutes."`
    case 'edit_text':
      return `file_path="${notePath}" · start_line=1 · end_line=1 · old_text_anchor="# Weekly Meal Plan" · new_text="# Weekly Meal Plan — Final"`
    case 'remove_text':
      return `file_path="${notePath}" · start_line=41 · end_line=41 · target_excerpt="- Buy oat milk before Friday."`
    case 'extract_visual_to_note':
      return `file_path="${notePath}" · visual_format="latex_block" · anchor_heading="1. Ingredients" · extracted_markdown="$$ … $$" (the directive's frame_extract)`
  }
}

/**
 * TOOL_DEFS description fixes for the packet rendering (data/tools.ts keeps
 * its shipped text; the worker packet must not teach supervisor vocabulary).
 */
const PARAM_DESCRIPTION_FIXES: Record<string, string> = {
  'Line number or exact heading supplied by the supervisor.':
    'line number or exact heading text to anchor the insertion (required for after_line and under_heading)',
  'Heading supplied by the supervisor.':
    'exact heading text to insert the extracted markdown under',
  'Where the content is inserted.':
    'where the content is inserted — under_heading inserts at the END of that heading\'s section (after its existing content); after_line inserts immediately after line N',
}

/**
 * The full 4-tool catalog, one schema block per tool, each with its OWN
 * parameter list and a complete example call in the repo XML contract — so a
 * function name and its parameter vocabulary are welded together (E4's
 * `edit_text`-shell-carrying-`add_text`-params class).
 */
export function renderPacketToolCatalog(notePath: string = NOTE_PATH): string {
  return TOOL_DEFS.map((tool) => {
    const params = tool.params
      .map((param) => {
        const description =
          PARAM_DESCRIPTION_FIXES[param.description] ??
          param.description.replace('Target note path.', `the target note: ${notePath}`)
        return `  ${param.name} (${param.type}${param.required ? ', required' : ', optional'}): ${description}`
      })
      .join('\n')
    return [
      `<schema function=${tool.name}>`,
      `Use when: ${TOOL_USE_WHEN[tool.name]}.`,
      'Parameters (exactly these — a parameter from another tool is rejected):',
      params,
      'Filled example (values only — the directive decides the real tool, lines, and content):',
      packetToolExample(tool.name, notePath),
      '</schema>',
    ].join('\n')
  }).join('\n\n')
}

function renderPacketContextTurns(packet: ContextPacket): string {
  if (!packet.editTurns.length) {
    return '(none — this is the first edit of the session)'
  }
  return packet.editTurns
    .map(
      (turn, index) =>
        `${index + 1}. user said: "${turn.command}"\n` +
        `   directive: ${turn.directiveSummary}\n` +
        `   diff: ${turn.diffSummary}`,
    )
    .join('\n')
}

/** Assemble the design.md §6 worker packet as a chat conversation. */
export function buildPacketWorkerMessages(input: PacketWorkerPromptInput): ChatMessage[] {
  const { directive, contextPacket, note } = input
  const notePath = input.notePath ?? NOTE_PATH
  const hint = TASK_TOOL_HINT[directive.task]

  const userText = [
    `DIRECTIVE from the conversation model (authoritative brief; its "task" field "${directive.task}" hints ${hint} — you pick the tool that fits):`,
    JSON.stringify(directive, null, 2),
    '',
    'RECENT EDIT TURNS (already applied; background for follow-ups like "do the same" — the directive above always wins):',
    renderPacketContextTurns(contextPacket),
    '',
    `CURRENT NOTE — "${notePath}", complete, every line numbered (the " │ " gutter is not note text; line numbers count from 1 at the top):`,
    numberNoteLines(note),
    '',
    'TOOL CATALOG — pick ONE tool; a tool accepts ONLY the parameters listed under it:',
    renderPacketToolCatalog(notePath),
    '',
    'Now author the content and emit exactly one tool call.',
  ].join('\n')

  return [
    { role: 'system', content: PACKET_WORKER_SYSTEM_PROMPT },
    { role: 'user', content: userText },
  ]
}

export interface WorkerRetryInput {
  /** The packet the first attempt answered. */
  original: PacketWorkerPromptInput
  /** The raw first reply (appended as the assistant turn; capped at 8,000 chars). */
  attemptText: string
  /** The exact parse/gate error that rejected the first attempt. */
  error: string
  /** The tool the rejected call named, when it parsed to a known tool. */
  attemptedTool?: ToolName | null
  /** The note's actual text at the attempted range, for anchor corrections. */
  anchorCorrection?: { startLine: number; endLine: number; actualText: string } | null
}

/**
 * The attempt-2 conversation: the original packet, the rejected reply as the
 * assistant turn, and a user turn carrying the concrete correction — the exact
 * error, the note's actual text on an anchor miss, the attempted tool's full
 * parameter list again, and the per-tool parameter ownership recap.
 *
 * Prose only: no fill-in XML skeleton (E4's retry template was echoed
 * literally as `<function=tool_name>` — the retry must not contain a
 * copyable placeholder).
 */
export function buildWorkerRetryMessages(input: WorkerRetryInput): ChatMessage[] {
  const { original, error, attemptedTool, anchorCorrection } = input
  const attemptText = input.attemptText.slice(0, 8000)
  const hint = TASK_TOOL_HINT[original.directive.task]

  const parts: string[] = [
    'That reply was rejected by the deterministic gates. Send one corrected tool call.',
    `Exact error: ${error}`,
  ]

  if (anchorCorrection) {
    const anchorParam =
      attemptedTool === 'remove_text' ? 'target_excerpt' : 'old_text_anchor'
    parts.push(
      `Your anchor did not match the note. The note's actual text at lines ${anchorCorrection.startLine}–${anchorCorrection.endLine} is:\n` +
        '"""\n' +
        anchorCorrection.actualText +
        '\n"""\n' +
        `Copy that text exactly into ${anchorParam} — or choose the line range whose text you actually meant. The " │ " gutter and its number are not note text.`,
    )
  }

  if (attemptedTool) {
    const def = TOOL_DEFS.find((tool) => tool.name === attemptedTool)
    if (def) {
      const paramList = def.params
        .map((param) => `  - ${param.name} (${param.type}${param.required ? ', required' : ', optional'})`)
        .join('\n')
      parts.push(
        `Your call was named "${attemptedTool}". ${attemptedTool} accepts EXACTLY these parameters:\n${paramList}\n` +
          'A parameter name outside this list is rejected — parameters that belong to another tool never validate.',
      )
    }
  }

  parts.push(
    'Parameter names per tool (exact — never mix):\n' +
      '- add_text: file_path, position, anchor, content\n' +
      '- edit_text: file_path, start_line, end_line, old_text_anchor, new_text\n' +
      '- remove_text: file_path, start_line, end_line, target_excerpt\n' +
      '- extract_visual_to_note: file_path, visual_format, anchor_heading, extracted_markdown',
  )

  parts.push(
    `The directive's task is "${original.directive.task}" — usually ${hint}, but choose the tool that fits. ` +
      'Reply with exactly one complete <tool_call> block and no prose; if you reason first, three short lines maximum inside <think></think>.',
  )

  return [
    ...buildPacketWorkerMessages(original),
    { role: 'assistant', content: attemptText },
    { role: 'user', content: parts.join('\n\n') },
  ]
}
