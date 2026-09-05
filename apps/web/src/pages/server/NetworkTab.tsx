import { useEffect, useState } from 'react'
import { publicHost } from '../../utils/mask'
import { api } from '../../api/client'
import { useApp } from '../../state/auth'
import { Icon, Spinner, Switch, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface PoolAlloc { id: string; ip: string; port: number; proto?: string; alias?: string; primary?: boolean }

export function NetworkTab({ server }: { server: Server }) {
  const { refresh } = useApp()
  const [pool, setPool] = useState<PoolAlloc[]>([])
  const [newPort, setNewPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)

  // --- Anti-DDoS state ---
  const ddos = (server as any)?.antiddos || {}
  const canManage = !!server.permissions?.files
  // The port manager is admin-only; anti-DDoS is open to everyone with access.
  const canAdmin = server.permissions?.admin === true || server.role === 'admin' || server.role === 'owner'
  const [ddosOn, setDdosOn] = useState(!!ddos.enabled)
  const [ddosLevel, setDdosLevel] = useState(ddos.level === 'strict' ? 'strict' : 'standard')
  const [ddosBusy, setDdosBusy] = useState(false)
  const [ddosApplied, setDdosApplied] = useState<{ enabled: boolean; ports: number[] } | null>(null)

  useEffect(() => {
    let live = true
    api.get(`/servers/${server.id}/antiddos`).then((d) => {
      if (live) setDdosApplied(d.antiddos?.applied || null)
    }).catch(() => {})
    return () => { live = false }
  }, [server.id, ddos.enabled, ddos.level])

  useEffect(() => {
    setDdosOn(!!ddos.enabled)
    setDdosLevel(ddos.level === 'strict' ? 'strict' : 'standard')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ddos.enabled, ddos.level])

  const applyDdos = async (enabled: boolean, level: string) => {
    setDdosBusy(true)
    try {
      await api.post(`/servers/${server.id}/antiddos`, { enabled, level })
      toast.ok(enabled ? 'Anti-DDoS protection enabled' : 'Anti-DDoS protection disabled')
      refresh()
    } catch (e: any) {
      toast.err(e?.message || 'Failed to apply anti-DDoS setting')
      setDdosOn(ddos.enabled)
      setDdosLevel(ddos.level)
    } finally {
      setDdosBusy(false)
    }
  }

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
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-h">
          <Icon name="shieldCheck" size={15} /> Anti-DDoS protection <span className="h-sub">per-server traffic filtering on the host</span>
          {ddosApplied && ddosApplied.enabled && (
            <span className="badge success xs ml-1">active on port{ddosApplied.ports.length !== 1 ? 's' : ''} {ddosApplied.ports.join(', ')}</span>
          )}
          {!canManage && <span className="badge gray xs ml-1">view only</span>}
        </div>
        <div className="p-3">
          {canManage ? (
            <div className="flex items-center gap-2" style={{ gap: 10 }}>
              <Switch
                checked={ddosOn}
                disabled={ddosBusy}
                onChange={(v) => { setDdosOn(v); applyDdos(v, ddosLevel) }}
                label="Protect this server from connection / packet floods"
              />
              {ddosBusy && <Spinner size={14} />}
            </div>
          ) : (
            <div className="xs text-3">You don't have permission to change network protection on this server.</div>
          )}
          <div className="flex gap-1 mt-3 items-center">
            <span className="xs text-3 mr-1">Protection level:</span>
            {(['standard', 'strict'] as const).map((lv) => (
              <button
                key={lv}
                className={`btn sm ${ddosLevel === lv && ddosOn ? 'primary' : ''}`}
                disabled={!canManage || ddosBusy || !ddosOn}
                title={ddosOn ? '' : 'Enable protection first'}
                onClick={() => { setDdosLevel(lv); applyDdos(true, lv) }}
              >
                {lv === 'standard' ? 'Standard' : 'Strict'}
              </button>
            ))}
          </div>
          <div className="xs text-3 mt-3">
            When enabled, the host limits {allocs.length ? `traffic on this server's port${allocs.length !== 1 ? 's' : ''} (${allocs.map((a: any) => a.port).join(', ')})` : 'traffic on the server'} from any single source IP: new TCP connections are capped per second, concurrent connections per IP are limited, and UDP packets are rate-limited. Anything above the cap is dropped before it reaches the server, so floods can't saturate it — while normal play is unaffected. <b>Standard</b> suits typical players; <b>Strict</b> is for an active attack (tighter caps, may drop a very large legitimate crowd).
          </div>
          {ddos.error && <div className="sm text-1 mt-2" style={{ color: 'var(--danger)' }}>Last apply failed: {ddos.error}</div>}
        </div>
      </div>

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
                    <td className="mono sm">{publicHost(a, server.node) || a.alias || a.ip || '0.0.0.0'}</td>
                    <td className="mono sm">{a.port} {(server as any)?.primaryAllocationId === a.id ? <span className="badge cyan xs ml-1">primary</span> : null}</td>
                    <td><span className="badge gray xs">{a.proto || 'tcp'}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      {canAdmin ? (
                        <button
                          className="btn sm ghost icon"
                          disabled={removing === a.id || allocs.length <= 1}
                          title={allocs.length <= 1 ? 'A server must keep at least one port' : 'Remove port'}
                          onClick={() => remove(a)}
                        >
                          {removing === a.id ? <Spinner size={13} /> : <Icon name="trash" size={13} className="danger" />}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="plus" size={15} /> Add a port {!canAdmin && <span className="h-sub">admin only</span>}</div>
        <div className="p-3">
          {!canAdmin ? (
            <div className="xs text-3">
              Only an admin or the server owner can add or remove ports. Protection settings above apply to the existing ports.
            </div>
          ) : (<>
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
                  <span className="mono">{publicHost(p, server.node) ? `${publicHost(p, server.node)}:${p.port}` : `:${p.port}`}</span>
                </button>
              ))}
              {freePool.length > 12 && <span className="xs text-3">+{freePool.length - 12} more</span>}
            </div>
          )}
          <div className="xs text-3 mt-4">
            Adding a port opens it in the host firewall (ufw). Removing a port or deleting the server closes it automatically.
          </div>
          </>)}
        </div>
      </div>
    </div>
  )
}
