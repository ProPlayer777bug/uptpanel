import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useApp } from '../state/auth'
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
  const { canAdmin } = useApp()
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
        <Icon name="webhook" size={15} /> Connections <span className="h-sub">{canAdmin ? 'Discord, YouTube, GitHub, Reddit, Xbox &amp; Steam links shown in the ticker at the top of the panel' : 'Links for this panel — see the ticker at the top of the page'}</span>
        <div style={{ flex: 1 }} />
        {busy && <Spinner size={15} />}
      </div>
      <div className="card-b">
        {items === null ? <div className="center" style={{ padding: 20 }}><Spinner size={18} /></div> : items.length === 0 ? (
          <p className="sub xs">{canAdmin ? 'No connections yet — add the first one below. It will start showing in the panel ticker.' : 'No connections yet.'}</p>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, marginBottom: 12 }}>
            {items.map((c) => (
              <a key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--text)', textDecoration: 'none', minWidth: 0, overflow: 'hidden' }} href={c.url} target="_blank" rel="noreferrer" title={c.url}>
                <span style={{ flexShrink: 0 }}><Icon name={metaOf(c.type).icon} size={15} /></span>
                <span className="sm" style={{ flexShrink: 0 }}>{metaOf(c.type).label}</span>
                <span className="xs mono flex-1" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-2)' }}>{c.url}</span>
                {canAdmin && (
                  <button className="btn sm ghost icon" style={{ flexShrink: 0 }} disabled={busy} title="Remove" onClick={(e) => { e.preventDefault(); e.stopPropagation(); remove(c.id) }}><Icon name="trash" size={13} /></button>
                )}
              </a>
            ))}
          </div>
        )}

        {canAdmin && (<>
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
        </>)}
      </div>
    </div>
  )
}