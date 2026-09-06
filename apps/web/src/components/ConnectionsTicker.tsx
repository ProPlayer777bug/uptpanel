import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Icon } from './ui'
import { metaOf, type PanelConnection } from './Connections'

const CYCLE_MS = 5000
const PANEL_T_KEY = 'uh_panel_t'

const clampT = (v: number) => Math.max(0, Math.min(100, Math.round(v)))
const storedT = () => {
  const raw = localStorage.getItem(PANEL_T_KEY)
  return raw === null ? null : clampT(Number(raw) || 71)
}

// Rotating hitchiker bar at the very top of the panel. Shows one connection at
// a time, advancing every 5s with a fade/slide transition. Clicking any entry
// opens the link in a new tab. No bar is rendered when admins haven't added any.
// Every user gets the per-user panel-transparency slider here (top of panel);
// the server value is only the default when the user hasn't set their own.
export function ConnectionsTicker() {
  const [items, setItems] = useState<PanelConnection[] | null>(null)
  const [idx, setIdx] = useState(0)
  const [panelT, setPanelT] = useState<number>(() => storedT() ?? 71)

  useEffect(() => {
    let alive = true
    const load = () => {
      api.get('/connections').then((d) => {
        if (!alive) return
        const next = d.connections || []
        setItems(next)
        setIdx((i) => (next.length > 0 ? Math.min(i, next.length - 1) : 0))
      }).catch(() => {})
    }
    // Seed the stored default once from the server when the user has no
    // preference of their own yet.
    if (storedT() === null) {
      api.get('/settings/panel').then((d: any) => {
        if (!alive || storedT() !== null) return
        const v = clampT(Number(d?.panelT ?? 71))
        localStorage.setItem(PANEL_T_KEY, String(v))
        setPanelT(v)
      }).catch(() => {})
    }
    load()
    const t = setInterval(load, 20000)
    const onChanged = () => load()
    const onStorage = (e: StorageEvent) => {
      if (e.key === PANEL_T_KEY) setPanelT(storedT() ?? 71)
    }
    window.addEventListener('uh-conn-changed', onChanged)
    window.addEventListener('storage', onStorage)
    return () => { alive = false; clearInterval(t); window.removeEventListener('uh-conn-changed', onChanged); window.removeEventListener('storage', onStorage) }
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--uh-panel-t', String(clampT(panelT) / 100))
  }, [panelT])

  useEffect(() => {
    if (!items || items.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), CYCLE_MS)
    return () => clearInterval(t)
  }, [items])

  const change = (v: number) => {
    const n = clampT(v)
    setPanelT(n)
    localStorage.setItem(PANEL_T_KEY, String(n))
  }

  const bar = (children?: React.ReactNode) => (
    <div className="conn-ticker" style={children ? undefined : { justifyContent: 'flex-end' }}>
      {children}
      <TickerSlider panelT={panelT} onChange={change} />
    </div>
  )

  if (!items || items.length === 0) return bar()

  const c = items[Math.max(0, Math.min(idx, items.length - 1))]
  const m = metaOf(c?.type)

  return bar(
    <>
      <a className="conn-tick-item" key={c.id + idx} href={c.url} target="_blank" rel="noreferrer" title={c.url}>
        <span className="conn-tick-ico"><Icon name={m.icon} size={14} /></span>
        <span className="conn-tick-label">{m.label}</span>
        <span className="conn-tick-url">{c.url}</span>
        <span className="conn-tick-arrow"><Icon name="external" size={13} /></span>
      </a>
      {items.length > 1 && (
        <div className="conn-tick-dots">
          {items.map((x, i) => <span key={x.id} className={`conn-tick-dot${i === idx ? ' on' : ''}`} />)}
        </div>
      )}
      {items.length > 1 && <div className="conn-tick-progress" />}
    </>
  )
}

function TickerSlider({ panelT, onChange }: { panelT: number; onChange: (v: number) => void }) {
  return (
    <div className="conn-tick-t" title={`Panel transparency: ${panelT}% transparent`}>
      <Icon name="layers" size={12} />
      <input
        type="range" min={0} max={100} value={panelT}
        aria-label="Panel transparency"
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="conn-tick-t-val">{panelT}%</span>
    </div>
  )
}