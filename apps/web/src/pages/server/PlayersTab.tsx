import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

// Player Management Center — a server's players without remembering commands.
// Reads real state from the server (whitelist/ops/bans/usercache/stats/logs)
// via the node agent and drives in-game actions over RCON.
interface PlayerEntry {
  name: string
  uuid?: string | null
  online: boolean
  playtimeTicks?: number
  firstJoined?: number | null
  lastJoined?: number | null
  lastSeenAt?: number | null
}

type Filter = 'online' | 'offline' | 'banned' | 'whitelist' | 'ops' | 'all'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'online', label: 'Online' },
  { id: 'offline', label: 'Offline' },
  { id: 'banned', label: 'Banned' },
  { id: 'whitelist', label: 'Whitelisted' },
  { id: 'ops', label: 'Operators' },
]

interface SnapshotResp {
  rcon: { enabled: boolean; reason?: string }
  online: string[]
  whitelist: { name: string; uuid?: string }[]
  ops: { name: string; uuid?: string }[]
  banned: { name: string; uuid?: string; reason?: string; expires?: string; by?: string }[]
  known: PlayerEntry[]
}

function hours(ticks: number): string {
  if (!ticks) return '—'
  const h = ticks / 20 / 3600
  return h >= 1 ? `${Math.floor(h)}h` : `${Math.max(1, Math.round(h * 60))}m`
}

function fmtDate(ts?: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  return d.toLocaleDateString()
}

export function PlayersTab({ server }: { server: Server }) {
  const [data, setData] = useState<SnapshotResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('online')
  const [sel, setSel] = useState<string | null>(null)
  const [lastOutput, setLastOutput] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.get(`/servers/${server.id}/players`)
      .then((d) => {
        setData(d.players as SnapshotResp)
        setSel((prev) => {
          if (prev && !allPlayerNames(d.players as SnapshotResp).includes(prev)) return null
          return prev
        })
      })
      .catch((e: any) => toast.err(e?.message))
      .finally(() => setLoading(false))
  }, [server.id])

  useEffect(() => { load() }, [load])

  const players = useMemo(() => {
    if (!data) return []
    const byName = new Map<string, PlayerEntry>()
    for (const p of data.known || []) {
      const key = p.name.toLowerCase()
      const existing = byName.get(key)
      if (!existing || (!existing.uuid && p.uuid)) byName.set(key, { ...existing, ...p })
    }
    const tag = (name: string, online: boolean, extra: Partial<PlayerEntry> = {}) => {
      const key = name.toLowerCase()
      if (!byName.has(key)) byName.set(key, { name, online, ...extra })
      else byName.set(key, { ...(byName.get(key) as PlayerEntry), online: byName.get(key)!.online || online, ...extra })
    }
    for (const n of data.online || []) tag(n, true)
    for (const w of data.whitelist || []) tag(w.name, false, { uuid: w.uuid })
    for (const o of data.ops || []) tag(o.name, false, { uuid: o.uuid })
    return Array.from(byName.values())
  }, [data])

  const nameLower = (n: string) => n.toLowerCase()
  const bannedSet = useMemo(() => new Set((data?.banned || []).map((b) => nameLower(b.name))), [data])
  const whitelistSet = useMemo(() => new Set((data?.whitelist || []).map((w) => nameLower(w.name))), [data])
  const opsSet = useMemo(() => new Set((data?.ops || []).map((o) => nameLower(o.name))), [data])

  const filtered = useMemo(() => {
    switch (filter) {
      case 'online': return players.filter((p) => p.online)
      case 'offline': return players.filter((p) => !p.online)
      case 'banned': return players.filter((p) => bannedSet.has(nameLower(p.name)))
      case 'whitelist': return players.filter((p) => whitelistSet.has(nameLower(p.name)))
      case 'ops': return players.filter((p) => opsSet.has(nameLower(p.name)))
      default: return players
    }
  }, [players, filter, bannedSet, whitelistSet, opsSet])

  const counts: Record<Filter, number> = {
    online: players.filter((p) => p.online).length,
    offline: players.filter((p) => !p.online).length,
    banned: players.filter((p) => bannedSet.has(nameLower(p.name))).length,
    whitelist: players.filter((p) => whitelistSet.has(nameLower(p.name))).length,
    ops: players.filter((p) => opsSet.has(nameLower(p.name))).length,
    all: players.length,
  }

  const p = sel ? players.find((x) => x.name.toLowerCase() === sel.toLowerCase()) : null

  const run = async (action: string, args: string[] = []) => {
    if (!sel) return
    setBusy(action)
    setLastOutput(null)
    try {
      const res = await api.post(`/servers/${server.id}/players/action`, { player: sel, action, args })
      const out = (res as any)?.output
      const err = (res as any)?.error || (res as any)?.needsRCON
      if (err) toast.err(err)
      else toast.ok(out || `${action} → ${sel}`)
      if (out) setLastOutput(out)
      load()
    } catch (e: any) { toast.err(e?.message || `Failed to ${action}`) }
    finally { setBusy(null) }
  }

  return (
    <div className="grid cols-1" style={{ gap: 12 }}>
      <div className="card">
        <div className="card-h">
          <Icon name="user" size={15} /> Players <span className="h-sub">no terminal commands needed — actions run via RCON</span>
          {data && <span className={`badge xs ml-2 ${data.rcon.enabled ? 'green' : 'amber'}`}>{data.rcon.enabled ? 'RCON online' : 'RCON off — start server'}</span>}
          <div style={{ flex: 1 }} />
          <button className="btn sm ghost" disabled={loading} onClick={load}><Icon name="restart" size={13} /> Refresh</button>
        </div>

        <div className="flex gap-1 flex-wrap" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
          {FILTERS.map((f) => (
            <button key={f.id} className={`btn sm${filter === f.id ? ' primary' : ' ghost'}`} onClick={() => setFilter(f.id)}>
              {f.label} <span className="xs" style={{ opacity: 0.7 }}>({counts[f.id]})</span>
            </button>
          ))}
        </div>

        {loading && !data ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div> : null}
        {!loading && data && filtered.length === 0 && <div className="empty"><h3 className="sm">No players</h3><p>{filter === 'online' ? 'Nobody is online right now.' : 'Nothing here yet — this list fills as players join.'}</p></div>}
        {data && filtered.length > 0 && (
          <div style={{ maxHeight: '46vh', overflowY: 'auto' }}>
            {filtered.map((pl) => {
              const active = sel && sel.toLowerCase() === pl.name.toLowerCase()
              return (
                <div
                  key={pl.name}
                  className="select-row"
                  style={{ cursor: 'pointer', background: active ? 'var(--bg-2)' : undefined }}
                  onClick={() => setSel(pl.name)}
                >
                  <Icon name="user" size={15} className={pl.online ? 'accent' : 'text-3'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="mono sm">{pl.name}</span>
                    {pl.online && <span className="badge green xs ml-2"><span className="dot pulse" /> online</span>}
                    {bannedSet.has(nameLower(pl.name)) && <span className="badge red xs ml-2">banned</span>}
                    {opsSet.has(nameLower(pl.name)) && <span className="badge amber xs ml-2">op</span>}
                    {!pl.online && <span className="badge gray xs ml-2">offline</span>}
                    <div className="cell-sub xs">{hours(pl.playtimeTicks as number)} played · last join {fmtDate(pl.lastJoined)}</div>
                  </div>
                  <Icon name="chev" size={13} className="text-3" />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {p && (
        <div className="card">
          <div className="card-h">
            <Icon name="user" size={15} /> {p.name}
            {p.online && <span className="badge green xs ml-2"><span className="dot pulse" /> Online</span>}
            {!p.online && <span className="badge gray xs ml-2">Offline</span>}
            <div style={{ flex: 1 }} />
            <button className="btn ghost icon sm" onClick={() => setSel(null)}><Icon name="x" size={14} /></button>
          </div>
          <div className="p-3" style={{ display: 'grid', gap: 6 }}>
            <table className="dtable" style={{ marginBottom: 8 }}>
              <tbody>
                <tr><td className="xs text-3">Playtime</td><td className="mono sm">{hours(p.playtimeTicks as number)}</td></tr>
                <tr><td className="xs text-3">First join</td><td className="sm">{fmtDate(p.firstJoined)}</td></tr>
                <tr><td className="xs text-3">Last join</td><td className="sm">{fmtDate(p.lastJoined)}</td></tr>
              </tbody>
            </table>
            <div className="flex gap-1 flex-wrap" style={{ alignItems: 'center' }}>
              <button className="btn sm" disabled={busy === 'kick' || !p.online} title={!p.online ? 'Player must be online' : ''} onClick={() => run('kick')}>{busy === 'kick' ? <Spinner size={13} /> : <Icon name="power" size={13} />} Kick</button>
              {bannedSet.has(nameLower(p.name))
                ? <button className="btn sm" disabled={busy === 'pardon'} onClick={() => run('pardon')}>{busy === 'pardon' ? <Spinner size={13} /> : <Icon name="unlock" size={13} />} Unban</button>
                : <button className="btn sm" disabled={busy === 'ban'} onClick={() => run('ban')}>{busy === 'ban' ? <Spinner size={13} /> : <Icon name="lock" size={13} />} Ban</button>}
              {whitelistSet.has(nameLower(p.name))
                ? <button className="btn sm ghost" disabled={busy === 'dewhitelist'} onClick={() => run('dewhitelist')}>{busy === 'dewhitelist' ? <Spinner size={13} /> : <Icon name="file" size={13} />} Unwhitelist</button>
                : <button className="btn sm ghost" disabled={busy === 'whitelist'} onClick={() => run('whitelist')}>{busy === 'whitelist' ? <Spinner size={13} /> : <Icon name="file" size={13} />} Whitelist</button>}
              {opsSet.has(nameLower(p.name))
                ? <button className="btn sm ghost" disabled={busy === 'deop'} onClick={() => run('deop')}>{busy === 'deop' ? <Spinner size={13} /> : <Icon name="star" size={13} />} Deop</button>
                : <button className="btn sm ghost" disabled={busy === 'op'} onClick={() => run('op')}>{busy === 'op' ? <Spinner size={13} /> : <Icon name="star" size={13} />} Op</button>}
              <button className="btn sm ghost" disabled={busy === 'teleport' || !p.online} title={!p.online ? 'Player must be online' : ''} onClick={() => run('teleport')}>{busy === 'teleport' ? <Spinner size={13} /> : <Icon name="map" size={13} />} Teleport</button>
              <button className="btn sm ghost" disabled={busy === 'inventory' || !p.online} title={!p.online ? 'Player must be online' : ''} onClick={() => run('inventory')}>{busy === 'inventory' ? <Spinner size={13} /> : <Icon name="box" size={13} />} Inventory</button>
              <button className="btn sm ghost" disabled={busy === 'enderchest' || !p.online} title={!p.online ? 'Player must be online' : ''} onClick={() => run('enderchest')}>{busy === 'enderchest' ? <Spinner size={13} /> : <Icon name="box" size={13} />} Ender Chest</button>
            </div>
            {!data?.rcon.enabled && (
              <div className="xs text-3 mt-2">
                RCON is off — start the server once to enable player actions. {(data?.rcon as any)?.reason ? `(${(data as any).rcon.reason})` : ''}
              </div>
            )}
            {lastOutput && (
              <div className="xs mono" style={{ background: 'var(--bg-2)', padding: 8, borderRadius: 6, marginTop: 4 }}>{lastOutput}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function allPlayerNames(d: SnapshotResp): string[] {
  const names = new Set<string>()
  for (const p of d?.known || []) names.add(p.name)
  for (const n of d?.online || []) names.add(n)
  for (const l of [...(d?.whitelist || []), ...(d?.ops || []), ...(d?.banned || [])]) names.add(l.name)
  return Array.from(names)
}