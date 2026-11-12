import { useCallback, useEffect, useState } from 'react'
import {
  applyThemePreference,
  loadThemePreference,
  nextThemePreference,
  saveThemePreference,
  type ThemePreference,
} from '../lib/theme'

/** The colour-theme preference, applied to <html> and persisted per browser. */
export function useTheme(): { theme: ThemePreference; cycleTheme: () => void } {
  const [theme, setTheme] = useState<ThemePreference>(() => loadThemePreference())

  useEffect(() => {
    applyThemePreference(theme)
    saveThemePreference(theme)
  }, [theme])

  const cycleTheme = useCallback(() => setTheme((current) => nextThemePreference(current)), [])
  return { theme, cycleTheme }
}
