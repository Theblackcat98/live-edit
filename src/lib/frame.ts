/**
 * Synthetic review frame as model-visible pixels.
 *
 * The on-screen slide (SceneSlide) is DOM. The bridge needs real image bytes
 * for the Omni chat turn and the d1-Omni-2B route probe, so this module renders
 * the same content as SVG and rasterizes it through a canvas.
 *
 * The visual panel registers real camera/screen snapshots here while capture
 * is active; `resolveSceneFrame` prefers them and reports exactly which pixels
 * (live camera, live screen, or the synthetic slide) the models received.
 * The synthetic slide is only ever the fallback.
 */

import type { FrameSource, LiveFrame, ResolvedFrame, SceneRegionId, SourceId } from '../types'

const WIDTH = 1280
const HEIGHT = 720

// --- live frame registry (written by VisualPanel, read by the orchestrator) ---

let liveFrame: LiveFrame | null = null

/** Register a live JPEG snapshot, or pass null when capture stops. */
export function registerLiveFrame(dataUrl: string | null, source: SourceId = 'camera'): void {
  liveFrame = dataUrl ? { dataUrl, source, at: Date.now() } : null
}

export function getLiveFrame(): LiveFrame | null {
  return liveFrame
}

interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

/** Region rects in slide coordinates (also used as SVG viewBox crops). */
const REGIONS: Record<SceneRegionId, RegionRect> = {
  full: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  header: { x: 40, y: 24, width: 640, height: 104 },
  table: { x: 60, y: 190, width: 520, height: 250 },
  'q3-row': { x: 60, y: 356, width: 520, height: 42 },
  formula: { x: 680, y: 170, width: 540, height: 190 },
  chart: { x: 680, y: 400, width: 540, height: 250 },
  sticky: { x: 60, y: 470, width: 300, height: 170 },
}

const BARS: Array<{ label: string; value: string; height: number; tone: string }> = [
  { label: 'Q1', value: '$0.92M', height: 96, tone: '#3f8f6f' },
  { label: 'Q2', value: '$1.08M', height: 118, tone: '#3f8f6f' },
  { label: 'Q3', value: '$1.20M', height: 138, tone: '#e0a63c' },
  { label: 'Q4', value: '$1.35M', height: 164, tone: '#5a6f8f' },
]

function slideSvg(): string {
  const row = (quarter: string, revenue: string, status: string, strong: boolean) => `
    <tr>
      <td>${quarter}</td><td>${revenue}</td>
      <td class="${status.toLowerCase()}">${status}</td>
      ${strong ? '<td class="mark">▲</td>' : '<td></td>'}
    </tr>`
  const bars = BARS.map((bar, index) => {
    const x = 760 + index * 118
    const baseY = 610
    return `
      <rect x="${x}" y="${baseY - bar.height}" width="64" height="${bar.height}" rx="4" fill="${bar.tone}"/>
      <text x="${x + 32}" y="${baseY - bar.height - 10}" text-anchor="middle" class="bar-value">${bar.value}</text>
      <text x="${x + 32}" y="${baseY + 22}" text-anchor="middle" class="bar-label">${bar.label}</text>`
  }).join('')
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <style>
    text { font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; fill: #1c2430; }
    .kicker { font-size: 15px; letter-spacing: 3px; fill: #5a6f8f; font-weight: 600; }
    .title { font-size: 34px; font-weight: 700; }
    .subtitle { font-size: 16px; fill: #6b7686; }
    .label { font-size: 14px; letter-spacing: 2px; fill: #6b7686; font-weight: 600; }
    .card { fill: #ffffff; stroke: #d7dde6; rx: 12; }
    th { font-size: 15px; fill: #5a6f8f; text-align: left; font-weight: 600; }
    td { font-size: 17px; }
    td.pending { fill: #b0761e; font-weight: 700; }
    td.closed { fill: #2f7a56; }
    td.forecast { fill: #5a6f8f; }
    .mark { fill: #2f7a56; font-weight: 700; }
    .bar-value { font-size: 14px; font-weight: 600; }
    .bar-label { font-size: 15px; fill: #6b7686; }
    .formula { font-size: 30px; font-weight: 700; font-style: italic; }
    .formula-target { font-size: 15px; fill: #2f7a56; font-weight: 600; }
    .sticky-text { font-size: 16px; fill: #4a4020; font-style: italic; }
    .footer { font-size: 13px; fill: #9aa4b2; letter-spacing: 1px; }
  </style>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2f4f0"/>
  <rect x="24" y="16" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="14" fill="#fbfbf9" stroke="#e2e5df"/>

  <rect x="52" y="44" width="34" height="6" rx="2" fill="#3f8f6f"/>
  <text x="96" y="52" class="kicker">Q3 OPERATING REVIEW</text>
  <text x="1060" y="52" class="footer">CONFIDENTIAL</text>
  <text x="52" y="94" class="title">Revenue &amp; operating efficiency</text>
  <text x="52" y="122" class="subtitle">Operating review · 14 November · Finance</text>

  <text x="60" y="180" class="label">REVENUE BY QUARTER</text>
  <g transform="translate(60,190)">
    <rect width="520" height="250" rx="10" class="card"/>
    <text x="22" y="36" class="th">QUARTER</text>
    <text x="200" y="36" class="th">REVENUE</text>
    <text x="330" y="36" class="th">STATUS</text>
    <line x1="12" x2="508" y1="48" y2="48" stroke="#e6e9ee"/>
    <foreignObject x="12" y="52" width="496" height="186">
      <table xmlns="http://www.w3.org/1999/xhtml" style="width:100%;border-collapse:collapse;font-family:'Inter','Segoe UI',sans-serif;">
        ${row('Q1', '$0.92M', 'Closed', false)}
        ${row('Q2', '$1.08M', 'Closed', false)}
        ${row('Q3', '$1.20M', 'Pending', true)}
        ${row('Q4', '$1.35M', 'Forecast', false)}
      </table>
    </foreignObject>
  </g>

  <g transform="translate(60,470) rotate(-2)">
    <rect width="300" height="150" rx="6" fill="#f5df8e" stroke="#e3c96a"/>
    <rect x="120" y="-10" width="60" height="20" rx="3" fill="#e8e2cf"/>
    <text x="24" y="38" class="label">FINANCE NOTE</text>
    <text x="24" y="76" class="sticky-text">Final invoice recon</text>
    <text x="24" y="102" class="sticky-text">still pending.</text>
  </g>

  <g transform="translate(680,170)">
    <rect width="540" height="190" rx="12" class="card"/>
    <text x="28" y="40" class="label">NORTH STAR</text>
    <text x="28" y="112" class="formula">LTV / CAC = 3.4×</text>
    <text x="28" y="156" class="formula-target">target ≥ 3.0×</text>
  </g>

  <text x="680" y="404" class="label">TRAJECTORY</text>
  ${bars}

  <line x1="52" y1="662" x2="${WIDTH - 52}" y2="662" stroke="#e6e9ee"/>
  <text x="52" y="686" class="footer">LFM · OPERATING REVIEW</text>
  <text x="${WIDTH - 160}" y="686" class="footer">Q3 · 2026</text>
</svg>`
}

const frameCache = new Map<SceneRegionId, string>()

function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  const decoded = Promise.withResolvers<void>()
  image.onload = () => decoded.resolve()
  image.onerror = () => decoded.reject(new Error('Frame failed to decode'))
  image.src = dataUrl
  return decoded.promise.then(() => image)
}

/**
 * Crop a live snapshot by the same fractional window the synthetic slide uses
 * for the region. Live frames have their own resolution, so the region rect is
 * scaled by the frame's aspect, not by slide pixels.
 */
async function cropLiveFrame(frame: LiveFrame, region: SceneRegionId): Promise<string> {
  const rect = REGIONS[region]
  const image = await decodeImage(frame.dataUrl)
  const sourceX = Math.round((rect.x / WIDTH) * image.naturalWidth)
  const sourceY = Math.round((rect.y / HEIGHT) * image.naturalHeight)
  const sourceWidth = Math.max(1, Math.round((rect.width / WIDTH) * image.naturalWidth))
  const sourceHeight = Math.max(1, Math.round((rect.height / HEIGHT) * image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.min(sourceWidth, image.naturalWidth - sourceX)
  canvas.height = Math.min(sourceHeight, image.naturalHeight - sourceY)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D unavailable for frame cropping')
  context.drawImage(
    image,
    sourceX,
    sourceY,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  return canvas.toDataURL('image/jpeg', 0.85)
}

async function syntheticFrame(region: SceneRegionId): Promise<string> {
  const cached = frameCache.get(region)
  if (cached) return cached

  const rect = REGIONS[region]
  const svg = slideSvg().replace(
    /viewBox="0 0 \d+ \d+"/,
    `viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}"`,
  )
  const blobUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const image = await decodeImage(blobUrl)
  const scale = region === 'full' ? 1 : 1.6
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(rect.width * scale)
  canvas.height = Math.round(rect.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D unavailable for frame rasterization')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/png')
  frameCache.set(region, dataUrl)
  return dataUrl
}

/**
 * Resolve a model-visible frame and its true provenance.
 * A registered live snapshot wins; the synthetic slide is the fallback.
 */
export async function resolveSceneFrame(
  region: SceneRegionId = 'full',
): Promise<ResolvedFrame> {
  const frame = liveFrame
  if (frame) {
    const source: FrameSource = frame.source === 'screen' ? 'live-screen' : 'live-camera'
    if (region === 'full') return { dataUrl: frame.dataUrl, source }
    try {
      return { dataUrl: await cropLiveFrame(frame, region), source }
    } catch {
      // Undecodable snapshot: fall through to the synthetic slide.
    }
  }
  return { dataUrl: await syntheticFrame(region), source: 'synthetic-slide' }
}
