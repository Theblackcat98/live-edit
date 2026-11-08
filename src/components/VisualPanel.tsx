import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  CameraOff,
  LoaderCircle,
  Monitor,
  MonitorUp,
  ScanLine,
  Square,
  Video,
} from 'lucide-react'
import type { BBoxTarget, PipelineStage, SourceId } from '../types'
import { SCENE_META } from '../data/scene'
import { cx, formatElapsed } from '../lib/utils'
import { registerLiveFrame } from '../lib/frame'
import { Waveform, type WaveMode } from './Waveform'
import { SceneSlide } from './SceneSlide'
import { SceneCropCard } from './SceneCrop'

/** Longest edge of an uploaded live frame; keeps JPEG snapshots small. */
const MAX_FRAME_WIDTH = 1280
/** Snapshot cadence while capture is live. */
const FRAME_INTERVAL_MS = 1000

interface VisualPanelProps {
  bbox: BBoxTarget | null
  stage: PipelineStage
  micOn: boolean
  speaking: boolean
  getMicLevel: () => number
  elapsedSeconds: number
}

interface RoiRect {
  left: number
  top: number
  width: number
  height: number
}

export function VisualPanel({
  bbox,
  stage,
  micOn,
  speaking,
  getMicLevel,
  elapsedSeconds,
}: VisualPanelProps) {
  const [source, setSource] = useState<SourceId>('camera')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [streamKind, setStreamKind] = useState<SourceId | null>(null)
  const [captureBusy, setCaptureBusy] = useState<'camera' | 'screen' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [hasLiveFrame, setHasLiveFrame] = useState(false)
  const hasLiveFrameRef = useRef(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [roi, setRoi] = useState<RoiRect | null>(null)

  const isLive = Boolean(stream && streamKind === source)
  const stageActive =
    stage === 'routing' ||
    stage === 'grounding' ||
    stage === 'generating' ||
    stage === 'verifying' ||
    stage === 'executing'
  const waveMode: WaveMode = micOn
    ? 'listening'
    : speaking
      ? 'speaking'
      : stageActive
        ? 'processing'
        : 'idle'

  const stopStream = () => {
    const active = streamRef.current
    if (active) {
      active.getTracks().forEach((track) => track.stop())
    }
    streamRef.current = null
    registerLiveFrame(null)
    hasLiveFrameRef.current = false
    setHasLiveFrame(false)
    setStream(null)
    setStreamKind(null)
    setNotice(null)
  }

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      registerLiveFrame(null)
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (stream) {
      video.srcObject = stream
      void video.play().catch(() => {
        setNotice('The browser blocked autoplay for the live feed.')
      })
    } else {
      video.srcObject = null
    }
  }, [stream])

  // Push real snapshots into the model frame registry while capture is active.
  // Throttled to ~1 fps; the synthetic slide is only used when nothing is here.
  useEffect(() => {
    if (!stream || !streamKind) {
      hasLiveFrameRef.current = false
      setHasLiveFrame(false)
      return
    }
    let cancelled = false
    const publish = () => {
      if (cancelled) return
      const video = videoRef.current
      if (!video || !video.videoWidth || !video.videoHeight) return
      const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth)
      const canvas = frameCanvasRef.current ?? document.createElement('canvas')
      frameCanvasRef.current = canvas
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) return
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      registerLiveFrame(canvas.toDataURL('image/jpeg', 0.8), streamKind)
      if (!hasLiveFrameRef.current) {
        hasLiveFrameRef.current = true
        setHasLiveFrame(true)
      }
    }
    publish()
    const timer = window.setInterval(publish, FRAME_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [stream, streamKind])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!bbox || isLive) {
      setRoi(null)
      return
    }
    const measure = () => {
      const stageElement = stageRef.current
      if (!stageElement) return
      const target = stageElement.querySelector(
        `[data-scene-region="${bbox.region}"]`,
      ) as HTMLElement | null
      if (!target) {
        setRoi(null)
        return
      }
      const stageRect = stageElement.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const padding = bbox.region === 'full' ? 2 : 5
      setRoi({
        left: targetRect.left - stageRect.left - padding,
        top: targetRect.top - stageRect.top - padding,
        width: targetRect.width + padding * 2,
        height: targetRect.height + padding * 2,
      })
    }
    measure()
    const timer = window.setTimeout(measure, 360)
    const observer = new ResizeObserver(measure)
    if (stageRef.current) observer.observe(stageRef.current)
    window.addEventListener('resize', measure)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [bbox, isLive, source, streamKind])

  const changeSource = (next: SourceId) => {
    if (next === source) return
    if (streamRef.current) stopStream()
    setSource(next)
    setNotice(null)
  }

  const capture = async (kind: SourceId) => {
    if (isLive && streamKind === kind) {
      stopStream()
      return
    }
    setNotice(null)
    setCaptureBusy(kind)
    stopStream()
    try {
      if (!navigator.mediaDevices) throw new Error('Media devices are unavailable in this browser.')
      const media =
        kind === 'camera'
          ? await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
              audio: false,
            })
          : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      streamRef.current = media
      setStream(media)
      setStreamKind(kind)
      setSource(kind)
      setNotice(
        kind === 'camera'
          ? 'Camera live. Snapshots now feed routing and vision; stop to fall back to the synthetic slide.'
          : 'Screen live. Snapshots now feed routing and vision; stop to fall back to the synthetic slide.',
      )
      const track = media.getVideoTracks()[0]
      if (track) {
        track.addEventListener('ended', () => {
          stopStream()
          setNotice('The live source ended · synthetic slide fallback restored.')
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Capture was cancelled.'
      setNotice(
        kind === 'camera'
          ? `Device camera unavailable (${message}). The synthetic slide is the frame fallback.`
          : `Screen share cancelled (${message}). The synthetic slide is the frame fallback.`,
      )
    } finally {
      setCaptureBusy(null)
    }
  }

  const label = isLive
    ? streamKind === 'screen'
      ? 'SCREEN 01'
      : 'CAM 01'
    : source === 'screen'
      ? 'SCREEN 01 · SYNTHETIC'
      : 'CAM 01 · SYNTHETIC'

  return (
    <section className="card visual-card">
      <header className="card-header visual-header">
        <div className="card-title">
          <Video size={14} />
          Visual context
        </div>
        <div className="source-tabs" role="tablist" aria-label="Visual source">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'camera'}
            className={cx('source-tab', source === 'camera' && 'is-active')}
            onClick={() => changeSource('camera')}
          >
            <Camera size={12} />
            Camera
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'screen'}
            className={cx('source-tab', source === 'screen' && 'is-active')}
            onClick={() => changeSource('screen')}
          >
            <Monitor size={12} />
            Screen
          </button>
        </div>
        <div className="card-header-spacer" />
        <span className="chip chip-ghost">1 fps</span>
      </header>

      <div
        ref={stageRef}
        className={cx('camera-stage', isLive && 'is-live', stageActive && 'is-active')}
      >
        <div className="stage-atmosphere" aria-hidden="true" />
        {isLive ? (
          <video ref={videoRef} className="stage-video" muted playsInline autoPlay />
        ) : (
          <div className={cx('stage-paper-wrap', source === 'screen' ? 'is-flat' : 'is-camera')}>
            <SceneSlide />
          </div>
        )}

        <div className="stage-hud stage-hud-top">
          <div className="stage-source">
            <span className={cx('stage-rec', isLive && 'is-live')}>
              <span className="stage-rec-dot" />
              {isLive ? 'LIVE' : 'SYNTH'}
            </span>
            <span className="stage-source-label mono">{label}</span>
          </div>
          <div className="stage-controls">
            <span className="stage-res mono">{SCENE_META.resolution}</span>
            <button
              type="button"
              className={cx('stage-icon-button', isLive && streamKind === 'camera' && 'is-on')}
              onClick={() => void capture('camera')}
              title={isLive && streamKind === 'camera' ? 'Stop camera' : 'Use device camera'}
              aria-label={isLive && streamKind === 'camera' ? 'Stop camera' : 'Use device camera'}
            >
              {captureBusy === 'camera' ? (
                <LoaderCircle size={13} className="spin" />
              ) : isLive && streamKind === 'camera' ? (
                <CameraOff size={13} />
              ) : (
                <Camera size={13} />
              )}
            </button>
            <button
              type="button"
              className={cx('stage-icon-button', isLive && streamKind === 'screen' && 'is-on')}
              onClick={() => void capture('screen')}
              title={isLive && streamKind === 'screen' ? 'Stop screen share' : 'Share screen'}
              aria-label={isLive && streamKind === 'screen' ? 'Stop screen share' : 'Share screen'}
            >
              {captureBusy === 'screen' ? (
                <LoaderCircle size={13} className="spin" />
              ) : isLive && streamKind === 'screen' ? (
                <Square size={11} />
              ) : (
                <MonitorUp size={13} />
              )}
            </button>
          </div>
        </div>

        {roi && bbox && (
          <div
            key={`${bbox.region}-${bbox.confidence.toFixed(2)}`}
            className={cx('stage-roi', roi.top < 38 && 'label-below')}
            style={{
              left: `${roi.left}px`,
              top: `${roi.top}px`,
              width: `${roi.width}px`,
              height: `${roi.height}px`,
            }}
          >
            <span className="roi-corner corner-tl" />
            <span className="roi-corner corner-tr" />
            <span className="roi-corner corner-bl" />
            <span className="roi-corner corner-br" />
            <span className="stage-roi-label">
              <ScanLine size={10} />
              d1 · {bbox.label}
              <span className="mono">{Math.round(bbox.confidence * 100)}%</span>
            </span>
          </div>
        )}

        {bbox && !isLive && (
          <SceneCropCard
            label={bbox.label}
            region={bbox.region}
            confidence={bbox.confidence}
          />
        )}

        <div className="stage-corners" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className={cx('stage-scanline', stageActive && 'is-active')} aria-hidden="true" />

        {notice && <div className="stage-notice">{notice}</div>}
      </div>

      <div className="stage-waveband">
        <div className="stage-wave-meta">
          <span className="stage-wave-label mono">AUDIO</span>
          <span className="stage-wave-rate mono">16 kHz</span>
        </div>
        <Waveform mode={waveMode} getMicLevel={getMicLevel} bars={72} />
        <div className="stage-wave-status">
          <span
            className={cx(
              'status-dot',
              micOn && 'is-green is-pulsing',
              speaking && 'is-accent is-pulsing',
              !micOn && !speaking && stageActive && 'is-accent is-pulsing',
            )}
          />
          <span className="stage-wave-mode">
            {micOn ? 'Listening' : speaking ? 'Omni speaking' : stageActive ? 'Working' : 'Ambient'}
          </span>
          <span className="stage-wave-time mono">{formatElapsed(elapsedSeconds)}</span>
        </div>
      </div>

      <div className="perception-strip">
        <div className="perception-scene">
          <ScanLine size={12} />
          <span>
            {isLive
              ? hasLiveFrame
                ? 'Live frames indexed'
                : 'Waiting for live frames'
              : 'Synthetic slide indexed'}
          </span>
          <span className="perception-meta mono">
            {isLive ? 'LIVE → VISION' : 'SYNTHETIC FALLBACK'}
          </span>
        </div>
        <div className="perception-status">
          {bbox && !isLive ? (
            <span className="chip chip-accent">
              <ScanLine size={9} />
              d1 ROI {Math.round(bbox.confidence * 100)}%
            </span>
          ) : (
            <span
              className={cx(
                'chip',
                isLive && hasLiveFrame ? 'chip-green' : 'chip-ghost',
              )}
            >
              {isLive ? (hasLiveFrame ? 'Live vision' : 'No frame yet') : 'Synthetic fallback'}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
