import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatResult, ChatStreamOptions, ToolCallRequest } from './bridge'
import {
  buildOmniMessages,
  CLARIFY_FOLLOWUP_INSTRUCTION,
  DELEGATE_EDIT_TOOL,
  NOTE_CONTEXT_CAP_CHARS,
  OMNI_SYSTEM_PROMPT,
  OMNI_TEMPERATURE,
  OMNI_MAX_TOKENS,
  OmniTurnError,
  runOmniTurn,
  sanitizeOmniText,
  turnIsAboutNote,
  noteContextFor,
  type OmniTurnInput,
} from './omni'

// --- fixtures -------------------------------------------------------------------

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

function delegateCall(args: unknown, id = 'call-1'): ToolCallRequest {
  return {
    id,
    type: 'function',
    function: { name: 'delegate_edit', arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  }
}

function actionCall(action: 'undo' | 'redo', id = 'call-1'): ToolCallRequest {
  return { id, type: 'function', function: { name: 'harness_action', arguments: JSON.stringify({ action }) } }
}

interface Recorded {
  messages: ChatMessage[]
  options: ChatStreamOptions
}

type ScriptStep = ChatResult | Error | ((recorded: Recorded) => ChatResult | Error)

/** A fake bridge chat: records every call, replays the scripted responses. */
function fakeChat(script: ScriptStep[]) {
  const calls: Recorded[] = []
  const chat = async (messages: ChatMessage[], options: ChatStreamOptions): Promise<ChatResult> => {
    calls.push({ messages, options })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    const value = typeof step === 'function' ? step(calls[calls.length - 1]) : step
    if (value instanceof Error) throw value
    return value
  }
  return { chat, calls }
}

function baseInput(overrides: Partial<OmniTurnInput> = {}): OmniTurnInput {
  return {
    command: 'update the Q3 revenue row to $1.45M Final',
    source: 'text',
    history: [],
    note: '# Q3 Business Review\n\n## Revenue by Quarter\n\n| Quarter | Revenue |\n| --- | --- |\n| Q1 | $0.92M |\n| Q3 | $1.31M |\n',
    lastRun: null,
    ...overrides,
  }
}

const VALID_DIRECTIVE_ARGS = {
  task: 'edit',
  instruction: 'Update the Q3 revenue row in the Revenue by Quarter table from $1.31M to $1.45M Final.',
  target: { description: 'the Q3 row of the Revenue by Quarter table', heading: 'Revenue by Quarter' },
}

// --- sanitizer --------------------------------------------------------------------

describe('sanitizeOmniText', () => {
  it('leaves normal prose untouched', () => {
    const prose =
      'The Q4 row would remain, but the overall Revenue summary would be incomplete. ' +
      'Use {curly} braces and "quotes" freely — even ACTION verbs in a sentence about nothing.'
    expect(sanitizeOmniText(prose)).toBe(prose)
  })

  it('strips a bare tool-call JSON object, nested braces consumed whole', () => {
    const text = 'Sure! {"task": "edit", "instruction": "Update the row", "target": {"heading": null}} done.'
    expect(sanitizeOmniText(text)).toBe('Sure! done.')
  })

  it('strips a truncated (unterminated) tool-call JSON from a cut stream', () => {
    const text = 'On it. {"task": "create", "instruction": "Write a README template with sections overview, getting'
    expect(sanitizeOmniText(text).trim()).toBe('On it.')
  })

  it('keeps JSON-looking prose that carries no tool vocabulary', () => {
    const text = 'The config is {"port": 8083, "host": "127.0.0.1"} on this box.'
    expect(sanitizeOmniText(text)).toBe(text)
  })

  it('strips <<<DIRECTIVE-style blocks and invented <<<README TEMPLATE drift shapes', () => {
    expect(sanitizeOmniText('Ok.\n<<<DIRECTIVE\n{"task": "edit"}\n>>>\nDone.')).toBe('Ok.\n\nDone.')
    expect(sanitizeOmniText('<<<README TEMPLATE\n# README\n## Overview\n>>>')).toBe('')
    expect(sanitizeOmniText('Header text <<<DIRECTIVE never closed')).toBe('Header text')
  })

  it('strips <function=…> fragments and <tool_call> blocks, closed or not', () => {
    expect(sanitizeOmniText('A <function=delegate_edit>{"task":"edit"}</function> B')).toBe('A B')
    expect(sanitizeOmniText('A <function=delegate_edit> B')).toBe('A B')
    expect(sanitizeOmniText('A <tool_call>{"task":"edit"}</tool_call> B')).toBe('A B')
    expect(sanitizeOmniText('A <tool_call>{"task":"edit" (cut')).toBe('A')
  })

  it('strips fenced tool-call blocks but keeps benign fenced code', () => {
    const tool = 'Sure.\n```tool_call\n{"task": "edit", "instruction": "x"}\n```'
    expect(sanitizeOmniText(tool)).toBe('Sure.')
    const benign = 'Run this:\n```bash\nls -la\n```'
    expect(sanitizeOmniText(benign)).toBe(benign)
  })

  it('strips plain-text tool-call renditions (battery case 25 leak shape)', () => {
    const leak = 'delegate_edit:\n task: remove\n instruction: remove the bullet about Redis'
    expect(sanitizeOmniText(leak)).toBe('')
    const wrapped = 'On it.\ndelegate_edit:\n task: remove\n instruction: remove the bullet about Redis\nDone.'
    expect(sanitizeOmniText(wrapped)).toBe('On it.\nDone.')
    const action = 'harness_action:\n action: redo'
    expect(sanitizeOmniText(action)).toBe('')
  })

  it('keeps prose that merely mentions a tool name mid-sentence', () => {
    const prose = 'You could delegate_edit that by hand, or just ask me to redo it.'
    expect(sanitizeOmniText(prose)).toBe(prose)
    const fieldy = 'Remember:\n task: finish the write-up by Friday'
    // A lone field-shaped line with no tool header above it is prose, kept.
    expect(sanitizeOmniText(fieldy)).toBe(fieldy)
  })

  it('strips ACTION signal lines (the textual undo marker this design replaces)', () => {
    expect(sanitizeOmniText('ACTION undo')).toBe('')
    expect(sanitizeOmniText('ACTION: redo')).toBe('')
    expect(sanitizeOmniText('Reverted.\nACTION undo\nAnything else?')).toBe('Reverted.\nAnything else?')
  })
})

// --- §6 context policy --------------------------------------------------------------

describe('note context policy', () => {
  it('classifies note questions and mutation commands as about-the-note', () => {
    expect(turnIsAboutNote('summarize the note so far in two sentences')).toBe(true)
    expect(turnIsAboutNote('update the Q3 revenue row to $1.45M Final')).toBe(true)
    expect(turnIsAboutNote('remove the bullet about Redis')).toBe(true)
    expect(turnIsAboutNote('write a README template document to begin')).toBe(true)
    expect(turnIsAboutNote('hey')).toBe(false)
    expect(turnIsAboutNote('what is my favorite color?')).toBe(false)
  })

  it('sends the full note for about-the-note turns, an outline otherwise', () => {
    const note = '# Q3 Business Review\n\n## Revenue by Quarter\n\nQ1–Q3 table.\n\n## Risks\n\nRedis costs.\n'
    expect(noteContextFor('summarize the note so far', note)).toContain('Q1–Q3 table.')
    const outline = noteContextFor('hey', note)
    expect(outline).toMatch(/outline: Q3 Business Review · Revenue by Quarter · Risks/)
    expect(outline).not.toContain('Q1–Q3 table.')
  })

  it(`caps the full note at ${NOTE_CONTEXT_CAP_CHARS} chars and records the cut`, () => {
    const filler = Array.from({ length: 500 }, (_, i) => `line-${i} with some words on it`).join('\n')
    const note = `# Long note\n\n${filler}\n`
    expect(note.length).toBeGreaterThan(NOTE_CONTEXT_CAP_CHARS)
    const context = noteContextFor('what does the note say', note)
    expect(context).toContain(`…[note truncated: showing ${NOTE_CONTEXT_CAP_CHARS} of ${note.length} characters]`)
    expect(context).toContain(note.slice(0, NOTE_CONTEXT_CAP_CHARS))
    expect(context.length).toBeLessThan(note.length)
  })
})

// --- message assembly (E1 run-3 history discipline) -----------------------------------

describe('buildOmniMessages', () => {
  it('leads with the answer/clarify/delegate system prompt and ends with the user turn', () => {
    const messages = buildOmniMessages(baseInput())
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toBe(OMNI_SYSTEM_PROMPT)
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(typeof last.content === 'string' && last.content).toContain('User: update the Q3 revenue row')
  })

  it('replays answer turns as user/assistant text pairs', () => {
    const messages = buildOmniMessages(
      baseInput({
        history: [{ command: 'what is my favorite color?', reply: 'Your favorite color is teal.' }],
      }),
    )
    expect(messages).toHaveLength(4) // system, history pair, current user turn
    expect(messages[1]).toEqual({ role: 'user', content: 'what is my favorite color?' })
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Your favorite color is teal.' })
    expect(messages[3].role).toBe('user')
  })

  it('persists delegations as a tool call plus a tool-role result — never harness text', () => {
    const messages = buildOmniMessages(
      baseInput({
        history: [
          {
            command: 'remove the bullet about Redis',
            delegation: {
              tool: 'delegate_edit',
              arguments: JSON.stringify({ task: 'remove', instruction: 'Remove the Redis bullet under Risks.' }),
              result: 'Executed',
            },
          },
        ],
      }),
    )
    // system, history user, history assistant(tool_calls, empty content),
    // history tool, current user. The assistant message carries the call
    // and nothing else: visible harness text teaches plain-text delegation
    // (battery case 21, measured 4/4 server-side), an empty-content echo
    // without the call teaches confabulation ('hey' → sections-7-9 brief).
    expect(messages).toHaveLength(5)
    const [user, assistant, tool, current] = messages.slice(1)
    expect(user.role).toBe('user')
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBe('')
    expect(assistant.tool_calls).toHaveLength(1)
    expect(assistant.tool_calls?.[0].function.name).toBe('delegate_edit')
    expect(tool.role).toBe('tool')
    expect(tool.tool_call_id).toBe(assistant.tool_calls?.[0].id)
    expect(tool.content).toBe('Executed')
    expect(current.role).toBe('user')

    // The E1 run-3 rule: the assistant channel carries only model-authored
    // text and tool_calls — no harness strings ever.
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const content = typeof message.content === 'string' ? message.content : ''
      expect(content).not.toMatch(/Executed|Execution failed|User:|Current note|Last completed run/)
    }
  })

  it('drops visible reply text on delegation turns — the call travels, harness prose does not', () => {
    const messages = buildOmniMessages(
      baseInput({
        history: [
          {
            command: 'update the Q3 row',
            reply: 'Inserted 1 line at line 39.',
            delegation: {
              tool: 'delegate_edit',
              arguments: JSON.stringify({ task: 'edit', instruction: 'Update Q3.' }),
              result: 'Executed',
            },
          },
        ],
      }),
    )
    // The execution confirmation is harness text, not model chat: replaying
    // it visibly teaches plain-text delegation (case 21). Content stays
    // empty; the tool call and result still travel.
    expect(messages).toHaveLength(5)
    const assistant = messages[2]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toBe('')
    expect(assistant.tool_calls).toHaveLength(1)
  })

  it('sends the current turn as plain text, never as attachment content parts', () => {
    const messages = buildOmniMessages(baseInput({ command: 'what can you see?' }))
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    expect(typeof last.content).toBe('string')
    expect(last.content).toContain('User: what can you see?')
  })

  it('cites the last completed run when present', () => {
    const messages = buildOmniMessages(
      baseInput({ lastRun: { command: 'remove the bullet about Redis', status: 'verified', message: 'removed 1 line' } }),
    )
    const last = messages[messages.length - 1]
    expect(typeof last.content === 'string' && last.content).toContain(
      'Last completed run: "remove the bullet about Redis" → verified (removed 1 line)',
    )
  })
})

// --- outcome parsing -------------------------------------------------------------------

describe('runOmniTurn — answer', () => {
  it('streams provisional deltas live and returns the sanitized authoritative text (battery case 18)', async () => {
    const deltas: string[] = []
    const { chat, calls } = fakeChat([
      (call) => {
        call.options.onToken?.('Your favorite ')
        call.options.onToken?.('color is teal.')
        return completion({ text: '  Your favorite color is teal.  ' })
      },
    ])
    const result = await runOmniTurn(
      baseInput({ command: 'what is my favorite color?', onText: (d) => deltas.push(d), chat }),
    )
    expect(result?.outcome).toBe('answer')
    expect(result?.text).toBe('Your favorite color is teal.')
    expect(deltas).toEqual(['Your favorite ', 'color is teal.'])
    expect(calls).toHaveLength(1)
    expect(calls[0].options.temperature).toBe(OMNI_TEMPERATURE)
    expect(calls[0].options.maxTokens).toBe(OMNI_MAX_TOKENS)
    expect(calls[0].options.tools?.map((t) => t.function.name)).toEqual(['delegate_edit', 'harness_action'])
    expect(result?.promptTokens).toBe(100)
    expect(result?.outputTokens).toBe(20)
    expect(typeof result?.ms).toBe('number')
  })

  it('throws empty-reply when the completion is nothing but tool markup', async () => {
    const { chat } = fakeChat([completion({ text: '<tool_call>{"task": "edit"}</tool_call>' })])
    await expect(runOmniTurn(baseInput({ chat }))).rejects.toMatchObject({
      name: 'OmniTurnError',
      kind: 'empty-reply',
    })
  })
})

describe('runOmniTurn — delegate', () => {
  it('validates a first-try directive and stays silent (mixed text + tool call shows nothing)', async () => {
    const deltas: string[] = []
    const { chat } = fakeChat([
      completion({ text: 'On it — fixing that row now.', toolCalls: [delegateCall(VALID_DIRECTIVE_ARGS)] }),
    ])
    const result = await runOmniTurn(baseInput({ onText: (d) => deltas.push(d), chat }))
    expect(result?.outcome).toBe('delegate')
    expect(result?.directive).toEqual(VALID_DIRECTIVE_ARGS)
    expect(result?.text).toBeUndefined()
    expect(result?.action).toBeUndefined()
    expect(deltas).toEqual([])
  })

  it('repairs an invalid directive once: failed call persists, error appended, retry valid', async () => {
    const { chat, calls } = fakeChat([
      completion({ toolCalls: [delegateCall({ task: 'update', instruction: 'Update the Q3 row to $1.45M Final.' })] }),
      completion({ toolCalls: [delegateCall(VALID_DIRECTIVE_ARGS, 'call-2')] }),
    ])
    const result = await runOmniTurn(baseInput({ chat }))
    expect(result?.outcome).toBe('delegate')
    expect(result?.directive?.task).toBe('edit')
    expect(calls).toHaveLength(2)

    const repair = calls[1].messages
    // The failed attempt persists as assistant tool_calls + tool-role failure.
    const assistant = repair[repair.length - 3]
    expect(assistant.role).toBe('assistant')
    expect(assistant.tool_calls?.[0].function.name).toBe('delegate_edit')
    const tool = repair[repair.length - 2]
    expect(tool.role).toBe('tool')
    expect(tool.content).toMatch(/^Execution failed: task must be one of/)
    // The schema error is appended as the ONE repair user message.
    const user = repair[repair.length - 1]
    expect(user.role).toBe('user')
    expect(user.content).toMatch(/That delegate_edit call was rejected/)
    expect(user.content).toContain('task must be one of create|insert|edit|remove')
    // The repair request still offers the tools.
    expect(calls[1].options.tools?.map((t) => t.function.name)).toEqual(['delegate_edit', 'harness_action'])
  })

  it('falls back to a model-authored clarify after two invalid directives', async () => {
    const deltas: string[] = []
    const { chat, calls } = fakeChat([
      completion({ toolCalls: [delegateCall({ task: 'update', instruction: 'Change the number.' })] }),
      completion({ toolCalls: [delegateCall({ task: 'edit', instruction: '' }, 'call-2')] }),
      (recorded) => {
        recorded.options.onToken?.('Which number ')
        recorded.options.onToken?.('did you mean — Q1 or Q3?')
        return completion({ text: 'Which number did you mean — Q1 or Q3?' })
      },
    ])
    const result = await runOmniTurn(baseInput({ command: 'change the number', onText: (d) => deltas.push(d), chat }))
    expect(result?.outcome).toBe('clarify')
    expect(result?.text).toBe('Which number did you mean — Q1 or Q3?')
    expect(deltas).toEqual(['Which number ', 'did you mean — Q1 or Q3?'])
    expect(calls).toHaveLength(3)

    // The follow-up carries NO tools and asks for exactly one question.
    expect(calls[2].options.tools).toBeUndefined()
    const final = calls[2].messages[calls[2].messages.length - 1]
    expect(final.role).toBe('user')
    expect(final.content).toBe(CLARIFY_FOLLOWUP_INSTRUCTION)
    expect(final.content).toMatch(/ONE short question/)
    // The last failed call persists as a tool_call + failure result.
    const tool = calls[2].messages[calls[2].messages.length - 3]
    expect(tool.role).toBe('assistant')
    expect(tool.tool_calls?.[0].id).toBe('call-2')
  })

  it('carries repair diagnostics (error + raw arguments) on a repair-failure clarify', async () => {
    const { chat } = fakeChat([
      completion({ toolCalls: [delegateCall({ task: 'update', instruction: 'Change the number.' })] }),
      completion({ toolCalls: [delegateCall({ task: 'edit', instruction: '' }, 'call-2')] }),
      completion({ text: 'Which number did you mean?' }),
    ])
    const result = await runOmniTurn(baseInput({ command: 'change the number', chat }))
    expect(result?.outcome).toBe('clarify')
    expect(result?.repair?.error).toMatch(/instruction must be a non-empty string/)
    expect(result?.repair?.rawArguments).toContain('"instruction":""')
  })

  it('unwraps double-encoded tool arguments (llama.cpp delivers a JSON string)', async () => {
    const doubleEncoded: ToolCallRequest = {
      id: 'call-double',
      type: 'function',
      function: {
        name: 'delegate_edit',
        arguments: JSON.stringify(JSON.stringify(VALID_DIRECTIVE_ARGS)),
      },
    }
    const { chat } = fakeChat([completion({ toolCalls: [doubleEncoded] })])
    const result = await runOmniTurn(baseInput({ chat }))
    expect(result?.outcome).toBe('delegate')
    expect(result?.directive?.task).toBe('edit')
  })

  it('treats unknown tool names as repairable, then clarify', async () => {
    const { chat, calls } = fakeChat([
      completion({
        toolCalls: [{ id: 'x1', type: 'function', function: { name: 'edit_note', arguments: '{}' } }],
      }),
      completion({
        toolCalls: [{ id: 'x2', type: 'function', function: { name: 'edit_note', arguments: '{}' } }],
      }),
      completion({ text: 'What exactly should I change in the note?' }),
    ])
    const result = await runOmniTurn(baseInput({ chat }))
    expect(result?.outcome).toBe('clarify')
    expect(calls).toHaveLength(3)
    const repairUser = calls[1].messages[calls[1].messages.length - 1]
    expect(repairUser.content).toContain('unknown tool "edit_note"')
  })
})

describe('runOmniTurn — action', () => {
  it('maps a harness_action call to an undo action outcome, silently', async () => {
    const deltas: string[] = []
    const { chat } = fakeChat([completion({ toolCalls: [actionCall('undo')] })])
    const result = await runOmniTurn(baseInput({ command: 'undo that', onText: (d) => deltas.push(d), chat }))
    expect(result?.outcome).toBe('action')
    expect(result?.action).toBe('undo')
    expect(result?.text).toBeUndefined()
    expect(deltas).toEqual([])
  })

  it('repairs a malformed harness_action once', async () => {
    const { chat, calls } = fakeChat([
      completion({
        toolCalls: [
          { id: 'a1', type: 'function', function: { name: 'harness_action', arguments: '{"action": "revert"}' } },
        ],
      }),
      completion({ toolCalls: [actionCall('redo', 'a2')] }),
    ])
    const result = await runOmniTurn(baseInput({ command: 'redo that', chat }))
    expect(result?.outcome).toBe('action')
    expect(result?.action).toBe('redo')
    expect(calls).toHaveLength(2)
    const repairUser = calls[1].messages[calls[1].messages.length - 1]
    expect(repairUser.content).toContain('{"action": "undo"}')
  })
})

// --- error classes ------------------------------------------------------------------------

describe('runOmniTurn — server-side tool-parse HTTP 500 (E2 finding)', () => {
  it('retries bare ONCE and then throws its own error class', async () => {
    const { chat, calls } = fakeChat([
      new Error('HTTP 500: failed to parse tool call'),
      new Error('HTTP 500: failed to parse tool call'),
    ])
    const promise = runOmniTurn(baseInput({ chat }))
    await expect(promise).rejects.toBeInstanceOf(OmniTurnError)
    await expect(promise).rejects.toMatchObject({
      kind: 'server-tool-parse',
      status: 500,
      endpoint: { id: 'audio', port: 8086 },
    })
    expect(calls).toHaveLength(2)
    // Bare retry: identical messages — nothing was appended (the raw call
    // never reached the client, so there is nothing to append).
    expect(JSON.stringify(calls[1].messages)).toBe(JSON.stringify(calls[0].messages))
  })

  it('recovers when the bare retry succeeds', async () => {
    const { chat, calls } = fakeChat([
      new Error('HTTP 500: failed to parse tool call'),
      completion({ toolCalls: [delegateCall(VALID_DIRECTIVE_ARGS)] }),
    ])
    const result = await runOmniTurn(baseInput({ chat }))
    expect(result?.outcome).toBe('delegate')
    expect(calls).toHaveLength(2)
    // Only completed requests contribute usage; the refused 500 reported none.
    expect(result?.promptTokens).toBe(100)
  })

  it('does NOT bare-retry a 500 on the tool-less clarify follow-up (nothing to tool-parse)', async () => {
    const { chat, calls } = fakeChat([
      completion({ toolCalls: [delegateCall({ task: 'nope', instruction: '' })] }),
      completion({ toolCalls: [delegateCall({ task: 'still nope', instruction: '' }, 'c2')] }),
      new Error('HTTP 500: internal'),
    ])
    await expect(runOmniTurn(baseInput({ chat }))).rejects.toMatchObject({ kind: 'endpoint' })
    expect(calls).toHaveLength(3)
  })
})

describe('runOmniTurn — endpoint errors', () => {
  it('wraps bridge failures in a typed error carrying endpoint state for the UI', async () => {
    const { chat } = fakeChat([new Error('HTTP 404: not found')])
    await expect(runOmniTurn(baseInput({ chat }))).rejects.toMatchObject({
      name: 'OmniTurnError',
      kind: 'endpoint',
      endpoint: { id: 'audio', name: 'LFM3-Audio-2B', port: 8086, url: 'http://127.0.0.1:8086' },
      detail: 'HTTP 404: not found',
    })
  })

  it('propagates network failures as endpoint errors, never as null', async () => {
    const { chat } = fakeChat([new Error('Network failure')])
    await expect(runOmniTurn(baseInput({ chat }))).rejects.toMatchObject({ kind: 'endpoint' })
  })
})

// --- abort (barge-in) ------------------------------------------------------------------------

describe('runOmniTurn — abort', () => {
  it('returns null without calling the model when the signal already fired', async () => {
    const { chat, calls } = fakeChat([completion({ text: 'hi' })])
    const controller = new AbortController()
    controller.abort()
    const result = await runOmniTurn(baseInput({ signal: controller.signal, chat }))
    expect(result).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('returns null when aborted mid-stream on the tools call: no outcome, no partial directive', async () => {
    const controller = new AbortController()
    const { chat, calls } = fakeChat([
      (recorded) => {
        // Tokens are arriving (the during-stream abort check runs per token)…
        recorded.options.onToken?.('On it — ')
        // …then the barge-in fires and the bridge aborts the stream.
        controller.abort()
        throw new Error('Stream aborted')
      },
      completion({ toolCalls: [delegateCall(VALID_DIRECTIVE_ARGS)] }),
    ])
    const result = await runOmniTurn(baseInput({ signal: controller.signal, chat }))
    expect(result).toBeNull()
    expect(calls).toHaveLength(1) // the scripted repair never ran
  })

  it('returns null when aborted mid-stream on the clarify follow-up, keeping deltas provisional', async () => {
    const controller = new AbortController()
    const deltas: string[] = []
    const { chat, calls } = fakeChat([
      completion({ toolCalls: [delegateCall({ task: 'nope', instruction: '' })] }),
      completion({ toolCalls: [delegateCall({ task: 'still nope', instruction: '' }, 'c2')] }),
      (recorded) => {
        recorded.options.onToken?.('Which num')
        controller.abort()
        throw new Error('Stream aborted')
      },
    ])
    const result = await runOmniTurn(
      baseInput({ command: 'change the number', signal: controller.signal, onText: (d) => deltas.push(d), chat }),
    )
    expect(result).toBeNull()
    expect(deltas).toEqual(['Which num']) // streamed, provisional — no outcome exists
    expect(calls).toHaveLength(3)
  })

  it('returns null when aborted between the primary call and the repair retry', async () => {
    const controller = new AbortController()
    const { chat, calls } = fakeChat([
      completion({ toolCalls: [delegateCall({ task: 'update', instruction: 'Change the number.' })] }),
      (recorded) => {
        controller.abort()
        recorded.options.signal?.throwIfAborted?.()
        return completion({ toolCalls: [delegateCall(VALID_DIRECTIVE_ARGS)] })
      },
    ])
    const result = await runOmniTurn(baseInput({ signal: controller.signal, chat }))
    expect(result).toBeNull()
    expect(calls).toHaveLength(2) // the repair request was made…
    // …but stage 3 (clarify follow-up) never ran and no outcome was produced.
  })
})

// --- prompt contract vs E1 failure classes ------------------------------------------------------

describe('OMNI_SYSTEM_PROMPT — the battery gate run 1 contract', () => {
  it('(a) the task taxonomy is NOT in the prompt prose (the 2B parroted it into chat); it lives in the tool schema', () => {
    expect(OMNI_SYSTEM_PROMPT).not.toMatch(/edit\s+—\s+change existing content in place/)
    expect(OMNI_SYSTEM_PROMPT).not.toMatch(/\*\*Task:\*\*/)
    const taskDescription = (
      DELEGATE_EDIT_TOOL.function.parameters.properties as { task: { description: string } }
    ).task.description
    expect(taskDescription).toMatch(/edit = change existing content in place/)
  })

  it('(a2) the delegate_edit target schema requires description, aligned with validateDirective', () => {
    const target = (
      DELEGATE_EDIT_TOOL.function.parameters.properties as {
        target: { required?: string[] }
      }
    ).target
    expect(target.required).toEqual(['description'])
  })

  it('(b) conversation is the default; a change request is an action, never a chat topic', () => {
    expect(OMNI_SYSTEM_PROMPT).toMatch(/conversation is the default/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/not a conversation topic — it is an action/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/do not ask for confirmation/)
  })

  it('(c) the ambiguity rule: ONE question, only for genuinely ambiguous changes', () => {
    expect(OMNI_SYSTEM_PROMPT).toMatch(/ONE short clarifying question only when a change request is genuinely ambiguous/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/A wrong edit is worse than a question/)
  })

  it('(d) brief-not-content, verbatim dictation, silent machinery, instant undo', () => {
    expect(OMNI_SYSTEM_PROMPT).toMatch(/never author the content itself/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/put those words in verbatim, character for character/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/Never mention this process or its machinery/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/Undo and redo are instant, never a discussion/)
    expect(OMNI_SYSTEM_PROMPT).toMatch(/harness_action/)
  })
})
