export function cx(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(' ')
}

/**
 * Display form for a probability. `null` (unreported) renders as an em dash
 * so a UI surface can never pass a fabricated number off as measured.
 */
export function formatP(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(2) : '—'
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

export function formatClock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${pad(minutes)}:${pad(seconds)}`
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

export function estimateTokens(text: string): number {
  if (!text.trim()) return 0
  const words = text.trim().split(/\s+/).length
  const chars = text.length
  return Math.max(1, Math.round(Math.max(words * 1.3, chars / 4.1)))
}

export function countWords(text: string): number {
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)
  return matches?.length ?? 0
}

export function truncate(text: string, maxLength = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= maxLength) return clean
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`
}

export function sentenceCase(text: string): string {
  const cleaned = text.trim().replace(/^[a-z]/, (character) => character.toUpperCase())
  if (!cleaned) return cleaned
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`
}

let idCounter = 0
export function makeId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Canonical guard for outside-controlled JSON (network payloads, parsed files). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

export function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}
