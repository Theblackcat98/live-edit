/**
 * Native LFM3 model bridge — compatibility shim.
 *
 * The bridge is split by concern:
 *
 *   ./endpoints    servers, transport, health probes
 *   ./chatClient   chat completions (single-shot and streamed)
 *   ./asrClient    speech-to-text
 *   ./ttsClient    text-to-speech
 *   ./d1Client     d1 decision model
 *
 * Every existing `from '../lib/bridge'` import keeps working through these
 * re-exports. New code should import from the specific client module.
 *
 * @deprecated Import from the per-concern module instead.
 */

export {
  BridgeError,
  ENDPOINTS,
  endpointUp,
  fetchJson,
  modelHost,
  modelUrl,
  probeEndpoint,
  probeRuntime,
  type EndpointSpec,
} from './endpoints'

export {
  chatComplete,
  chatCompleteStream,
  measuredUsage,
  readCompletionChoice,
  usageOf,
  type ChatContent,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ChatStreamOptions,
  type ToolCallRequest,
  type ToolDef,
  type TokenUsage,
} from './chatClient'

export { transcribeAudio, type TranscriptResult } from './asrClient'

export { synthesizeSpeech } from './ttsClient'

export {
  d1Decide,
  parseD1Answer,
  type D1DecideResult,
  type D1Question,
} from './d1Client'
