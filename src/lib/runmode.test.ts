import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_RUN_MODE,
  RUN_MODES,
  RUN_MODE_STORAGE_KEY,
  loadRunMode,
  runModeInfo,
  saveRunMode,
  speechEndpointFor,
  speechPortFor,
} from './runmode'

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

beforeEach(() => {
  installStorage()
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('run mode catalog', () => {
  it('has exactly the three modes, defaulting to omni', () => {
    expect(RUN_MODES.map((mode) => mode.id)).toEqual(['omni', 'worker-d1', 'lowram'])
    expect(DEFAULT_RUN_MODE).toBe('omni')
  })

  it('every mode carries a short label for the segmented control and a description', () => {
    for (const mode of RUN_MODES) {
      expect(mode.short.length).toBeGreaterThan(0)
      expect(mode.label.length).toBeGreaterThan(0)
      expect(mode.description.length).toBeGreaterThan(0)
    }
    expect(runModeInfo('lowram').short).toBe('1.7B')
  })
})

describe('persistence', () => {
  it.each(['omni', 'worker-d1', 'lowram'] as const)('round-trips %s', (mode) => {
    saveRunMode(mode)
    expect(loadRunMode()).toBe(mode)
  })

  it('writes the dedicated key, not the workspace schema key', () => {
    const backing = installStorage()
    saveRunMode('worker-d1')
    expect(backing.get(RUN_MODE_STORAGE_KEY)).toBe('worker-d1')
    expect(backing.has('liquidscribe.workspace.v1')).toBe(false)
  })

  it.each([
    ['absent', {}],
    ['an unknown value', { [RUN_MODE_STORAGE_KEY]: 'turbo' }],
    ['an empty string', { [RUN_MODE_STORAGE_KEY]: '' }],
    ['a lookalike', { [RUN_MODE_STORAGE_KEY]: 'OMNI' }],
  ])('loads omni when the stored value is %s', (_label, seed) => {
    installStorage(seed)
    expect(loadRunMode()).toBe('omni')
  })

  it('loads omni when the store throws', () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      },
    }
    expect(loadRunMode()).toBe('omni')
    expect(() => saveRunMode('lowram')).not.toThrow()
  })
})

describe('speech routing per mode', () => {
  it('names the endpoint ASR/TTS must use, or null when no Omni server exists', () => {
    expect(speechEndpointFor('omni')).toBe('omni')
    expect(speechEndpointFor('worker-d1')).toBe('d1omni')
    expect(speechEndpointFor('lowram')).toBeNull()
    expect(speechPortFor('omni')).toBe(8083)
    expect(speechPortFor('d1omni')).toBe(8085)
    expect(speechPortFor(null)).toBeNull()
  })
})
