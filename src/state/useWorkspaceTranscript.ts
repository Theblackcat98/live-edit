import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { Message } from '../types'
import type { PersistedWorkspace } from '../lib/storage'
import { makeId } from '../lib/utils'
import { initialMessages } from './workspaceSeed'

interface TranscriptArgs {
  persisted: PersistedWorkspace | null
}

export interface WorkspaceTranscriptApi {
  messages: Message[]
  setMessages: Dispatch<SetStateAction<Message[]>>
  /** Latest transcript, replayed by the conversational branches as memory. */
  messagesRef: { current: Message[] }
  addMessage: (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => string
  patchMessage: (id: string, patch: Partial<Message>) => void
  /** Replace the transcript with a fresh session's seed messages (resetChat). */
  resetMessages: () => void
}

/**
 * The transcript: message state plus the append/patch mutators the pipeline
 * and the feature hooks share.
 */
export function useWorkspaceTranscript({ persisted }: TranscriptArgs): WorkspaceTranscriptApi {
  const [messages, setMessages] = useState<Message[]>(() =>
    (persisted?.messages ?? initialMessages()).map((message) =>
      // A stream cut off by a reload must not leave a permanent caret.
      message.streaming ? { ...message, streaming: false } : message,
    ),
  )
  const messagesRef = useRef<Message[]>(messages)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const addMessage = useCallback(
    (message: Omit<Message, 'id' | 'at'> & { at?: number; id?: string }) => {
      const id = message.id ?? makeId('msg')
      const full: Message = { ...message, id, at: message.at ?? Date.now() }
      setMessages((previous) => [...previous, full])
      return id
    },
    [],
  )

  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((previous) =>
      previous.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    )
  }, [])

  const resetMessages = useCallback(() => setMessages(initialMessages()), [])

  return { messages, setMessages, messagesRef, addMessage, patchMessage, resetMessages }
}
