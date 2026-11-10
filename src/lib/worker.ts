import type { ContextPacket, Directive, ToolName, WorkerCall } from '../types'
import type { ChatMessage } from './bridge'
import { NOTE_PATH } from '../data/note'
import { TOOL_DEFS } from '../data/tools'

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
