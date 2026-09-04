import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNodes, useLocations } from '../api/hooks'
import { api } from '../api/client'
import { useApp } from '../state/auth'
import { Icon, Modal, Spinner, StatePill, toast } from '../components/ui'
import { Shell } from '../components/Shell'
import type { Node } from '@uptimehost/types'

// Defined at module scope (NOT inside a component): if this were declared
// inside AutoConnectModal/CreateNodeModal, every keystroke would re-run the
// modal and give `Field` a NEW function identity, so React would treat it as a
// brand-new component and remount each field — dropping focus and closing the
// on-screen keyboard after every character.
function Field({ label, children, hint }: any) {
  return (
    <div className="field"><label>{label}</label>{children}{hint ? <span className="xs text-3">{hint}</span> : null}</div>
  )
}

export function Nodes() {
  const { nodes, loading, refetch } = useNodes()
  const { locations } = useLocations()
  const navigate = useNavigate()
  const { refresh } = useApp()
  const [create, setCreate] = useState(false)
  const [auto, setAuto] = useState(false)
  const [installCmd, setInstallCmd] = useState<string | null>(null)

  return (
    <Shell>
      <div className="page">
        <div className="page-h">
          <h1>Nodes</h1>
          <span className="sub">{nodes.filter((n) => n.status === 'online').length}/{nodes.length} online</span>
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setAuto(true)}><Icon name="terminal" size={14} /> Auto Connect</button>
          <button className="btn primary sm" onClick={() => setCreate(true)}><Icon name="plus" size={14} /> Add node</button>
        </div>

        {loading ? (
          <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
        ) : nodes.length === 0 ? (
          <div className="card">
            <div className="empty">
              <Icon name="node" size={24} className="accent" />
              <h3>No nodes</h3>
              <p>Add a node to get a ready-to-run agent install command, then run it on any reachable host to enroll it. Or use Auto&nbsp;Connect to deploy a node over SSH with just an IP and password.</p>
              <div className="mt-3">
                <button className="btn sm" onClick={() => setAuto(true)}><Icon name="terminal" size={14} /> Auto Connect</button>
                <button className="btn primary sm" onClick={() => setCreate(true)}><Icon name="plus" size={14} /> Add node</button>
              </div>
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
        {auto && <AutoConnectModal locations={locations} onClose={() => { setAuto(false); refresh() }} onNode={refresh} />}
        {installCmd && <InstallModal nodeId={nodes.find((n) => n.installCommand === installCmd)?.name || ''} command={installCmd} onClose={() => setInstallCmd(null)} />}
      </div>
    </Shell>
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
  const [portRangeStart, setPortRangeStart] = useState('25565')
  const [portRangeEnd, setPortRangeEnd] = useState('25597')
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
        portRangeStart: Number(portRangeStart),
        portRangeEnd: Number(portRangeEnd),
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
          <label>Connection & protocol</label>
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
        <div className="grid cols-2">
          <div className="field"><label>Port range start</label><input className="input" type="number" value={portRangeStart} onChange={(e) => setPortRangeStart(e.target.value)} placeholder="e.g., 25565" /></div>
          <div className="field"><label>Port range end</label><input className="input" type="number" value={portRangeEnd} onChange={(e) => setPortRangeEnd(e.target.value)} placeholder="e.g., 25597" /></div>
        </div>
        <span className="xs text-3">Servers on this node will automatically receive ports from this range (e.g., 25565-25597).</span>
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
    <Modal open onClose={onClose} title={`Install agent${nodeId ? ` \u2014 ${nodeId}` : ''}`} width={620}>
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

// AutoNodeConnect — deploy a node over SSH with just an IP + password.
// 1) Enter SSH credentials -> probe host resources.
// 2) Review detected resources, pick name/RAM/disk -> install + enroll.
//    The panel uploads the node agent, installs it (systemd) and it registers.
function AutoConnectModal({ locations, onClose, onNode }: { locations: any[]; onClose: () => void; onNode: () => void }) {
  const [step, setStep] = useState<'creds' | 'probe' | 'installing' | 'done'>('creds')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('root')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [info, setInfo] = useState<any>(null)
  const [done, setDone] = useState<any>(null)

  const [name, setName] = useState('')
  const [locationId, setLocationId] = useState(locations[0]?.id || '')
  const [memoryMb, setMemoryMb] = useState('')
  const [diskGb, setDiskGb] = useState('')
  const [overcommit, setOvercommit] = useState(false)

  useEffect(() => { if (locations.length && !locationId) setLocationId(locations[0].id) }, [locations])

  const mbToGb = (mb: number) => Math.max(1, Math.round(mb / 1024))

  const connect = async () => {
    if (!host.trim() || !username.trim() || !password) { setErr('Enter host, username and password'); return }
    setBusy(true); setErr('')
    try {
      const r = await api.post('/nodes/auto/probe', {
        host: host.trim(), port: Number(port || 22), username: username.trim(), password,
      })
      setInfo(r.info)
      // Sensible caps: cap RAM at 85% of total, disk at free disk.
      const ramCap = r.info?.totalRamMb ? Math.floor((r.info.totalRamMb || 0) * 0.85) : 8192
      setMemoryMb(String(ramCap))
      setDiskGb(String(r.info?.freeDiskGb || 100))
      setStep('probe')
    } catch (e: any) { setErr(e?.message || 'Connection failed') }
    finally { setBusy(false) }
  }

  const install = async () => {
    setBusy(true); setErr(''); setStep('installing')
    try {
      const r = await api.post('/nodes/auto/install', {
        host: host.trim(), port: Number(port || 22), username: username.trim(), password,
        name: name || undefined,
        locationId: locationId || undefined,
        memoryMb: Number(memoryMb), diskGb: Number(diskGb), overcommit,
      })
      setDone(r.node)
      setStep('done')
      onNode()
      toast.ok(`Node ${r.node?.name || ''} connected`)
    } catch (e: any) {
      setErr(e?.message || 'Install failed')
      setStep('probe')
    } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title="AutoNodeConnect" width={560}>
      {/* step tracker */}
      <div className="flex items-center gap-2 mb-3" style={{ fontSize: 12 }}>
        {['SSH access', 'Resources', 'Install'].map((s, i) => (
          [<span key={`s${i}`} className={`badge ${(step === 'done' ? 2 : step === 'probe' || step === 'installing' ? 1 : 0) >= i ? 'green' : 'gray'}`}>{i + 1}</span>,
          <span key={`l${i}`} className="text-3 sm">{s}</span>,
          i < 2 ? <span key={`a${i}`} className="text-3">→</span> : null]
        ))}
      </div>

      {step === 'creds' && (
        <div className="grid gap-3">
          <p className="xs text-3 mb-2">
            Enter SSH credentials for a server (VPS/VDS). The panel connects, inspects its resources, and can
            automatically install + connect the node agent for you.
          </p>
          <div className="grid cols-2">
            <Field label="Host / IP"><input className="input mono" placeholder="203.0.113.5 or node.example.com" value={host} onChange={(e) => setHost(e.target.value)} /></Field>
            <Field label="SSH port"><input className="input mono" type="number" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
          </div>
          <div className="grid cols-2">
            <Field label="Username"><input className="input mono" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
            <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </div>
          <span className="xs text-3">The password is used only to provision this node and is never stored.</span>
        </div>
      )}

      {step === 'probe' && info && (
        <div className="grid gap-3">
          <div className="card stat-row" style={{ padding: '10px 12px' }}>
            <div className="grid cols-4">
              <div className="stat"><span className="label">OS</span><span className="value sm">{info.os || '—'}</span></div>
              <div className="stat"><span className="label">CPU</span><span className="value sm">{info.cpuCores} cores</span></div>
              <div className="stat"><span className="label">RAM</span><span className="value sm">{mbToGb(info.totalRamMb || 0)}GB</span></div>
              <div className="stat"><span className="label">Disk</span><span className="value sm">{info.freeDiskGb || 0}GB free</span></div>
            </div>
          </div>
          <div className="mb-2">
            {info.dockerInstalled
              ? <span className="badge green xs"><span className="dot" /> Docker ready</span>
              : <span className="badge amber xs"><span className="dot" /> Docker not found — will be installed</span>}
            {info.systemd ? <span className="badge green xs"><span className="dot" /> systemd</span> : null}
            {info.root ? <span className="badge gray xs">root</span> : <span className="badge amber xs">non-root (needs passwordless sudo)</span>}
          </div>

          <div className="grid cols-2">
            <Field label="Node name"><input className="input" placeholder={host} value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Location">
              <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                {locations.length === 0 && <option value="">—</option>}
              </select>
            </Field>
          </div>
          <div className="grid cols-2">
            <Field label="Memory (MB)" hint={info.totalRamMb ? `Detected ${mbToGb(info.totalRamMb)}GB total, ${mbToGb(info.availRamMb)}GB free` : null}>
              <input className="input mono" type="number" value={memoryMb} onChange={(e) => setMemoryMb(e.target.value)} />
            </Field>
            <Field label="Disk (GB)" hint={`${info.freeDiskGb || 0}GB free on /`}>
              <input className="input mono" type="number" value={diskGb} onChange={(e) => setDiskGb(e.target.value)} />
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={overcommit} onChange={(e) => setOvercommit(e.target.checked)} /> Allow overcommit — schedule more capacity than the host has</label>
        </div>
      )}

      {step === 'installing' && (
        <div className="center" style={{ padding: 40 }}>
          <Spinner size={28} />
          <p className="sm text-3 mt-2">Connecting to {host}, installing node agent…</p>
        </div>
      )}

      {step === 'done' && done && (
        <div className="center" style={{ padding: 32 }}>
          <Icon name="check" size={30} className="accent" />
          <h3 className="mt-2">{done.name} online</h3>
          <p className="sm text-3">{done.scheme}://{done.host}:{done.port} — the agent installed itself and registered with this panel.</p>
        </div>
      )}

      {err && <div className="alert danger mt-2">{err}</div>}

      <div className="actions">
        {step === 'creds' && <button className="btn" onClick={onClose}>Cancel</button>}
        {step === 'probe' && <button className="btn" disabled={busy} onClick={() => setStep('creds')}>Back</button>}
        {step !== 'done' && (
          <button className="btn primary" disabled={busy} onClick={() => (step === 'creds' ? connect() : install())}>
            {busy ? <Spinner size={16} /> : step === 'creds' ? 'Connect' : step === 'probe' ? 'Install & Connect' : '…'}
          </button>
        )}
        {step === 'done' && <button className="btn primary" onClick={onClose}>Done</button>}
      </div>
    </Modal>
  )
}