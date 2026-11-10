import type { ToolName } from '../types'

export interface ParsedToolCall {
  name: ToolName
  params: Record<string, string>
  think?: string
}

const KNOWN_TOOLS: ToolName[] = [
  'add_text',
  'edit_text',
  'remove_text',
]

/**
 * Tolerant parser for the LFM3 native XML tool-call contract.
 * The worker is deterministic in this build, but the executor still round-trips
 * its emitted XML through this parser so a native model bridge can swap in cleanly.
 */
export function parseToolCallXml(xml: string): ParsedToolCall | null {
  const think = xml.match(/<think>([\s\S]*?)<\/think>/)?.[1]?.trim()
  const functionMatch = xml.match(/<function=([a-z_]+)>([\s\S]*?)<\/function>/)
  if (!functionMatch) return null
  const name = functionMatch[1] as ToolName
  if (!KNOWN_TOOLS.includes(name)) return null

  const params: Record<string, string> = {}
  const parameterRegex = /<parameter=([a-z_]+)>\s*([\s\S]*?)\s*<\/parameter>/g
  let parameterMatch: RegExpExecArray | null
  while ((parameterMatch = parameterRegex.exec(functionMatch[2])) !== null) {
    params[parameterMatch[1]] = parameterMatch[2].trim()
  }
  return { name, params, think }
}

export function callToJson(call: { name: string; params: Record<string, string> }): string {
  return JSON.stringify({ name: call.name, arguments: call.params }, null, 2)
}

export function xmlToPlainText(xml: string): string {
  return xml.replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n').trim()
}
