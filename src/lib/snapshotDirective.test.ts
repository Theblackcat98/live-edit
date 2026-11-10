import { describe, expect, it } from 'vitest'
import { detectSnapshotDirective } from './snapshotDirective'

describe('detectSnapshotDirective', () => {
  it.each([
    'undo',
    'undo that',
    'please undo that',
    'revert the last',
    'roll back this',
    'um, please undo that',
  ])('detects undo in %j', (command) => {
    expect(detectSnapshotDirective(command)).toBe('undo')
  })

  it.each(['redo', 'redo it', 'please reapply that', 'apply that again'])(
    'detects redo in %j',
    (command) => {
      expect(detectSnapshotDirective(command)).toBe('redo')
    },
  )

  it.each([
    'update the Q3 revenue row to $1.45M Final',
    'remove the bullet about Redis',
    'what happens if I undo the Q3 row?',
    'add a line under Security',
    'hey',
  ])('returns null for %j', (command) => {
    expect(detectSnapshotDirective(command)).toBeNull()
  })
})
