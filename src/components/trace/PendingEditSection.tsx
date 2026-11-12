/** Where the held turn sits: still queued under Pending edits, or already stopped. */
export function PendingEditSection({ pending }: { pending: boolean }) {
  return (
    <span className="trace-verdict-meta mono">
      {pending ? 'waiting under Pending edits · note untouched' : 'note untouched'}
    </span>
  )
}
