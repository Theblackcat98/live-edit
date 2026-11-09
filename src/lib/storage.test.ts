import { describe, expect, it } from 'vitest'
import { parseWorkspaceState } from './storage'

describe('parseWorkspaceState', () => {
  it('migrates a v1 payload with an empty pending list', () => {
    const v1 = JSON.stringify({
      version: 1,
      note: '# Old note',
      snapshots: [],
      messages: [],
      runs: [],
      rejectedTraces: [],
    })
    const parsed = parseWorkspaceState(v1)
    expect(parsed?.version).toBe(2)
    expect(parsed?.note).toBe('# Old note')
    expect(parsed?.pendingEdits).toEqual([])
  })

  it('round-trips a v2 payload including pending edits', () => {
    const v2 = JSON.stringify({
      version: 2,
      note: '# Note',
      snapshots: [],
      messages: [],
      runs: [],
      rejectedTraces: [],
      pendingEdits: [{ id: 'pending-1', status: 'pending' }],
    })
    const parsed = parseWorkspaceState(v2)
    expect(parsed?.pendingEdits).toHaveLength(1)
    expect(parsed?.pendingEdits[0].id).toBe('pending-1')
  })

  it('rejects unknown versions, corrupt JSON, and missing notes', () => {
    expect(parseWorkspaceState(null)).toBeNull()
    expect(parseWorkspaceState('{not json')).toBeNull()
    expect(parseWorkspaceState(JSON.stringify({ version: 3, note: '# x' }))).toBeNull()
    expect(parseWorkspaceState(JSON.stringify({ version: 2 }))).toBeNull()
  })

  it('defaults missing collections to empty arrays', () => {
    const parsed = parseWorkspaceState(JSON.stringify({ version: 2, note: '# x' }))
    expect(parsed?.snapshots).toEqual([])
    expect(parsed?.messages).toEqual([])
    expect(parsed?.rejectedTraces).toEqual([])
    expect(parsed?.pendingEdits).toEqual([])
  })
})
