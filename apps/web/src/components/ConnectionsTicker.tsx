import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Icon } from './ui'
import { metaOf, type PanelConnection } from './Connections'

const CYCLE_MS = 5000

// Rotating hitchiker bar at the very top of the panel. Shows one connection at
// a time, advancing every 5s with a fade/slide transition. Clicking any entry
// opens the link in a new tab. No bar is rendered when admins haven't added any.
export function ConnectionsTicker() {
  const [items, setItems] = useState<PanelConnection[] | null>(null)
  const [idx, setIdx] = useState(0)

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
    load()
    const t = setInterval(load, 20000)
    const onChanged = () => load()
    window.addEventListener('uh-conn-changed', onChanged)
    return () => { alive = false; clearInterval(t); window.removeEventListener('uh-conn-changed', onChanged) }
  }, [])

  useEffect(() => {
    if (!items || items.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), CYCLE_MS)
    return () => clearInterval(t)
  }, [items])

  if (!items || items.length === 0) return null
  const c = items[Math.max(0, Math.min(idx, items.length - 1))]
  const m = metaOf(c?.type)

  return (
    <div className="conn-ticker">
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
    </div>
  )
}