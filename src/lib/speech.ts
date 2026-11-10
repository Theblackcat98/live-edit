/**
 * Voice capture + spoken replies.
 *
 * Capture records 16 kHz mono WAV locally and hands the blob to the Omni
 * model (LFM3-Omni-2B on :8083) over /v1/audio/transcriptions — the model
 * does the recognition, not the browser. See useWorkspace for the call.
 */

const SAMPLE_RATE = 16_000
const MAX_RECORD_MS = 20_000
/** Trailing silence after the last voiced block that ends the capture. */
const SILENCE_STOP_MS = 1_200
/**
 * Absolute gate on the processed RMS (~−48 dBFS). Chrome's AGC+noise
 * suppression puts the room floor at 0.0005–0.004 here, while quiet
 * far-field speech measured 0.014 (HDMI speakers) to 0.038 (USB speakers);
 * a single absolute threshold above both floors would never latch.
 */
const VOICE_RMS_MIN = 0.004
/** Speech must also clear the rolling noise floor by this factor. */
const VOICE_FLOOR_RATIO = 2.2
/**
 * Consecutive 3-block means (~256 ms each) above the gate before voice
 * latches. Two means reject keyboard/fan transients.
 */
const VOICE_ONSET_BLOCKS = 2
/** Chrome's AGC/NS startup transient is loud for the first ~0.5 s; do not
 * treat it as speech (audio is still recorded, only detection waits). */
const VAD_WARMUP_MS = 500
/** Noise-floor tracking per block: fall immediately, creep up slowly. */
const FLOOR_FALL = 0.5
const FLOOR_RISE = 0.02
/** Blocks averaged before a gate decision (85 ms each at 48 kHz). */
const LEVEL_WINDOW = 3
/** Peak-safe gain lift applied to the capture before ASR. */
const ASR_TARGET_RMS = 0.1
const ASR_MAX_GAIN = 31.6

export interface VoiceRecorderOptions {
  /** Fired when the recorder auto-stops after trailing silence. */
  onAutoStop?: () => void
  /**
   * Fired exactly once per capture, when voice onset latches (`sawVoice`
   * flips true). Hands-free listening uses it for barge-in: talking over a
   * spoken reply cuts the playback; the VAD's own stop still decides when
   * this utterance is over.
   */
  onVoiceStart?: () => void
  onError?: (message: string) => void
}

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private chunks: Float32Array[] = []
  private samples = 0
  private level = 0
  private lastVoiceAt = 0
  private sawVoice = false
  private recordingStartedAt = 0
  private stopping = false
  /** Rolling noise-floor estimate of the processed RMS. */
  private noiseFloor = 0
  /** Last few block RMS values; smoothed before gate decisions. */
  private recentRms: number[] = []
  /** Consecutive smoothed levels above the gate. */
  private aboveGateRun = 0
  private readonly options: VoiceRecorderOptions

  constructor(options: VoiceRecorderOptions = {}) {
    this.options = options
  }

  async start(): Promise<void> {
    if (this.stream) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    this.stream = stream
    this.chunks = []
    this.samples = 0
    this.level = 0
    this.sawVoice = false
    this.stopping = false
    this.noiseFloor = VOICE_RMS_MIN
    this.recentRms = []
    this.aboveGateRun = 0
    this.recordingStartedAt = performance.now()
    this.lastVoiceAt = this.recordingStartedAt

    // If any of the graph setup below throws, the stream obtained above must
    // not outlive the failed start: a hands-free re-arm discards this
    // recorder before it ever reaches recorderRef, so nothing else could
    // stop the track.
    try {
      const AudioContextClass = window.AudioContext
      this.context = new AudioContextClass()
      if (this.context.state === 'suspended') await this.context.resume()
      this.source = this.context.createMediaStreamSource(stream)
      this.processor = this.context.createScriptProcessor(4096, 1, 1)
      this.processor.onaudioprocess = (event) => this.ingest(event.inputBuffer.getChannelData(0))
      this.source.connect(this.processor)
      // ScriptProcessor only runs when connected to the graph.
      this.processor.connect(this.context.destination)
    } catch (error) {
      this.teardown()
      throw error
    }
  }

  private ingest(input: Float32Array): void {
    if (!this.stream || this.stopping) return
    const ratio = Math.max(1, Math.round(this.context?.sampleRate ?? 48_000) / SAMPLE_RATE)
    const outLength = Math.floor(input.length / ratio)
    const down = new Float32Array(outLength)
    let sum = 0
    for (let index = 0; index < input.length; index += 1) {
      const centered = input[index]
      sum += centered * centered
    }
    const rms = Math.sqrt(sum / input.length)
    this.level = Math.min(1, rms * 5.5)
    for (let index = 0; index < outLength; index += 1) {
      down[index] = input[Math.floor(index * ratio)]
    }
    this.chunks.push(down)
    this.samples += outLength

    const now = performance.now()
    const elapsed = now - this.recordingStartedAt

    // Track the room/AGC floor: fall to any quieter block immediately, creep
    // up only while no voice is active so speech cannot lift the gate.
    this.noiseFloor =
      rms < this.noiseFloor
        ? this.noiseFloor + (rms - this.noiseFloor) * FLOOR_FALL
        : this.sawVoice
          ? this.noiseFloor
          : this.noiseFloor + (rms - this.noiseFloor) * FLOOR_RISE

    this.recentRms.push(rms)
    if (this.recentRms.length > LEVEL_WINDOW) this.recentRms.shift()
    const smoothed =
      this.recentRms.reduce((sum, value) => sum + value, 0) / this.recentRms.length
    const gate = Math.max(VOICE_RMS_MIN, this.noiseFloor * VOICE_FLOOR_RATIO)
    if (elapsed >= VAD_WARMUP_MS && smoothed >= gate) {
      this.aboveGateRun += 1
      if (!this.sawVoice && this.aboveGateRun >= VOICE_ONSET_BLOCKS) {
        this.sawVoice = true
        this.options.onVoiceStart?.()
      }
      if (this.sawVoice) this.lastVoiceAt = now
    } else {
      this.aboveGateRun = 0
    }

    if (this.sawVoice && now - this.lastVoiceAt >= SILENCE_STOP_MS) {
      this.stopping = true
      this.options.onAutoStop?.()
    } else if (elapsed >= MAX_RECORD_MS) {
      this.stopping = true
      this.options.onAutoStop?.()
    }
  }

  getLevel(): number {
    return this.level
  }

  get seconds(): number {
    return this.samples / SAMPLE_RATE
  }

  /** Finish capture and return the WAV blob. Returns null when nothing usable was captured. */
  async stop(): Promise<Blob | null> {
    const audioContext = this.context
    const chunks = this.chunks
    this.teardown()
    if (!audioContext || !chunks.length) return null
    const seconds = this.samples / SAMPLE_RATE
    if (seconds < 0.4) return null
    return encodeWav(chunks, this.samples, captureGain(chunks, this.samples))
  }

  abort(): void {
    this.teardown()
  }

  private teardown(): void {
    this.stopping = true
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
      this.processor = null
    }
    this.source?.disconnect()
    this.source = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    if (this.context) {
      void this.context.close()
      this.context = null
    }
  }
}

/**
 * Lift quiet captures toward a level ASR models are calibrated for. A real
 * USB mic fed through Chrome's AGC can deliver a −40 dBFS phrase; the Omni
 * transcription of the same audio degrades sharply that low. Gain is capped
 * so the loudest sample stays below full scale and never attenuates.
 */
function captureGain(chunks: Float32Array[], totalSamples: number): number {
  if (!totalSamples) return 1
  let sum = 0
  let peak = 0
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = chunk[index]
      sum += sample * sample
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
    }
  }
  const rms = Math.sqrt(sum / totalSamples)
  if (!rms || !peak) return 1
  const gain = Math.min(ASR_MAX_GAIN, ASR_TARGET_RMS / rms, 0.95 / peak)
  return gain > 1 ? gain : 1
}

function encodeWav(chunks: Float32Array[], totalSamples: number, gain = 1): Blob {
  const pcm = new Int16Array(totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index] * gain))
      pcm[offset + index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    }
    offset += chunk.length
  }
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const writeText = (position: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(position + index, text.charCodeAt(index))
    }
  }
  const dataBytes = pcm.length * 2
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeText(36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Blob([header, pcm.buffer], { type: 'audio/wav' })
}

// --- spoken replies (browser TTS; presentation only, not inference) ----------

let preferredVoice: SpeechSynthesisVoice | null = null

function resolveVoice(): SpeechSynthesisVoice | null {
  if (preferredVoice) return preferredVoice
  const voices = window.speechSynthesis?.getVoices?.() ?? []
  if (!voices.length) return null
  preferredVoice =
    voices.find((voice) => /samantha/i.test(voice.name) && /en/i.test(voice.lang)) ??
    voices.find((voice) => /google us english/i.test(voice.name)) ??
    voices.find((voice) => /en-US/i.test(voice.lang)) ??
    voices[0]
  return preferredVoice
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    preferredVoice = null
    resolveVoice()
  }
}

export function speechSynthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Strip markup so both TTS paths (model + browser) speak clean prose. */
export function cleanSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function speak(text: string, handlers?: { onStart?: () => void; onEnd?: () => void }): void {
  if (!speechSynthesisAvailable()) return
  const clean = cleanSpeechText(text)
  if (!clean) return
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(clean)
  const voice = resolveVoice()
  if (voice) utterance.voice = voice
  utterance.rate = 1.02
  utterance.pitch = 1
  utterance.volume = 0.92
  utterance.onstart = () => handlers?.onStart?.()
  utterance.onend = () => handlers?.onEnd?.()
  utterance.onerror = () => handlers?.onEnd?.()
  window.speechSynthesis.speak(utterance)
}

export function stopSpeaking(): void {
  if (speechSynthesisAvailable()) window.speechSynthesis.cancel()
}
