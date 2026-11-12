import type { ReactNode } from 'react'

/** One numbered block in the decision tab (D, W, E, T). */
export function TraceSection({
  index,
  title,
  caption,
  children,
}: {
  index: string
  title: string
  caption: string
  children: ReactNode
}) {
  return (
    <section className="trace-section">
      <header className="trace-section-head">
        <span className="trace-section-index mono">{index}</span>
        <h3>{title}</h3>
        <span className="trace-section-caption mono">{caption}</span>
      </header>
      <div className="trace-section-body">{children}</div>
    </section>
  )
}
