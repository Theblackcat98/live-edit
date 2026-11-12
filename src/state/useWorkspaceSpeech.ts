import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeHealth } from '../types'
import { speak, stopSpeaking, cleanSpeechText, speechSynthesisAvailable } from '../lib/speech'
import { endpointUp, synthesizeSpeech } from '../lib/bridge'
import type { RunMode } from '../lib/runmode'
import { modeDef } from '../lib/modes'

interface SpeechArgs {
  /** Latest run mode: decides whether a model TTS server (or browser voice) speaks. */
  modeRef: { current: RunMode }
  healthRef: { current: RuntimeHealth | null }
}

export interface WorkspaceSpeechApi {
  speakerOn: boolean
  toggleSpeaker: () => void
  speaking: boolean
  ttsBusy: boolean
  /** Stop any spoken audio: model TTS fetch, audio element, browser voice. */
  stopSpeech: () => void
  /** Speak an assistant reply when the speaker is on. */
  speakReply: (text: string) => void
}

/**
 * Model TTS with a browser-voice fallback. The mode's Omni-architecture
 * server speaks its own reply over /tts when it is up; every failure path
 * finishes with the browser voice rather than going silent.
 */
export function useWorkspaceSpeech({ modeRef, healthRef }: SpeechArgs): WorkspaceSpeechApi {
  const [speaking, setSpeaking] = useState(false)
  const [speakerOn, setSpeakerOn] = useState(false)
  const [ttsBusy, setTtsBusy] = useState(false)

  const speakerOnRef = useRef(speakerOn)
  const speechTokenRef = useRef(0)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const ttsAbortRef = useRef<AbortController | null>(null)
  const ttsUrlRef = useRef<string | null>(null)

  useEffect(() => {
    speakerOnRef.current = speakerOn
  }, [speakerOn])

  const stopSpeech = useCallback(() => {
    speechTokenRef.current += 1
    ttsAbortRef.current?.abort()
    ttsAbortRef.current = null
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current = null
    }
    if (ttsUrlRef.current) {
      URL.revokeObjectURL(ttsUrlRef.current)
      ttsUrlRef.current = null
    }
    stopSpeaking()
    setSpeaking(false)
    setTtsBusy(false)
  }, [])

  const speakReply = useCallback(
    (text: string) => {
      if (!speakerOnRef.current) return
      speechTokenRef.current += 1
      const token = speechTokenRef.current
      const clean = cleanSpeechText(text)
      if (!clean) return

      // Browser-voice dispatch: the speaking state is set at DISPATCH, not
      // on the utterance's onstart — headless and some embedded browsers
      // never fire onstart, which left a playing reply with a permanently
      // disabled Stop button (battery case 17a). onend/onerror still clear
      // it; stopSpeech cancels the utterance outright.
      const speakWithBrowserVoice = (value: string) => {
        if (!speechSynthesisAvailable()) return
        setSpeaking(true)
        speak(value, {
          onStart: () => {
            if (speechTokenRef.current === token) setSpeaking(true)
          },
          onEnd: () => {
            if (speechTokenRef.current === token) setSpeaking(false)
          },
        })
      }

      // Live path: the mode's Omni-architecture server speaks its own reply
      // over /tts (24 kHz WAV). Low-RAM has no such server
      // (modeDef(...).speech → null) and always uses the browser voice.
      const ttsEndpoint = modeDef(modeRef.current).speech
      if (ttsEndpoint && endpointUp(healthRef.current, ttsEndpoint)) {
        setTtsBusy(true)
        const controller = new AbortController()
        ttsAbortRef.current = controller
        void (async () => {
          try {
            const blob = await synthesizeSpeech(clean, {
              signal: controller.signal,
              endpoint: ttsEndpoint,
            })
            if (speechTokenRef.current !== token) return
            const url = URL.createObjectURL(blob)
            ttsUrlRef.current = url
            const audio = new Audio(url)
            ttsAudioRef.current = audio
            audio.onended = () => {
              if (speechTokenRef.current !== token) return
              setSpeaking(false)
              URL.revokeObjectURL(url)
              if (ttsUrlRef.current === url) ttsUrlRef.current = null
              ttsAudioRef.current = null
            }
            audio.onerror = () => {
              if (speechTokenRef.current !== token) return
              setSpeaking(false)
              // Model audio failed mid-playback — finish with the browser voice.
              speakWithBrowserVoice(clean)
            }
            setSpeaking(true)
            await audio.play()
          } catch (error) {
            if (controller.signal.aborted || speechTokenRef.current !== token) return
            // TTS request failed — fall back to the browser voice.
            speakWithBrowserVoice(clean)
          } finally {
            if (speechTokenRef.current === token) setTtsBusy(false)
          }
        })()
        return
      }

      // Fallback: browser speechSynthesis.
      speakWithBrowserVoice(clean)
    },
    [healthRef, modeRef],
  )

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((previous) => {
      const next = !previous
      speakerOnRef.current = next
      if (!next) {
        speechTokenRef.current += 1
        stopSpeaking()
        setSpeaking(false)
      }
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      // Unmount is a stop path: no TTS fetch or utterance survives the session.
      ttsAbortRef.current?.abort()
      stopSpeaking()
    }
  }, [])

  return { speakerOn, toggleSpeaker, speaking, ttsBusy, stopSpeech, speakReply }
}
