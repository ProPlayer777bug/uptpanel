import { useMemo, useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { usePoll } from '../api/hooks'
import { api } from '../api/client'
import { useApp } from '../state/auth'
import { Icon, Spinner, Modal, toast } from '../components/ui'
import type { Node, Server } from '@uptimehost/types'

type Section =
  | 'overview' | 'general' | 'resources' | 'allocations' | 'storage' | 'docker'
  | 'images' | 'defaults' | 'backups' | 'sftp' | 'agent' | 'health'
  | 'logs' | 'activity' | 'security' | 'maintenance' | 'danger'

const SECTIONS: { id: Section; label: string; icon: any }[] = [
  { id: 'overview', label: 'Overview', icon: 'node' },
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'resources', label: 'Resources', icon: 'chip' },
  { id: 'allocations', label: 'Allocations', icon: 'globe' },
  { id: 'storage', label: 'Storage', icon: 'folder' },
  { id: 'docker', label: 'Docker', icon: 'box' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'defaults', label: 'Server Defaults', icon: 'layers' },
  { id: 'backups', label: 'Backups', icon: 'download' },
  { id: 'sftp', label: 'SFTP / Files', icon: 'lock' },
  { id: 'agent', label: 'Agent', icon: 'terminal' },
  { id: 'health', label: 'Health', icon: 'activity' },
  { id: 'logs', label: 'Logs', icon: 'list' },
  { id: 'activity', label: 'Activity', icon: 'clock' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'maintenance', label: 'Maintenance', icon: 'down' },
  { id: 'danger', label: 'Danger Zone', icon: 'trash' },
]

function NodeStatusBadge({ node }: { node: Node }) {
  const online = node.status === 'online'
  return (
    <span className={`badge ${online ? 'green' : node.maintenance ? 'amber' : node.status === 'unconfigured' ? 'red' : 'gray'}`}>
      <span className="dot" /> {online ? 'ONLINE' : node.maintenance ? 'MAINTENANCE' : node.status === 'unconfigured' ? 'UNCONFIGURED' : 'OFFLINE'}
    </span>
  )
}

export function NodeDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { refresh } = useApp()
  const [section, setSection] = useState<Section>('overview')
  const { data, loading, refetch } = usePoll<{ node: Node; servers: Server[] }>(
    async () => api.get(`/nodes/${id}`), [id], 6000,
  )
  const node = data?.node
  const servers = data?.servers || []

  useEffect(() => { setSection('overview') }, [id])

  if (loading && !node) return <div className="center" style={{ padding: 80 }}><Spinner size={28} /></div>
  if (!node) return <div className="center" style={{ padding: 80, color: 'var(--text-3)' }}>Node not found</div>

  return (
    <div className="page">
      <div className="page-h">
        <a className="text-3 sm" onClick={() => navigate('/nodes')} style={{ cursor: 'pointer' }}>Nodes</a>
        <span className="text-3 sm">/</span>
        <h1>{node.name}</h1>
        <NodeStatusBadge node={node} />
        <span className="mono xs text-3">{node.id}</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={async () => { await api.post(`/nodes/${id}/refresh`, {}); toast.ok('Node health refreshed'); refetch() }}>
          <Icon name="restart" size={13} /> Refresh
        </button>
      </div>

      <div className="node-layout">
        <nav className="node-nav card">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`node-nav-item ${section === s.id ? 'active' : ''}`} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} size={14} /><span>{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="node-body">
          {section === 'overview' && <Overview node={node} servers={servers} onSection={setSection} />}
          {section === 'general' && <General node={node} onSaved={refetch} />}
          {section === 'resources' && <Resources node={node} onSaved={refetch} />}
          {section === 'allocations' && <Allocations node={node} />}
          {section === 'storage' && <Storage node={node} onSaved={refetch} />}
          {section === 'docker' && <Docker node={node} onSaved={refetch} />}
          {section === 'images' && <Images node={node} onSaved={refetch} />}
          {section === 'defaults' && <Defaults node={node} onSaved={refetch} />}
          {section === 'backups' && <Backups node={node} onSaved={refetch} />}
          {section === 'sftp' && <SFTP node={node} onSaved={refetch} />}
          {section === 'agent' && <Agent node={node} onSaved={refetch} />}
          {section === 'health' && <Health node={node} />}
          {section === 'logs' && <Logs node={node} />}
          {section === 'activity' && <Activity node={node} />}
          {section === 'security' && <Security node={node} onSaved={refetch} />}
          {section === 'maintenance' && <Maintenance node={node} onSaved={refetch} />}
          {section === 'danger' && <Danger node={node} onDeleted={() => { refresh(); navigate('/nodes') }} />}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- utilities */
function fmtBytes(n?: number) {
  if (!n) return '—'
  const g = n / 1073741824
  if (g >= 1) return `${g.toFixed(1)} GB`
  const m = n / 1048576
  if (m >= 1) return `${m.toFixed(0)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}
function fmtUptime(sec: number) {
  if (!sec) return '—'
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
function pct(v?: number) { return Math.min(100, Math.max(0, v || 0)) }
function InfoRow({ k, v }: { k: string; v: any }) {
  return <div className="info-row"><span className="k">{k}</span><span>{v}</span></div>
}
function SaveBox({ onSave, saving, dirty, children }: any) {
  return (
    <div className="card-b">
      {children}
      <div style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={onSave} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>
    </div>
  )
}
function useForm<T extends object>(init: T) {
  const [form, setForm] = useState<T>(init)
  const [dirty, setDirty] = useState(false)
  const set = (k: keyof T, v: any) => { setForm((p) => ({ ...p, [k]: v })); setDirty(true) }
  return { form, set, dirty, reset: (i: T) => { setForm(i); setDirty(false) } }
}
function Field({ label, children, hint }: any) {
  return <div className="field" style={{ flex: 1 }}><label>{label}</label>{children}{hint && <span className="xs text-3">{hint}</span>}</div>
}

/* ------------------------------------------------------------------ 1. Overview */
function Overview({ node, servers, onSection }: { node: Node; servers: Server[]; onSection: (s: Section) => void }) {
  const navigate = useNavigate()
  const hs = node.hostStats
  const memPct = pct(hs?.memoryPercent)
  const diskPct = pct(hs?.diskPercent)
  const cpuPct = pct(hs?.cpuPercent)
  const loc = node.locationId
  return (
    <div className="grid gap-3">
      <div className="card">
        <div className="card-h"><Icon name="node" size={15} /> Node overview</div>
        <div className="card-b">
          <div className="info-row"><span className="k">Name</span><b>{node.name}</b></div>
          <div className="info-row"><span className="k">Node ID</span><span className="mono sm">{node.id}</span></div>
          <div className="info-row"><span className="k">Status</span><NodeStatusBadge node={node} /></div>
          <div className="info-row"><span className="k">Hostname (FQDN)</span><span className="mono sm">{node.host || '—'}</span></div>
          <div className="info-row"><span className="k">Location</span>{loc || '—'}</div>
          <div className="info-row"><span className="k">Agent version</span>{node.agentVersion ? `v${node.agentVersion}` : '—'}</div>
          <div className="info-row"><span className="k">OS</span><span className="mono sm">{hs?.os || '—'}</span></div>
          <div className="info-row"><span className="k">Kernel</span><span className="mono sm">{hs?.kernel || '—'}</span></div>
          <div className="info-row"><span className="k">Uptime</span><span className="mono sm">{fmtUptime(hs?.uptimeSec || 0)}</span></div>
          <div className="info-row"><span className="k">CPU cores</span><span className="mono sm">{hs?.cpuCores || '—'}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="activity" size={15} /> Live resource usage</div>
        <div className="card-b" style={{ display: 'grid', gap: 16 }}>
          <Gauge label="CPU" pct={cpuPct} text={`${hs?.cpuPercent?.toFixed?.(1) ?? '—'}%`} color="var(--cyan)" />
          <Gauge label="Memory used" pct={memPct} text={`${fmtBytes(hs?.memoryUsed)} / ${fmtBytes(hs?.memoryBytes)}`} color="var(--accent)" />
          <Gauge label="Disk used" pct={diskPct} text={`${fmtBytes(hs?.diskUsed)} / ${fmtBytes(hs?.diskBytes)}`} color="var(--good)" />
          <div className="grid cols-3">
            <div className="card stat-card"><div className="label">Load (1/5/15)</div><div className="value sm mono">{hs ? `${hs.load1?.toFixed?.(1) ?? 0} / ${hs.load5?.toFixed?.(1) ?? 0} / ${hs.load15?.toFixed?.(1) ?? 0}` : '—'}</div></div>
            <div className="card stat-card"><div className="label">Network RX</div><div className="value sm mono">{fmtBytes(hs?.netRxBytes)}</div></div>
            <div className="card stat-card"><div className="label">Network TX</div><div className="value sm mono">{fmtBytes(hs?.netTxBytes)}</div></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="server" size={15} /> Servers on this node <span className="h-sub">({servers.length})</span></div>
        <div style={{ padding: 16 }}>
          {servers.length === 0
            ? <div className="empty"><h3 className="sm text-3">No servers yet — configure resources &amp; allocations, then create a server.</h3></div>
            : servers.map((s) => (
                <div key={s.id} className="row-item" onClick={() => navigate(`/servers/${s.id}`)}>
                  <Icon name="server" size={16} /><div className="flex-1"><div className="cell-main">{s.name}</div><div className="cell-sub mono xs">{s.id}</div></div>
                  <span className={`badge ${s.state === 'running' ? 'green' : 'gray'}`}><span className="dot" /> {s.state}</span>
                </div>
              ))}
        </div>
        <div className="card-b thin flex gap-2" style={{ alignItems: 'center' }}>
          {node.maintenance && <span className="badge amber">Under maintenance</span>}
          <div style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => onSection('allocations')}><Icon name="globe" size={13} /> Allocations</button>
          <button className="btn sm" onClick={() => onSection('resources')}><Icon name="chip" size={13} /> Resources</button>
        </div>
      </div>
    </div>
  )
}

function Gauge({ label, pct, text, color }: { label: string; pct: number; text: string; color: string }) {
  return (
    <div>
      <div className="flex justify-between sm mb-1"><span className="text-2 bold">{label}</span><span className="mono sm">{text}</span></div>
      <div className="bar" style={{ height: 9 }}><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}

/* ------------------------------------------------------------------ 2. General */
function General({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const { form, set, reset, dirty } = useForm({
    name: node.name, description: node.description || '', locationId: node.locationId || '',
    fqdn: node.host || '', port: node.port, timezone: node.timezone || '',
  })
  const [saving, setSaving] = useState(false)
  const { data: locs } = usePoll<any>(async () => api.get('/locations'), [], 60000)
  useEffect(() => { reset({ name: node.name, description: node.description || '', locationId: node.locationId || '', fqdn: node.host || '', port: node.port, timezone: node.timezone || '' }) }, [node.id])
  useEffect(() => { if (!form.fqdn && node.host) set('fqdn', node.host) }, [])
  const save = async () => {
    setSaving(true)
    try { const r = await api.patch(`/nodes/${node.id}`, form); toast.ok('Node settings saved'); onSaved() }
    catch (e: any) { toast.err(e?.message) } finally { setSaving(false) }
  }
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="gear" size={15} /> General settings</div>
      <SaveBox onSave={save} saving={saving} dirty={dirty}>
        <div className="grid cols-2 gap-3">
          <Field label="Node name"><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Location">
            <select className="select" value={form.locationId} onChange={(e) => set('locationId', e.target.value)}>
              <option value="">— no location —</option>
              {(locs?.locations || []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Description"><input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Primary production node" /></Field>
          <Field label="FQDN / Hostname" hint="Public hostname pointing to this VPS (used as the public address for allocations)."><input className="input mono" value={form.fqdn} onChange={(e) => set('fqdn', e.target.value)} /></Field>
          <Field label="Agent port"><input className="input mono" type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} /></Field>
          <Field label="Timezone"><input className="input" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} placeholder="Asia/Kolkata" /></Field>
        </div>
      </SaveBox>
    </div>
  )
}

/* ------------------------------------------------------------------ 3. Resources */
function Resources({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const sl = node.serverLimits || {}
  const { form, set, reset, dirty } = useForm({
    memoryMb: node.memoryMb, diskGb: node.diskGb, swapMb: node.swapMb || 0, overcommit: !!node.overcommit,
    allocationStrategy: node.allocationStrategy || 'most_available',
    overcommitCpu: node.overcommitCpu || 200, overcommitMemory: node.overcommitMemory || 100, overcommitDisk: node.overcommitDisk || 120,
    maxServers: sl.maxServers || 0, maxCpuPercent: sl.maxCpuPercent || 0, maxRamMb: sl.maxRamMb || 0, maxDiskGb: sl.maxDiskGb || 0, maxBackups: sl.maxBackups || 0, maxDatabases: sl.maxDatabases || 0,
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ memoryMb: node.memoryMb, diskGb: node.diskGb, swapMb: node.swapMb || 0, overcommit: !!node.overcommit, allocationStrategy: node.allocationStrategy || 'most_available', overcommitCpu: node.overcommitCpu || 200, overcommitMemory: node.overcommitMemory || 100, overcommitDisk: node.overcommitDisk || 120, maxServers: sl.maxServers || 0, maxCpuPercent: sl.maxCpuPercent || 0, maxRamMb: sl.maxRamMb || 0, maxDiskGb: sl.maxDiskGb || 0, maxBackups: sl.maxBackups || 0, maxDatabases: sl.maxDatabases || 0 }) }, [node.id])
  const save = async () => {
    setSaving(true)
    try { await api.patch(`/nodes/${node.id}`, form); toast.ok('Resources updated'); onSaved() }
    catch (e: any) { toast.err(e?.message) } finally { setSaving(false) }
  }
  const allocPct = node.memoryMb ? Math.min(100, (node.allocatedMemoryMb / node.memoryMb) * 100) : 0
  const overWarn = form.overcommitMemory > 100
  return (
    <div className="grid gap-3 anim-in">
      <div className="card">
        <div className="card-h"><Icon name="chip" size={15} /> Physical resources</div>
        <div className="card-b" style={{ display: 'grid', gap: 14 }}>
          <div>
            <div className="flex justify-between sm mb-1"><span className="text-2 bold">Memory</span><span className="mono sm">{node.allocatedMemoryMb} allocated / {node.memoryMb} MB · {node.remainingMemoryMb} free</span></div>
            <div className="bar" style={{ height: 10 }}><div style={{ width: `${allocPct}%`, background: 'var(--accent)' }} /></div>
          </div>
          <div>
            <div className="flex justify-between sm mb-1"><span className="text-2 bold">Disk</span><span className="mono sm">{node.allocatedDiskGb} allocated / {node.diskGb} GB · {node.remainingDiskGb} free</span></div>
            <div className="bar" style={{ height: 10 }}><div style={{ width: `${pct(node.diskGb ? (node.allocatedDiskGb / node.diskGb) * 100 : 0)}%`, background: 'var(--cyan)' }} /></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="layers" size={15} /> Reservable resources</div>
        <SaveBox onSave={save} saving={saving} dirty={dirty}>
          <div className="grid cols-3 gap-3">
            <Field label="Physical memory (MB)"><input className="input mono" type="number" value={form.memoryMb} onChange={(e) => set('memoryMb', Number(e.target.value))} /></Field>
            <Field label="Physical disk (GB)"><input className="input mono" type="number" value={form.diskGb} onChange={(e) => set('diskGb', Number(e.target.value))} /></Field>
            <Field label="Swap (MB)" hint="Not allocated to customer servers."><input className="input mono" type="number" value={form.swapMb} onChange={(e) => set('swapMb', Number(e.target.value))} /></Field>
          </div>
          <div className="mt-3 grid cols-3 gap-3">
            <Field label="CPU overcommit %"><input className="input mono" type="number" value={form.overcommitCpu} onChange={(e) => set('overcommitCpu', Number(e.target.value))} /></Field>
            <Field label="Memory overcommit %" hint={<span style={{ color: overWarn ? 'var(--danger)' : undefined }}>{overWarn ? 'Warning: exceeds physical capacity' : 'matching physical capacity'}</span>}><input className="input mono" type="number" value={form.overcommitMemory} onChange={(e) => set('overcommitMemory', Number(e.target.value))} /></Field>
            <Field label="Disk overcommit %"><input className="input mono" type="number" value={form.overcommitDisk} onChange={(e) => set('overcommitDisk', Number(e.target.value))} /></Field>
          </div>
          <label className="check mt-3"><input type="checkbox" checked={form.overcommit} onChange={(e) => set('overcommit', e.target.checked)} /> Allow memory overcommit on this node</label>
        </SaveBox>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="globe" size={15} /> Allocation strategy</div>
        <SaveBox onSave={save} saving={saving} dirty={dirty}>
          <div className="grid gap-2">
            {[
              ['least_used', 'Least Used', 'Find the node with the most free resources.'],
              ['most_available', 'Most Available', 'Prefer the node with the greatest available capacity.'],
              ['round_robin', 'Round Robin', 'Distribute new servers across nodes in turn.'],
              ['manual', 'Manual', 'The administrator picks the node explicitly.'],
            ].map(([v, label, desc]) => (
              <label key={v} className={`check ${form.allocationStrategy === v ? 'accent' : ''}`} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>
                <input type="radio" name="strategy" checked={form.allocationStrategy === v} onChange={() => set('allocationStrategy', v)} />
                <div><div className="sm bold">{label}</div><div className="xs text-3">{desc}</div></div>
              </label>
            ))}
          </div>
        </SaveBox>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="server" size={15} /> Server limits <span className="h-sub">per server, independent of physical resources</span></div>
        <SaveBox onSave={save} saving={saving} dirty={dirty}>
          <div className="grid cols-3 gap-3">
            <Field label="Max servers" hint="0 = unlimited"><input className="input mono" type="number" value={form.maxServers} onChange={(e) => set('maxServers', Number(e.target.value))} /></Field>
            <Field label="Max CPU / server (%)"><input className="input mono" type="number" value={form.maxCpuPercent} onChange={(e) => set('maxCpuPercent', Number(e.target.value))} /></Field>
            <Field label="Max RAM / server (MB)"><input className="input mono" type="number" value={form.maxRamMb} onChange={(e) => set('maxRamMb', Number(e.target.value))} /></Field>
            <Field label="Max disk / server (GB)"><input className="input mono" type="number" value={form.maxDiskGb} onChange={(e) => set('maxDiskGb', Number(e.target.value))} /></Field>
            <Field label="Max backups / server"><input className="input mono" type="number" value={form.maxBackups} onChange={(e) => set('maxBackups', Number(e.target.value))} /></Field>
            <Field label="Max databases / server"><input className="input mono" type="number" value={form.maxDatabases} onChange={(e) => set('maxDatabases', Number(e.target.value))} /></Field>
          </div>
        </SaveBox>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 4. Allocations (Ally) */
function Allocations({ node }: { node: Node }) {
  const { data, loading, refetch } = usePoll<any>(async () => api.get(`/nodes/${node.id}/allocations`), [node.id], 8000)
  const [showAdd, setShowAdd] = useState(false)
  const allocs = data?.allocations || []
  const primaryId = data?.primaryId
  const usedPorts = node.portRangeStart && node.portRangeEnd
    ? (node.portRangeEnd - node.portRangeStart + 1) - allocs.length
    : 0
  const fqdn = node.host || node.agentUrl?.replace(/^https?:\/\//, '').split(':')[0] || '—'

  const delAlloc = async (a: any) => {
    if (!window.confirm(`Delete allocation ${a.ip}:${a.port}?`)) return
    try { await api.del(`/nodes/${node.id}/allocations/${a.id}`); toast.ok('Allocation deleted'); refetch() }
    catch (e: any) { toast.err(e?.message || 'Allocation is in use') }
  }
  const setPrimary = async (a: any) => {
    try { await api.post(`/nodes/${node.id}/allocations/${a.id}/primary`, {}); toast.ok('Primary set'); refetch() }
    catch (e: any) { toast.err(e?.message) }
  }

  return (
    <div className="grid gap-3 anim-in">
      <div className="card">
        <div className="card-h"><Icon name="globe" size={15} /> Network allocations <span className="h-sub">bind on 0.0.0.0, exposed as {fqdn}:port</span>
          <div style={{ flex: 1 }} />
          <button className="btn sm primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={13} /> Add allocation</button>
        </div>
        <div className="card-b">
          <p className="xs text-3 mb-3">
            Servers bind to the <b className="mono">0.0.0.0</b> interface on the host. The node FQDN ({fqdn}) points to the VPS public IP, so players connect to{' '}
            <b className="mono">{fqdn}:port</b> which routes to <b className="mono">0.0.0.0:port</b> on the container.
          </p>
          <div className="grid cols-3 mb-3">
            <div className="card stat-card"><div className="label">Total</div><div className="value">{allocs.length}</div></div>
            <div className="card stat-card"><div className="label">Used</div><div className="value">{usedPorts}</div></div>
            <div className="card stat-card"><div className="label">Available</div><div className="value">{allocs.length}</div></div>
          </div>

          {loading && !allocs.length ? <Spinner size={20} /> : allocs.length === 0 ? (
            <div className="empty"><h3 className="sm text-3">No allocations yet. Add a port (or a port range) for this node.</h3></div>
          ) : (
            <table className="dtable">
              <thead><tr><th>Bind IP</th><th>Port</th><th>Public address ({fqdn})</th><th>Primary</th><th></th></tr></thead>
              <tbody>
                {allocs.map((a: any) => (
                  <tr key={a.id}>
                    <td className="mono sm">{a.ip}</td>
                    <td className="mono sm">{a.port}</td>
                    <td className="mono sm">{fqdn}:{a.port} <span className="xs text-3">→ 0.0.0.0:{a.port}</span></td>
                    <td>{a.primary || a.id === primaryId ? <span className="badge green"><span className="dot" /> primary</span> : <button className="btn sm subtle" onClick={() => setPrimary(a)}>Set primary</button>}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn sm danger icon" onClick={() => delAlloc(a)} title="Delete"><Icon name="trash" size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <AddAllocationModal open={showAdd} onClose={() => setShowAdd(false)} node={node} fqdn={fqdn} onDone={refetch} />
    </div>
  )
}

function AddAllocationModal({ open, onClose, node, fqdn, onDone }: any) {
  const [ip, setIp] = useState('0.0.0.0')
  const [port, setPort] = useState(25565)
  const [bulk, setBulk] = useState(false)
  const [start, setStart] = useState(25565)
  const [end, setEnd] = useState(25566)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setIp('0.0.0.0'); setPort(25565); setBulk(false); setStart(25565); setEnd(25566) } }, [open])
  const create = async () => {
    setBusy(true)
    const body = bulk ? { ip, startPort: start, endPort: end, total: end - start + 1 } : { ip, port }
    try { await api.post(`/nodes/${node.id}/allocations`, body); toast.ok(bulk ? `Created ${end - start + 1} allocations` : 'Allocation created'); onDone(); onClose() }
    catch (e: any) { toast.err(e?.message) } finally { setBusy(false) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add allocation" width={460}>
      <div className="field mb-2"><label>Bind IP</label><input className="input mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="0.0.0.0" /></div>
      <label className="check mb-2"><input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} /> Bulk create a port range</label>
      {bulk ? (
        <div className="grid cols-2 gap-2">
          <div className="field"><label>Start port</label><input className="input mono" type="number" value={start} onChange={(e) => setStart(Number(e.target.value))} /></div>
          <div className="field"><label>End port</label><input className="input mono" type="number" value={end} onChange={(e) => setEnd(Number(e.target.value))} /></div>
        </div>
      ) : (
        <div className="field"><label>Port</label><input className="input mono" type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} /></div>
      )}
      <p className="xs text-3 mt-3">Public address: <b className="mono">{fqdn}:{bulk ? `${start}-${end}` : port}</b> → <b className="mono">{ip}:{bulk ? `${start}-${end}` : port}</b></p>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : bulk ? `Create ${end - start + 1} allocations` : 'Create allocation'}</button>
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ 5. Storage */
function Storage({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const { form, set, reset, dirty } = useForm({
    dataDir: c.dataDir || '/var/lib/my-panel/servers',
    backupDir: c.backupDir || '/backup',
    tempDir: c.tempDir || '/tmp',
    logsDir: c.logsDir || '/var/log/my-panel',
  })
  const [saving, setSaving] = useState(false)
  const hs = node.hostStats
  useEffect(() => { reset({ dataDir: c.dataDir || '/var/lib/my-panel/servers', backupDir: c.backupDir || '/backup', tempDir: c.tempDir || '/tmp', logsDir: c.logsDir || '/var/log/my-panel' }) }, [node.id])
  const save = async () => { setSaving(true); try { await api.patch(`/nodes/${node.id}`, form); toast.ok('Storage settings saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="folder" size={15} /> Server storage</div>
      <div className="card-b mb-3 grid cols-3 gap-3">
        <div className="card stat-card"><div className="label">Disk total</div><div className="value sm mono">{fmtBytes(hs?.diskBytes)}</div></div>
        <div className="card stat-card"><div className="label">Disk used</div><div className="value sm mono">{fmtBytes(hs?.diskUsed)}</div></div>
        <div className="card stat-card"><div className="label">Disk available</div><div className="value sm mono">{hs ? fmtBytes(hs.diskBytes - hs.diskUsed) : '—'}</div></div>
      </div>
      <SaveBox onSave={save} saving={saving} dirty={dirty}>
        <div className="grid cols-2 gap-3">
          <Field label="Server data directory"><input className="input mono" value={form.dataDir} onChange={(e) => set('dataDir', e.target.value)} /></Field>
          <Field label="Backup directory"><input className="input mono" value={form.backupDir} onChange={(e) => set('backupDir', e.target.value)} /></Field>
          <Field label="Temporary directory"><input className="input mono" value={form.tempDir} onChange={(e) => set('tempDir', e.target.value)} /></Field>
          <Field label="Logs directory"><input className="input mono" value={form.logsDir} onChange={(e) => set('logsDir', e.target.value)} /></Field>
        </div>
      </SaveBox>
    </div>
  )
}

/* ------------------------------------------------------------------ 6. Docker */
function Docker({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const { form, set, reset, dirty } = useForm({
    dockerStatus: node.dockerStatus !== false, networkName: c.networkName || 'bridge',
    storageDriver: node.storageDriver || 'overlay2', dataDir: c.dataDir || '/var/lib/my-panel/servers',
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ dockerStatus: node.dockerStatus !== false, networkName: c.networkName || 'bridge', storageDriver: node.storageDriver || 'overlay2', dataDir: c.dataDir || '/var/lib/my-panel/servers' }) }, [node.id])
  const save = async () => { setSaving(true); try { await api.patch(`/nodes/${node.id}`, form); toast.ok('Docker settings saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="box" size={15} /> Container runtime</div>
      <div className="card-b mb-3">
        <InfoRow k="Runtime" v="Docker" />
        <InfoRow k="Docker status" v={node.dockerHealthy ? <span className="badge green"><span className="dot" /> Running</span> : <span className="badge red"><span className="dot" /> Unavailable</span>} />
        <InfoRow k="Docker version" v={node.agentVersion ? `v${node.agentVersion}` : '—'} />
      </div>
      <SaveBox onSave={save} saving={saving} dirty={dirty}>
        <div className="grid cols-2 gap-3">
          <Field label="Default network"><input className="input mono" value={form.networkName} onChange={(e) => set('networkName', e.target.value)} /></Field>
          <Field label="Storage driver"><input className="input mono" value={form.storageDriver} onChange={(e) => set('storageDriver', e.target.value)} /></Field>
          <Field label="Server data directory"><input className="input mono" value={form.dataDir} onChange={(e) => set('dataDir', e.target.value)} /></Field>
          <Field label="Docker enabled"><label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={form.dockerStatus} onChange={(e) => set('dockerStatus', e.target.checked)} /> Container creation enabled</label></Field>
        </div>
        <p className="xs text-3 mt-3">Dangerous host-level Docker configuration is not exposed here to ordinary users.</p>
      </SaveBox>
    </div>
  )
}

/* ------------------------------------------------------------------ 7. Images */
function Images({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const images = c.images || []
  const [img, setImg] = useState('')
  const [busy, setBusy] = useState(false)
  const saveImages = async (next: string[]) => { await api.patch(`/nodes/${node.id}`, { images: next }); onSaved() }
  const add = async () => { if (!img.trim()) return; setBusy(true); try { await saveImages([...images, img.trim()]); toast.ok('Image added'); setImg('') } catch (e: any) { toast.err(e?.message) } finally { setBusy(false) } }
  const remove = async (name: string) => { if (!window.confirm(`Remove image ${name} from this node?`)) return; setBusy(true); try { await saveImages(images.filter((i: string) => i !== name)); toast.ok('Image removed') } catch (e: any) { toast.err(e?.message) } finally { setBusy(false) } }
  const orphan = [{ tag: 'java:21', size: '—' }, { tag: 'node:22', size: '—' }, { tag: 'python:3.13', size: '—' }, { tag: 'ubuntu:24.04', size: '—' }, { tag: 'alpine:3.20', size: '—' }, { tag: 'itzg/minecraft-server:latest', size: '—' }]
  return (
    <div className="grid gap-3 anim-in">
      <div className="card">
        <div className="card-h"><Icon name="image" size={15} /> Available container images <span className="h-sub">administrator-controlled</span>
          <div style={{ flex: 1 }} /></div>
        <div className="card-b">
          <div className="flex gap-2 mb-3">
            <input className="input mono" style={{ flex: 1 }} placeholder="e.g. itzg/minecraft-server:latest" value={img} onChange={(e) => setImg(e.target.value)} />
            <button className="btn primary" onClick={add} disabled={busy || !img.trim()}><Icon name="plus" size={14} /> Add image</button>
          </div>
          <table className="dtable">
            <thead><tr><th>Image</th><th>Tag</th><th>Status</th><th>Size</th><th></th></tr></thead>
            <tbody>
              {images.length === 0 && (orphan.map((o, i) => (
                <tr key={i}><td className="mono sm">{o.tag.split(':')[0]}</td><td className="mono sm">{o.tag.split(':')[1]}</td><td><span className="badge green"><span className="dot" /> available</span></td><td className="mono sm">{o.size}</td><td /></tr>
              )))}
              {images.map((name: string) => {
                const [repo, tag] = name.split(':')
                return (
                  <tr key={name}><td className="mono sm">{repo}</td><td className="mono sm">{tag}</td><td><span className="badge green"><span className="dot" /> available</span></td><td className="mono sm">—</td><td style={{ textAlign: 'right' }}><button className="btn sm danger icon" onClick={() => remove(name)} title="Remove"><Icon name="trash" size={13} /></button></td></tr>
                )
              })}
            </tbody>
          </table>
          <p className="xs text-3 mt-3">Only images added here are selectable when creating servers. Arbitrary privileged image pulls are not permitted.</p>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 8. Defaults */
function Defaults({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const { form, set, reset, dirty } = useForm({
    defaultImage: c.defaultImage || 'itzg/minecraft-server:latest', defaultStartup: c.defaultStartup || 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar',
    defaultDirectory: c.defaultDirectory || '/home/container', defaultStopTimeout: c.defaultStopTimeout || 10, defaultRestartPolicy: c.defaultRestartPolicy || 'unless-stopped',
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ defaultImage: c.defaultImage || 'itzg/minecraft-server:latest', defaultStartup: c.defaultStartup || 'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar server.jar', defaultDirectory: c.defaultDirectory || '/home/container', defaultStopTimeout: c.defaultStopTimeout || 10, defaultRestartPolicy: c.defaultRestartPolicy || 'unless-stopped' }) }, [node.id])
  const save = async () => { setSaving(true); try { await api.patch(`/nodes/${node.id}`, form); toast.ok('Defaults saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="layers" size={15} /> Server creation defaults <span className="h-sub">applied to new servers, not hard limits</span></div>
      <SaveBox onSave={save} saving={saving} dirty={dirty}>
        <div className="grid cols-2 gap-3">
          <Field label="Default image"><input className="input mono" value={form.defaultImage} onChange={(e) => set('defaultImage', e.target.value)} /></Field>
          <Field label="Default server directory"><input className="input mono" value={form.defaultDirectory} onChange={(e) => set('defaultDirectory', e.target.value)} /></Field>
          <Field label="Default stop timeout (s)"><input className="input mono" type="number" value={form.defaultStopTimeout} onChange={(e) => set('defaultStopTimeout', Number(e.target.value))} /></Field>
          <Field label="Default restart policy"><input className="input mono" value={form.defaultRestartPolicy} onChange={(e) => set('defaultRestartPolicy', e.target.value)} /></Field>
        </div>
        <div className="field mt-3"><label>Default startup command</label><textarea className="input mono" rows={2} value={form.defaultStartup} onChange={(e) => set('defaultStartup', e.target.value)} /></div>
      </SaveBox>
    </div>
  )
}

/* ------------------------------------------------------------------ 9. Backups */
function Backups({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const { form, set, reset, dirty } = useForm({
    backupDir: c.backupDir || '/backup', maxConcurrentBackups: c.maxConcurrentBackups || 2, backupBandwidth: c.backupBandwidth || 0, tempDir: c.tempDir || '/tmp',
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ backupDir: c.backupDir || '/backup', maxConcurrentBackups: c.maxConcurrentBackups || 2, backupBandwidth: c.backupBandwidth || 0, tempDir: c.tempDir || '/tmp' }) }, [node.id])
  const save = async () => { setSaving(true); try { await api.patch(`/nodes/${node.id}`, form); toast.ok('Backup settings saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  const hs = node.hostStats
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="download" size={15} /> Backup settings</div>
      <div className="card-b mb-3 grid cols-3 gap-3">
        <div className="card stat-card"><div className="label">Backup storage total</div><div className="value sm mono">{fmtBytes(hs?.diskBytes)}</div></div>
        <div className="card stat-card"><div className="label">Backup storage available</div><div className="value sm mono">{hs ? fmtBytes(hs.diskBytes - hs.diskUsed) : '—'}</div></div>
        <div className="card stat-card"><div className="label">Storage used</div><div className="value sm mono">{fmtBytes(hs?.diskUsed)}</div></div>
      </div>
      <SaveBox onSave={save} saving={saving} dirty={dirty}>
        <div className="grid cols-2 gap-3">
          <Field label="Backup directory"><input className="input mono" value={form.backupDir} onChange={(e) => set('backupDir', e.target.value)} /></Field>
          <Field label="Temporary backup directory"><input className="input mono" value={form.tempDir} onChange={(e) => set('tempDir', e.target.value)} /></Field>
          <Field label="Max concurrent backups"><input className="input mono" type="number" value={form.maxConcurrentBackups} onChange={(e) => set('maxConcurrentBackups', Number(e.target.value))} /></Field>
          <Field label="Backup bandwidth (MB/s)" hint="0 = unlimited"><input className="input mono" type="number" value={form.backupBandwidth} onChange={(e) => set('backupBandwidth', Number(e.target.value))} /></Field>
        </div>
      </SaveBox>
    </div>
  )
}

/* ------------------------------------------------------------------ 10. SFTP */
function SFTP({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const { form, set, reset, dirty } = useForm({ sftpPort: c.sftpPort || 2022, sftpStatus: node.sftpStatus !== false })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ sftpPort: c.sftpPort || 2022, sftpStatus: node.sftpStatus !== false }) }, [node.id])
  const save = async () => { setSaving(true); try { await api.patch(`/nodes/${node.id}`, { sftpPort: form.sftpPort, sftpStatus: form.sftpStatus }); toast.ok('SFTP settings saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="lock" size={15} /> SFTP / file service <span className="h-sub">{form.sftpStatus ? <span className="badge green"><span className="dot" /> Running</span> : <span className="badge gray">Disabled</span>}</span></div>
      <SaveBox onSave={save} saving={saving} dirty={dirty}>
        <div className="grid cols-2 gap-3">
          <Field label="SFTP port"><input className="input mono" type="number" value={form.sftpPort} onChange={(e) => set('sftpPort', Number(e.target.value))} /></Field>
          <Field label="Status"><label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={form.sftpStatus} onChange={(e) => set('sftpStatus', e.target.checked)} /> Enable SFTP file service</label></Field>
        </div>
      </SaveBox>
    </div>
  )
}

/* ------------------------------------------------------------------ 11. Agent */
function Agent({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const reconnect = async () => { setBusy(true); try { await api.post(`/nodes/${node.id}/refresh`, {}); toast.ok('Agent reconnected'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setBusy(false) } }
  const rotate = async () => { if (!window.confirm('Rotate agent token? The existing token stops working and the agent must be re-provisioned.')) return; try { const r: any = await api.post(`/nodes/${node.id}/rotate-token`, {}); window.prompt('New agent token (shown once — update the agent config):', r.token); onSaved() } catch (e: any) { toast.err(e?.message) } }
  const lastSeen = node.health?.reachedAt
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="terminal" size={15} /> Agent</div>
      <div className="card-b mb-3">
        <InfoRow k="Agent version" v={node.agentVersion ? `v${node.agentVersion}` : '—'} />
        <InfoRow k="Connection status" v={node.status === 'online' ? <span className="badge green"><span className="dot" /> Connected</span> : <span className="badge gray">Offline</span>} />
        <InfoRow k="Last heartbeat" v={lastSeen ? new Date(lastSeen).toLocaleString() : '—'} />
        <InfoRow k="Certificate / TLS" v={node.scheme === 'https' ? <span className="badge green"><span className="dot" /> TLS</span> : <span className="badge amber">HTTP</span>} />
        <InfoRow k="Docker" v={node.dockerHealthy ? <span className="badge green"><span className="dot" /> healthy</span> : <span className="badge red">unhealthy</span>} />
      </div>
      <div className="card-b thin flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn" onClick={reconnect} disabled={busy}><Icon name="restart" size={13} /> Reconnect</button>
        <button className="btn" onClick={rotate}><Icon name="refresh" size={13} /> Rotate credentials</button>
        <button className="btn sm" onClick={async () => { try { await api.post(`/nodes/${node.id}/install`, {}); onSaved() } catch (e: any) { toast.err(e?.message) } }}><Icon name="download" size={13} /> Regenerate install</button>
        <span className="xs text-3" style={{ marginLeft: 'auto' }}>Secret credentials are never shown here.</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 12. Health */
function Health({ node }: { node: Node }) {
  const hs = node.hostStats
  const checks: { name: string; ok: boolean; icon: any }[] = [
    { name: 'Agent', ok: node.status === 'online', icon: 'terminal' },
    { name: 'Docker', ok: node.dockerHealthy, icon: 'box' },
    { name: 'Disk', ok: (hs?.diskPercent ?? 0) < 95, icon: 'folder' },
    { name: 'Network', ok: (hs?.netRxBytes ?? 0) >= 0, icon: 'globe' },
    { name: 'Memory', ok: (hs?.memoryPercent ?? 0) < 95, icon: 'chip' },
    { name: 'CPU', ok: (hs?.cpuPercent ?? 0) < 90, icon: 'activity' },
    { name: 'Load', ok: (hs?.load1 ?? 0) < (hs?.cpuCores || 1) * 1.5, icon: 'clock' },
  ]
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="activity" size={15} /> Health monitoring</div>
      <div className="card-b grid cols-2 gap-2">
        {checks.map((c) => (
          <div key={c.name} className={`row-item`} style={{ alignItems: 'center' }}>
            <Icon name={c.icon} size={16} /><div className="flex-1"><div className="cell-main">{c.name}</div><div className="cell-sub">{c.ok ? 'Operating normally' : 'Needs attention'}</div></div>
            <span className={`badge ${c.ok ? 'green' : 'red'}`}><span className="dot" /> {c.ok ? 'Healthy' : 'Unavailable'}</span>
          </div>
        ))}
      </div>
      <div className="card-b thin">
        <div className="grid cols-3 gap-3">
          <MiniStat label="CPU" value={`${hs?.cpuPercent?.toFixed?.(1) ?? '—'}%`} pct={pct(hs?.cpuPercent)} color="var(--cyan)" />
          <MiniStat label="Memory" value={`${hs?.memoryPercent?.toFixed?.(1) ?? '—'}%`} pct={pct(hs?.memoryPercent)} color="var(--accent)" />
          <MiniStat label="Disk" value={`${hs?.diskPercent?.toFixed?.(1) ?? '—'}%`} pct={pct(hs?.diskPercent)} color="var(--good)" />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 13. Logs */
function Logs({ node }: { node: Node }) {
  const { data } = usePoll<any>(async () => api.get('/activity'), [node.id], 8000)
  const rows = (data?.activity || []).filter((a: any) => (a.nodeId === node.id) || (a.message || '').toLowerCase().includes(node.name.toLowerCase()))
  const [q, setQ] = useState('')
  const filtered = rows.filter((a: any) => !q || (a.message || '').toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="list" size={15} /> Node logs / system events</div>
      <div className="card-b">
        <div className="field mb-3"><input className="input" placeholder="Search logs…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {filtered.length === 0 ? <div className="empty"><h3 className="sm text-3">No logs for this node yet.</h3></div> : (
          <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
            {filtered.map((a: any, i: number) => (
              <div key={i} className="row-item" style={{ alignItems: 'flex-start' }}>
                <span className={`badge ${a.severity === 'error' ? 'red' : a.severity === 'warn' ? 'amber' : 'gray'}`} style={{ width: 64, textAlign: 'center' }}>{a.severity}</span>
                <div className="flex-1">
                  <div className="cell-main sm">{a.message}</div>
                  <div className="cell-sub xs">{new Date(a.ts).toLocaleString()} · {a.actor}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="xs text-3 mt-3">Sensitive credentials are never logged.</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 14. Activity / Audit */
function Activity({ node }: { node: Node }) {
  const { data, loading, refetch } = usePoll<any>(async () => api.get('/activity'), [node.id], 8000)
  const rows = (data?.activity || []).filter((a: any) => a.nodeId === node.id)
  const [q, setQ] = useState('')
  const filtered = rows.filter((a: any) => !q || (a.message || '').toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="clock" size={15} /> Activity / audit log</div>
      <div className="card-b">
        <div className="field mb-3"><input className="input" placeholder="Search activity…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {!loading && filtered.length === 0 ? <div className="empty"><h3 className="sm text-3">No recorded activity for this node.</h3></div> : (
          <table className="dtable">
            <thead><tr><th>Action</th><th>Actor</th><th>Time</th></tr></thead>
            <tbody>
              {filtered.slice(0, 50).map((a: any, i: number) => (
                <tr key={i}><td className="cell-main sm">{a.message}</td><td className="sm">{a.actor}</td><td className="xs text-3">{new Date(a.ts).toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 15. Security */
function Security({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const { form, set, reset, dirty } = useForm({
    allowedPanelIps: (node.allowedPanelIps || []).join(', '), tlsEnabled: node.tlsEnabled ?? node.scheme === 'https',
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ allowedPanelIps: (node.allowedPanelIps || []).join(', '), tlsEnabled: node.tlsEnabled ?? node.scheme === 'https' }) }, [node.id])
  const save = async () => { setSaving(true); try { await api.patch(`/nodes/${node.id}`, { allowedPanelIps: form.allowedPanelIps.split(',').map((s: string) => s.trim()).filter(Boolean), tlsEnabled: form.tlsEnabled }); toast.ok('Security settings saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  return (
    <div className="grid gap-3 anim-in">
      <div className="card">
        <div className="card-h"><Icon name="shield" size={15} /> Security</div>
        <div className="card-b mb-3">
          <InfoRow k="Agent scheme" v={node.scheme === 'https' ? <span className="badge green"><span className="dot" /> TLS enabled</span> : <span className="badge amber">Plain HTTP — not recommended in production</span>} />
          <InfoRow k="Request rate limiting" v={<span className="badge green"><span className="dot" /> enabled</span>} />
        </div>
        <SaveBox onSave={save} saving={saving} dirty={dirty}>
          <div className="field"><label>Allowed panel IPs (comma separated)</label><input className="input mono" value={form.allowedPanelIps} onChange={(e) => set('allowedPanelIps', e.target.value)} placeholder="203.0.113.10, 203.0.113.11" /></div>
          <label className="check mt-3" style={{ display: 'flex' }}><input type="checkbox" checked={form.tlsEnabled} onChange={(e) => set('tlsEnabled', e.target.checked)} /> Enforce TLS on the agent connection</label>
          <p className="xs text-3 mt-3">Insecure HTTP and disabling TLS verification are not permitted as normal production settings.</p>
        </SaveBox>
      </div>
      <div className="card">
        <div className="card-h"><Icon name="refresh" size={15} /> Credentials</div>
        <div className="card-b thin flex gap-2" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={async () => { if (!window.confirm('Rotate agent token?')) return; try { await api.post(`/nodes/${node.id}/rotate-token`, {}); toast.ok('Token rotated'); onSaved() } catch (e: any) { toast.err(e?.message) } }}><Icon name="restart" size={13} /> Rotate credentials</button>
          <button className="btn danger" onClick={async () => { if (!window.confirm('Revoke agent token? This disables the node until re-provisioned.')) return; try { await api.post(`/nodes/${node.id}/revoke-token`, {}); toast.ok('Token revoked'); onSaved() } catch (e: any) { toast.err(e?.message) } }}><Icon name="logout" size={13} /> Revoke credentials</button>
          <span className="xs text-3" style={{ marginLeft: 'auto' }}>Secrets are never exposed in the UI.</span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 16. Maintenance */
function Maintenance({ node, onSaved }: { node: Node; onSaved: () => void }) {
  const c = node.config || {}
  const { form, set, reset, dirty } = useForm({
    maintenance: node.maintenance, preventNew: c.preventNew !== false, preventMigrations: c.preventMigrations !== false, preventAuto: c.preventAuto !== false,
  })
  const [saving, setSaving] = useState(false)
  useEffect(() => { reset({ maintenance: node.maintenance, preventNew: c.preventNew !== false, preventMigrations: c.preventMigrations !== false, preventAuto: c.preventAuto !== false }) }, [node.id])
  const save = async () => { setSaving(true); try { if (form.maintenance !== node.maintenance) await api.post(`/nodes/${node.id}/maintenance`, {}); await api.patch(`/nodes/${node.id}`, { preventNew: form.preventNew, preventMigrations: form.preventMigrations, preventAuto: form.preventAuto }); toast.ok('Maintenance settings saved'); onSaved() } catch (e: any) { toast.err(e?.message) } finally { setSaving(false) } }
  return (
    <div className="card anim-in">
      <div className="card-h"><Icon name="down" size={15} /> Maintenance mode</div>
      <div className="card-b">
        <label className="check" style={{ display: 'flex', marginBottom: 12 }}><input type="checkbox" checked={form.maintenance} onChange={(e) => set('maintenance', e.target.checked)} /> <b>Enable maintenance mode</b></label>
        {form.maintenance && <p className="sm text-2 mb-3">The node is in maintenance mode. Existing servers continue running unless stopped explicitly; only new provisioning is affected.</p>}
        <div className="grid gap-2">
          <label className="check"><input type="checkbox" checked={form.preventNew} onChange={(e) => set('preventNew', e.target.checked)} /> Prevent new server creation</label>
          <label className="check"><input type="checkbox" checked={form.preventMigrations} onChange={(e) => set('preventMigrations', e.target.checked)} /> Prevent migrations</label>
          <label className="check"><input type="checkbox" checked={form.preventAuto} onChange={(e) => set('preventAuto', e.target.checked)} /> Prevent automatic placement</label>
        </div>
        <div style={{ marginTop: 16 }}><button className="btn primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save maintenance settings'}</button></div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ 17. Danger Zone */
function Danger({ node, onDeleted }: { node: Node; onDeleted: () => void }) {
  const [rmOpen, setRmOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const servers = node.serverCount || 0
  const safe = typed === node.name
  const doRemove = async () => {
    if (servers > 0) { toast.err('Cannot remove node: servers are still assigned. Delete or move them first.'); return }
    setBusy(true)
    try { await api.del(`/nodes/${node.id}`); toast.ok('Node removed'); onDeleted() }
    catch (e: any) { toast.err(e?.message || 'Cannot remove node with servers') } finally { setBusy(false) }
  }
  const resetCfg = async () => {
    if (!window.confirm('Reset this node configuration to defaults? This clears non-essential settings but not servers.')) return
    try { await api.patch(`/nodes/${node.id}`, {}); toast.ok('Configuration reset requested'); } catch (e: any) { toast.err(e?.message) }
  }
  return (
    <div className="grid gap-3 anim-in">
      <div className="card" style={{ borderColor: 'rgba(242,95,92,0.4)' }}>
        <div className="card-h"><Icon name="trash" size={15} /> Danger zone</div>
        <div className="card-b">
          {servers > 0 && <p className="sm text-2 mb-3" style={{ color: 'var(--warn)' }}>This node has <b>{servers} server{servers === 1 ? '' : 's'}</b> assigned. Remove or migrate them before removing the node.</p>}
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <button className="btn" onClick={resetCfg}><Icon name="restart" size={14} /> Reset node configuration</button>
            <button className="btn danger" onClick={() => { setTyped(''); setRmOpen(true) }} disabled={servers > 0}><Icon name="trash" size={14} /> Remove node</button>
          </div>
        </div>
      </div>
      <Modal open={rmOpen} onClose={() => setRmOpen(false)} title="Remove node?" width={440}>
        <p className="sm text-2 mb-3">Permanently remove <b>{node.name}</b>? Type the node name to confirm. Customer servers are never silently deleted.</p>
        <div className="field"><input className="input mono" placeholder={node.name} value={typed} onChange={(e) => setTyped(e.target.value)} /></div>
        <div className="actions">
          <button className="btn" onClick={() => setRmOpen(false)}>Cancel</button>
          <button className="btn danger" onClick={doRemove} disabled={busy || !safe}>{busy ? 'Removing…' : 'Remove node'}</button>
        </div>
      </Modal>
    </div>
  )
}

function MiniStat({ label, value, pct, color }: { label: string; value: string; pct: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between xs text-3 mb-1"><span>{label}</span><span className="mono">{value}</span></div>
      <div className="bar" style={{ height: 6 }}><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}
