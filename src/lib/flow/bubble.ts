/**
 * The provisional streaming bubble every flow shares (battery case 18).
 * Visible deltas land in one assistant message as they arrive; an outcome that
 * is not a visible reply retracts the bubble entirely, and an answer settles
 * it with the authoritative text. There is exactly one implementation — both
 * flows differ only in the reply author they pass in.
 */

import type { PipelineDeps } from './turnContext'

/** The transcript capabilities a bubble needs. */
export interface StreamBubbleDeps {
  addMessage: PipelineDeps['addMessage']
  patchMessage: PipelineDeps['patchMessage']
  setMessages: PipelineDeps['setMessages']
}

export interface StreamBubbleInput {
  /** Reply author label for the bubble (the flow's chat model). */
  author: string
  /** The run this bubble belongs to. */
  runId: string
}

export interface StreamBubble {
  /** Append a visible delta, opening the bubble on the first one. */
  onText: (delta: string) => void
  /** Drop the bubble (delegation/action turns must stay silent). */
  retractStream: () => void
  /** Replace the streamed text with the authoritative final text. */
  settleStream: (text: string) => void
}

export function createStreamBubble(
  messages: StreamBubbleDeps,
  input: StreamBubbleInput,
): StreamBubble {
  let streamId: string | null = null
  let streamedText = ''
  const onText = (delta: string) => {
    streamedText += delta
    if (!streamId) {
      streamId = messages.addMessage({
        role: 'assistant',
        text: streamedText,
        streaming: true,
        author: input.author,
        runId: input.runId,
      })
    } else {
      messages.patchMessage(streamId, { text: streamedText })
    }
  }
  const retractStream = () => {
    if (streamId) {
      const id = streamId
      messages.setMessages((previous) => previous.filter((message) => message.id !== id))
      streamId = null
      streamedText = ''
    }
  }
  const settleStream = (text: string) => {
    if (streamId) {
      messages.patchMessage(streamId, { text, streaming: false })
      streamId = null
    } else {
      messages.addMessage({ role: 'assistant', text, author: input.author, runId: input.runId })
    }
  }
  return { onText, retractStream, settleStream }
}
