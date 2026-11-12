/**
 * User-selectable run modes: which local model(s) serve the chat and the
 * edit pipeline.
 *
 * - `audio`     the Audio-first pipeline (default):
 *               LFM3-Audio-2B (:8086) is the chat/ASR/TTS front door, the
 *               1.7B (:8080) authors tool calls, d1-Omni (:8085) is the §7
 *               safety check.
 * - `omni`      legacy Omni-first pipeline:
 *               LFM3-Omni-2B (:8083) is the chat/ASR/TTS front door, the
 *               1.7B (:8080) authors tool calls, d1-Omni (:8085) is the §7
 *               safety check.
 * - `worker-d1` the 1.7B chats with tools enabled and also authors tool
 *               calls; d1-Omni (:8085) is the decision layer (edit safety
 *               check → approve / hold as a pending edit). ASR/TTS ride the
 *               d1-Omni endpoint because it is the same Omni architecture.
 * - `lowram`    just the 1.7B. No d1 anywhere: tool calls pass the
 *               deterministic hard gates and are then held as pending
 *               edits for the user — with no decision model running,
 *               nothing executes silently. Mic ASR is impossible without
 *               an Omni-arch server, so it is honestly disabled; TTS uses
 *               the browser voice only.
 *
 * Persistence is best-effort and defensive, mirroring storage.ts: an absent,
 * corrupt or unknown value loads as the default (`audio`). The mode lives
 * under its own key — the workspace storage schema is deliberately not
 * bumped.
 */

import { MODES, isRunMode, modeDef } from './modes'

export type RunMode = 'audio' | 'omni' | 'worker-d1' | 'lowram'

export interface RunModeInfo {
  id: RunMode
  /** Full label for toasts and the runtime card. */
  label: string
  /** Compact label for the TopBar segmented control. */
  short: string
  description: string
}

/** The catalog, derived from the registry — never a second copy. */
export const RUN_MODES: RunModeInfo[] = Object.values(MODES).map((def) => def.info)

export const RUN_MODE_STORAGE_KEY = 'liquidscribe.runmode.v1'

export const DEFAULT_RUN_MODE: RunMode = 'audio'

export { isRunMode }

/** Absent, corrupt, or unknown persistent values all load as `audio`. */
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
  return modeDef(mode).info
}

/**
 * The endpoint that serves ASR/TTS for a mode. `null` means there is no
 * Omni-architecture server in the mode — the mic is honestly disabled and
 * speech falls back to the browser voice (never a model /tts call).
 */
export type SpeechEndpoint = 'audio' | 'omni' | 'd1omni' | null

/** @deprecated Read `modeDef(mode).speech`; kept for the existing tests. */
export function speechEndpointFor(mode: RunMode): SpeechEndpoint {
  return modeDef(mode).speech
}

/** Port for the mode's speech endpoint, for honest offline messages. */
export function speechPortFor(endpoint: SpeechEndpoint): number | null {
  if (endpoint === 'audio') return 8086
  if (endpoint === 'omni') return 8083
  if (endpoint === 'd1omni') return 8085
  return null
}

// --- per-mode model naming -------------------------------------------------------
// UI honesty: a surface names the model that actually serves the mode, never a
// hardcoded one. The interface model is Audio by default; Omni only in the
// legacy mode; the 1.7B itself in the worker-chat modes.

/** The model that answers chat in a mode — the author label on its replies. */
export function chatModelName(mode: RunMode): string {
  return modeDef(mode).chat.author
}

/** Short chat-model label for compact status surfaces. */
export function chatModelShort(mode: RunMode): string {
  return modeDef(mode).chat.short
}

/**
 * The model whose `/v1/audio/transcriptions` endpoint serves the mic in this
 * mode; null in `lowram` (no audio server — the mic is honestly disabled).
 */
export function transcribingModel(mode: RunMode): string | null {
  return modeDef(mode).chat.transcriber
}
