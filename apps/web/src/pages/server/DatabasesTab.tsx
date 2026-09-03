import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast, Modal } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface DB {
  id: string
  serverId: string
  name: string
  type: string
  username: string
  password: string
  host: string
  port: number
}

export function DatabasesTab({ server }: { server: Server }) {
  const [dbs, setDbs] = useState<DB[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('mysql')
  const [showPw, setShowPw] = useState<Record<string, boolean>>({})

  const load = () => {
    setLoading(true)
    api.get(`/servers/${server.id}/databases`).then((d) => setDbs(d.databases)).catch((e: any) => toast.err(e?.message)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [server.id])

  const create = async () => {
    setBusy(true)
    try {
      await api.post(`/servers/${server.id}/databases`, { name, type })
      toast.ok('Database provisioned')
      setOpen(false); setName('')
      load()
    } catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const rotate = async (d: DB) => {
    if (!confirm(`Rotate password for "${d.name}"? The old password will stop working.`)) return
    setBusy(true)
    try {
      const r = await api.post(`/servers/${server.id}/databases/${d.id}/rotate`, {})
      toast.ok('Password rotated')
      load()
    } catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const remove = async (d: DB) => {
    if (!confirm(`Delete database "${d.name}" permanently?`)) return
    setBusy(true)
    try { await api.del(`/servers/${server.id}/databases/${d.id}`); toast.ok('Database deleted'); load() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-h">
        <Icon name="chip" size={15} /> Databases <span className="h-sub">connection metadata + credentials</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={() => setOpen(true)}><Icon name="plus" size={13} /> New database</button>
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {loading && dbs == null ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
        : !dbs || dbs.length === 0 ? (
          <div className="empty"><h3>No databases</h3><p>Provision a database for your server and get a connection string.</p></div>
        ) : (
          <table className="dtable">
            <thead><tr><th>Name</th><th>Type</th><th>Host</th><th>Port</th><th>User</th><th>Password</th><th></th></tr></thead>
            <tbody>
              {dbs.map((d) => (
                <tr key={d.id}>
                  <td><span className="cell-main">{d.name}</span></td>
                  <td><span className="badge gray xs">{d.type}</span></td>
                  <td className="mono sm">{d.host}</td>
                  <td className="mono sm">{d.port}</td>
                  <td className="mono sm">{d.username}</td>
                  <td className="mono sm">
                    {showPw[d.id] ? d.password : '••••••••••••'}
                    <button className="btn ghost icon sm" onClick={() => setShowPw((m) => ({ ...m, [d.id]: !m[d.id] }))}><Icon name="lock" size={12} /></button>
                  </td>
                  <td>
                    <div className="flex gap-1" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm ghost" onClick={() => rotate(d)} disabled={busy}><Icon name="restart" size={13} /> Rotate</button>
                      <button className="btn sm ghost" onClick={() => remove(d)}><Icon name="trash" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New database" width={460}>
        <div className="form">
          <label>Database name <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="myapp" /></label>
          <label>Type
            <select className="inp" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </label>
        </div>
        <div className="flex gap-2 mt-3" style={{ justifyContent: 'flex-end' }}>
          <button className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn sm primary" onClick={create} disabled={busy || !name}>Provision</button>
        </div>
      </Modal>
    </div>
  )
}
