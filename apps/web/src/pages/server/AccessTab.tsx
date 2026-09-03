import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

const ROLE_BADGE: Record<string, string> = { owner: 'amber', admin: 'red', operator: 'blue', developer: 'cyan', viewer: 'gray' }

export function AccessTab({ server }: { server: Server }) {
  const [data, setData] = useState<{ owner?: any; access: any[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [busy, setBusy] = useState(false)

  const load = () => {
    setLoading(true)
    api.get(`/servers/${server.id}/access`).then((d) => setData(d)).catch((e: any) => toast.err(e?.message)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [server.id])

  const add = async () => {
    if (!email.trim()) { toast.err('Enter an email'); return }
    setBusy(true)
    try { await api.post(`/servers/${server.id}/access`, { email: email.trim(), role }); toast.ok('Access granted'); setEmail(''); load() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  const people = data ? [data.owner, ...(data.access || [])].filter(Boolean) : []

  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="card-h"><Icon name="lock" size={15} /> Grant access</div>
        <div className="card-b">
          <div className="flex gap-2" style={{ alignItems: 'flex-end' }}>
            <div className="field flex-1"><label>Email</label><input className="input" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="field"><label>Role</label>
              <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="viewer">Viewer</option><option value="developer">Developer</option><option value="operator">Operator</option><option value="admin">Admin</option><option value="owner">Owner</option>
              </select>
            </div>
            <button className="btn primary" onClick={add} disabled={busy}><Icon name="plus" size={14} /> Grant</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="server" size={15} /> People on this server</div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {loading && !data ? <div className="center" style={{ padding: 40 }}><Spinner size={20} /></div>
          : people.length === 0 ? <div className="empty"><h3 className="sm">No access entries</h3></div>
          : people.map((a, i) => (
            <div key={i} className="row-item">
              <span className="avatar" style={{ width: 26, height: 26, fontSize: 11, background: `hsl(${a.avatarHue ?? 0} 70% 55%)` }}>{(a.name?.[0] || a.email?.[0] || '?').toUpperCase()}</span>
              <div className="flex-1">
                <div className="cell-main">{a.name || a.email || 'User'}</div>
                <div className="cell-sub">{a.email}</div>
              </div>
              <span className={`badge ${ROLE_BADGE[a.role] || 'gray'}`}>{a.role}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
