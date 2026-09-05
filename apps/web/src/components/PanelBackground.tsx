import { useEffect, useState } from 'react'
import { api } from '../api/client'

export interface PanelBgConfig {
  enabled: boolean
  kind: 'wallpaper' | 'live'
  url: string
  durationSec: number
}

// Global panel background layer. Fetches the admin-configured background (which
// also applies to the login screen) and renders it fixed behind the app.
// Polls + listens for a local "uh-bg-changed" event so an admin's save applies
// instantly without a reload.
export function PanelBackground() {
  const [bg, setBg] = useState<PanelBgConfig | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const d = await api.get('/settings/background')
        if (alive) setBg(d.background || null)
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

  if (!bg?.enabled || !bg.url) return null

  if (bg.kind === 'live') {
    return (
      <div className="panel-bg-layer" aria-hidden>
        <video key={bg.url} src={bg.url} autoPlay muted loop playsInline />
        <div className="panel-bg-scrim" />
      </div>
    )
  }
  return (
    <div className="panel-bg-layer" aria-hidden>
      <div className="panel-bg-img" style={{ backgroundImage: `url(${bg.url})` }} />
      <div className="panel-bg-scrim" />
    </div>
  )
}