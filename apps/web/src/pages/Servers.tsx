import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useServer, useServers } from '../api/hooks'
import { useApp } from '../state/auth'
import { Icon, StatePill, Spinner, EmptyState } from '../components/ui'
import { CreateServer } from './CreateServer'
import { PowerControls } from './server/PowerControls'

function barPct(v: number) { return Math.min(100, v) }

export function Servers() {
  const { servers, loading } = useServers()
  const { canAdmin } = useApp()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [filter, setFilter] = useState<'all' | 'running' | 'offline'>('all')

  const filtered = useMemo(() => {
    return servers.filter((s) => {
      if (filter === 'running' && s.state !== 'running') return false
      if (filter === 'offline' && s.state !== 'offline') return false
      const t = q.trim().toLowerCase()
      if (t && !s.name.toLowerCase().includes(t) && !(s.blueprint?.name || '').toLowerCase().includes(t)) return false
      return true
    })
  }, [servers, q, filter])

  return (
    <div className="page">
      <div className="page-h">
        <h1>Servers</h1>
        <span className="sub">{servers.length} total</span>
        <div style={{ flex: 1 }} />
        {canAdmin && <button className="btn primary sm" onClick={() => setShowCreate(true)}><Icon name="plus" size={14} /> New server</button>}
      </div>

      <div className="flex gap-2 mb-3" style={{ alignItems: 'center' }}>
        <input className="input flex-1" placeholder="Search by name or blueprint…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`btn sm ${filter === 'all' ? 'subtle' : 'ghost'}`} onClick={() => setFilter('all')}>All</button>
        <button className={`btn sm ${filter === 'running' ? 'subtle' : 'ghost'}`} onClick={() => setFilter('running')}>Running</button>
        <button className={`btn sm ${filter === 'offline' ? 'subtle' : 'ghost'}`} onClick={() => setFilter('offline')}>Offline</button>
      </div>

      {loading ? (
        <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
      ) : servers.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="server" title={canAdmin ? 'No servers' : 'No accessible servers'}
            desc={canAdmin ? 'Create your first server to provision a real container on a connected node.' : 'You do not have access to any servers yet. Ask an administrator to grant you access.'}
            action={canAdmin ? <CreateButton onClick={() => setShowCreate(true)} /> : undefined}
          />
        </div>
      ) : (
        <div className="card anim-in" style={{ overflowX: 'auto' }}>
          <table className="dtable">
            <thead>
              <tr>
                <th>Server</th><th>State</th><th>Blueprint</th><th>Node</th><th>CPU</th><th>Memory</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} onClick={() => navigate(`/servers/${s.id}`)}>
                  <td>
                    <div className="cell-main">{s.name}</div>
                    <div className="cell-sub mono xs">{s.id}</div>
                  </td>
                  <td><StatePill state={s.state} pulse /></td>
                  <td>{s.blueprint?.name || '—'}</td>
                  <td>{s.node?.name || '—'}</td>
                  <td style={{ minWidth: 110 }}>
                    <div className="flex gap-2 items-center">
                      <div className="bar flex-1" style={{ width: 70 }}><div style={{ width: `${barPct(s.cpuPercent)}%`, background: 'var(--cyan)' }} /></div>
                      <span className="xs text-3">{s.cpuPercent}%</span>
                    </div>
                  </td>
                  <td style={{ minWidth: 110 }}>
                    <div className="flex gap-2 items-center">
                      <div className="bar flex-1" style={{ width: 70 }}><div style={{ width: `${barPct((s.memoryMb / (s.memoryLimitMb || 1)) * 100)}%`, background: 'var(--accent)' }} /></div>
                      <span className="xs text-3">{s.memoryMb}/{s.memoryLimitMb}MB</span>
                    </div>
                  </td>
                  <td>
                    <ServerRowPower server={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateServer onClose={() => setShowCreate(false)} />}
    </div>
  )
}

function CreateButton({ onClick }: { onClick: () => void }) {
  return <button className="btn primary sm" onClick={onClick}><Icon name="plus" size={14} /> New server</button>
}

function ServerRowPower({ server }: { server: any }) {
  const { data } = useServer(server.id)
  const s = data?.server || server
  return (
    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
      <PowerControls server={s} compact />
    </div>
  )
}

export function useParamServerId() {
  const { id } = useParams()
  return id
}
