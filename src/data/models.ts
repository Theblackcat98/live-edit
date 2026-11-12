import type { ModelInfo } from '../types'

// Specs are ground truth from scripts/start-models.sh: quant files, mmproj
// adapters, and each server's -c context window. The roster a mode actually
// runs is `MODES[mode].roster` in src/lib/modes.ts — never a static trinity,
// so the Runtime rail shows the models serving the active mode.

/** The default interface: LFM3-Audio-2B on :8086 (-c 128000). */
export const AUDIO_INTERFACE: ModelInfo = {
  id: 'audio',
  flow: 'omni',
  role: 'Interface',
  shortName: 'Audio 2B',
  name: 'LFM3-Audio-2B',
  params: '2.17B',
  contextK: 128,
  quant: 'Q4_K_M',
  memGB: 1.3,
  color: 'green',
  description:
    'The front door in the audio mode: listens, answers, speaks and silently delegates edits.',
}

/** The legacy interface: LFM3-Omni-2B on :8083 (-c 32000). */
export const OMNI_INTERFACE: ModelInfo = {
  id: 'omni',
  flow: 'omni',
  role: 'Interface · legacy',
  shortName: 'Omni 2B',
  name: 'LFM3-Omni-2B',
  params: '2.17B',
  contextK: 32,
  quant: 'Q4_K_M',
  memGB: 1.5,
  color: 'green',
  description:
    'The legacy omni-mode front door (chats, ASR, TTS). Not part of the default roster.',
}

export const D1_CHECK: ModelInfo = {
  id: 'd1',
  flow: 'd1',
  role: 'Safety check',
  shortName: 'd1 Omni 2B',
  name: 'd1-Omni-2B',
  params: '2.17B',
  contextK: 128,
  quant: 'Q8_0',
  memGB: 2.3,
  color: 'accent',
  description: 'Zero-output-token decision head. Judges every proposed tool call.',
}

/** LFM3-1.7B on :8080 (-c 128000). */
export const WORKER: ModelInfo = {
  id: 'worker',
  flow: 'worker',
  role: 'Worker',
  shortName: '1.7B',
  name: 'LFM3-1.7B',
  params: '1.7B',
  contextK: 128,
  quant: 'Q4_K_M',
  memGB: 1.1,
  color: 'orange',
  description: 'Reasons in <think> and emits XML tool calls against the active note.',
}

/** The worker-chat role label: the 1.7B answers chat AND authors calls there. */
export const WORKER_CHAT: ModelInfo = { ...WORKER, role: 'Chat + Worker' }

/** Weights+adapter footprint of a roster (each model counted once). */
export function rosterMemoryGB(models: ModelInfo[]): number {
  return models.reduce((total, model) => total + model.memGB, 0)
}

export const MEMORY_BUDGET_GB = 8
