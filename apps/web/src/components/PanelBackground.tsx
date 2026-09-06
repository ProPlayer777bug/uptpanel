import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'

const PANEL_T_KEY = 'uh_panel_t'
const clampT = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
const storedT = () => {
  const raw = localStorage.getItem(PANEL_T_KEY)
  return raw === null ? null : clampT(Number(raw) || 71)
}
const clampSec = (v: unknown) => {
  const n = Number(v)
  return Math.max(60, Math.min(86400, Number.isFinite(n) && n > 0 ? Math.round(n) : 600))
}

export interface PanelBgConfig {
  enabled: boolean
  kind: 'wallpaper' | 'live'
  url: string
  durationSec: number
  screen?: 'pc' | 'mobile' | 'both'
}

export interface StoredMedia {
  name: string
  url: string
  kind: 'wallpaper' | 'live'
  size: number
  addedAt: number
}

// Global panel background layer. Fetches the admin-configured background (which
// also applies to the login screen) and renders it fixed behind the app.
// Polls + listens for a local "uh-bg-changed" event so an admin's save applies
// instantly without a reload. When the admins enable slideshow, the stored
// library (wallpapers + live wallpapers) rotates every intervalSec instead —
// done client-side so every user and the login screen rotate in sync-ish.
export function PanelBackground() {
  const [bg, setBg] = useState<PanelBgConfig | null>(null)
  const [slides, setSlides] = useState(false)
  const [interSec, setInterSec] = useState(600)
  // Per-user transparency: the user's stored preference, else the server default.
  const [panelT, setPanelT] = useState<number>(() => storedT() ?? 71)

  const mediaRef = useRef<StoredMedia[]>([])
  const idxRef = useRef(-1)
  const baseRef = useRef<{ durationSec: number; screen: 'pc' | 'mobile' | 'both' }>({ durationSec: 5, screen: 'both' })
  const enabledRef = useRef(false)
  const slidesRef = useRef(false)
  const aliveRef = useRef(true)

  const showSlide = (i: number) => {
    const m = mediaRef.current[i]
    if (!m) return
    setBg({ enabled: true, kind: m.kind, url: m.url, durationSec: baseRef.current.durationSec, screen: baseRef.current.screen })
  }

  useEffect(() => {
    aliveRef.current = true
    const load = async () => {
      try {
        const d = await api.get('/settings/background')
        const c = (d.background || null) as PanelBgConfig | null
        enabledRef.current = !!c?.enabled && !!c.url
        if (c) baseRef.current = { durationSec: c.durationSec || 5, screen: (c.screen as 'pc' | 'mobile' | 'both') || 'both' }
        const ss = (d.slideshow || {}) as { enabled?: boolean; intervalSec?: number }
        const on = !!ss.enabled
        if (on !== slidesRef.current) {
          slidesRef.current = on
          setSlides(on)
          if (!on && aliveRef.current) setBg(c?.enabled ? c : null) // slideshow off -> configured bg
        }
        setInterSec(clampSec(ss.intervalSec))

        const ml = await api.get('/settings/background/media').catch(() => ({ media: [] } as any))
        mediaRef.current = ml.media || []

        if (on && enabledRef.current && mediaRef.current.length >= 2) {
          if (idxRef.current === -1) {
            let i = mediaRef.current.findIndex((m) => m.url === c?.url)
            idxRef.current = i >= 0 ? i : 0
          }
          showSlide(idxRef.current)
        } else {
          idxRef.current = -1
          if (aliveRef.current) setBg(c?.enabled ? c : null)
        }

        // Only seed from the server default when the user hasn't set their own.
        if (storedT() === null) {
          const p = await api.get('/settings/panel').catch(() => ({ panelT: 71 } as any))
          if (aliveRef.current && storedT() === null) {
            const v = clampT(Number(p.panelT ?? 71))
            localStorage.setItem(PANEL_T_KEY, String(v))
            setPanelT(v)
          }
        }
      } catch { /* ignore: keep current background */ }
    }
    load()
    const t = setInterval(load, 20000)
    const onChanged = () => load()
    const onFocus = () => load()
    const onStorage = (e: StorageEvent) => {
      if (e.key === PANEL_T_KEY) setPanelT(storedT() ?? 71)
    }
    window.addEventListener('uh-bg-changed', onChanged)
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    return () => { aliveRef.current = false; clearInterval(t); window.removeEventListener('uh-bg-changed', onChanged); window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onStorage) }
  }, [])

  // Slideshow rotation: advance one stored media every intervalSec.
  useEffect(() => {
    if (!slides || mediaRef.current.length < 2) return
    const t = setInterval(() => {
      if (idxRef.current === -1) idxRef.current = 0
      idxRef.current = (idxRef.current + 1) % mediaRef.current.length
      showSlide(idxRef.current)
    }, interSec * 1000)
    return () => clearInterval(t)
  }, [slides, interSec])

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