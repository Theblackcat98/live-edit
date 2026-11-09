import { beforeEach, describe, expect, it } from 'vitest'
import { currentSceneSource, registerLiveFrame } from './frame'

/**
 * Audit TD-18: the local chat fallback needs the scene's true provenance to
 * decide what it may describe. currentSceneSource is that sync lookup.
 */
describe('currentSceneSource (audit TD-18)', () => {
  beforeEach(() => {
    registerLiveFrame(null)
  })

  it('reports the synthetic slide when no live capture is registered', () => {
    expect(currentSceneSource()).toBe('synthetic-slide')
  })

  it('prefers a registered camera snapshot', () => {
    registerLiveFrame('data:image/jpeg;base64,zzz', 'camera')
    expect(currentSceneSource()).toBe('live-camera')
  })

  it('prefers a registered screen snapshot', () => {
    registerLiveFrame('data:image/jpeg;base64,zzz', 'screen')
    expect(currentSceneSource()).toBe('live-screen')
  })

  it('returns to the synthetic slide when capture stops', () => {
    registerLiveFrame('data:image/jpeg;base64,zzz', 'camera')
    registerLiveFrame(null)
    expect(currentSceneSource()).toBe('synthetic-slide')
  })
})
