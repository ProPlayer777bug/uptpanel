import { useEffect, useState } from 'react'
import { api, downloadBlob } from '../../api/client'
import { useSocket } from '../../hooks/useSocket'
import { Icon, Spinner, Switch, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface AutoBackup {
  enabled: boolean
  intervalHours: number
  retention: number
  nextAt: number | null
  lastAt: number | null
  lastStatus: string | null
}

interface Backup {
  id: string
  serverId: string
  name: string
  uuid: string
  file: string
  sizeBytes: number
  status: string
  createdAt: number
  completedAt: number | null
  error: string | null
}

function fmt(n: number): string {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let v = n, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${u[i]}`
}

export function BackupsTab({ server }: { server: Server }) {
  const [backups, setBackups] = useState<Backup[] | null>(null)
  const [auto, setAuto] = useState<AutoBackup | null>(null)
  const [live, setLive] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [savingAuto, setSavingAuto] = useState(false)
  const [name, setName] = useState('')

  const load = () => {
    setLoading(true)
    api.get(`/servers/${server.id}/backups`).then((d) => { setBackups(d.backups); setAuto(d.autoBackup) }).catch((e: any) => toast.err(e?.message)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [server.id])

  useSocket((msg: any) => {
    if (msg.type === 'backup-progress' && msg.data?.serverId === undefined && msg.data?.backupId) {
      setLive((m) => ({ ...m, [msg.data.backupId]: msg.data.status }))
    }
  })

  const create = async () => {
    setBusy(true)
    try {
      const r = await api.post(`/servers/${server.id}/backups`, { name: name || undefined })
      toast.info('Backup started')
      if (r.backup) setLive((m) => ({ ...m, [r.backup.id]: 'running' }))
      setName('')
      load()
    } catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const download = async (b: Backup) => {
    try { await downloadBlob(`/servers/${server.id}/backups/${b.id}/download`, b.file) }
    catch (e: any) { toast.err(e?.message) }
  }
  const restore = async (b: Backup) => {
    if (!confirm(`Restore server files from backup "${b.name}"? This overwrites current files.`)) return
    setBusy(true)
    try { await api.post(`/servers/${server.id}/backups/${b.id}/restore`, {}); toast.ok('Restore complete') }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const remove = async (b: Backup) => {
    if (!confirm(`Delete backup "${b.name}"?`)) return
    setBusy(true)
    try { await api.del(`/servers/${server.id}/backups/${b.id}`); toast.ok('Backup deleted'); load() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  const status = (b: Backup) => live[b.id] || b.status

  const saveAuto = async () => {
    if (!auto) return
    setSavingAuto(true)
    try {
      const r = await api.post(`/servers/${server.id}/backups/auto`, auto)
      setAuto(r.autoBackup)
      toast.ok(auto.enabled ? 'Auto backups enabled' : 'Auto backups disabled')
    } catch (e: any) { toast.err(e?.message || 'Failed to save settings') }
    finally { setSavingAuto(false) }
  }

  const nextRun = auto?.nextAt ? new Date(auto.nextAt).toLocaleString() : '—'

  return (
    <div className="grid cols-1" style={{ gap: 12 }}>
      <div className="card">
        <div className="card-h">
          <Icon name="clock" size={15} /> Auto backup <span className="h-sub">scheduled snapshots kept on the node</span>
          <div style={{ flex: 1 }} />
          <Switch checked={!!auto?.enabled} onChange={(v) => auto && setAuto({ ...auto, enabled: v })} />
        </div>
        <div className="p-3" style={{ display: 'grid', gap: 12 }}>
          <div className="flex gap-2 items-center flex-wrap">
            <span className="xs text-3">Backup every</span>
            <select className="select" style={{ width: 130 }} disabled={!auto?.enabled} value={auto?.intervalHours || 24}
              onChange={(e) => auto && setAuto({ ...auto, intervalHours: Number(e.target.value) })}>
              {[1, 3, 6, 12, 24, 48, 72, 168].map((h) => (
                <option key={h} value={h}>{h === 1 ? '1 hour' : h === 24 ? 'every day' : h === 168 ? 'every week' : `${h} hours`}</option>
              ))}
            </select>
            <span className="xs text-3">keep</span>
            <input className="input sm" style={{ width: 70 }} type="number" min={1} max={100} disabled={!auto?.enabled}
              value={auto?.retention ?? 10} onChange={(e) => auto && setAuto({ ...auto, retention: Math.max(1, Math.min(100, Number(e.target.value) || 10)) })} />
            <span className="xs text-3">backups</span>
            <div style={{ flex: 1 }} />
            {auto?.enabled && (
              <span className="xs text-3">
                next run <b style={{ color: 'var(--text)' }}>{nextRun}</b>
                {auto.lastStatus && <> · last <span className={`badge xs ml-1 ${auto.lastStatus === 'ok' ? 'green' : 'amber'}`}>{auto.lastStatus}</span></>}
              </span>
            )}
            <button className="btn sm primary" disabled={savingAuto || !auto} onClick={saveAuto}>
              {savingAuto ? <Spinner size={13} /> : <Icon name="check" size={13} />} Save
            </button>
          </div>
          <div className="xs text-3">Auto backups archive the server's files and delete the oldest copy once more than the keep limit exist. A new backup only runs while the server's node is reachable.</div>
        </div>
      </div>

      <div className="card">
      <div className="card-h">
        <Icon name="download" size={15} /> Backups <span className="h-sub">real ZIP archives on the node</span>
        <div style={{ flex: 1 }} />
        <input className="inp xs" style={{ width: 180 }} placeholder="Backup name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm primary" onClick={create} disabled={busy}><Icon name="plus" size={13} /> New backup</button>
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {loading && backups == null ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
        : !backups || backups.length === 0 ? (
          <div className="empty"><h3>No backups</h3><p>Create a backup to archive the server's files and restore them later.</p></div>
        ) : (
          <table className="dtable">
            <thead><tr><th>Name</th><th>Status</th><th>Size</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td><span className="cell-main">{b.name}</span></td>
                  <td>
                    {(() => {
                      const s = status(b)
                      if (s === 'running') return <span className="badge blue"><span className="dot pulse" /> Running</span>
                      if (s === 'failed') return <span className="badge red">Failed</span>
                      return <span className="badge green">Completed</span>
                    })()}
                  </td>
                  <td className="mono sm">{fmt(b.sizeBytes)}</td>
                  <td className="sm text-2">{new Date(b.createdAt).toLocaleString()}</td>
                  <td>
                    <div className="flex gap-1" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm ghost" onClick={() => download(b)} disabled={status(b) === 'running'}><Icon name="download" size={13} /> Download</button>
                      <button className="btn sm ghost" onClick={() => restore(b)} disabled={status(b) === 'running'}><Icon name="restart" size={13} /> Restore</button>
                      <button className="btn sm ghost" onClick={() => remove(b)}><Icon name="trash" size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </div>
  )
}
