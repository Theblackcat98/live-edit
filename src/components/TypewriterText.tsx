import { cx } from '../lib/utils'

interface TypewriterTextProps {
  text: string
  className?: string
}

/**
 * Assistant text renderer. Locally composed messages render instantly — a
 * 3-chars-per-tick caret animation made canned templates indistinguishable
 * from real model streaming (audit TD-22). Genuinely streamed messages grow
 * this component's `text` as tokens arrive; the caret is driven separately by
 * `message.streaming`, which is set only while a model stream is attached.
 */
export function TypewriterText({ text, className }: TypewriterTextProps) {
  return <span className={cx('typewriter', className)}>{text}</span>
}
