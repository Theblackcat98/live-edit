import { afterEach, describe, expect, it } from 'vitest'
import { modelHost, modelUrl } from './bridge'

/**
 * LAN regression: the bridge must address model servers through the host
 * that served the page. A hardcoded 127.0.0.1 is the phone itself on a LAN
 * client, so ASR (and chat/TTS/route) fail there while the desktop works.
 * The servers bind 0.0.0.0, so the page host is always the right target.
 */
function setPageHost(hostname: string): void {
  Object.defineProperty(globalThis, 'window', {
    value: { location: { hostname } },
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('model host resolution', () => {
  it('uses loopback when the page itself is loopback', () => {
    setPageHost('127.0.0.1')
    expect(modelHost()).toBe('127.0.0.1')
    expect(modelUrl(8086, '/v1/audio/transcriptions')).toBe(
      'http://127.0.0.1:8086/v1/audio/transcriptions',
    )
  })

  it('uses the LAN host when the page is served over LAN', () => {
    setPageHost('192.168.1.199')
    expect(modelHost()).toBe('192.168.1.199')
    expect(modelUrl(8086, '/v1/audio/transcriptions')).toBe(
      'http://192.168.1.199:8086/v1/audio/transcriptions',
    )
    expect(modelUrl(8080, '/v1/chat/completions')).toBe(
      'http://192.168.1.199:8080/v1/chat/completions',
    )
  })

  it('falls back to loopback with no window (tests, SSR)', () => {
    expect(modelHost()).toBe('127.0.0.1')
    expect(modelUrl(8086, '/v1/models')).toBe('http://127.0.0.1:8086/v1/models')
  })

  it('brackets an IPv6 page host', () => {
    setPageHost('::1')
    expect(modelUrl(8086, '/v1/models')).toBe('http://[::1]:8086/v1/models')
  })
})
