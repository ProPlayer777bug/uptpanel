import { useEffect, useState } from 'react'
import { api } from '../api/client'

export interface PanelBgConfig {
  enabled: boolean
  kind: 'wallpaper' | 'live'
  url: string
  durationSec: number
  screen?: 'pc' | 'mobile' | 'both'
}

// Global panel background layer. Fetches the admin-configured background (which
// also applies to the login screen) and renders it fixed behind the app.
// Polls + listens for a local "uh-bg-changed" event so an admin's save applies
// instantly without a reload.
export function PanelBackground() {
  const [bg, setBg] = useState<PanelBgConfig | null>(null)
  const [panelT, setPanelT] = useState(0)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api.get('/settings/background')
        if (alive) setBg(d.background || null)
        const p = await api.get('/settings/panel').catch(() => ({ panelT: 0 } as any))
        if (alive) setPanelT(Math.round(Number(p.panelT ?? 0)))
      } catch { /* ignore: keep current background */ }
    }
    load()
    const t = setInterval(load, 20000)
    const onChanged = () => load()
    const onFocus = () => load()
    window.addEventListener('uh-bg-changed', onChanged)
    window.addEventListener('focus', onFocus)
    return () => { alive = false; clearInterval(t); window.removeEventListener('uh-bg-changed', onChanged); window.removeEventListener('focus', onFocus) }
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('uh-bg', !!bg?.enabled)
  }, [bg])

  // Universal panel transparency 0-100 (100 = fully see-through). Drives
  // color-mix() alpha for .shell/.sidebar/.card in app.css via --uh-panel-t
  // (0..1). Independent of whether a background is set.
  useEffect(() => {
    document.documentElement.style.setProperty('--uh-panel-t', String(Math.max(0, Math.min(100, panelT)) / 100))
  }, [panelT])

  if (!bg?.enabled || !bg.url) return null

  const layer = (children: React.ReactNode) => (
    <div className="panel-bg-layer" data-screen={bg.screen || 'both'} aria-hidden>
      {children}
      <div className="panel-bg-scrim" />
    </div>
  )

  if (bg.kind === 'live') {
    return layer(<video key={bg.url} src={bg.url} autoPlay muted loop playsInline />)
  }
  return layer(<div className="panel-bg-img" style={{ backgroundImage: `url(${bg.url})` }} />)
}