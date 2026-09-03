import { useNavigate, useParams } from 'react-router-dom'
import { usePoll } from '../api/hooks'
import { api } from '../api/client'
import { useApp } from '../state/auth'
import { Icon, Spinner, StatePill, toast } from '../components/ui'
import type { Node, Server } from '@uptimehost/types'

export function NodeDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { refresh } = useApp()
  const { data, loading, refetch } = usePoll<{ node: Node; servers: Server[] }>(
    async () => api.get(`/nodes/${id}`), [id], 6000,
  )
  const node = data?.node
  const servers = data?.servers || []

  const refreshNode = async () => {
    try { await api.post(`/nodes/${id}/refresh`, {}); toast.ok('Node health refreshed'); refetch() }
    catch (e: any) { toast.err(e?.message) }
  }

  const del = async () => {
    if (!confirm(`Delete node "${node?.name}"?`)) return
    try { await api.del(`/nodes/${id}`); toast.ok('Node deleted'); refresh(); navigate('/nodes') }
    catch (e: any) { toast.err(e?.message || 'Cannot delete node with servers') }
  }

  const toggleMaintenance = async () => {
    if (window.confirm(`${node?.maintenance ? 'Exit' : 'Enter'} maintenance mode for "${node?.name}"? Existing servers keep running; new ones are blocked.`)) {
      try { await api.post(`/nodes/${id}/maintenance`, {}); toast.ok('Maintenance mode updated'); refetch() }
      catch (e: any) { toast.err(e?.message) }
    }
  }
  const rotateToken = async () => {
    if (!window.confirm(`Rotate agent token for "${node?.name}"? The existing token stops working and the agent must be re-provisioned.`)) return
    try {
      const r = await api.post(`/nodes/${id}/rotate-token`, {})
      window.prompt('New agent token (shown once — update the agent config):', r.token)
      toast.ok('Token rotated'); refetch()
    } catch (e: any) { toast.err(e?.message) }
  }
  const revokeToken = async () => {
    if (!window.confirm(`Revoke agent token for "${node?.name}"? This disables the node until re-provisioned.`)) return
    try { await api.post(`/nodes/${id}/revoke-token`, {}); toast.ok('Token revoked'); refetch() }
    catch (e: any) { toast.err(e?.message) }
  }
  const regenerateInstall = async () => {
    if (!window.confirm(`Regenerate the install command for "${node?.name}"? Any previously issued install token is invalidated.`)) return
    try { await api.post(`/nodes/${id}/install`, {}); toast.ok('Install command regenerated'); refetch() }
    catch (e: any) { toast.err(e?.message) }
  }
  const copyInstall = () => {
    if (!node?.installCommand) return
    navigator.clipboard?.writeText(node.installCommand).then(() => toast.ok('Copied'), () => toast.err('Copy failed'))
  }

  if (loading && !node) return <div className="center" style={{ padding: 80 }}><Spinner size={28} /></div>
  if (!node) return <div className="center" style={{ padding: 80, color: 'var(--text-3)' }}>Node not found</div>

  const memPct = node.memoryMb ? Math.min(100, (node.allocatedMemoryMb / node.memoryMb) * 100) : 0
  const diskPct = node.diskGb ? Math.min(100, (node.allocatedDiskGb / node.diskGb) * 100) : 0

  return (
    <div className="page">
      <div className="page-h">
        <a className="text-3 sm" onClick={() => navigate('/nodes')} style={{ cursor: 'pointer' }}>Nodes</a>
        <span className="text-3 sm">/</span>
        <h1>{node.name}</h1>
        <StatePill state={node.status} />
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={refreshNode}><Icon name="restart" size={13} /> Refresh health</button>
        <button className="btn sm danger" onClick={del}><Icon name="trash" size={13} /> Delete</button>
      </div>

      <div className="grid cols-2 mb-4">
        <div className="card">
          <div className="card-h"><Icon name="node" size={15} /> Agent</div>
          <div className="card-b">
            <InfoRow k="Protocol" v={<span className="mono sm">{node.scheme}</span>} />
            <InfoRow k="Host (FQDN / IP)" v={<span className="mono sm">{node.host}</span>} />
            <InfoRow k="Port" v={<span className="mono sm">{node.port}</span>} />
            <InfoRow k="Status" v={node.status === 'online' ? <span className="badge green"><span className="dot" /> Enrolled / online</span> : node.status === 'unconfigured' ? <span className="badge red">Unconfigured</span> : <span className="badge gray">Offline — run the install command</span>} />
            <InfoRow k="Version" v={node.agentVersion ? `v${node.agentVersion}` : '—'} />
            <InfoRow k="Docker" v={node.dockerHealthy ? <span className="badge green"><span className="dot" /> healthy</span> : <span className="badge red">unhealthy</span>} />
            {node.health && <InfoRow k="Containers" v={<span className="mono sm">{node.health.containers}</span>} />}
            {node.health && <InfoRow k="Last reached" v={new Date(node.health.reachedAt).toLocaleTimeString()} />}
          </div>
        </div>
        <div className="card">
          <div className="card-h"><Icon name="chip" size={15} /> Allocation</div>
          <div className="card-b" style={{ display: 'grid', gap: 20 }}>
            <div>
              <div className="flex justify-between sm mb-1"><span className="text-2 bold">Memory</span><span className="mono sm">{node.allocatedMemoryMb} / {node.memoryMb} MB · <span style={{ color: 'var(--text-3)' }}>{node.remainingMemoryMb} free</span></span></div>
              <div className="bar" style={{ height: 10 }}><div style={{ width: `${memPct}%`, background: 'var(--accent)' }} /></div>
            </div>
            <div>
              <div className="flex justify-between sm mb-1"><span className="text-2 bold">Disk</span><span className="mono sm">{node.allocatedDiskGb} / {node.diskGb} GB · <span style={{ color: 'var(--text-3)' }}>{node.remainingDiskGb} free</span></span></div>
              <div className="bar" style={{ height: 10 }}><div style={{ width: `${diskPct}%`, background: 'var(--cyan)' }} /></div>
            </div>
            {node.overcommit && <span className="badge amber xs">Memory overcommit enabled</span>}
          </div>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-h"><Icon name="gear" size={15} /> Status &amp; security</div>
        <div className="card-b">
          <div className="flex gap-3" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`badge ${node.maintenance ? 'amber' : 'green'}`}>{node.maintenance ? 'Under maintenance' : 'Operational'}</span>
            {node.status === 'unconfigured' && <span className="badge red">Token revoked / unconfigured</span>}
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={toggleMaintenance}><Icon name="down" size={13} /> {node.maintenance ? 'Exit maintenance' : 'Enter maintenance'}</button>
            <button className="btn sm" onClick={rotateToken}><Icon name="restart" size={13} /> Rotate token</button>
            <button className="btn sm danger" onClick={revokeToken}><Icon name="logout" size={13} /> Revoke token</button>
          </div>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-h"><Icon name="terminal" size={15} /> Install agent / enroll <span className="h-sub">run on any reachable host</span>
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={copyInstall}><Icon name="download" size={13} /> Copy</button>
          <button className="btn sm" onClick={regenerateInstall}><Icon name="restart" size={13} /> Regenerate</button>
        </div>
        <div className="card-b">
          {node.installCommand ? (
            <pre className="code-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{node.installCommand}</pre>
          ) : (
            <span className="text-3 sm">No install command yet.</span>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="server" size={15} /> Servers on this node <span className="h-sub">({servers.length})</span></div>
        <div style={{ maxHeight: '48vh', overflowY: 'auto' }}>
          {servers.length === 0 ? (
            <div className="empty"><h3 className="sm">No servers on this node</h3></div>
          ) : (
            <table className="dtable">
              <thead><tr><th>Server</th><th>State</th><th>Blueprint</th><th>Memory</th><th></th></tr></thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.id} onClick={() => navigate(`/servers/${s.id}`)}>
                    <td>
                      <div className="cell-main">{s.name}</div>
                      <div className="cell-sub mono xs">{s.id}</div>
                    </td>
                    <td><StatePill state={s.state} pulse /></td>
                    <td>{s.blueprint?.name || '—'}</td>
                    <td className="mono sm">{s.memoryLimitMb} MB</td>
                    <td style={{ textAlign: 'right' }}><Icon name="chevron" size={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoRow({ k, v }: { k: string; v: any }) {
  return <div className="info-row"><span className="k">{k}</span><span>{v}</span></div>
}
