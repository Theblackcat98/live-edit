export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="logo-mark"
    >
      <rect width="32" height="32" rx="9" className="logo-mark-bg" />
      <path
        d="M7.5 16h4l2.3-5.4L18 21.2l2.4-4.4h4.1"
        stroke="var(--surface)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24.3" cy="17.1" r="1.9" fill="var(--accent)" />
    </svg>
  )
}
