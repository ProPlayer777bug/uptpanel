import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, StatePill } from '../../components/ui'
import { useSocket } from '../../hooks/useSocket'
import type { Server } from '@uptimehost/types'

interface Stats { cpuPercent?: number; memoryUsedMb?: number; memoryLimitMb?: number; memoryPercent?: number; networkRxMb?: number; networkTxMb?: number; pids?: number; state?: string; error?: string }
interface Progress { pct: number; stage: string }

export function OverviewTab({ server }: { server: Server }) {
  const { connected } = useSocket((m: any) => {
    if (m.type === 'deploy-progress' && m.data?.serverId === server.id) setProgress(m.data)
    if (m.type === 'server-update' && m.data?.id === server.id && m.data?.state !== 'provisioning') setProgress(null)
  })
  const [stats, setStats] = useState<Stats>({})
  const [progress, setProgress] = useState<Progress | null>(null)

  const fetchStats = () => api.get(`/servers/${server.id}/stats`).then((d) => d.stats && setStats(d.stats)).catch(() => {})
  useEffect(() => { fetchStats() }, [server.id])
  useEffect(() => { if (!connected) return; const t = setTimeout(fetchStats, 6000); return () => clearTimeout(t) }, [connected, server.id])

  const cpu = Math.round((stats.cpuPercent || 0) * 100) / 100
  const memPct = stats.memoryPercent != null ? Math.round(stats.memoryPercent * 100) : null

  if (server.state === 'provisioning') return <ProvisionView progress={progress} />

  return (
    <div>
      <div className="grid cols-4 mb-4">
        <StatBlock icon="cpu" label="CPU" value={cpu >= 0.05 ? `${cpu}%` : '0%'} sub={`${server.cpuPercent}% cap`} tone="var(--cyan)" />
        <StatBlock icon="down" label="Memory" value={`${stats.memoryUsedMb ?? 0} MB`} sub={`of ${server.memoryLimitMb} MB`} tone="var(--accent)" />
        <StatBlock icon="activity" label="Processes" value={`${stats.pids ?? 0}`} sub="container pids" tone="var(--good)" />
        <StatBlock icon="snap" label="Network" value={`${(stats.networkTxMb ?? 0).toFixed(2)} MB`} sub={`TX ${(stats.networkTxMb ?? 0).toFixed(2)} · RX ${(stats.networkRxMb ?? 0).toFixed(2)}`} tone="var(--info)" />
      </div>

      <div className="grid cols-2">
        <div>
          <div className="card mb-4">
            <div className="card-h">Resource usage</div>
            <div className="card-b" style={{ display: 'grid', gap: 16 }}>
              <MetricBar label="CPU" value={stats.cpuPercent ?? 0} max={100} color="var(--cyan)" display={`${stats.cpuPercent != null ? cpu.toFixed(2) : 0}%`} />
              <MetricBar label="Memory" value={memPct ?? 0} max={100} color="var(--accent)" display={`${stats.memoryUsedMb ?? 0} MB / ${server.memoryLimitMb} MB`} />
            </div>
            {stats.error && <div className="card-b thin"><span className="badge red">{stats.error}</span></div>}
          </div>
          <div className="card">
            <div className="card-h">Details</div>
            <div className="card-b">
              <InfoRow k="State" v={<StatePill state={server.state} />} />
              <InfoRow k="Blueprint" v={server.blueprint?.name || '—'} />
              <InfoRow k="Image" v={<div className="mono sm">{server.blueprint?.image}</div>} />
              <InfoRow k="Startup" v={<div className="mono sm">{server.blueprint?.startup}</div>} />
              <InfoRow k="Node" v={server.node?.name || '—'} />
              <InfoRow k="Disk" v={`${server.storageGb} GB`} />
              <InfoRow k="Created" v={new Date(server.createdAt).toLocaleString()} />
            </div>
          </div>
        </div>
        <div>
          <div className="card mb-4">
            <div className="card-h">Allocations</div>
            <div className="card-b">
              {server.allocations.length === 0 ? <div className="text-3 sm">No allocations</div> : (
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px,1fr))' }}>
                  {server.allocations.map((a) => (
                    <div key={a.id} className="alloc"><span className="mono">{a.port}</span><span className="xs text-3">{a.proto}</span></div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-h">Limits</div>
            <div className="card-b">
              <InfoRow k="CPU" v={<div className="mono sm">{server.cpuPercent}%</div>} />
              <InfoRow k="Memory" v={<div className="mono sm">{server.memoryLimitMb} MB</div>} />
              <InfoRow k="Disk" v={<div className="mono sm">{server.storageGb} GB</div>} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatBlock({ icon, label, value, sub, tone }: { icon: any; label: string; value: string; sub: string; tone: string }) {
  return (
    <div className="card stat-card">
      <div className="stat" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div className="label">{label}</div>
          <div className="value" style={{ marginTop: 4 }}>{value}</div>
          <div className="xs text-3">{sub}</div>
        </div>
        <Icon name={icon} size={26} />
      </div>
      <div className="stat-bar"><span style={{ background: tone }} /></div>
    </div>
  )
}

function MetricBar({ label, value, max, color, display }: { label: string; value: number; max: number; color: string; display: string }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div>
      <div className="flex justify-between mb-1" style={{ alignItems: 'baseline' }}>
        <span className="sm text-2 bold">{label}</span>
        <span className="sm mono">{display}</span>
      </div>
      <div className="bar" style={{ height: 8 }}><div style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}

function InfoRow({ k, v }: { k: string; v: any }) {
  return <div className="info-row"><span className="k">{k}</span><span>{v}</span></div>
}

function ProvisionView({ progress }: { progress: Progress | null }) {
  const pct = progress?.pct ?? 0
  const stage = progress?.stage || 'Provisioning…'
  return (
    <div className="card">
      <div className="card-b" style={{ padding: 48, display: 'grid', placeItems: 'center', gap: 18 }}>
        <Spinner size={34} />
        <div className="center" style={{ gap: 8 }}>
          <div className="bold" style={{ fontSize: 17 }}>{stage}</div>
          <div className="text-3 sm">Pulling container image and configuring resources…</div>
        </div>
        <div className="bar" style={{ width: 'min(360px, 80%)', height: 10 }}>
          <div style={{ width: `${pct}%`, background: 'var(--accent)' }} />
        </div>
        <span className="mono sm text-3">{pct}%</span>
      </div>
    </div>
  )
}
