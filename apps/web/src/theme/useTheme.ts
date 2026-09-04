import { useEffect, useState } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => (localStorage.getItem('uh_theme') as ThemeMode) || 'dark')

  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      let m = mode
      if (m === 'system') m = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      root.dataset.theme = m
    }
    apply()
    const q = window.matchMedia('(prefers-color-scheme: dark)')
    const onSys = () => { if (mode === 'system') apply() }
    q.addEventListener('change', onSys)
    return () => q.removeEventListener('change', onSys)
  }, [mode])

  const applyMode = (m: ThemeMode) => {
    setMode(m)
    localStorage.setItem('uh_theme', m)
  }
  return { mode, applyMode }
}

// preferReducedMotion exposes a reactive flag so JS-driven animation can also
// be disabled for users who ask for reduced motion (CSS handles transitions;
// this covers imperative animation in components). Mirrors the media query in
// styles/tokens.css.
export function preferReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
