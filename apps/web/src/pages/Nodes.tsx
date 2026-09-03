import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNodes, useLocations } from '../api/hooks'
import { api } from '../api/client'
import { useApp } from '../state/auth'
import { Icon, Modal, Spinner, StatePill, toast } from '../components/ui'
import type { Node } from '@uptimehost/types'

export function Nodes() {
  const { nodes, loading, refetch } = useNodes()
  const { locations } = useLocations()
  const navigate = useNavigate()
  const { refresh } = useApp()
  const [create, setCreate] = useState(false)
  const [installCmd, setInstallCmd] = useState<string | null>(null)

  return (
    <div className="page">
      <div className="page-h">
        <h1>Nodes</h1>
        <span className="sub">{nodes.filter((n) => n.status === 'online').length}/{nodes.length} online</span>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={() => setCreate(true)}><Icon name="plus" size={14} /> Add node</button>
      </div>

      {loading ? (
        <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
      ) : nodes.length === 0 ? (
        <div className="card">
          <div className="empty">
            <Icon name="node" size={24} className="accent" />
            <h3>No nodes</h3>
            <p>Add a node to get a ready-to-run agent install command, then run it on any reachable host to enroll it.</p>
            <div className="mt-3"><button className="btn primary sm" onClick={() => setCreate(true)}><Icon name="plus" size={14} /> Add node</button></div>
          </div>
        </div>
      ) : (
        <div className="grid cols-2">
          {nodes.map((n) => (
            <NodeCard key={n.id} n={n} onClick={() => navigate(`/nodes/${n.id}`)} onInstall={() => setInstallCmd(n.installCommand)} />
          ))}
        </div>
      )}

      {create && <CreateNodeModal locations={locations} onClose={() => { setCreate(false); refresh() }} onCreated={(cmd) => { setCreate(false); refresh(); setInstallCmd(cmd) }} />}
      {installCmd && <InstallModal nodeId={nodes.find((n) => n.installCommand === installCmd)?.name || ''} command={installCmd} onClose={() => setInstallCmd(null)} />}
    </div>
  )
}

function NodeCard({ n, onClick, onInstall }: { n: Node; onClick: () => void; onInstall: () => void }) {
  const memPct = n.memoryMb ? Math.min(100, (n.allocatedMemoryMb / n.memoryMb) * 100) : 0
  const diskPct = n.diskGb ? Math.min(100, (n.allocatedDiskGb / n.diskGb) * 100) : 0
  return (
    <div className="card anim-in" style={{ cursor: 'pointer' }} onClick={onClick}>
      <div className="card-h">
        <Icon name="node" size={15} className="accent" />
        {n.name}
        <span className="h-sub mono xs">{n.scheme}://{n.host}:{n.port}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost icp sm" onClick={(e) => { e.stopPropagation(); onInstall() }} title="Install command">
          <Icon name="terminal" size={13} />
        </button>
        <StatePill state={n.status} />
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <div className="grid cols-3">
          <div className="stat"><span className="label">Servers</span><span className="value lg">{n.serverCount}</span></div>
          <div className="stat"><span className="label">Memory</span><span className="value lg">{n.allocatedMemoryMb}<span className="unit">/{n.memoryMb}MB</span></span></div>
          <div className="stat"><span className="label">Disk</span><span className="value lg">{n.allocatedDiskGb}<span className="unit">/{n.diskGb}GB</span></span></div>
        </div>
        <div>
          <div className="flex justify-between sm text-3 mb-1"><span>Memory</span><span>{memPct.toFixed(0)}%</span></div>
          <div className="bar"><div style={{ width: `${memPct}%`, background: 'var(--accent)' }} /></div>
        </div>
        <div>
          <div className="flex justify-between sm text-3 mb-1"><span>Disk</span><span>{diskPct.toFixed(0)}%</span></div>
          <div className="bar"><div style={{ width: `${diskPct}%`, background: 'var(--cyan)' }} /></div>
        </div>
        {n.status === 'online' && (
          <div className="flex items-center gap-2">
            <span className={`badge ${n.dockerHealthy ? 'green' : 'red'}`}><span className="dot" /> Docker {n.dockerHealthy ? 'healthy' : 'unhealthy'}</span>
            {n.agentVersion && <span className="badge gray mono xs">v{n.agentVersion}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function CreateNodeModal({ locations, onClose, onCreated }: { locations: any[]; onClose: () => void; onCreated: (installCommand: string) => void }) {
  const [name, setName] = useState('')
  const [locationId, setLocationId] = useState(locations[0]?.id || '')
  const [scheme, setScheme] = useState<'http' | 'https'>('http')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('7373')
  const [agentToken, setAgentToken] = useState('')
  const [memoryMb, setMemoryMb] = useState('8192')
  const [diskGb, setDiskGb] = useState('100')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (locations.length && !locationId) setLocationId(locations[0].id) }, [locations])

  const add = async () => {
    setBusy(true)
    try {
      const r = await api.post('/nodes', {
        name: name || undefined,
        locationId: locationId || undefined,
        scheme,
        host: host || undefined,
        port: Number(port || 7373),
        agentToken: agentToken || undefined,
        memoryMb: Number(memoryMb),
        diskGb: Number(diskGb),
      })
      toast.ok('Node added')
      onCreated(r.node?.installCommand || '')
    } catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title="Add node" width={540}>
      <div className="grid gap-3">
        <div className="flex gap-2">
          <div className="field flex-1"><label>Name</label><input className="input" placeholder="Frankfurt-1" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field" style={{ minWidth: 180 }}><label>Location</label>
            <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {locations.length === 0 && <span className="xs text-3">Create a location first</span>}
          </div>
        </div>
        <div className="field">
          <label>Connection &amp; protocol</label>
          <div className="flex gap-2" style={{ alignItems: 'center' }}>
            <select className="select" style={{ width: 110 }} value={scheme} onChange={(e) => setScheme(e.target.value as 'http' | 'https')}>
              <option value="http">http://</option>
              <option value="https">https://</option>
            </select>
            <input className="input flex-1 mono" placeholder="node.example.com or 203.0.113.5" value={host} onChange={(e) => setHost(e.target.value)} />
            <span className="text-3">:</span>
            <input className="input mono" style={{ width: 90 }} value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <span className="xs text-3">How the panel will reach this agent (choose https if the agent is behind TLS).</span>
        </div>
        <div className="field"><label>Agent shared token</label><input className="input mono" placeholder="Shared secret the agent will accept" value={agentToken} onChange={(e) => setAgentToken(e.target.value)} /></div>
        <div className="grid cols-2">
          <div className="field"><label>Memory (MB)</label><input className="input" value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} /></div>
          <div className="field"><label>Disk (GB)</label><input className="input" value={diskGb} onChange={(e) => setDiskGb(e.target.value)} /></div>
        </div>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={add} disabled={busy}>{busy ? <Spinner size={16} /> : 'Add node'}</button>
      </div>
    </Modal>
  )
}

function InstallModal({ nodeId, command, onClose }: { nodeId: string; command: string; onClose: () => void }) {
  const copy = () => {
    navigator.clipboard?.writeText(command).then(() => toast.ok('Copied'), () => toast.err('Copy failed'))
  }
  return (
    <Modal open onClose={onClose} title={`Install agent${nodeId ? ` — ${nodeId}` : ''}`} width={620}>
      <p className="sm text-3 mb-2">
        Paste this on the machine where the agent should run. It enrolls the node into the panel by advertising its
        connection endpoint, then keeps reporting liveness. The agent can be installed on any host that can reach the panel.
      </p>
      <pre className="code-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{command}</pre>
      <div className="actions">
        <button className="btn" onClick={() => copy()}><Icon name="download" size={13} /> Copy</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  )
}
