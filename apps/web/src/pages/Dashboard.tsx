import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/auth'
import { useServers, useNodes } from '../api/hooks'
import { Icon, StatePill, Spinner, EmptyState } from '../components/ui'

function barPct(v: number) { return Math.min(100, Math.max(0, v)) }

export function Dashboard() {
  const { summary, user, canAdmin } = useApp()
  const { servers, loading } = useServers()
  const { nodes } = useNodes()
  const navigate = useNavigate()

  const running = (summary?.running ?? servers.filter((s) => s.state === 'running').length)
  const attention = servers.filter((s) => s.state === 'error').length

  const stats = [
    { label: 'Servers', value: summary?.total ?? servers.length, icon: 'server' as const, to: '/servers', tone: 'accent' },
    { label: 'Running', value: running, icon: 'play' as const, to: '/servers', tone: 'green' },
    ...(canAdmin ? [{ label: 'Nodes Online', value: `${summary?.nodesOnline ?? 0}/${summary?.nodesTotal ?? 0}`, icon: 'node' as const, to: '/nodes', tone: 'cyan' }] : []),
    { label: 'Needs Attention', value: attention, icon: 'activity' as const, to: '/servers', tone: attention > 0 ? 'red' : 'amber' },
  ]
  const toneColor: Record<string, string> = { accent: 'var(--accent-strong)', green: 'var(--good)', cyan: 'var(--cyan)', amber: 'var(--warn)', red: 'var(--danger)' }

  return (
    <div className="page">
      <div className="page-h">
        <h1>Welcome back, {user?.name || 'there'}</h1>
        <span className="sub">{new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
        <div style={{ flex: 1 }} />
        {canAdmin && <button className="btn primary sm" onClick={() => navigate('/servers/new')}><Icon name="plus" size={14} /> New server</button>}
      </div>

      {loading ? (
        <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
      ) : (
        <>
          <div className="grid cols-4 mb-4 anim-in">
            {stats.map((s) => (
              <div key={s.label} className={`card stat-card clickable`} style={{ cursor: 'pointer' }} onClick={() => navigate(s.to)}>
                <div className="stat" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div className="label">{s.label}</div>
                    <div className="value" style={{ marginTop: 4 }}>{s.value}</div>
                  </div>
                  <Icon name={s.icon} size={26} />
                </div>
                <div className="stat-bar"><span style={{ background: toneColor[s.tone] }} /></div>
              </div>
            ))}
          </div>

          <div className="grid cols-2">
            <div className="card anim-in">
              <div className="card-h">Your Servers <span className="h-sub">({servers.length})</span></div>
              {servers.length === 0 ? (
                <EmptyState
                  icon="server" title="No servers yet"
                  desc="Create a server to provision a real container on one of your nodes."
                  action={canAdmin ? <button className="btn primary sm" onClick={() => navigate('/servers/new')}><Icon name="plus" size={14} /> New server</button> : undefined}
                />
              ) : (
                <div className="grid gap-2" style={{ padding: 14 }}>
                  {servers.slice(0, 8).map((s) => (
                    <ServerCard key={s.id} s={s} onManage={() => navigate(`/servers/${s.id}`)} />
                  ))}
                </div>
              )}
            </div>

            {canAdmin && (
              <div className="card anim-in">
                <div className="card-h">Nodes <span className="h-sub">({nodes.length})</span></div>
                {nodes.length === 0 ? (
                  <EmptyState
                    icon="node" title="No nodes online"
                    desc="Connect a node agent to start provisioning servers. Create a node, then the panel health-checks the Go agent."
                  />
                ) : (
                  <div>
                    {nodes.map((n) => (
                      <div key={n.id} className="row-item" onClick={() => navigate(`/nodes/${n.id}`)}>
                        <Icon name="node" size={16} />
                        <div className="flex-1">
                          <div className="cell-main">{n.name}</div>
                          <div className="cell-sub">{n.agentUrl} · {n.serverCount} servers</div>
                        </div>
                        <StatePill state={n.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function uptime(startedAt: number | null | undefined): string {
  if (!startedAt) return ''
  const ms = Math.max(0, Date.now() - startedAt)
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

function ServerCard({ s, onManage }: { s: any; onManage: () => void }) {
  const primaryPort = s.allocations?.[0]?.port
  const host = s.node?.host || s.node?.name || '—'
  const memPct = s.memoryLimitMb ? barPct((s.memoryMb / s.memoryLimitMb) * 100) : 0
  return (
    <div className="row-item" style={{ cursor: 'pointer', alignItems: 'stretch', flexDirection: 'column', padding: 12 }}>
      <div className="flex items-center gap-2" style={{ width: '100%' }}>
        <Icon name="server" size={16} className="accent" />
        <div className="flex-1">
          <div className="cell-main">{s.name}</div>
          <div className="cell-sub">
            {[s.node?.name, s.blueprint?.name].filter(Boolean).join(' • ') || '—'}
          </div>
        </div>
        <StatePill state={s.state} pulse />
      </div>

      <div className="flex items-center gap-3 xs text-3 mt-2" style={{ flexWrap: 'wrap' }}>
        <span className="mono">
          {primaryPort ? `${host}:${primaryPort}` : host}
        </span>
        {s.state === 'running' && uptime(s.startedAt) && <span>up {uptime(s.startedAt)}</span>}
      </div>

      <div className="grid gap-2 mt-3" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <MiniBar label="CPU" color="var(--cyan)" pct={barPct(s.cpuPercent)} text={`${s.cpuPercent}%`} />
        <MiniBar label="RAM" color="var(--accent)" pct={memPct} text={`${s.memoryMb}/${s.memoryLimitMb}MB`} />
        <MiniBar label="DISK" color="var(--good)" pct={s.storageGb ? 100 : 0} text={`${s.storageGb}GB`} />
      </div>

      <div style={{ marginTop: 10 }}>
        <button className="btn sm primary" style={{ width: '100%' }} onClick={onManage}>Manage Server</button>
      </div>
    </div>
  )
}

function MiniBar({ label, color, pct, text }: { label: string; color: string; pct: number; text: string }) {
  return (
    <div>
      <div className="flex justify-between xs text-3 mb-1"><span>{label}</span><span className="mono">{text}</span></div>
      <div className="bar" style={{ height: 5 }}><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}
