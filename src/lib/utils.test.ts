import { describe, expect, it } from 'vitest'
import { formatP, pAdopted, pDecisive, pFloor } from './utils'

describe('probability display helper (audit TD-03)', () => {
  it('formats measured probabilities to two decimals', () => {
    expect(formatP(0.876)).toBe('0.88')
    expect(formatP(1)).toBe('1.00')
  })

  it('renders unreported values as an em dash, never a number', () => {
    expect(formatP(null)).toBe('—')
    expect(formatP(undefined)).toBe('—')
  })
})

describe('adoption gate: null satisfies adoption (audit TD-04)', () => {
  it('an unreported score adopts — the decision was made, only its p was not measured', () => {
    expect(pAdopted(null, 0.25)).toBe(true)
    expect(pAdopted(undefined, 0.25)).toBe(true)
  })

  it('a measured score must clear the threshold', () => {
    expect(pAdopted(0.26, 0.25)).toBe(true)
    expect(pAdopted(0.25, 0.25)).toBe(false)
    expect(pAdopted(0.1, 0.25)).toBe(false)
  })
})

describe('decisive gate: null is never decisive (audit TD-04)', () => {
  it('only a measured probability at or above the threshold can overturn', () => {
    expect(pDecisive(null, 0.5)).toBe(false)
    expect(pDecisive(0.49, 0.5)).toBe(false)
    expect(pDecisive(0.5, 0.5)).toBe(true)
    expect(pDecisive(0.9, 0.5)).toBe(true)
  })
})

describe('repair floor (audit TD-04)', () => {
  it('passes measured values above the floor through verbatim', () => {
    expect(pFloor(0.88, 0.3)).toBe(0.88)
  })

  it('replaces sub-floor measured values with the flat heuristic floor', () => {
    expect(pFloor(0.05, 0.5)).toBe(0.5)
  })

  it('never invents a number for an unreported score', () => {
    expect(pFloor(null, 0.5)).toBeNull()
    expect(pFloor(undefined, 0.5)).toBeNull()
  })
})
