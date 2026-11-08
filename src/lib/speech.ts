/**
 * Voice capture + spoken replies.
 *
 * Capture records 16 kHz mono WAV locally and hands the blob to the Omni
 * model (LFM3-Omni-2B on :8083) over /v1/audio/transcriptions — the model
 * does the recognition, not the browser. See useWorkspace for the call.
 */

const SAMPLE_RATE = 16_000
const MAX_RECORD_MS = 20_000
const SILENCE_STOP_MS = 1_500
/** RMS above this counts as speech (microphone gain applied). */
const SPEECH_RMS = 0.045

export interface VoiceRecorderOptions {
  /** Fired when the recorder auto-stops after trailing silence. */
  onAutoStop?: () => void
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
    this.recordingStartedAt = performance.now()
    this.lastVoiceAt = this.recordingStartedAt

    const AudioContextClass = window.AudioContext
    this.context = new AudioContextClass()
    if (this.context.state === 'suspended') await this.context.resume()
    this.source = this.context.createMediaStreamSource(stream)
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (event) => this.ingest(event.inputBuffer.getChannelData(0))
    this.source.connect(this.processor)
    // ScriptProcessor only runs when connected to the graph.
    this.processor.connect(this.context.destination)
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
    if (rms >= SPEECH_RMS) {
      this.sawVoice = true
      this.lastVoiceAt = now
    } else if (
      this.sawVoice &&
      now - this.lastVoiceAt >= SILENCE_STOP_MS
    ) {
      this.stopping = true
      this.options.onAutoStop?.()
    } else if (now - this.recordingStartedAt >= MAX_RECORD_MS) {
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
    return encodeWav(chunks, this.samples)
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

function encodeWav(chunks: Float32Array[], totalSamples: number): Blob {
  const pcm = new Int16Array(totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]))
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

export function speak(text: string, handlers?: { onStart?: () => void; onEnd?: () => void }): void {
  if (!speechSynthesisAvailable()) return
  const clean = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_#>`]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
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
