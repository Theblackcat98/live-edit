import type { VoiceEndpoint } from './useWorkspaceVoice'

/** The one honest message for a mode with no Omni-architecture speech server. */
export const VOICE_NEEDS_OMNI_DETAIL = 'Low-RAM mode runs only LFM3-1.7B — type instead.'

/** Honest ASR-offline notice for each Omni-architecture endpoint, with its port. */
export function voiceOfflineNotice(endpoint: VoiceEndpoint, port: number | null): {
  title: string
  detail: string
} {
  if (endpoint === 'omni') {
    return {
      title: 'Omni ASR offline',
      detail: `LFM3-Omni-2B is not answering on :${port} — start it with ./lfm3.sh omni, or type the command.`,
    }
  }
  if (endpoint === 'audio') {
    return {
      title: 'Audio ASR offline',
      detail: `LFM3-Audio-2B is not answering on :${port} — start it with scripts/start-models.sh, or type the command.`,
    }
  }
  return {
    title: 'd1-Omni ASR offline',
    detail: `d1-Omni-2B is not answering on :${port} — start it, or type the command.`,
  }
}
