import { useNavigate } from 'react-router-dom'
import { useApp } from '../state/auth'
import { useServers, useNodes } from '../api/hooks'
import { Icon, StatePill, Spinner, EmptyState } from '../components/ui'

export function Dashboard() {
  const { summary, canAdmin } = useApp()
  const { servers, loading } = useServers()
  const { nodes } = useNodes()
  const navigate = useNavigate()

  const stats = [
    { label: 'Servers', value: summary?.total ?? servers.length, icon: 'server' as const, to: '/servers', tone: 'accent' },
    { label: 'Running', value: summary?.running ?? 0, icon: 'play' as const, to: '/servers', tone: 'green' },
    ...(canAdmin ? [{ label: 'Nodes Online', value: `${summary?.nodesOnline ?? 0}/${summary?.nodesTotal ?? 0}`, icon: 'node' as const, to: '/nodes', tone: 'cyan' }] : []),
    { label: 'Attention', value: summary?.offline ?? 0, icon: 'activity' as const, to: '/servers', tone: 'amber' },
  ]
  const toneColor: Record<string, string> = { accent: 'var(--accent-strong)', green: 'var(--good)', cyan: 'var(--cyan)', amber: 'var(--warn)', red: 'var(--danger)' }

  return (
    <div className="page">
      <div className="page-h">
        <h1>Dashboard</h1>
        <span className="sub">Control plane overview</span>
        <div style={{ flex: 1 }} />
        {canAdmin && <button className="btn primary sm" onClick={() => navigate('/servers/new')}><Icon name="plus" size={14} /> New server</button>}
        {canAdmin && <button className="btn sm" onClick={() => navigate('/nodes')}><Icon name="node" size={14} /> View nodes</button>}
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
              <div className="card-h">Servers <span className="h-sub">({servers.length})</span></div>
              {servers.length === 0 ? (
                <EmptyState
                  icon="server" title="No servers yet"
                  desc="Create a server to provision a real container on one of your nodes."
                  action={<button className="btn primary sm" onClick={() => navigate('/servers/new')}><Icon name="plus" size={14} /> New server</button>}
                />
              ) : (
                <div>
                  {servers.slice(0, 6).map((s) => (
                    <div key={s.id} className="row-item" onClick={() => navigate(`/servers/${s.id}`)}>
                      <Icon name="server" size={16} />
                      <div className="flex-1">
                        <div className="cell-main">{s.name}</div>
                        <div className="cell-sub">{s.blueprint?.name} · {s.node?.name}</div>
                      </div>
                      <StatePill state={s.state} pulse />
                    </div>
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
