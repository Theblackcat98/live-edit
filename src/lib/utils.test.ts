import { describe, expect, it } from 'vitest'
import { clamp, formatP } from './utils'

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

describe('clamp', () => {
  it('keeps values inside the bounds untouched', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
    expect(clamp(25, 1, 100)).toBe(25)
  })

  it('pins values at the nearest bound', () => {
    expect(clamp(-3, 0, 1)).toBe(0)
    expect(clamp(4, 0, 1)).toBe(1)
  })
})

describe('probability display helper: honesty edges', () => {
  it('never rounds a measured value up into a false certainty', () => {
    expect(formatP(0.999)).toBe('1.00')
    expect(formatP(0.004)).toBe('0.00')
    expect(formatP(0)).toBe('0.00')
  })

  it('keeps negative reported scores visible rather than hiding them', () => {
    expect(formatP(-0.2)).toBe('-0.20')
  })

  it('renders the gate thresholds at display precision', () => {
    expect(formatP(0.25)).toBe('0.25')
    expect(formatP(0.5)).toBe('0.50')
  })

  it('is stable across repeated reads of the same unreported value', () => {
    expect(formatP(null)).toBe('—')
    expect(formatP(null)).toBe('—')
  })
})
