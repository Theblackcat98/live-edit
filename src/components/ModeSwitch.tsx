import { RUN_MODES, type RunMode } from '../lib/runmode'
import { cx } from '../lib/utils'

interface ModeSwitchProps {
  mode: RunMode
  onSetMode: (mode: RunMode) => void
  /** data-testid for the group; each button gets `${buttonTestIdPrefix}-${id}`. */
  testId?: string
  buttonTestIdPrefix?: string
  /** Surface-specific class (the TopBar and runtime-card instances have different visibility). */
  className?: string
}

/**
 * The three-state run-mode control, shared by the TopBar (desktop) and the
 * Runtime truth card (phone, where the TopBar instance is hidden). One markup
 * definition, wired to the same setMode; the surface class decides visibility.
 */
export function ModeSwitch({
  mode,
  onSetMode,
  testId = 'mode-switch',
  buttonTestIdPrefix = 'mode',
  className,
}: ModeSwitchProps) {
  return (
    <div
      className={cx('mode-switch', className)}
      role="group"
      aria-label="Run mode"
      data-testid={testId}
    >
      {RUN_MODES.map((info) => {
        const active = info.id === mode
        return (
          <button
            key={info.id}
            type="button"
            className={cx('mode-option', active && 'is-active')}
            aria-pressed={active}
            data-testid={`${buttonTestIdPrefix}-${info.id}`}
            title={info.description}
            onClick={() => onSetMode(info.id)}
          >
            {info.short}
          </button>
        )
      })}
    </div>
  )
}
