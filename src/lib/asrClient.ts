/**
 * Speech-to-text against an Omni-architecture server
 * (`POST /v1/audio/transcriptions`).
 */

import { isRecord, readString } from './utils'
import { BridgeError, ENDPOINTS, fetchJson, modelUrl } from './endpoints'
import { usageOf, type TokenUsage } from './completion'

export interface TranscriptResult {
  text: string
  ms: number
  usage: TokenUsage
}

export async function transcribeAudio(
  blob: Blob,
  endpoint: 'omni' | 'd1omni' | 'audio' = 'omni',
): Promise<TranscriptResult> {
  const spec = ENDPOINTS.find((candidate) => candidate.id === endpoint)
  if (!spec) throw new BridgeError(`${endpoint} endpoint missing`)
  const started = performance.now()
  const form = new FormData()
  form.append('file', blob, 'capture.wav')
  form.append('response_format', 'json')
  const payload = await fetchJson(modelUrl(spec.port, '/v1/audio/transcriptions'), {
    method: 'POST',
    body: form,
    timeoutMs: 45_000,
  })
  const text = ((isRecord(payload) ? readString(payload, 'text') : undefined) ?? '').trim()
  if (!text) throw new BridgeError('Transcription came back empty')
  return {
    text,
    ms: Number((performance.now() - started).toFixed(1)),
    usage: usageOf(payload),
  }
}
