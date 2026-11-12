/**
 * What the llama.cpp servers report must reach the app intact: model lists
 * in both shapes, the runtime context window, performance timings, and a
 * real duration on failed requests.
 */
import { describe, expect, it } from 'vitest'
import { contextFromProps, listedModels } from './endpoints'
import { optionalServerFacts, serverTimingsOf } from './completion'
import { captureExchange } from './exchange'

describe('health probe payload parsing', () => {
  it('reads the OpenAI data[] list, not only llama.cpp models[]', () => {
    expect(listedModels({ object: 'list', data: [{ id: 'lfm3-audio-2b' }] })).toEqual(['lfm3-audio-2b'])
    expect(
      listedModels({ models: [{ name: 'lfm3-1.7b', model: 'lfm3-1.7b' }], data: [{ id: 'lfm3-1.7b' }] }),
    ).toEqual(['lfm3-1.7b'])
  })

  it('reads the runtime context window from /props', () => {
    expect(contextFromProps({ default_generation_settings: { n_ctx: 32000 } })).toBe(32000)
    expect(contextFromProps({ n_ctx: 128000 })).toBe(128000)
    expect(contextFromProps({})).toBeUndefined()
  })
})

describe('server timings', () => {
  it('keeps speed and prompt-cache hits llama.cpp reports', () => {
    const payload = {
      model: 'lfm3-1.7b',
      timings: { prompt_ms: 120.5, predicted_ms: 900, predicted_per_second: 41.2, cache_n: 1800 },
    }
    expect(serverTimingsOf(payload)).toEqual({
      promptMs: 120.5,
      predictedMs: 900,
      tokensPerSecond: 41.2,
      cachedTokens: 1800,
    })
    expect(optionalServerFacts(payload).servedModel).toBe('lfm3-1.7b')
  })

  it('reports nothing it was not given', () => {
    expect(serverTimingsOf({ choices: [] })).toBeUndefined()
    expect(optionalServerFacts({})).toEqual({})
  })
})

describe('captureExchange', () => {
  it('records how long a failed request ran instead of 0 ms', () => {
    const exchange = captureExchange({
      role: 'chat',
      label: 'primary',
      model: 'LFM3-Audio-2B',
      url: 'http://localhost:8086/v1/chat/completions',
      messages: [],
      stream: true,
      temperature: 0.3,
      maxTokens: 1000,
      completion: null,
      error: 'Request timed out after 90s',
      elapsedMs: 90012.4,
    })
    expect(exchange.ok).toBe(false)
    expect(exchange.ms).toBe(90012.4)
  })
})
