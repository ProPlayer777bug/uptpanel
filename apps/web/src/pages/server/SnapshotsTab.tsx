import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast } from '../../components/ui'
import type { Server, Snapshot } from '@uptimehost/types'

export function SnapshotsTab({ server }: { server: Server }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = () => {
    setLoading(true)
    api.get(`/servers/${server.id}/snapshots`).then((d) => setSnaps(d.snapshots)).catch((e: any) => toast.err(e?.message)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [server.id])

  const create = async () => {
    setBusy(true)
    try { await api.post(`/servers/${server.id}/snapshots`, { name: 'Restore point' }); toast.ok('Snapshot created'); load() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const restore = async (s: Snapshot) => {
    if (!confirm(`Restore server from snapshot "${s.name}"?`)) return
    setBusy(true)
    try { await api.post(`/servers/${server.id}/snapshots/${s.id}/restore`, {}); toast.ok('Restore initiated'); load() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const remove = async (s: Snapshot) => {
    if (!confirm(`Delete snapshot "${s.name}"?`)) return
    setBusy(true)
    try { await api.del(`/servers/${server.id}/snapshots/${s.id}`); toast.ok('Snapshot deleted'); load() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  return (
    <div className="card">
      <div className="card-h">
        <Icon name="snap" size={15} /> Snapshots <span className="h-sub">restore points</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={create} disabled={busy}><Icon name="plus" size={13} /> Take snapshot</button>
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {loading && snaps == null ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
        : !snaps || snaps.length === 0 ? (
          <div className="empty"><h3>No snapshots</h3><p>Create a snapshot to capture the current state as a restore point.</p></div>
        ) : (
          <table className="dtable">
            <thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {snaps.map((s) => (
                <tr key={s.id}>
                  <td><span className="cell-main">{s.name}</span></td>
                  <td><span className="badge gray">{s.kind}</span></td>
                  <td className="mono sm">{s.sizeMb} MB</td>
                  <td className="sm text-2">{new Date(s.createdAt).toLocaleString()}</td>
                  <td>
                    <div className="flex gap-1" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm ghost" onClick={() => restore(s)}><Icon name="restart" size={13} /> Restore</button>
                      <button className="btn sm ghost" onClick={() => remove(s)}><Icon name="trash" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
