import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadWorkspaceState, saveWorkspaceState, SCHEMA_VERSION, type PersistedWorkspace } from './storage'
import type { Message, PendingEdit, RejectedTraceRecord, Snapshot, Trace } from '../types'

// The storage key must not move across the v1→v2 migration, or existing users'
// workspaces are silently dropped — tests hardcode it on purpose.
const STORAGE_KEY = 'liquidscribe.workspace.v1'

// Fixed epoch ms: persisted fixtures must be deterministic for deep equality.
const AT = 1762672000000

const snapshot: Snapshot = {
  id: 'snap-1',
  at: AT,
  label: 'add Q3 total (add_text)',
  note: '# Ledger\n\n## Q3\n\n- revenue: 120\n- total (Q3): 120\n',
  tool: 'add_text',
  automatic: false,
}

const messages: Message[] = [
  { id: 'msg-1', role: 'user', text: 'Add a Q3 total row.', at: AT, source: 'text' },
  { id: 'msg-2', role: 'assistant', text: 'Done — the Q3 total is in.', at: AT + 1, kind: 'result' },
]

const run: Trace = {
  id: 'run-1',
  at: AT,
  command: 'Add a Q3 total row.',
  source: 'text',
  timings: { route: 12, ground: 34, generate: 88, critic: 21, execute: 9, total: 164 },
  status: 'verified',
  outputTokens: 64,
  promptTokens: 512,
  noteTokensAtStart: 96,
  workerNoteView: '# Ledger\n\n## Q3\n\n- revenue: 120\n- total (Q3): 120\n',
}

const rejectedTrace: RejectedTraceRecord = {
  at: AT,
  command: 'Delete the Q3 block.',
  route: { tool: 'remove_text', provenance: 'local-router' },
  spanCandidates: [{ startLine: 3, endLine: 4, excerpt: '## Q3' }],
  grounding: { source: 'fallback-keyword', chosenLine: 3 },
  workerXml: '<tool name="remove_text"><param name="startLine">3</param></tool>',
  critic: { verdict: 'rejected', reason: 'row-count check failed', pCorrect: null },
}

const pendingEdit: PendingEdit = {
  id: 'pe-1',
  createdAt: AT,
  directive: {
    task: 'insert',
    instruction: 'Insert a Q4 total row directly under the Q3 total.',
  },
  call: {
    name: 'add_text',
    params: { line: '6', text: '- total (Q4): 137' },
    thought: 'Insert the Q4 total after the Q3 line.',
    xml: '<tool name="add_text"><param name="line">6</param><param name="text">- total (Q4): 137</param></tool>',
    rawTokens: 58,
    promptHints: ['current note view'],
    toolSchemasInjected: 4,
    noteView: '# Ledger\n\n## Q3\n\n- revenue: 120\n- total (Q3): 120\n',
  },
  diff: {
    startLine: 6,
    before: ['- total (Q3): 120'],
    after: ['- total (Q3): 120', '- total (Q4): 137'],
    added: 1,
    removed: 0,
  },
  noteHash: '9f2cd1ab',
  d1: {
    verdict: 'disapproved',
    noul: 0.31,
    destructiveSafety: 'safe',
    reason: 'the call inserts a row the user never mentioned',
  },
  status: 'pending',
}

// The persisted v1 shape, exactly as the current save path produced it:
// version + the five fields saveWorkspaceState received (useWorkspace.ts).
const v1Payload = {
  version: 1,
  note: '# Ledger\n\n## Q3\n\n- revenue: 120\n- total (Q3): 120\n',
  snapshots: [snapshot],
  messages,
  runs: [run],
  rejectedTraces: [rejectedTrace],
}

// Vitest runs in the node environment — install a minimal localStorage before
// storage.ts touches `window`.
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const backing = new Map(Object.entries(seed))
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value)
      },
    },
  }
  return backing
}

function expectLoaded(): PersistedWorkspace {
  const loaded = loadWorkspaceState()
  if (!loaded) throw new Error('expected a persisted workspace, got null')
  return loaded
}

beforeEach(() => {
  installStorage()
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('storage schema version', () => {
  it('is 2 — the pending-edits bump (decision D3)', () => {
    expect(SCHEMA_VERSION).toBe(2)
  })
})

describe('v2 round trip', () => {
  it('saves and loads a payload including pendingEdits, deep-equal', () => {
    const backing = installStorage()
    const state = {
      note: v1Payload.note,
      snapshots: v1Payload.snapshots,
      messages,
      runs: [run],
      rejectedTraces: [rejectedTrace],
      pendingEdits: [pendingEdit],
    }

    saveWorkspaceState(state)

    const raw = backing.get(STORAGE_KEY)
    expect(raw).toBeDefined()
    const persisted = JSON.parse(raw as string) as Record<string, unknown>
    expect(persisted.version).toBe(SCHEMA_VERSION)
    expect(persisted.pendingEdits).toEqual([pendingEdit])

    expect(expectLoaded()).toEqual({
      version: SCHEMA_VERSION,
      note: state.note,
      snapshots: state.snapshots,
      messages: state.messages,
      runs: state.runs,
      rejectedTraces: state.rejectedTraces,
      pendingEdits: state.pendingEdits,
    })
  })

  it('still caps persisted runs at the most recent 12', () => {
    const backing = installStorage()
    const runs = Array.from({ length: 15 }, (_, i): Trace => ({ ...run, id: `run-${i}` }))

    saveWorkspaceState({
      note: '# Ledger\n',
      snapshots: [],
      messages: [],
      runs,
      rejectedTraces: [],
      pendingEdits: [],
    })

    const persisted = JSON.parse(backing.get(STORAGE_KEY) as string) as { runs: Trace[] }
    expect(persisted.runs).toHaveLength(12)
    expect(persisted.runs[0]?.id).toBe('run-3')
    expect(persisted.runs[11]?.id).toBe('run-14')
  })
})

describe('v1 → v2 migration (decision D3)', () => {
  it('loads a v1 payload with pendingEdits: [] and every other field identical', () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify(v1Payload) })

    const loaded = expectLoaded()
    expect(loaded.version).toBe(SCHEMA_VERSION)
    expect(loaded.pendingEdits).toEqual([])
    // Carried over untouched (byte-for-byte values).
    expect(loaded.note).toBe(v1Payload.note)
    expect(loaded.snapshots).toEqual(v1Payload.snapshots)
    expect(loaded.messages).toEqual(v1Payload.messages)
    expect(loaded.runs).toEqual(v1Payload.runs)
    expect(loaded.rejectedTraces).toEqual(v1Payload.rejectedTraces)
  })

  it('the next save after a v1 load writes a complete v2 payload', () => {
    const backing = installStorage({ [STORAGE_KEY]: JSON.stringify(v1Payload) })
    const loaded = expectLoaded()

    saveWorkspaceState({
      note: loaded.note,
      snapshots: loaded.snapshots,
      messages: loaded.messages,
      runs: loaded.runs,
      rejectedTraces: loaded.rejectedTraces,
      pendingEdits: loaded.pendingEdits,
    })

    const persisted = JSON.parse(backing.get(STORAGE_KEY) as string) as Record<string, unknown>
    expect(persisted.version).toBe(2)
    expect(persisted.pendingEdits).toEqual([])
    expect(persisted.snapshots).toEqual(v1Payload.snapshots)
  })

  it('saves carry pendingEdits: [] until the P5 wiring passes real pendings', () => {
    const backing = installStorage()

    saveWorkspaceState({
      note: v1Payload.note,
      snapshots: [snapshot],
      messages,
      runs: [run],
      rejectedTraces: [rejectedTrace],
    })

    const persisted = JSON.parse(backing.get(STORAGE_KEY) as string) as {
      version: number
      pendingEdits: unknown[]
    }
    expect(persisted.version).toBe(2)
    expect(persisted.pendingEdits).toEqual([])
  })
})

describe('defensive pendingEdits in a v2 payload', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'not-a-list'],
    ['a number', 42],
    ['an object', { length: 1 }],
  ])('loads a v2 payload with %s for pendingEdits as []', (_label, pendingEdits) => {
    installStorage({
      [STORAGE_KEY]: JSON.stringify({ version: 2, note: '# Ledger\n', pendingEdits }),
    })
    expect(expectLoaded().pendingEdits).toEqual([])
  })
})

describe('loader discipline on unknown payloads (unchanged from v1)', () => {
  it.each([
    ['absent', { note: '# Ledger\n' }],
    ['a future version', { version: 3, note: '# Ledger\n' }],
    ['a pre-v1 version', { version: 0, note: '# Ledger\n' }],
    ['a mistyped version', { version: '2', note: '# Ledger\n' }],
  ])('a payload with %s loads as null — the app seeds fresh', (_label, payload) => {
    installStorage({ [STORAGE_KEY]: JSON.stringify(payload) })
    expect(loadWorkspaceState()).toBeNull()
  })

  it('a payload whose note is not a string loads as null, whatever the version', () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, note: 42 }) })
    expect(loadWorkspaceState()).toBeNull()
  })

  it('corrupt JSON loads as null without throwing', () => {
    installStorage({ [STORAGE_KEY]: '{not json at all' })
    expect(loadWorkspaceState()).toBeNull()
  })

  it('an empty store loads as null', () => {
    expect(loadWorkspaceState()).toBeNull()
  })
})
