/**
 * Text-to-speech against an Omni-architecture server (`POST /tts`).
 */

import { BridgeError, ENDPOINTS, modelUrl } from './endpoints'

/**
 * Model TTS. `endpoint` names the Omni-architecture server that speaks:
 * 'omni' (:8083) in the legacy Omni mode, 'd1omni' (:8085) in worker-d1
 * (same Omni architecture), 'audio' (:8086) in the audio-first mode.
 * Low-RAM never calls this — the caller uses the browser voice instead.
 */
export async function synthesizeSpeech(
  text: string,
  options: { signal?: AbortSignal; endpoint?: 'omni' | 'd1omni' | 'audio' } = {},
): Promise<Blob> {
  const endpoint = options.endpoint ?? 'omni'
  const spec = ENDPOINTS.find((candidate) => candidate.id === endpoint)
  if (!spec) throw new BridgeError(`${endpoint} endpoint missing`)
  const response = await fetch(modelUrl(spec.port, '/tts'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, response_format: 'wav' }),
    signal: options.signal,
  })
  if (!response.ok) {
    throw new BridgeError(`TTS failed: HTTP ${response.status}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new BridgeError('TTS returned empty audio')
  return blob
}
