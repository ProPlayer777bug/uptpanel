import { useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useServers, powerAction } from '../api/hooks'
import { useApp } from '../state/auth'
import { Icon, StatePill, Button, EmptyState, Switch, Menu, Spinner, toast, Tooltip } from '../components/ui'
import { CreateServer } from './CreateServer'
import { Shell } from '../components/Shell'
import { maskAddress } from '../utils/mask'

function barPct(v: number) { return Math.min(100, Math.max(0, v)) }

type SortKey = 'name' | 'state' | 'cpu' | 'mem' | 'uptime'

export function Servers() {
  const { servers, loading, refetch } = useServers()
  const { canAdmin } = useApp()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'running' | 'offline' | 'error'>('all')
  const [view, setView] = useState<'table' | 'grid'>('table')
  const [sort, setSort] = useState<SortKey>('name')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [showCreate, setShowCreate] = useState(pathname.endsWith('/new'))
  const [bulkBusy, setBulkBusy] = useState(false)

  const filtered = useMemo(() => {
    let list = servers.filter((s) => {
      if (filter === 'running' && s.state !== 'running') return false
      if (filter === 'offline' && s.state !== 'offline') return false
      if (filter === 'error' && s.state !== 'error') return false
      const t = q.trim().toLowerCase()
      if (t && !s.name.toLowerCase().includes(t)
        && !(s.blueprint?.name || '').toLowerCase().includes(t)
        && !(s.node?.name || '').toLowerCase().includes(t)
        && !s.id.toLowerCase().includes(t)) return false
      return true
    })
    list = [...list].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      if (sort === 'state') return (a.state || '').localeCompare(b.state || '')
      if (sort === 'cpu') return (b.cpuPercent || 0) - (a.cpuPercent || 0)
      if (sort === 'mem') return (b.memoryMb || 0) - (a.memoryMb || 0)
      return (b.startedAt || 0) - (a.startedAt || 0)
    })
    return list
  }, [servers, q, filter, sort])

  const allSelected = filtered.length > 0 && filtered.every((s) => sel.has(s.id))

  const toggleAll = () => {
    setSel(allSelected ? new Set() : new Set(filtered.map((s) => s.id)))
  }
  const toggleOne = (id: string) => {
    setSel((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  const bulk = async (action: 'start' | 'stop' | 'restart' | 'kill') => {
    setBulkBusy(true)
    let ok = 0, err = 0
    for (const id of sel) {
      try { await powerAction(id, action); ok++ } catch { err++ }
    }
    toast.ok(`Bulk ${action}: ${ok} ok${err ? `, ${err} failed` : ''}`)
    setSel(new Set())
    setBulkBusy(false)
    refetch()
    setTimeout(refetch, 1400)
  }

  return (
    <Shell>
    <div className="page">
      <div className="page-h">
        <h1>Servers</h1>
        <span className="sub">{servers.length} total</span>
        <div style={{ flex: 1 }} />
        <Switch checked={view === 'grid'} onChange={(v) => setView(v ? 'grid' : 'table')} label={view === 'grid' ? 'Grid' : 'Table'} />
        {canAdmin && <Button variant="primary" size="sm" icon="plus" onClick={() => setShowCreate(true)}>New server</Button>}
      </div>

      {/* Toolbar: search / filter / sort / bulk */}
      <div className="server-toolbar">
        <div className="flex gap-2 flex-1 items-center" style={{ minWidth: 0 }}>
          <div className="search-box flex-1">
            <Icon name="search" size={14} />
            <input placeholder="Search name, blueprint, node, id…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterBtn>
          <FilterBtn active={filter === 'running'} onClick={() => setFilter('running')}>Running</FilterBtn>
          <FilterBtn active={filter === 'offline'} onClick={() => setFilter('offline')}>Offline</FilterBtn>
          <FilterBtn active={filter === 'error'} onClick={() => setFilter('error')}>Error</FilterBtn>
        </div>
        <div className="flex gap-2 items-center">
          {sel.size > 0 && (
            <>
              <Button size="sm" variant="ghost" icon="play" disabled={bulkBusy} onClick={() => bulk('start')}>Start</Button>
              <Button size="sm" variant="ghost" icon="stop" disabled={bulkBusy} onClick={() => bulk('stop')}>Stop</Button>
              <Button size="sm" variant="ghost" icon="restart" disabled={bulkBusy} onClick={() => bulk('restart')}>Restart</Button>
              <Button size="sm" variant="danger" icon="power" disabled={bulkBusy} onClick={() => bulk('kill')}>Kill</Button>
              <span className="xs text-3">{sel.size} selected</span>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
      ) : servers.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="server" title={canAdmin ? 'No servers' : 'No accessible servers'}
            desc={canAdmin ? 'Create your first server to provision a real container on a connected node.' : 'You do not have access to any servers yet. Ask an administrator to grant you access.'}
            action={canAdmin ? <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>Create server</Button> : undefined}
          />
        </div>
      ) : view === 'grid' ? (
        <div className="server-grid anim-in">
          {filtered.map((s) => (
            <ServerCard key={s.id} server={s} selected={sel.has(s.id)} onSelect={() => toggleOne(s.id)} onOpen={() => navigate(`/servers/${s.id}`)} />
          ))}
        </div>
      ) : (
        <div className="card anim-in" style={{ overflowX: 'auto' }}>
          <table className="dtable">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th onClick={() => setSort('name')}>Server</th>
                <th onClick={() => setSort('state')}>State</th>
                <th>Blueprint</th>
                <th>Version</th>
                <th>Node</th>
                <th onClick={() => setSort('cpu')}>CPU</th>
                <th onClick={() => setSort('mem')}>Memory</th>
                <th>Disk</th>
                <th>Uptime</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} onClick={() => navigate(`/servers/${s.id}`)} className={sel.has(s.id) ? 'sel' : ''}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={sel.has(s.id)} onChange={() => toggleOne(s.id)} aria-label={`Select ${s.name}`} />
                  </td>
                  <td><div className="cell-main">{s.name}</div><div className="cell-sub mono xs">{s.id}</div></td>
                  <td><StatePill state={s.state} pulse /></td>
                  <td>{s.blueprint?.name || '—'}</td>
                  <td>{s.mcVersion || '—'}</td>
                  <td>{s.node?.name || '—'}</td>
                  <td>
                    <MiniBar pct={s.cpuPercent} color="var(--cyan)" label={`${s.cpuPercent}%`} />
                  </td>
                  <td>
                    <MiniBar pct={barPct((s.memoryMb / (s.memoryLimitMb || 1)) * 100)} color="var(--accent)" label={`${s.memoryMb}/${s.memoryLimitMb}MB`} />
                  </td>
                  <td><span className="xs text-3">{s.storageGb}GB</span></td>
                  <td><span className="xs text-3">{s.state === 'running' && s.startedAt ? uptime(s.startedAt) : '—'}</span></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Menu trigger={<span className="nav-icon-btn"><Icon name="dots" size={16} /></span>} align="right"
                      items={[
                        { label: 'Open', icon: 'server', onClick: () => navigate(`/servers/${s.id}`) },
                        { label: 'Copy IP', icon: 'copy', onClick: () => copyAddr(s) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && <CreateServer onClose={() => setShowCreate(false)} />}
    </div>
    </Shell>
  )
}

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button size="sm" variant={active ? 'subtle' : 'ghost'} onClick={onClick}>{children}</Button>
}

function MiniBar({ pct, color, label }: { pct: number; color: string; label: string }) {
  return (
    <div className="flex gap-2 items-center" style={{ minWidth: 110 }}>
      <div className="bar flex-1" style={{ width: 70 }}><div style={{ width: `${barPct(pct)}%`, background: color }} /></div>
      <span className="xs text-3 nowrap">{label}</span>
    </div>
  )
}

function ServerCard({ server, selected, onSelect, onOpen }: { server: any; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  const memPct = barPct((server.memoryMb / (server.memoryLimitMb || 1)) * 100)
  return (
    <div className={`server-card ${selected ? 'selected' : ''}`}>
      <div className="server-card-head">
        <span className="avatar" style={{ width: 30, height: 30, fontSize: 12, background: 'var(--cyan-soft)', color: 'var(--cyan-strong)' }}><Icon name="server" size={14} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cell-main" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.name}</div>
          <div className="cell-sub mono xs">{server.mcVersion || server.blueprint?.name || ''}</div>
        </div>
        <input type="checkbox" checked={selected} onChange={onSelect} aria-label="Select" />
      </div>
      <div className="server-card-body" onClick={onOpen}>
        <div className="flex items-center gap-2"><StatePill state={server.state} pulse /></div>
        <div className="sc-line"><span>Node</span><b>{server.node?.name || '—'}</b></div>
        <div className="sc-line"><span>CPU</span><b>{server.cpuPercent}%</b></div>
        <div className="sc-line"><span>RAM</span><b>{server.memoryMb}/{server.memoryLimitMb}MB</b></div>
        <div className="sc-line"><span>Disk</span><b>{server.storageGb}GB</b></div>
      </div>
      <div className="server-card-foot">
        <div className="bar flex-1"><div style={{ width: `${memPct}%`, background: 'var(--accent)' }} /></div>
      </div>
    </div>
  )
}

function copyAddr(s: any) {
  const addr = s.allocations?.[0] ? `${s.node?.name || ''}:${s.allocations[0].port}` : ''
  if (!addr) { toast.info('No allocation'); return }
  navigator.clipboard?.writeText(addr).then(() => toast.ok('Copied address')).catch(() => toast.err('Copy failed'))
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