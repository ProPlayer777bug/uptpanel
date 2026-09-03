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
