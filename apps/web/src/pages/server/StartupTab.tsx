import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface StartupData {
  startup: Record<string, string>
  extraEnv: Record<string, string>
  blueprintEnv: Record<string, string>
  startupCommand: string
  resourceLimits: { cpuPercent: number; memoryLimitMb: number; storageGb: number }
}

export function StartupTab({ server }: { server: Server }) {
  const [data, setData] = useState<StartupData | null>(null)
  const [env, setEnv] = useState<Record<string, string>>({})
  const [limits, setLimits] = useState({ cpuPercent: 100, memoryLimitMb: 1024, storageGb: 5 })
  const [busy, setBusy] = useState(false)

  const load = () => {
    api.get(`/servers/${server.id}/startup`).then((d) => {
      setData(d)
      setEnv({ ...(d.extraEnv || {}) })
      setLimits(d.resourceLimits || { cpuPercent: 100, memoryLimitMb: 1024, storageGb: 5 })
    }).catch((e: any) => toast.err(e?.message))
  }
  useEffect(() => { load() }, [server.id])

  const updateKey = (k: string, v: string) => setEnv((m) => ({ ...m, [k]: v }))
  const addKey = () => { const k = `ENV_${Object.keys(env).length + 1}`; setEnv((m) => ({ ...m, [k]: '' })) }
  const delKey = (k: string) => { setEnv((m) => { const n = { ...m }; delete n[k]; return n }) }

  const save = async () => {
    setBusy(true)
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) if (k.trim() && v !== undefined) cleaned[k.trim()] = v || ''
    try {
      await api.post(`/servers/${server.id}/startup`, { extraEnv: cleaned, resourceLimits: limits })
      toast.ok('Startup configuration saved')
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
        <div className="sm text-3 mb-2">Startup command</div>
        <div className="term-line mono" style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)' }}>{data.startupCommand || '—'}</div>

        <div className="sm text-3 mb-2 mt-4">Environment variables</div>
        <div className="flex mt-1" style={{ alignItems: 'center' }}>
          <span className="sm text-3" style={{ width: '40%' }}>Key</span>
          <span className="sm text-3" style={{ width: '40%' }}>Value</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={addKey}><Icon name="plus" size={13} /> Add</button>
        </div>
        {Object.entries(env).map(([k, v]) => (
          <div key={k} className="flex mt-1" style={{ alignItems: 'center', gap: 6 }}>
            <input className="inp xs mono" style={{ width: '40%' }} value={k} onChange={(e) => { const nv = { ...env }; delete nv[k]; nv[e.target.value] = v; setEnv(nv) }} />
            <input className="inp xs mono" style={{ width: '40%' }} value={v} onChange={(e) => updateKey(k, e.target.value)} />
            <button className="btn sm ghost icon" onClick={() => delKey(k)}><Icon name="trash" size={13} /></button>
          </div>
        ))}
        {Object.keys(data.blueprintEnv).length > 0 && (
          <div className="xs text-3 mt-2">Blueprint-managed: {Object.keys(data.blueprintEnv).join(', ')}</div>
        )}

        <div className="sm text-3 mb-2 mt-4">Resource limits</div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <label>CPU % <input className="inp" type="number" value={limits.cpuPercent} onChange={(e) => setLimits({ ...limits, cpuPercent: Number(e.target.value) })} /></label>
          <label>Memory (MB) <input className="inp" type="number" value={limits.memoryLimitMb} onChange={(e) => setLimits({ ...limits, memoryLimitMb: Number(e.target.value) })} /></label>
          <label>Storage (GB) <input className="inp" type="number" value={limits.storageGb} onChange={(e) => setLimits({ ...limits, storageGb: Number(e.target.value) })} /></label>
        </div>
      </div>
    </div>
  )
}
