import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/utils'

interface TypewriterTextProps {
  text: string
  animate?: boolean
  className?: string
}

export function TypewriterText({ text, animate, className }: TypewriterTextProps) {
  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [count, setCount] = useState(animate && !reducedMotion.current ? 0 : text.length)

  useEffect(() => {
    if (!animate || reducedMotion.current) {
      setCount(text.length)
      return
    }
    setCount(0)
    let position = 0
    const timer = window.setInterval(() => {
      position = Math.min(text.length, position + 3)
      setCount(position)
      if (position >= text.length) window.clearInterval(timer)
    }, 17)
    return () => window.clearInterval(timer)
  }, [animate, text])

  const streaming = count < text.length

  return (
    <span className={cx('typewriter', className)}>
      {text.slice(0, count)}
      {streaming && <span className="typewriter-caret" aria-hidden="true" />}
    </span>
  )
}
