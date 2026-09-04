import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Shell } from '../components/Shell'
import { Icon, Spinner, EmptyState, toast } from '../components/ui'

export function Databases() {
  const [dbs, setDbs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  const load = async () => {
    try { setDbs((await api.get('/databases')).databases || []) }
    catch (e: any) { toast.err(e?.message || 'Failed to load databases') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const t = q.trim().toLowerCase()
  const filtered = t ? dbs.filter((d) => (d.name || '').toLowerCase().includes(t) || (d.serverName || '').toLowerCase().includes(t)) : dbs

  return (
    <Shell>
      <div className="page">
        <div className="page-h">
          <h1>Databases</h1>
          <span className="sub">{dbs.length} total</span>
          <div style={{ flex: 1 }} />
        </div>

        <div className="server-toolbar">
          <div className="search-box" style={{ maxWidth: 320 }}>
            <Icon name="search" size={14} />
            <input placeholder="Search name / server…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ flex: 1 }} />
        </div>

        {loading ? (
          <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
        ) : filtered.length === 0 ? (
          <div className="card"><EmptyState icon="database" title="No databases" desc="Create a database from a server's Databases tab." /></div>
        ) : (
          <div className="card anim-in" style={{ overflowX: 'auto' }}>
            <table className="dtable">
              <thead>
                <tr><th>Database</th><th>Server</th><th>Type</th><th>Host</th><th>Username</th></tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id}>
                    <td><span className="mono sm">{d.name}</span></td>
                    <td>{d.serverName}</td>
                    <td><span className="badge gray xs">{d.type}</span></td>
                    <td><span className="mono xs text-2">{d.host}:{d.port}</span></td>
                    <td><span className="mono xs text-2">{d.username}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  )
}
