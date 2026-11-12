import { describe, expect, it } from 'vitest'
import { MODES, isOmniFirstMode, isRunMode, isWorkerChatMode, modeDef, transcriberFor } from './modes'

const IDS = ['audio', 'omni', 'worker-d1', 'lowram'] as const

describe('mode registry', () => {
  it('has exactly the four shipped modes, in catalog order', () => {
    expect(Object.keys(MODES)).toEqual([...IDS])
  })

  it('every row names itself and carries catalog copy', () => {
    for (const id of IDS) {
      const def = MODES[id]
      expect(def.id).toBe(id)
      expect(def.info.id).toBe(id)
      expect(def.info.label.length).toBeGreaterThan(0)
      expect(def.info.short.length).toBeGreaterThan(0)
      expect(def.info.description.length).toBeGreaterThan(0)
      expect(modeDef(id)).toBe(def)
    }
  })

  it('keeps the shipped per-mode values verbatim (no silent fallback rows)', () => {
    expect(MODES.audio.speech).toBe('audio')
    expect(MODES.omni.speech).toBe('omni')
    expect(MODES['worker-d1'].speech).toBe('d1omni')
    // lowram has no audio server; this is an explicit row, not a fallback.
    expect(MODES.lowram.speech).toBeNull()
    expect(MODES.lowram.chat.transcriber).toBeNull()
    expect(MODES.lowram.endpoints).toEqual(['text'])
    expect(MODES.lowram.decide).toBe('hold-always')

    expect(MODES.audio.chat).toEqual({
      author: 'LFM3-Audio-2B',
      short: 'Audio',
      endpoint: 'audio',
      transcriber: 'LFM3-Audio-2B',
    })
    expect(MODES.omni.chat.endpoint).toBe('omni')
    expect(MODES['worker-d1'].chat).toEqual({
      author: 'LFM3-1.7B',
      short: '1.7B',
      endpoint: 'text',
      transcriber: 'd1-Omni-2B',
    })
  })

  it('derives the transcriber from the speech endpoint in one place', () => {
    for (const id of IDS) {
      expect(MODES[id].chat.transcriber).toBe(transcriberFor(MODES[id].speech))
    }
    expect(transcriberFor('audio')).toBe('LFM3-Audio-2B')
    expect(transcriberFor('omni')).toBe('LFM3-Omni-2B')
    expect(transcriberFor('d1omni')).toBe('d1-Omni-2B')
  })

  it('keeps one context row per roster model, in roster order', () => {
    for (const id of IDS) {
      expect(MODES[id].contextRows).toHaveLength(MODES[id].roster.length)
    }
  })

  it('splits the flows exactly as the pipeline dispatches them', () => {
    expect(IDS.filter(isOmniFirstMode)).toEqual(['audio', 'omni'])
    expect(IDS.filter(isWorkerChatMode)).toEqual(['worker-d1', 'lowram'])
  })

  it('accepts only the registered ids as persisted modes', () => {
    for (const id of IDS) expect(isRunMode(id)).toBe(true)
    for (const value of ['turbo', 'OMNI', '', null, undefined, 3, {}]) {
      expect(isRunMode(value)).toBe(false)
    }
  })
})
