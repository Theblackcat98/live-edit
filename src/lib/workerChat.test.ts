import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatResult, ChatStreamOptions } from './bridge'
import { NOTE_PATH } from '../data/note'
import {
  buildWorkerChatMessages,
  runWorkerChatTurn,
  sanitizeWorkerChatText,
  visibleWorkerChatText,
  WORKER_CHAT_MAX_TOKENS,
  WORKER_CHAT_SAMPLER,
  WORKER_CHAT_SYSTEM_PROMPT,
  WorkerChatError,
  type WorkerChatInput,
} from './workerChat'

// --- fixtures -------------------------------------------------------------------

const NOTE =
  '# Q3 Business Review\n\n## Revenue by Quarter\n\n| Quarter | Revenue |\n| --- | --- |\n| Q1 | $0.92M |\n| Q3 | $1.31M |\n\n## Risks\n\n- Long sales cycles\n'

function completion(overrides: Partial<ChatResult> = {}): ChatResult {
  return {
    text: '',
    reasoning: '',
    ms: 10,
    usage: { promptTokens: 100, outputTokens: 20 },
    toolCalls: [],
    finishReason: 'stop',
    ...overrides,
  }
}

interface Recorded {
  messages: ChatMessage[]
  options: ChatStreamOptions
}

/** A fake bridge chat: records calls, replays the scripted result, streams deltas. */
function fakeChat(result: ChatResult | Error, deltas?: string[]) {
  const calls: Recorded[] = []
  const chat = async (messages: ChatMessage[], options: ChatStreamOptions): Promise<ChatResult> => {
    calls.push({ messages, options })
    if (result instanceof Error) throw result
    for (const delta of deltas ?? []) options.onToken?.(delta)
    return result
  }
  return { chat, calls }
}

function baseInput(overrides: Partial<WorkerChatInput> = {}): WorkerChatInput {
  return {
    command: 'update the Q3 revenue row to $1.45M Final',
    history: [],
    note: NOTE,
    lastRun: null,
    ...overrides,
  }
}

function userText(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]
  return typeof last.content === 'string' ? last.content : ''
}

// --- prompt contract ------------------------------------------------------------

describe('buildWorkerChatMessages', () => {
  it('puts the three-tool XML catalog in the system prompt with each parameter table', () => {
    const [system] = buildWorkerChatMessages(baseInput())
    expect(system.role).toBe('system')
    const prompt = String(system.content)
    for (const tool of ['add_text', 'edit_text', 'remove_text']) {
      expect(prompt).toContain(`<schema function=${tool}>`)
    }
    for (const param of [
      'file_path',
      'content',
      'start_line',
      'old_text_anchor',
      'new_text',
      'target_excerpt',
    ]) {
      expect(prompt).toContain(param)
    }
    expect(prompt).toContain('<tool_call>')
    expect(prompt).toContain('exactly one of two shapes')
    expect(WORKER_CHAT_SYSTEM_PROMPT).toContain('authoritative')
  })

  it('sends the full note for a command about the note, and the outline for small talk', () => {
    const mutation = buildWorkerChatMessages(
      baseInput({ command: 'update the Q3 revenue row to $1.45M Final' }),
    )
    expect(userText(mutation)).toContain('| Q3 | $1.31M |')
    expect(userText(mutation)).toContain(`Current note (${NOTE_PATH}):`)

    const smallTalk = buildWorkerChatMessages(baseInput({ command: 'hello there' }))
    expect(userText(smallTalk)).toContain('outline')
    expect(userText(smallTalk)).not.toContain('| Q3 | $1.31M |')
  })

  it('replays prior turns as user/assistant pairs, command-only when there was no reply', () => {
    const messages = buildWorkerChatMessages(
      baseInput({
        history: [
          { command: 'hello', reply: 'Hey!' },
          { command: 'and the note?' },
        ],
      }),
    )
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Hey!' })
    expect(messages[3]).toEqual({ role: 'user', content: 'and the note?' })
    expect(messages[4].role).toBe('user')
  })

  it('appends the rejected reply and the exact error for the one retry', () => {
    const messages = buildWorkerChatMessages(
      baseInput({ retry: { attemptText: '<think>hmm</think>', error: 'no parseable call' } }),
    )
    expect(messages[messages.length - 2]).toEqual({
      role: 'assistant',
      content: '<think>hmm</think>',
    })
    const retryInstruction = String(messages[messages.length - 1].content)
    expect(retryInstruction).toContain('no parseable call')
    expect(retryInstruction).toContain('<tool_call>')
  })
})

// --- visible channel ------------------------------------------------------------

describe('visibleWorkerChatText', () => {
  it('hides complete and unterminated think blocks', () => {
    expect(visibleWorkerChatText('<think>secret</think>Hello')).toBe(' Hello')
    expect(visibleWorkerChatText('Hello <think>secret never closed')).toBe('Hello ')
    expect(visibleWorkerChatText('Hi </think>there')).toBe('Hi  there')
  })

  it('holds a partial trailing tag until it completes', () => {
    expect(visibleWorkerChatText('Hello <thi')).toBe('Hello ')
    expect(visibleWorkerChatText('Hello <th')).toBe('Hello ')
  })

  it('sanitizes tool markers out of a visible answer', () => {
    expect(sanitizeWorkerChatText('On it. <function=edit_text>{"x":1}</function>')).toBe('On it.')
    expect(sanitizeWorkerChatText('Hi <tool_call>{"a":1}</tool_call>')).toBe('Hi')
  })
})

// --- outcomes -------------------------------------------------------------------

describe('runWorkerChatTurn outcomes', () => {
  it('answers in prose, streaming only the visible channel', async () => {
    const { chat, calls } = fakeChat(completion({ text: '<think>reasoning here</think>Hello there.' }), [
      '<thi',
      'nk>reasoning',
      ' here</think>Hello',
      ' there.',
    ])
    const deltas: string[] = []
    const result = await runWorkerChatTurn(baseInput({ command: 'hello', chat, onText: (d) => deltas.push(d) }))

    expect(result.outcome).toBe('answer')
    expect(result.text).toBe('Hello there.')
    // The stream may carry the separator whitespace left by the removed
    // think block; it must never carry the block's content.
    expect(deltas.join('').trim()).toBe('Hello there.')
    expect(deltas.join('')).not.toContain('reasoning')
    expect(calls[0].options.maxTokens).toBe(WORKER_CHAT_MAX_TOKENS)
    expect(calls[0].options.temperature).toBe(WORKER_CHAT_SAMPLER.temperature)
  })

  it('parses one XML tool call into a delegate outcome, with its think text', async () => {
    const xml =
      '<think>Edit the Q3 row.</think>\n<tool_call>\n<function=edit_text>\n' +
      '<parameter=file_path>\nnotes/q3-review.md\n</parameter>\n' +
      '<parameter=start_line>\n7\n</parameter>\n' +
      '<parameter=end_line>\n7\n</parameter>\n' +
      '<parameter=old_text_anchor>\n| Q3 | $1.31M |\n</parameter>\n' +
      '<parameter=new_text>\n| Q3 | $1.45M | Final |\n</parameter>\n</function>\n</tool_call>'
    const { chat } = fakeChat(completion({ text: xml }), [xml])
    const result = await runWorkerChatTurn(baseInput({ chat }))

    expect(result.outcome).toBe('delegate')
    expect(result.call?.name).toBe('edit_text')
    expect(result.call?.params.new_text).toBe('| Q3 | $1.45M | Final |')
    expect(result.think).toBe('Edit the Q3 row.')
  })

  it('accepts a call when reasoning arrived on the reasoning channel instead of inline', async () => {
    const call =
      '<tool_call><function=remove_text><parameter=file_path>x</parameter></function></tool_call>'
    const { chat } = fakeChat(completion({ text: call, reasoning: 'Remove the row.' }))
    const result = await runWorkerChatTurn(baseInput({ chat }))
    expect(result.outcome).toBe('delegate')
    expect(result.think).toBe('Remove the row.')
  })

  it('reports invalid when the reply is only think text', async () => {
    const { chat } = fakeChat(completion({ text: '<think>still thinking</think>' }))
    const result = await runWorkerChatTurn(baseInput({ chat }))
    expect(result.outcome).toBe('invalid')
    expect(result.error).toMatch(/no parseable tool call/)
  })

  it('throws a typed endpoint error when the bridge fails', async () => {
    const { chat } = fakeChat(new Error('HTTP 500: boom'))
    await expect(runWorkerChatTurn(baseInput({ chat }))).rejects.toMatchObject({
      name: 'WorkerChatError',
      kind: 'endpoint',
    })
    await expect(runWorkerChatTurn(baseInput({ chat }))).rejects.toBeInstanceOf(WorkerChatError)
  })
})
