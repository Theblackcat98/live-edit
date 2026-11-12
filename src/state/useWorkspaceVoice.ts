import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeHealth, RuntimeSource, Toast } from '../types'
import { VoiceRecorder } from '../lib/speech'
import { endpointUp, transcribeAudio } from '../lib/bridge'
import { speechPortFor, type RunMode } from '../lib/runmode'
import { modeDef } from '../lib/modes'
import { VOICE_NEEDS_OMNI_DETAIL, voiceOfflineNotice } from './voiceNotices'

export type VoiceEndpoint = 'omni' | 'd1omni' | 'audio'
export type SubmitCommand = (command: string, source?: 'text' | 'voice' | 'demo') => Promise<void>

interface VoiceArgs {
  /** Latest run mode: decides which ASR endpoint a capture uses. */
  modeRef: { current: RunMode }
  healthRef: { current: RuntimeHealth | null }
  busyRef: { current: boolean }
  notify: (title: string, detail?: string, tone?: Toast['tone']) => void
  /** Barge-in: voice onset cuts a spoken reply. */
  stopSpeech: () => void
  /** Hands-free toggle mirror, injected: the mode-switch hook (declared before this one) reads it. */
  micOnRef: { current: boolean }
  /** Latest stopMic, injected so the mode-switch hook can stop a capture. Assigned below. */
  stopMicRef: { current: () => void }
  /**
   * Latest submitCommand, late-bound: finishVoiceCapture runs a full turn but
   * the pipeline is assembled by the orchestrator after every hook. The ref is
   * assigned during render, so a resolved capture submits through the current
   * turn function.
   */
  submitRef: { current: SubmitCommand }
}

export interface WorkspaceVoiceApi {
  micOn: boolean
  micActive: boolean
  toggleMic: () => void
  asrBusy: boolean
  getMicLevel: () => number
  /** Abandon a capture without submitting it (reset, unmount, no speech server). */
  stopMic: () => void
  /** Open one capture; false means the microphone could not be opened. */
  beginCapture: (endpoint: VoiceEndpoint) => Promise<boolean>
  /** Re-arm listening after an utterance while hands-free is still on. */
  restartHandsFree: () => Promise<void>
  /** Transcribe and submit the capture the VAD just ended. */
  finishVoiceCapture: () => Promise<void>
  /** Active microphone capture, stopped when a turn starts. */
  recorderRef: { current: VoiceRecorder | null }
  asrSourceRef: { current: RuntimeSource }
  lastVoiceSecondsRef: { current: number | undefined }
}

/**
 * Hands-free microphone capture: VAD, live ASR, hands-free re-arm and
 * barge-in. The turn itself is not run here — a finished capture submits
 * through `submitRef`, which the orchestrator keeps pointed at the composed
 * submitCommand.
 */
export function useWorkspaceVoice({
  modeRef,
  healthRef,
  busyRef,
  notify,
  stopSpeech,
  micOnRef,
  stopMicRef,
  submitRef,
}: VoiceArgs): WorkspaceVoiceApi {
  const [micOn, setMicOn] = useState(false)
  const [micActive, setMicActive] = useState(false)
  const [asrBusy, setAsrBusy] = useState(false)

  const recorderRef = useRef<VoiceRecorder | null>(null)
  const asrBusyRef = useRef(false)
  /** Latest finishVoiceCapture, for VoiceRecorder.autoStop callbacks created earlier. */
  const finishVoiceCaptureRef = useRef<() => Promise<void>>(async () => {})
  /** Endpoint the active mic capture started against (mode is read at start, not at stop). */
  const micEndpointRef = useRef<VoiceEndpoint | null>(null)
  const asrSourceRef = useRef<RuntimeSource>('fallback')
  const lastVoiceSecondsRef = useRef<number | undefined>(undefined)

  /** State + mirror in one step: capture callbacks read the ref, not a render. */
  const setMicToggle = useCallback(
    (on: boolean) => {
      micOnRef.current = on
      setMicOn(on)
    },
    [micOnRef],
  )

  const notifyVoiceNeedsOmni = useCallback(() => {
    notify('Voice is off in this mode', VOICE_NEEDS_OMNI_DETAIL, 'error')
  }, [notify])

  const notifySpeechOffline = useCallback(
    (endpoint: VoiceEndpoint) => {
      const { title, detail } = voiceOfflineNotice(endpoint, speechPortFor(endpoint))
      notify(title, detail, 'error')
    },
    [notify],
  )

  const stopMic = useCallback(() => {
    // The ONE path allowed to abandon a capture without submitting it
    // (reset, unmount, a mode that has no speech server): the toggle goes
    // off, the recorder is aborted, and no re-arm follows.
    setMicToggle(false)
    recorderRef.current?.abort()
    recorderRef.current = null
    micEndpointRef.current = null
    setMicActive(false)
  }, [setMicToggle])

  useEffect(() => {
    stopMicRef.current = stopMic
  }, [stopMic, stopMicRef])

  /**
   * Open one capture. Returns false when the microphone could not be opened
   * (a toast has been shown); the caller decides whether that ends the
   * hands-free toggle.
   */
  const beginCapture = useCallback(
    async (endpoint: VoiceEndpoint): Promise<boolean> => {
      const recorder = new VoiceRecorder({
        // The VAD ending an utterance is NOT the user ending hands-free:
        // finishVoiceCapture transcribes + submits, then re-arms if the
        // toggle is still on.
        onAutoStop: () => {
          void finishVoiceCaptureRef.current()
        },
        // Barge-in: voice onset cuts a spoken reply mid-sentence. Fires at
        // most once per capture (the recorder latches on voice onset).
        onVoiceStart: () => stopSpeech(),
      })
      try {
        await recorder.start()
      } catch {
        notify(
          'Microphone permission denied',
          'Allow microphone access in the browser, or type the command.',
          'error',
        )
        return false
      }
      recorderRef.current = recorder
      micEndpointRef.current = endpoint
      setMicActive(true)
      return true
    },
    [notify, stopSpeech],
  )

  /**
   * Re-arm listening after an utterance when hands-free is still on. The
   * guards are re-run against the CURRENT mode/health: a switch to low-RAM
   * (no speech server) or an endpoint that went away ends hands-free with
   * the honest toast instead of leaving the UI claiming to listen.
   */
  const restartHandsFree = useCallback(async () => {
    if (!micOnRef.current) return
    const endpoint = modeDef(modeRef.current).speech
    if (!endpoint) {
      setMicToggle(false)
      notifyVoiceNeedsOmni()
      return
    }
    if (!endpointUp(healthRef.current, endpoint)) {
      setMicToggle(false)
      notifySpeechOffline(endpoint)
      return
    }
    const started = await beginCapture(endpoint)
    if (!started) {
      // A failed re-arm ends hands-free: the toggle must never claim to be
      // listening with no recorder behind it.
      setMicToggle(false)
      return
    }
    if (!micOnRef.current) {
      // Tapped off while the microphone was opening.
      recorderRef.current?.abort()
      recorderRef.current = null
      micEndpointRef.current = null
      setMicActive(false)
    }
  }, [
    beginCapture,
    healthRef,
    micOnRef,
    modeRef,
    notifySpeechOffline,
    notifyVoiceNeedsOmni,
    setMicToggle,
  ])

  const finishVoiceCapture = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    recorderRef.current = null
    setMicActive(false)
    // The endpoint is the one the capture started against; a mode switch
    // mid-capture must not retarget a finished recording.
    const endpoint = micEndpointRef.current ?? modeDef(modeRef.current).speech
    micEndpointRef.current = null
    asrBusyRef.current = true
    setAsrBusy(true)
    const seconds = recorder.seconds
    try {
      const blob = await recorder.stop()
      if (!blob) {
        notify(
          'No speech captured',
          'The microphone did not pick up anything. Try again or type the command.',
          'error',
        )
      } else if (!endpoint) {
        // The mode this capture belonged to no longer offers a speech server
        // (a switch to low-RAM mid-capture): stop hands-free here; the re-arm
        // below then finds the toggle off and stays quiet.
        setMicToggle(false)
        notifyVoiceNeedsOmni()
      } else {
        // Live ASR over the mode's Omni-architecture endpoint (:8083 omni,
        // :8085 in 1.7B + d1 — same architecture).
        const transcript = await transcribeAudio(blob, endpoint)
        asrSourceRef.current = 'live'
        lastVoiceSecondsRef.current = Number(seconds.toFixed(1))
        // Awaiting the turn is the hands-free sequencing guarantee:
        // runPipelineTurn resolves only after its finally cleared busyRef, so
        // the re-arm below can never listen underneath a running turn.
        await submitRef.current(transcript.text, 'voice')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ASR request failed.'
      const label = endpoint === 'd1omni' ? 'd1-Omni' : endpoint === 'audio' ? 'Audio' : 'Omni'
      notify(`${label} ASR unavailable`, `${message} Type the command instead.`, 'error')
    } finally {
      asrBusyRef.current = false
      setAsrBusy(false)
      // Utterance over — the VAD stopped this capture, not the user. If the
      // toggle is still on, listen for the next one.
      await restartHandsFree()
    }
  }, [
    modeRef,
    notify,
    notifyVoiceNeedsOmni,
    restartHandsFree,
    setMicToggle,
    submitRef,
  ])

  useEffect(() => {
    finishVoiceCaptureRef.current = finishVoiceCapture
  }, [finishVoiceCapture])

  const toggleMic = useCallback(() => {
    // Barge-in: speaking while you talk would fight the microphone.
    stopSpeech()
    if (micOnRef.current) {
      // OFF: never discard spoken words. A capture in progress is finished
      // (transcribed + submitted) and not restarted; an in-flight ASR/submit
      // is allowed to complete and submit. Clearing the toggle is what ends
      // the loop — finishVoiceCapture's re-arm reads it.
      setMicToggle(false)
      if (recorderRef.current) void finishVoiceCapture()
      return
    }
    if (busyRef.current) {
      notify('Still working', 'Wait for the current turn to finish before speaking.', 'neutral')
      return
    }
    const endpoint = modeDef(modeRef.current).speech
    if (!endpoint) {
      // Low-RAM: no Omni-architecture server exists, so ASR is honestly off.
      notifyVoiceNeedsOmni()
      return
    }
    if (!endpointUp(healthRef.current, endpoint)) {
      notifySpeechOffline(endpoint)
      return
    }
    // ON: the toggle is set before the permission prompt so a second tap
    // cancels instead of opening a second stream; a failed start rolls it
    // back below.
    setMicToggle(true)
    if (asrBusyRef.current) {
      // The previous utterance is still transcribing; arming now is honest —
      // finishVoiceCapture's re-arm picks the toggle up when it resolves.
      return
    }
    void (async () => {
      const started = await beginCapture(endpoint)
      if (!started) {
        setMicToggle(false)
        return
      }
      if (!micOnRef.current) {
        // Tapped off while the permission prompt was open: no capture runs
        // for a toggle that is already off.
        recorderRef.current?.abort()
        recorderRef.current = null
        micEndpointRef.current = null
        setMicActive(false)
      }
    })()
  }, [
    beginCapture,
    busyRef,
    finishVoiceCapture,
    healthRef,
    micOnRef,
    modeRef,
    notify,
    notifySpeechOffline,
    notifyVoiceNeedsOmni,
    setMicToggle,
    stopSpeech,
  ])

  const getMicLevel = useCallback(() => recorderRef.current?.getLevel() ?? 0, [])

  useEffect(() => {
    return () => {
      // Unmount is a stop path: never let an in-flight ASR/turn re-arm the
      // microphone after the session is gone.
      micOnRef.current = false
      recorderRef.current?.abort()
      recorderRef.current = null
    }
  }, [micOnRef])

  return {
    micOn,
    micActive,
    toggleMic,
    asrBusy,
    getMicLevel,
    stopMic,
    beginCapture,
    restartHandsFree,
    finishVoiceCapture,
    recorderRef,
    asrSourceRef,
    lastVoiceSecondsRef,
  }
}
