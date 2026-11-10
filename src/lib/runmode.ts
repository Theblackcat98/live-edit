/**
 * User-selectable run modes: which local model(s) serve the chat and the
 * edit pipeline.
 *
 * - `omni`      the Omni-first pipeline:
 *               LFM3-Omni-2B (:8083) is the chat/ASR/TTS front door, the
 *               1.7B (:8080) authors tool calls, d1-Omni (:8085) is the §7
 *               safety check.
 * - `worker-d1` the 1.7B chats with tools enabled and also authors tool
 *               calls; d1-Omni (:8085) is the decision layer (edit safety
 *               check → approve / hold as a pending edit). Omni (:8083) is
 *               out of the loop; ASR/TTS ride the d1-Omni endpoint because
 *               it is the same Omni architecture.
 * - `lowram`    just the 1.7B. No d1 anywhere: tool calls pass the
 *               deterministic hard gates and are then held as pending
 *               edits for the user — with no decision model running,
 *               nothing executes silently. Mic ASR is impossible without
 *               an Omni-arch server, so it is honestly disabled; TTS uses
 *               the browser voice only.
 *
 * Persistence is best-effort and defensive, mirroring storage.ts: an absent,
 * corrupt or unknown value loads as the default (`omni`). The mode lives
 * under its own key — the workspace storage schema is deliberately not
 * bumped.
 */

export type RunMode = 'omni' | 'worker-d1' | 'lowram'

export interface RunModeInfo {
  id: RunMode
  /** Full label for toasts and the runtime card. */
  label: string
  /** Compact label for the TopBar segmented control. */
  short: string
  description: string
}

export const RUN_MODES: RunModeInfo[] = [
  {
    id: 'omni',
    label: 'Omni-first',
    short: 'Omni',
    description:
      'Omni 2B (:8083) answers, the 1.7B (:8080) authors tool calls, d1-Omni (:8085) checks ' +
      'every edit. ASR and TTS use :8083.',
  },
  {
    id: 'worker-d1',
    label: '1.7B + d1',
    short: '1.7B + d1',
    description:
      'LFM3-1.7B (:8080) chats and authors tool calls; d1-Omni (:8085) decides edit safety. ' +
      'Omni is out of the loop; ASR and TTS use :8085.',
  },
  {
    id: 'lowram',
    label: '1.7B',
    short: '1.7B',
    description:
      'Low-RAM: only LFM3-1.7B (:8080). Tool calls pass the hard gates and are held for your approval; no d1. ' +
      'Mic ASR is off — type instead; speech uses the browser voice.',
  },
]

export const RUN_MODE_STORAGE_KEY = 'liquidscribe.runmode.v1'

export const DEFAULT_RUN_MODE: RunMode = 'omni'

function isRunMode(value: unknown): value is RunMode {
  return value === 'omni' || value === 'worker-d1' || value === 'lowram'
}

/** Absent, corrupt, or unknown persistent values all load as `omni`. */
export function loadRunMode(): RunMode {
  try {
    const raw = window.localStorage.getItem(RUN_MODE_STORAGE_KEY)
    return isRunMode(raw) ? raw : DEFAULT_RUN_MODE
  } catch {
    return DEFAULT_RUN_MODE
  }
}

/** Best-effort persistence: a blocked or full store never breaks the switch. */
export function saveRunMode(mode: RunMode): void {
  try {
    window.localStorage.setItem(RUN_MODE_STORAGE_KEY, mode)
  } catch {
    // QuotaExceededError or a blocked store — persistence is best-effort.
  }
}

export function runModeInfo(mode: RunMode): RunModeInfo {
  return RUN_MODES.find((info) => info.id === mode) ?? RUN_MODES[0]
}

/**
 * The endpoint that serves ASR/TTS for a mode. `null` means there is no
 * Omni-architecture server in the mode — the mic is honestly disabled and
 * speech falls back to the browser voice (never a model /tts call).
 */
export type SpeechEndpoint = 'omni' | 'd1omni' | null

export function speechEndpointFor(mode: RunMode): SpeechEndpoint {
  if (mode === 'omni') return 'omni'
  if (mode === 'worker-d1') return 'd1omni'
  return null
}

/** Port for the mode's speech endpoint, for honest offline messages. */
export function speechPortFor(endpoint: SpeechEndpoint): number | null {
  if (endpoint === 'omni') return 8083
  if (endpoint === 'd1omni') return 8085
  return null
}
