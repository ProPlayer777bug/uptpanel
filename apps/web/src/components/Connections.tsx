import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Icon, Spinner, toast } from './ui'
import type { IconName } from './ui'

export interface PanelConnection {
  id: string
  type: string
  url: string
  addedAt?: number
  addedBy?: string
}

export const CONNECTION_TYPES: { id: string; label: string; icon: IconName; placeholder: string }[] = [
  { id: 'discord', label: 'Discord', icon: 'discord', placeholder: 'https://discord.gg/…' },
  { id: 'youtube', label: 'YouTube', icon: 'youtube', placeholder: 'https://youtube.com/@…' },
  { id: 'github', label: 'GitHub', icon: 'github', placeholder: 'https://github.com/…' },
  { id: 'reddit', label: 'Reddit', icon: 'reddit', placeholder: 'https://reddit.com/r/… or /u/…' },
  { id: 'xbox', label: 'Xbox', icon: 'xbox', placeholder: 'https://account.xbox.com/…' },
  { id: 'steam', label: 'Steam', icon: 'steam', placeholder: 'https://steamcommunity.com/id/…' },
]

export function metaOf(type: string) {
  return CONNECTION_TYPES.find((t) => t.id === type) || { id: type, label: type, icon: 'globe' as IconName, placeholder: 'https://…' }
}

export function Connections() {
  const [items, setItems] = useState<PanelConnection[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [type, setType] = useState('discord')
  const [url, setUrl] = useState('')
  const [ban, setBan] = useState('')

  const load = () => {
    api.get('/connections').then((d) => setItems(d.connections || [])).catch((e: any) => toast.err(e?.message))
  }
  useEffect(() => { load() }, [])

  const persist = async (next: PanelConnection[], what: string) => {
    setBusy(true)
    setBan('')
    try {
      const d = await api.put('/connections', { connections: next })
      setItems(d.connections || next)
      toast.ok(what)
      window.dispatchEvent(new Event('uh-conn-changed'))
    } catch (e: any) { setBan(e?.message || 'Failed to save'); toast.err(e?.message) }
    finally { setBusy(false) }
  }

  const add = () => {
    const u = url.trim()
    if (!/^https?:\/\//i.test(u)) { setBan('Enter a valid link — it must start with https://'); return }
    const next = [...(items || []), { id: '', type, url: u } as PanelConnection]
    persist(next, 'Connection added')
    setUrl('')
  }

  const remove = (id: string) => {
    persist((items || []).filter((c) => c.id !== id), 'Connection removed')
  }

  const meta = metaOf(type)

  return (
    <div className="card">
      <div className="card-h">
        <Icon name="webhook" size={15} /> Connections <span className="h-sub">Discord, YouTube, GitHub, Reddit, Xbox &amp; Steam links shown in the ticker at the top of the panel</span>
        <div style={{ flex: 1 }} />
        {busy && <Spinner size={15} />}
      </div>
      <div className="card-b">
        {items === null ? <div className="center" style={{ padding: 20 }}><Spinner size={18} /></div> : items.length === 0 ? (
          <p className="sub xs">No connections yet — add the first one below. It will start showing in the panel ticker.</p>
        ) : (
          <div style={{ maxHeight: '40vh', overflowY: 'auto', marginBottom: 12 }}>
            {items.map((c) => (
              <div key={c.id} className="row-item" style={{ alignItems: 'center' }}>
                <span className="side-ico" style={{ background: 'var(--surface-2)' }}><Icon name={metaOf(c.type).icon} size={15} /></span>
                <span className="sm" style={{ width: 110, flexShrink: 0 }}>{metaOf(c.type).label}</span>
                <a className="sm mono flex-1" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--accent)' }} href={c.url} target="_blank" rel="noreferrer">{c.url}</a>
                <button className="btn sm ghost icon" disabled={busy} title="Remove" onClick={() => remove(c.id)}><Icon name="trash" size={13} /></button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 panel-row" style={{ alignItems: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <div className="field">
            <label>Type</label>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {CONNECTION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="field flex-1">
            <label>Link</label>
            <input className="input mono" placeholder={meta.placeholder} value={url} onChange={(e) => { setUrl(e.target.value); setBan('') }} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
          <button className="btn primary" onClick={add} disabled={busy}><Icon name="plus" size={14} /> Add</button>
        </div>
        {ban && <div className="xs mt-2" style={{ color: 'var(--danger)' }}>{ban}</div>}
      </div>
    </div>
  )
}