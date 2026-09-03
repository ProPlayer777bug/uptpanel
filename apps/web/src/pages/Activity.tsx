import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Icon, SevBadge, Spinner } from '../components/ui'
import type { ActivityItem } from '@uptimehost/types'

export function Activity() {
  const [items, setItems] = useState<ActivityItem[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'server' | 'node' | 'admin'>('all')

  useEffect(() => { api.get('/activity?kind=all').then((d) => setItems(d.activity)).catch(() => setItems([])) }, [])

  const kindIcon: Record<string, any> = { server: 'server', node: 'node', admin: 'gear', auth: 'lock' }
  const shown = (items || []).filter((a) => filter === 'all' || a.kind === filter)

  return (
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="page-h">
        <h1>Activity</h1>
        <span className="sub">control plane events</span>
        <div style={{ flex: 1 }} />
        {(['all', 'server', 'node', 'admin'] as const).map((f) => (
          <button key={f} className={`btn sm ${filter === f ? 'subtle' : 'ghost'}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>

      <div className="card">
        {!items ? <div className="center" style={{ padding: 60 }}><Spinner size={24} /></div>
        : items.length === 0 ? <div className="empty"><h3>No activity yet</h3><p>Actions such as logging in, creating servers or nodes will appear here.</p></div>
        : shown.length === 0 ? <div className="empty"><h3 className="sm">No {filter} events</h3></div>
        : (
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {shown.map((a) => (
              <div key={a.id} className="row-item">
                <span style={{ color: 'var(--text-3)', width: 20, textAlign: 'center' }}><Icon name={kindIcon[a.kind] || 'activity'} size={16} /></span>
                <div className="flex-1">
                  <div className="sm">{a.message}</div>
                  <div className="cell-sub xs">{a.actor || 'system'} · {new Date(a.ts).toLocaleString()}</div>
                </div>
                <SevBadge sev={a.severity} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
