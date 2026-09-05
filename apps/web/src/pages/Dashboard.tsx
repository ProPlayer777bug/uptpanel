import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/auth'
import { useServers, useNodes, useActivity } from '../api/hooks'
import { Icon, StatePill, Button, EmptyState, Skeleton } from '../components/ui'
import { SparkChart } from '../components/Chart'
import { Shell } from '../components/Shell'
import { publicAddress } from '../utils/mask'

function barPct(v: number) { return Math.min(100, Math.max(0, v)) }

export function Dashboard() {
  const { summary, user, canAdmin } = useApp()
  const { servers, loading } = useServers()
  const { nodes } = useNodes(canAdmin)
  const { data: activityData, loading: activityLoading } = useActivity(12)
  const navigate = useNavigate()

  const running = summary?.running ?? servers.filter((s) => s.state === 'running').length
  const attention = servers.filter((s) => s.state === 'error').length
  const activity = activityData?.activity ?? []
  const [showUserMode, setShowUserMode] = useState(false)

  // Aggregate node resource utilization from live host stats.
  const nodesOnline = (nodes || []).filter((n) => (n.status as any) === 'online' || n.dockerHealthy)
  const avgCpu = avg(nodesOnline, (n) => n.cpuPercent ?? n.hostStats?.cpuPercent)
  const avgMem = avg(nodesOnline, (n) => n.memoryPercent ?? n.hostStats?.memoryPercent)
  const avgDisk = avg(nodesOnline, (n) => n.diskPercent ?? n.hostStats?.diskPercent)

  const utilSeries = [avgCpu, avgMem, avgDisk]
    .map((v) => (Number.isFinite(v) ? Math.round(v) : 0))

  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <Shell>
    <div className="page">
      {/* Greeting + org + quick actions */}
      <div className="page-h dash-head">
        <div>
          <h1>{greet}, {user?.name?.split(' ')[0] || 'there'}</h1>
          <span className="sub">{user?.role ? `${user.role} · ` : ''}{new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
        </div>
        <div style={{ flex: 1 }} />
        {canAdmin && (
          <Button variant="secondary" icon="user" onClick={() => setShowUserMode(!showUserMode)}>User mode</Button>
        )}
        {canAdmin && (
          <Button variant="primary" icon="plus" onClick={() => navigate('/servers/new')}>Create Server</Button>
        )}
        {canAdmin && (
          <Button variant="secondary" icon="user" onClick={() => setShowUserMode(!showUserMode)}>
            User mode
          </Button>
        )}
      </div>

      {loading ? (
        <div className="grid cols-4 mb-4"><Skeleton h={92} /><Skeleton h={92} /><Skeleton h={92} /><Skeleton h={92} /></div>
      ) : (
        <>
          {/* Infrastructure cards */}
          <div className="grid cols-4 mb-4 anim-in">
            <StatCard icon="server" label="Servers" value={summary?.total ?? servers.length} sub={`${running} running`} tone="accent" />
            <StatCard icon="play" label="Running" value={running} sub="active now" tone="success" />
            <StatCard icon="node" label="Nodes" value={`${summary?.nodesOnline ?? 0}/${summary?.nodesTotal ?? 0}`} sub="online" tone="accent" />
            <StatCard icon="cpu" label="CPU" value={`${utilSeries[0]}%`} sub="avg utilization" tone={toneFor(utilSeries[0])} />
            <StatCard icon="chip" label="RAM" value={`${utilSeries[1]}%`} sub="avg utilization" tone={toneFor(utilSeries[1])} />
            <StatCard icon="box" label="Storage" value={`${utilSeries[2]}%`} sub="avg utilization" tone={toneFor(utilSeries[2])} />
            <StatCard icon="activity" label="Attention" value={attention} sub={attention > 0 ? 'needs review' : 'all clear'} tone={attention > 0 ? 'danger' : 'success'} />
            <StatCard icon="download" label="Network" value={netTotal(nodesOnline)} sub="across nodes" tone="info" />
          </div>

          {/* Resource utilization sparkline + health */}
          <div className="grid dash-cols anim-in">
            <div className="card">
              <div className="card-h"><Icon name="cpu" size={15} /> Average Utilization <div style={{ flex: 1 }} /><span className="h-sub">nodes</span></div>
              <div className="card-b">
                <SparkChart data={utilSeries} labels={['CPU', 'RAM', 'Disk']} color="var(--accent)" />
              </div>
            </div>
            <div className="card">
              <div className="card-h"><Icon name="shieldCheck" size={15} /> Health</div>
              <div className="card-b health-grid">
                <HealthRow tone="success" label="Healthy" count={nodes.length - offlineCount(nodes)} />
                <HealthRow tone="warning" label="Warning" count={0} />
                <HealthRow tone="danger" label="Critical" count={attention} />
                <HealthRow tone="muted" label="Offline" count={offlineCount(nodes)} />
              </div>
            </div>
          </div>

          {/* Server list */}
          <div className="card anim-in" style={{ marginTop: 16 }}>
            <div className="card-h">
              <Icon name="server" size={16} /> Server Overview <span className="h-sub">({servers.length})</span>
              <div style={{ flex: 1 }} />
              {canAdmin && <Button size="sm" variant="primary" icon="plus" onClick={() => navigate('/servers/new')}>New Server</Button>}
            </div>
            {servers.length === 0 ? (
              <EmptyState
                icon="server" title="No Servers"
                desc="Create a server to provision a real container on one of your nodes."
                action={canAdmin ? <Button variant="primary" icon="plus" onClick={() => navigate('/servers/new')}>Create Server</Button> : undefined}
              />
            ) : (
              <div>
                {servers.map((s) => <ServerRow key={s.id} server={s} onNavigate={() => navigate(`/servers/${s.id}`)} />)}
              </div>
            )}
          </div>

          {/* Recent activity */}
          <div className="card anim-in" style={{ marginTop: 16 }}>
            <div className="card-h"><Icon name="activity" size={15} /> Recent Activity</div>
            <div className="card-b" style={{ padding: 8 }}>
              {activityLoading && <Skeleton h={80} />}
              {!activityLoading && activity.length === 0 && (
                <div className="text-3" style={{ padding: '20px 8px', textAlign: 'center', fontSize: 13 }}>No recent activity.</div>
              )}
              {activity.map((a) => <ActivityRow key={a.id} a={a} />)}
            </div>
          </div>
        </>
      )}
    </div>
    </Shell>
  )
}

function StatCard({ icon, label, value, sub, tone }: { icon: any; label: string; value: string | number; sub: string; tone: string }) {
  const cls = tone === 'success' ? 'green' : tone === 'accent' ? 'cyan' : tone === 'danger' ? 'red' : tone === 'warning' ? 'amber' : 'blue'
  const barColor = tone === 'success' ? 'var(--good)' : tone === 'accent' ? 'var(--cyan-strong)' : tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warn)' : 'var(--info)'
  return (
    <div className="stat-block">
      <div className={`sb-icon ${cls}`}><Icon name={icon} size={20} /></div>
      <div className="sb-text">
        <div className="sb-label">{label}</div>
        <div className="sb-value">{value}</div>
        <div className="sb-sub">{sub}</div>
      </div>
      <div className="sb-bar"><span style={{ background: barColor }} /></div>
    </div>
  )
}

function HealthRow({ tone, label, count }: { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string; count: number }) {
  const dot = tone === 'success' ? 'var(--good)' : tone === 'warning' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--text-3)'
  return (
    <div className="info-row">
      <span className="k"><span className="dot" style={{ background: dot, marginRight: 6 }} />{label}</span>
      <span className="bold">{count}</span>
    </div>
  )
}

function ActivityRow({ a }: { a: any }) {
  const sev = a.severity === 'error' ? 'red' : a.severity === 'warn' ? 'amber' : 'blue'
  const icon = a.kind === 'node' ? 'node' : a.kind === 'snapshot' ? 'snap' : a.kind === 'user' ? 'user' : a.kind === 'backup' ? 'download' : a.kind === 'automation' ? 'activity' : 'server'
  return (
    <div className="activity-row">
      <span className={`act-ico ${sev}`}><Icon name={icon} size={14} /></span>
      <span className="act-msg">{a.message}</span>
      <span className="act-time">{dateAgo(a.ts)}</span>
    </div>
  )
}

function avg(list: any[], fn: (n: any) => number | undefined): number {
  const vals = list.map(fn).filter((v): v is number => Number.isFinite(v))
  if (!vals.length) return 0
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

function offlineCount(nodes: any[]): number {
  return (nodes || []).filter((n) => n.status === 'offline' || !n.dockerHealthy).length
}

function netTotal(nodes: any[]): string {
  const sum = (nodes || []).reduce((a, n) => a + ((n.hostStats?.netRxBytes ?? 0) + (n.hostStats?.netTxBytes ?? 0)), 0)
  return fmtBytes(sum)
}

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(n) / Math.log(1024))
  return `${(n / Math.pow(1024, i)).toFixed(i > 2 ? 2 : 0)} ${units[Math.min(i, units.length - 1)]}`
}

function toneFor(v: number): string {
  return v >= 90 ? 'danger' : v >= 75 ? 'warning' : 'accent'
}

function dateAgo(ts?: number): string {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
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

function ServerRow({ server, onNavigate }: { server: any; onNavigate: () => void }) {
  const memPct = server.memoryLimitMb ? barPct((server.memoryMb / server.memoryLimitMb) * 100) : 0
  // Connectable address: alias when set, else node host/IP, plus port.
  const ipPort = server.allocations?.[0]
    ? publicAddress(server.allocations[0], server.node) || `${server.node?.host || server.node?.name || '—'}:${server.allocations[0].port}`
    : (server.node?.host || server.node?.name || '—')

  return (
    <div className="row-item" onClick={onNavigate} style={{ alignItems: 'center' }}>
      <div style={{ minWidth: 28 }}><Icon name="server" size={18} className="accent" /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="cell-main">{server.name}</div>
        <div className="cell-sub">{ipPort}{server.blueprint?.name ? ` · ${server.blueprint.name}` : ''}</div>
      </div>
      <div style={{ minWidth: 96 }}><StatePill state={server.state} pulse /></div>
      <div style={{ minWidth: 70, textAlign: 'right' }}>
        <span className="xs text-3">{server.state === 'running' && uptime(server.startedAt) ? `up ${uptime(server.startedAt)}` : '—'}</span>
      </div>
      <Metric mini="CPU" val={`${server.cpuPercent}%`} />
      <Metric mini="RAM" val={`${server.memoryMb}/${server.memoryLimitMb}MB`} />
      <Metric mini="Disk" val={`${server.storageGb}GB`} />
    </div>
  )
}

function Metric({ mini, val }: { mini: string; val: string }) {
  return (
    <div style={{ minWidth: 110 }} className="metric-cell">
      <div className="metric-mini">{mini}</div>
      <div className="metric-val nowrap">{val}</div>
    </div>
  )
}