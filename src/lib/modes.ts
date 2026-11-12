/**
 * The single run-mode registry. Every per-mode fact lives in one row: the
 * catalog copy, the model roster, the servers that serve it, chat and speech
 * routing, the turn flow, the decision policy and the context-budget rows.
 * Callers read {@link modeDef} instead of branching on the mode id, so adding
 * a run mode is one explicit table entry — and a compile-time exhaustive
 * check (assertNever) instead of a hunt for missing branches.
 *
 * Every value is the shipped value, copied verbatim from the former per-mode
 * helpers (runmode.ts, data/models.ts, modelPlan.ts). This module decides
 * nothing the old code did not; it only holds the answer in one place.
 */

import type { EndpointHealth, ModelInfo } from '../types'
import {
  AUDIO_INTERFACE,
  D1_CHECK,
  OMNI_INTERFACE,
  WORKER,
  WORKER_CHAT,
} from '../data/models'
import type { RunMode, RunModeInfo, SpeechEndpoint } from './runmode'

export type EndpointId = EndpointHealth['id']

/** The server that answers `/v1/chat/completions` in a mode. */
export type ChatEndpoint = 'audio' | 'omni' | 'text'

export interface ModeDef {
  id: RunMode
  /** Catalog copy for the segmented control, toasts and the runtime card. */
  info: RunModeInfo
  chat: {
    /** The model that answers chat — the author label on its replies. */
    author: string
    /** Compact chat-model label for status surfaces. */
    short: string
    /** The server that serves the chat completion. */
    endpoint: ChatEndpoint
    /**
     * The model behind `/v1/audio/transcriptions`; null only when the mode
     * runs no Omni-architecture server (the mic is honestly disabled).
     */
    transcriber: string | null
  }
  /** Endpoint ASR/TTS use; null means browser voice only, no /tts call. */
  speech: SpeechEndpoint
  /** The models the mode actually runs, display order. */
  roster: ModelInfo[]
  /** The servers the roster needs, in start-plan order. */
  endpoints: EndpointId[]
  flow: 'omni-first' | 'worker-chat'
  /** `d1` runs the safety check; `hold-always` holds every gate-passing edit. */
  decide: 'd1' | 'hold-always'
  /**
   * Context-budget rows, in roster order. Labels/limits are the servers' real
   * `-c` windows (start-models.sh); the row's usage key is the roster model's
   * flow slot, so the table stays label-and-limit only.
   */
  contextRows: { label: string; limit: number }[]
}

/** The model that serves speech, by endpoint — one mapping, no drift. */
const SPEECH_MODEL = {
  audio: AUDIO_INTERFACE.name,
  omni: OMNI_INTERFACE.name,
  d1omni: D1_CHECK.name,
} satisfies Record<NonNullable<SpeechEndpoint>, string>

/** The transcriber for a speech endpoint; null when there is no audio server. */
export function transcriberFor(endpoint: SpeechEndpoint): string | null {
  return endpoint ? SPEECH_MODEL[endpoint] : null
}

/** A seed omits `transcriber`; the row derives it from `speech`. */
type ModeSeed = Omit<ModeDef, 'chat'> & { chat: Omit<ModeDef['chat'], 'transcriber'> }

function defineMode(seed: ModeSeed): ModeDef {
  return { ...seed, chat: { ...seed.chat, transcriber: transcriberFor(seed.speech) } }
}

export const MODES: Record<RunMode, ModeDef> = {
  audio: defineMode({
    id: 'audio',
    info: {
      id: 'audio',
      label: 'Audio-first',
      short: 'Audio',
      description:
        'Audio 2B (:8086) answers, the 1.7B (:8080) authors tool calls, d1-Omni (:8085) checks ' +
        'every edit. ASR and TTS use :8086.',
    },
    chat: { author: 'LFM3-Audio-2B', short: 'Audio', endpoint: 'audio' },
    speech: 'audio',
    roster: [AUDIO_INTERFACE, D1_CHECK, WORKER],
    endpoints: ['audio', 'd1omni', 'text'],
    flow: 'omni-first',
    decide: 'd1',
    contextRows: [
      { label: 'Audio · rolling', limit: 128000 },
      { label: 'd1 · stateless', limit: 128000 },
      { label: '1.7B · task', limit: 128000 },
    ],
  }),
  omni: defineMode({
    id: 'omni',
    info: {
      id: 'omni',
      label: 'Omni-first (legacy)',
      short: 'Omni',
      description:
        'Omni 2B (:8083) answers, the 1.7B (:8080) authors tool calls, d1-Omni (:8085) checks ' +
        'every edit. ASR and TTS use :8083.',
    },
    chat: { author: 'LFM3-Omni-2B', short: 'Omni', endpoint: 'omni' },
    speech: 'omni',
    roster: [OMNI_INTERFACE, D1_CHECK, WORKER],
    endpoints: ['omni', 'd1omni', 'text'],
    flow: 'omni-first',
    decide: 'd1',
    contextRows: [
      { label: 'Omni · rolling', limit: 32000 },
      { label: 'd1 · stateless', limit: 128000 },
      { label: '1.7B · task', limit: 128000 },
    ],
  }),
  'worker-d1': defineMode({
    id: 'worker-d1',
    info: {
      id: 'worker-d1',
      label: '1.7B + d1',
      short: '1.7B + d1',
      description:
        'LFM3-1.7B (:8080) chats and authors tool calls; d1-Omni (:8085) decides edit safety. ' +
        'No front-door model runs; ASR and TTS use :8085.',
    },
    chat: { author: 'LFM3-1.7B', short: '1.7B', endpoint: 'text' },
    speech: 'd1omni',
    roster: [WORKER_CHAT, D1_CHECK],
    endpoints: ['text', 'd1omni'],
    flow: 'worker-chat',
    decide: 'd1',
    contextRows: [
      { label: '1.7B · chat + calls', limit: 128000 },
      { label: 'd1 · stateless', limit: 128000 },
    ],
  }),
  lowram: defineMode({
    id: 'lowram',
    info: {
      id: 'lowram',
      label: '1.7B',
      short: '1.7B',
      description:
        'Low-RAM: only LFM3-1.7B (:8080). Tool calls pass the hard gates and are held for your approval; no d1. ' +
        'Mic ASR is off — type instead; speech uses the browser voice.',
    },
    chat: { author: 'LFM3-1.7B', short: '1.7B', endpoint: 'text' },
    speech: null,
    roster: [WORKER_CHAT],
    endpoints: ['text'],
    flow: 'worker-chat',
    decide: 'hold-always',
    contextRows: [{ label: '1.7B · rolling', limit: 128000 }],
  }),
}

/**
 * A mode's row. The switch is exhaustive: a fifth `RunMode` fails to compile
 * here (the default reaches `assertNever`) and in the `MODES` record itself.
 */
export function modeDef(mode: RunMode): ModeDef {
  switch (mode) {
    case 'audio':
      return MODES.audio
    case 'omni':
      return MODES.omni
    case 'worker-d1':
      return MODES['worker-d1']
    case 'lowram':
      return MODES.lowram
    default:
      return assertNever(mode)
  }
}

/** Compile-time exhaustiveness guard: an unhandled union member is `never`. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled run mode: ${String(value)}`)
}

/** Unknown/corrupt persisted values are not run modes. */
export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && Object.hasOwn(MODES, value)
}

/** The omni-first modes (their chat front door is Audio or legacy Omni). */
export function isOmniFirstMode(mode: RunMode): mode is 'audio' | 'omni' {
  return modeDef(mode).flow === 'omni-first'
}

/** The worker-chat modes (LFM3-1.7B is the chat model itself). */
export function isWorkerChatMode(mode: RunMode): mode is 'worker-d1' | 'lowram' {
  return modeDef(mode).flow === 'worker-chat'
}
