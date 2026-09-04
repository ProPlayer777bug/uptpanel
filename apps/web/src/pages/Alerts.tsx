import { useMemo, useState } from 'react'
import { useNodes, useServers } from '../api/hooks'
import { Shell } from '../components/Shell'
import { Icon } from '../components/ui'

type Tone = 'critical' | 'warning' | 'info' | 'resolved'
interface Alert { id: string; tone: Tone; title: string; detail: string; ts: number; source: string }

function nodeCpu(n: any): number { return n.cpuPercent ?? n.hostStats?.cpuPercent ?? 0 }
function nodeMem(n: any): number { return n.memoryPercent ?? n.hostStats?.memoryPercent ?? 0 }
function nodeDisk(n: any): number { return n.diskPercent ?? n.hostStats?.diskPercent ?? 0 }

const TONE_STYLE: Record<Tone, { cls: string; dot: string; label: string }> = {
  critical: { cls: 'red', dot: 'var(--danger)', label: 'Critical' },
  warning: { cls: 'amber', dot: 'var(--warn)', label: 'Warning' },
  info: { cls: 'cyan', dot: 'var(--info)', label: 'Info' },
  resolved: { cls: 'green', dot: 'var(--good)', label: 'Resolved' },
}

export function Alerts() {
  const { nodes, loading } = useNodes()
  const { servers } = useServers()
  const [filter, setFilter] = useState<Tone | 'all'>('all')

  const alerts = useMemo<Alert[]>(() => {
    const out: Alert[] = []
    const online = (nodes || []).filter((n) => n.status === 'online')

    for (const n of nodes || []) {
      if (n.status === 'offline' || !n.dockerHealthy) {
        out.push({ id: `n-off-${n.id}`, tone: 'critical', title: `Node offline: ${n.name}`, detail: 'The node is unreachable. Servers on it are unavailable and auto-start is paused.', ts: Date.now(), source: 'node' })
      }
      const cpu = nodeCpu(n), mem = nodeMem(n), disk = nodeDisk(n)
      if (cpu >= 90 && n.status === 'online') out.push({ id: `n-cpu-${n.id}`, tone: 'warning', title: `High CPU on ${n.name}`, detail: `Sustained ${Math.round(cpu)}% CPU utilization.`, ts: Date.now(), source: 'node' })
      if (disk >= 85) out.push({ id: `n-disk-${n.id}`, tone: 'warning', title: `Disk near capacity on ${n.name}`, detail: `${Math.round(disk)}% of disk is in use.`, ts: Date.now(), source: 'node' })
    }

    for (const s of servers || []) {
      if (s.state === 'error') out.push({ id: `s-err-${s.id}`, tone: 'critical', title: `Server error: ${s.name}`, detail: s.error || 'The server is in an error state and needs attention.', ts: Date.now(), source: 'server' })
      if (s.state === 'offline' && s.error) out.push({ id: `s-down-${s.id}`, tone: 'info', title: `Server offline: ${s.name}`, detail: 'The server is stopped. Start it from its workspace.', ts: Date.now(), source: 'server' })
    }

    if (online.length > 0 && online.length >= (nodes || []).length) {
      out.push({ id: 'all-healthy', tone: 'resolved', title: 'All systems operational', detail: 'All nodes are online and reporting healthy.', ts: Date.now(), source: 'system' })
    }

    return out.sort((a, b) => (a.tone === 'resolved' ? 1 : 0) - (b.tone === 'resolved' ? 1 : 0) || b.ts - a.ts)
  }, [nodes, servers])

  const counts = useMemo(() => {
    const c = { critical: 0, warning: 0, info: 0, resolved: 0 }
    for (const a of alerts) c[a.tone]++
    return c
  }, [alerts])

  const filtered = filter === 'all' ? alerts : alerts.filter((a) => a.tone === filter)

  const filters: { key: Tone | 'all'; label: string }[] = [
    { key: 'all', label: `All (${alerts.length})` },
    { key: 'critical', label: `Critical (${counts.critical})` },
    { key: 'warning', label: `Warning (${counts.warning})` },
    { key: 'info', label: `Info (${counts.info})` },
    { key: 'resolved', label: `Resolved (${counts.resolved})` },
  ]

  return (
    <Shell>
      <div className="page">
        <div className="anim-in">
          <div className="flex items-center gap-3 mb-4">
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600 }}>Alerts</h1>
              <div className="sm text-3">Real-time health from nodes and servers</div>
            </div>
            <div style={{ flex: 1 }} />
            <span className={`badge ${TONE_STYLE[counts.critical ? 'critical' : counts.warning ? 'warning' : 'resolved'].cls}`}>
              <span className={`dot ${counts.critical || counts.warning ? 'pulse' : ''}`} style={{ background: TONE_STYLE[counts.critical ? 'critical' : counts.warning ? 'warning' : 'resolved'].dot }} />
              {counts.critical ? `${counts.critical} critical` : counts.warning ? `${counts.warning} warning` : 'All clear'}
            </span>
          </div>

          <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
            {filters.map((f) => (
              <button key={f.key} className={`badge gray xs ${filter === f.key ? '' : ''}`} style={{ cursor: 'pointer', opacity: filter === f.key ? 1 : 0.6 }} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
          </div>

          {loading && nodes.length === 0 ? (
            <div className="card"><div className="center" style={{ padding: 50 }}>Loading health…</div></div>
          ) : filtered.length === 0 ? (
            <div className="card"><div className="empty"><h3>Nothing here</h3><p>No alerts match this filter.</p></div></div>
          ) : (
            <div className="card">
              <div className="alert-list">
                {filtered.map((a) => {
                  const st = TONE_STYLE[a.tone]
                  return (
                    <div key={a.id} className="alert-row">
                      <span className="dot" style={{ background: st.dot, boxShadow: a.tone !== 'resolved' ? `0 0 0 4px ${st.dot}22` : undefined }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="cell-main">{a.title}</div>
                        <div className="xs text-3">{a.detail}</div>
                      </div>
                      <span className={`badge ${st.cls} xs`}>{st.label}</span>
                      <span className="xs text-3">{timeAgo(a.ts)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}