import { useEffect, useRef } from 'react'
import { cx } from '../lib/utils'

export type WaveMode = 'idle' | 'listening' | 'processing' | 'speaking'

interface WaveformProps {
  mode: WaveMode
  getMicLevel?: () => number
  className?: string
  bars?: number
}

export function Waveform({ mode, getMicLevel, className, bars = 96 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const styles = getComputedStyle(canvas)
    const accent = styles.getPropertyValue('--wave-accent').trim() || '#3d9aff'
    const muted = styles.getPropertyValue('--wave-muted').trim() || '#a5a8ad'
    const history: number[] = Array.from({ length: bars }, (_, index) => {
      return 0.04 + Math.abs(Math.sin(index * 0.37)) * 0.05
    })
    let width = 0
    let height = 0
    let animation = 0
    let frame = 0
    let previous = 0.12

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = () => {
      context.clearRect(0, 0, width, height)
      const centerY = height / 2
      const gap = 2
      const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars)
      const step = (width + gap) / bars
      const active = modeRef.current !== 'idle'

      context.fillStyle = muted
      context.globalAlpha = 0.24
      context.fillRect(0, centerY - 0.5, width, 1)

      context.globalAlpha = 1
      for (let index = 0; index < history.length; index += 1) {
        const amplitude = history[index]
        const barHeight = Math.max(1.5, amplitude * (height - 8))
        const x = index * step
        const y = centerY - barHeight / 2
        const distanceFromCenter = Math.abs(index - history.length / 2) / (history.length / 2)
        context.globalAlpha = active
          ? 0.36 + (1 - distanceFromCenter) * 0.64
          : 0.2 + (1 - distanceFromCenter) * 0.26
        context.fillStyle = index > history.length * 0.54 ? accent : muted
        context.beginPath()
        context.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, barHeight / 2))
        context.fill()
      }
      context.globalAlpha = 1
    }

    const sample = () => {
      const currentMode = modeRef.current
      let target = 0.04
      if (currentMode === 'listening') {
        const mic = Math.max(0, Math.min(1, getMicLevel?.() ?? 0))
        target = mic > 0.025 ? 0.16 + mic * 0.78 : 0.08 + Math.random() * 0.03
      } else if (currentMode === 'speaking') {
        const t = performance.now() / 210
        target =
          0.3 +
          Math.abs(Math.sin(t) * 0.36) +
          Math.abs(Math.sin(t * 0.43 + 1.7) * 0.16) +
          Math.random() * 0.04
      } else if (currentMode === 'processing') {
        const t = performance.now() / 480
        target = 0.16 + Math.abs(Math.sin(t) * 0.14) + Math.random() * 0.025
      } else {
        target = 0.05 + Math.random() * 0.045
        if (Math.random() > 0.9) target += 0.09
      }
      previous = previous * 0.62 + target * 0.38
      if (currentMode === 'idle' && Math.random() > 0.93) {
        history.push(previous * 2.2)
      } else {
        history.push(previous)
      }
      history.shift()
    }

    const loop = () => {
      frame += 1
      if (frame % 2 === 0) sample()
      draw()
      animation = window.requestAnimationFrame(loop)
    }

    const observer = new ResizeObserver(() => {
      resize()
      draw()
    })
    observer.observe(canvas)
    resize()

    if (reducedMotion) {
      draw()
    } else {
      animation = window.requestAnimationFrame(loop)
    }

    return () => {
      observer.disconnect()
      if (animation) window.cancelAnimationFrame(animation)
    }
  }, [bars, getMicLevel])

  return (
    <canvas
      ref={canvasRef}
      className={cx('waveform', `waveform-${mode}`, className)}
      aria-hidden="true"
    />
  )
}
