import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast } from '../../components/ui'
import { useApp } from '../../state/auth'
import type { Server } from '@uptimehost/types'

interface StartupData {
  startup: Record<string, string>
  extraEnv: Record<string, string>
  blueprintEnv: Record<string, string>
  startupCommand: string
  resourceLimits: { cpuPercent: number; memoryLimitMb: number; storageGb: number }
}

function previewCommand(data: StartupData, env: Record<string, string>): string {
  let cmd = data.startupCommand || ''
  const all = { ...(data.blueprintEnv || {}), ...env }
  cmd = cmd.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, k) => all[k] ?? `{{${k}}}`)
  return cmd
}

function componentIfMinecraft(server: Server) {
  const isMc = server.blueprintId === 'bp-minecraft' || server.blueprintId === 'bp-paper'
  if (!isMc) return null
  const { mcVersion, javaVersion } = server as any
  const reinstall = async () => {
    const ok = window.confirm('Reinstall this server at its current pinned version? This rewrites server.jar and resets to default files (world data is preserved).')
    if (!ok) return
    try {
      await api.post(`/servers/${server.id}/reinstall`, {})
      toast.ok('Reinstall started')
    } catch (e: any) { toast.err(e?.message) }
  }
  return (
    <div className="flex mt-3 mb-3" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="badge cyan sm"><Icon name="box" size={12} /> Minecraft</span>
      <span className="badge gray sm mono">MC {mcVersion || '—'}</span>
      <span className="badge gray sm mono">Java {javaVersion || '—'}</span>
      <span className="xs text-3">This server is pinned — new panel releases never change it. Reinstall to reselect.</span>
      <div style={{ flex: 1 }} />
      <button className="btn sm ghost" onClick={reinstall}><Icon name="restart" size={13} /> Reinstall</button>
    </div>
  )
}

export function StartupTab({ server }: { server: Server }) {
  const { refresh } = useApp()
  const [data, setData] = useState<StartupData | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [limits, setLimits] = useState({ cpuPercent: 100, memoryLimitMb: 1024, storageGb: 5 })
  const [busy, setBusy] = useState(false)

  // Server-level policies editable by admins (persisted via PUT /servers/:id).
  const [name, setName] = useState(server.name || '')
  const [maxBackups, setMaxBackups] = useState(String((server as any).maxBackups ?? 1))
  const [maxAllocations, setMaxAllocations] = useState(String((server as any).maxAllocations ?? 1))

  const load = () => {
    api.get(`/servers/${server.id}/startup`).then((d) => {
      setData(d)
      setEnv({ ...(d.extraEnv || {}) })
      setLimits(d.resourceLimits || { cpuPercent: 100, memoryLimitMb: 1024, storageGb: 5 })
    }).catch((e: any) => toast.err(e?.message))
  }
  useEffect(() => { load() }, [server.id])

  const updateKey = (k: string, v: string) => setEnv((m) => ({ ...m, [k]: v }))
  const addKey = () => {
    let n = 1
    while (env[`ENV_${n}`] !== undefined) n++
    const k = `ENV_${n}`
    setEnv((m) => ({ ...m, [k]: '' }))
  }
  const delKey = (k: string) => { setEnv((m) => { const n = { ...m }; delete n[k]; return n }) }

  const save = async () => {
    setBusy(true)
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (k.trim() && v !== undefined) cleaned[k.trim()] = v || ''
    try {
      await api.post(`/servers/${server.id}/startup`, { extraEnv: cleaned, resourceLimits: limits })
      // Keep the resource limits posted through Startup in sync with the quotas
      // editor, then persist the name/quota changes via the server PUT editor.
      await api.put(`/servers/${server.id}`, {
        name: name.trim() || undefined,
        maxBackups: Number(maxBackups) || undefined,
        maxAllocations: Number(maxAllocations) || undefined,
      })
      toast.ok('Configuration saved')
      refresh()
      load()
    } catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  if (!data) return <div className="card"><div className="center" style={{ padding: 50 }}><Spinner size={22} /></div></div>

  return (
    <div className="card">
      <div className="card-h">
        <Icon name="gear" size={15} /> Startup &amp; configuration <span className="h-sub">environment + resource limits</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={save} disabled={busy}><Icon name="play" size={13} /> Save</button>
      </div>

      <div className="p-3">
        <div className="sm text-3 mb-2">Server name</div>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />

        <div className="sm text-3 mb-2 mt-4">Server policies</div>
        <div className="grid panel-2" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label>Backup limit
            <input className="inp" type="number" min={1} max={100} value={maxBackups} onChange={(e) => setMaxBackups(e.target.value)} />
            <span className="xs text-3">Max backups this server can hold at once (auto-backups prune to this too).</span>
          </label>
          <label>Allocation limit
            <input className="inp" type="number" min={1} max={100} value={maxAllocations} onChange={(e) => setMaxAllocations(e.target.value)} />
            <span className="xs text-3">Max ports/addresses this server may use. Most servers need 1.</span>
          </label>
        </div>

        <div className="sm text-3 mb-2 mt-4">Startup command</div>
        <div className="term-line mono" style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>{data.startupCommand || '—'}</div>

        <div className="sm text-3 mb-2 mt-4">Preview (with env substituted)</div>
        <div className="term-line mono" style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', color: 'var(--accent)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {previewCommand(data, env)}
        </div>

        {componentIfMinecraft(server)}

        <div className="sm text-3 mb-2 mt-4">Environment variables</div>
        <div className="flex mt-1" style={{ alignItems: 'center' }}>
          <span className="sm text-3" style={{ width: '40%' }}>Key</span>
          <span className="sm text-3" style={{ width: '40%' }}>Value</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={addKey}><Icon name="plus" size={13} /> Add</button>
        </div>
        {/* Row keyed by stable array index, NOT by env key: typing in the Key field
            renames the entry and would otherwise unmount/remount this row (React key
            = old name), dropping input focus after every keystroke. */}
        {Object.entries(env).map(([k, v], i) => (
          <div key={i} className="flex mt-1" style={{ alignItems: 'center', gap: 6 }}>
            <input className="inp xs mono" style={{ width: '40%' }} value={k} onChange={(e) => { const nv = { ...env }; delete nv[k]; nv[e.target.value] = v; setEnv(nv) }} />
            <input className="inp xs mono" style={{ width: '40%' }} value={v} onChange={(e) => updateKey(k, e.target.value)} />
            <button className="btn sm ghost icon" onClick={() => delKey(k)}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        {Object.keys(data.blueprintEnv).length > 0 && (
          <div className="xs text-3 mt-2">Blueprint-managed: {Object.keys(data.blueprintEnv).join(', ')}</div>
        )}

        <div className="sm text-3 mb-2 mt-4">Resource limits</div>
        <div className="grid panel-3" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <label>CPU % <input className="inp" type="number" value={limits.cpuPercent} onChange={(e) => setLimits({ ...limits, cpuPercent: Number(e.target.value) })} /></label>
          <label>Memory (MB) <input className="inp" type="number" value={limits.memoryLimitMb} onChange={(e) => setLimits({ ...limits, memoryLimitMb: Number(e.target.value) })} /></label>
          <label>Storage (GB) <input className="inp" type="number" value={limits.storageGb} onChange={(e) => setLimits({ ...limits, storageGb: Number(e.target.value) })} /></label>
        </div>
      </div>
    </div>
  )
}
