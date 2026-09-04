import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useApp } from '../../state/auth'
import { Icon, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface PoolAlloc { id: string; ip: string; port: number; proto?: string; alias?: string; primary?: boolean }

export function NetworkTab({ server }: { server: Server }) {
  const { refresh } = useApp()
  const [pool, setPool] = useState<PoolAlloc[]>([])
  const [newPort, setNewPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  const usedPorts = new Set((server.allocations || []).map((a: any) => a.port))
  const freePool = pool.filter((p) => !usedPorts.has(p.port))
  const allocs = server.allocations || []

  useEffect(() => {
    let live = true
    if (server.nodeId) {
      api.get(`/nodes/${server.nodeId}/allocations`).then((d) => {
        if (live) setPool(d.allocations || [])
      }).catch(() => {})
    }
    return () => { live = false }
  }, [server.nodeId])

  const add = async (port: number) => {
    if (!port || port < 1 || port > 65535) { toast.err('Enter a valid port (1-65535)'); return }
    setBusy(true)
    try {
      await api.post(`/servers/${server.id}/allocations`, { port })
      toast.ok(`Port ${port} added and firewall opened`)
      setNewPort('')
      refresh()
    } catch (e: any) { toast.err(e?.message || 'Failed to add port') }
    finally { setBusy(false) }
  }

  const remove = async (a: any) => {
    setRemoving(a.id)
    try {
      await api.del(`/servers/${server.id}/allocations/${a.id}`)
      toast.ok(`Port ${a.port} removed and firewall closed`)
      refresh()
    } catch (e: any) { toast.err(e?.message || 'Failed to remove port') }
    finally { setRemoving(null) }
  }

  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="card-h"><Icon name="node" size={15} /> Ports <span className="h-sub">allocated to this server</span></div>
        <div className="p-3">
          {allocs.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}><p>No ports allocated yet.</p></div>
          ) : (
            <table className="dtable">
              <thead><tr><th>Address</th><th>Port</th><th>Protocol</th><th></th></tr></thead>
              <tbody>
                {allocs.map((a: any) => (
                  <tr key={a.id}>
                    <td className="mono sm">{a.alias || a.ip || '0.0.0.0'}</td>
                    <td className="mono sm">{a.port} {(server as any)?.primaryAllocationId === a.id ? <span className="badge cyan xs ml-1">primary</span> : null}</td>
                    <td><span className="badge gray xs">{a.proto || 'tcp'}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn sm ghost icon"
                        disabled={removing === a.id || allocs.length <= 1}
                        title={allocs.length <= 1 ? 'A server must keep at least one port' : 'Remove port'}
                        onClick={() => remove(a)}
                      >
                        {removing === a.id ? <Spinner size={13} /> : <Icon name="trash" size={13} className="danger" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="plus" size={15} /> Add a port</div>
        <div className="p-3">
          <div className="field">
            <label>Port number</label>
            <input
              className="input mono"
              placeholder="e.g. 25566"
              inputMode="numeric"
              value={newPort}
              onChange={(e) => setNewPort(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <button className="btn primary" disabled={busy || !newPort} onClick={() => add(Number(newPort))}>
            {busy ? <Spinner size={14} /> : <Icon name="plus" size={14} />} Add & open firewall
          </button>
          <div className="xs text-3 mt-3 mb-1">Or pick from free node ports:</div>
          {freePool.length === 0 ? (
            <div className="xs text-3">No free ports remain in the node's pool.</div>
          ) : (
            <div className="flex gap-1 flex-wrap">
              {freePool.slice(0, 12).map((p) => (
                <button key={p.id} className="btn sm" disabled={busy} onClick={() => add(p.port)}>
                  <span className="mono">{p.alias || p.ip ? `${(p.alias || p.ip)}:` : ''}{p.port}</span>
                </button>
              ))}
              {freePool.length > 12 && <span className="xs text-3">+{freePool.length - 12} more</span>}
            </div>
          )}
          <div className="xs text-3 mt-4">
            Adding a port opens it in the host firewall (ufw). Removing a port or deleting the server closes it automatically.
          </div>
        </div>
      </div>
    </div>
  )
}
