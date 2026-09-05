import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, StatePill } from '../../components/ui'
import { useSocket } from '../../hooks/useSocket'
import { publicAddress } from '../../utils/mask'
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
      {/* Stat blocks row */}
      <div className="grid cols-4 mb-4">
        <PStatBlock
          icon="cpu" label="CPU"
          value={cpu >= 0.05 ? `${cpu}%` : '0%'}
          sub={`/ ${server.cpuPercent}% limit`}
          iconCls="cyan" barColor="var(--cyan-strong)"
          barPct={Math.min(100, (cpu / (server.cpuPercent || 100)) * 100)}
        />
        <PStatBlock
          icon="down" label="Memory"
          value={`${stats.memoryUsedMb ?? 0} MB`}
          sub={`of ${server.memoryLimitMb} MB`}
          iconCls="amber" barColor="var(--cyan)"
          barPct={memPct ?? 0}
        />
        <PStatBlock
          icon="activity" label="Processes"
          value={`${stats.pids ?? 0}`}
          sub="container pids"
          iconCls="green" barColor="var(--good)"
          barPct={0}
        />
        <PStatBlock
          icon="snap" label="Network"
          value={`${(stats.networkTxMb ?? 0).toFixed(2)} MB`}
          sub={`TX ${(stats.networkTxMb ?? 0).toFixed(2)} · RX ${(stats.networkRxMb ?? 0).toFixed(2)}`}
          iconCls="blue" barColor="var(--info)"
          barPct={0}
        />
      </div>

      <div className="grid cols-2">
        <div>
          {/* Resource usage */}
          <div className="card mb-4">
            <div className="card-h">Resource Usage</div>
            <div className="card-b" style={{ display: 'grid', gap: 16 }}>
              <MetricBar label="CPU" value={cpu} max={server.cpuPercent || 100} color="var(--cyan-strong)" display={stats.cpuPercent != null ? `${cpu.toFixed(2)} / ${server.cpuPercent}%` : '0%'} />
              <MetricBar label="Memory" value={memPct ?? 0} max={100} color="var(--cyan)" display={`${stats.memoryUsedMb ?? 0} MB / ${server.memoryLimitMb} MB`} />
            </div>
            {stats.error && <div className="card-b thin"><span className="badge red">{stats.error}</span></div>}
          </div>

          {/* Details */}
          <div className="card">
            <div className="card-h">Details</div>
            <div className="card-b">
              <InfoRow k="State" v={<StatePill state={server.state} />} />
              <InfoRow k="Blueprint" v={server.blueprint?.name || '—'} />
              <InfoRow k="Runtime" v={<div className="sm">{friendlyRuntime(server.blueprint?.image)}</div>} />
              <InfoRow k="Startup" v={<div className="sm">{friendlyStartup(server.blueprint?.startup)}</div>} />
              <InfoRow k="Node" v={server.node?.name || '—'} />
              <InfoRow k="Disk" v={`${server.storageGb} GB`} />
              <InfoRow k="Created" v={new Date(server.createdAt).toLocaleString()} />
            </div>
          </div>
        </div>
        <div>
          {/* Allocations */}
          <div className="card mb-4">
            <div className="card-h">Allocations</div>
            <div className="card-b">
              {server.allocations.length === 0 ? (
                <div className="text-3 sm">No allocations configured</div>
              ) : (
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px,1fr))' }}>
                  {server.allocations.map((a) => (
                    <div key={a.id} className="alloc">
                      <span className="mono">{publicAddress(a, server.node) || `${(a as any).alias || (a as any).ip || '—'}:${a.port}`}</span>
                      <span className="xs text-3">{a.proto}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Limits */}
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

function PStatBlock({ icon, label, value, sub, iconCls, barColor, barPct }: {
  icon: any; label: string; value: string; sub: string; iconCls: string; barColor: string; barPct: number
}) {
  return (
    <div className="stat-block">
      <div className={`sb-icon ${iconCls}`}>
        <Icon name={icon} size={20} />
      </div>
      <div className="sb-text">
        <div className="sb-label">{label}</div>
        <div className="sb-value">{value}</div>
        <div className="sb-sub">{sub}</div>
      </div>
      {barPct > 0 && (
        <div className="sb-bar"><span style={{ width: `${Math.min(100, barPct)}%`, background: barColor }} /></div>
      )}
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

// Present the runtime image to end users without exposing the underlying
// engine registry (e.g. ghcr.io/pterodactyl/yolks:java_21 -> "Java 21 runtime").
function friendlyRuntime(img: string | undefined): string {
  if (!img) return '—'
  const m = /(?:java|openjdk)[_-]?(\d+)/i.exec(img)
  if (m) return `Java ${m[1]} runtime`
  const tag = img.split(':').pop()
  if (tag) return tag.charAt(0).toUpperCase() + tag.slice(1)
  return img
}

// Present the launch line without the raw java flags/registry detail.
function friendlyStartup(startup: string | undefined): string {
  if (!startup) return '—'
  if (/java\b/.test(startup)) return 'Minecraft runtime launcher'
  return startup.trim().split(/\s+/)[0] || '—'
}

function ProvisionView({ progress }: { progress: Progress | null }) {
  const pct = progress?.pct ?? 0
  const stage = progress?.stage || 'Provisioning...'
  return (
    <div className="card">
      <div className="card-b" style={{ padding: 48, display: 'grid', placeItems: 'center', gap: 18 }}>
        <Spinner size={34} />
        <div className="center" style={{ gap: 8 }}>
          <div className="bold" style={{ fontSize: 17 }}>{stage}</div>
          <div className="text-3 sm">Pulling container image and configuring resources...</div>
        </div>
        <div className="bar" style={{ width: 'min(360px, 80%)', height: 10 }}>
          <div style={{ width: `${pct}%`, background: 'var(--cyan)' }} />
        </div>
        <span className="mono sm text-3">{pct}%</span>
      </div>
    </div>
  )
}
