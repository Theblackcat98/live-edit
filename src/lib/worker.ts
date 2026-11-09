import type { WorkerCall, RouteDecision } from '../types'
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
      `Grounded span: lines ${plan.span.startLine}–${plan.span.endLine} · confidence ${plan.span.confidence.toFixed(2)} · exact current text: "${plan.span.excerpt}"`,
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

function thoughtFor(
  command: string,
  route: RouteDecision,
  plan: SupervisorPlan,
): string {
  const tool = route.primaryTool
  if (tool === 'edit_text' && plan.span) {
    return `The user asked to ${command
      .replace(/^please\s+/i, '')
      .toLowerCase()}. d1 locked the target to lines ${plan.span.startLine}–${plan.span.endLine} (“${truncate(
      plan.span.excerpt,
      58,
    )}”) at ${(plan.span.confidence * 100).toFixed(0)}% confidence. I will replace exactly that span and leave adjacent text untouched.`
  }
  if (tool === 'remove_text' && plan.span) {
    return `d1 grounded the deletion to lines ${plan.span.startLine}–${plan.span.endLine} with a blast-radius check. I will remove only “${truncate(
      plan.span.excerpt,
      64,
    )}” and preserve the surrounding structure.`
  }
  if (tool === 'add_text') {
    return plan.addPosition === 'under_heading'
      ? `The insertion point is pinned under “${plan.addAnchor}”. d1 supplied the exact heading anchor, so I can use add_text without regenerating the file.`
      : `No anchored mutation is needed. I will ${plan.addPosition ?? 'append'} the content at the supervisor-pinned location and preserve the existing note.`
  }
  if (tool === 'extract_visual_to_note') {
    return `The user referenced a visual element. d1 returned the ${plan.bbox?.label ?? 'ROI'} crop at ${(
      (plan.bbox?.confidence ?? 0.9) * 100
    ).toFixed(0)}% confidence. I will convert the ROI into ${plan.visualFormat} and insert it under “${plan.anchorHeading}”.`
  }
  return 'Supervisor hints are attached. I will emit one minimal tool call.'
}

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
  const thought = thoughtFor(command, route, plan)
  const promptHints: string[] = [
    `Allowed tool pruned to ${tool} (1 schema injected)`,
    'temperature=0.1 · top_k=50 · repetition_penalty=1.1',
  ]
  if (plan.span) {
    promptHints.push(
      `Target span: lines ${plan.span.startLine}–${plan.span.endLine} · P=${plan.span.confidence.toFixed(2)}`,
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
