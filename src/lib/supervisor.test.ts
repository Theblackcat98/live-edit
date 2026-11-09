import { describe, expect, it } from 'vitest'
import { normalizeCommand } from './supervisor'

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
