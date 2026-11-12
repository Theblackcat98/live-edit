import type { ReactNode } from 'react'

/** One lettered block in the decision tab (R, D, W, S, E, T — pipeline order). */
export function TraceSection({
  index,
  title,
  caption,
  children,
}: {
  index: string
  title: string
  caption?: string
  children: ReactNode
}) {
  return (
    <section className="trace-section">
      <header className="trace-section-head">
        <span className="trace-section-index mono" aria-hidden="true">
          {index}
        </span>
        <h3>{title}</h3>
        {caption && <span className="trace-section-caption mono">{caption}</span>}
      </header>
      <div className="trace-section-body">{children}</div>
    </section>
  )
}
