import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Modal, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface CatalogVersion { id: string; name: string; type: 'vanilla' | 'paper' | 'purpur' | 'folia'; java: number | null; url: string | null; release: boolean }
interface PluginInfo { id: string; name: string; description: string; source: 'spigot' | 'modrinth'; author: string | null; downloads: number; icon: string | null; url: string | null; latestVersion: string | null; downloadUrl: string | null; kind: 'plugin' | 'mod' }

const PLATFORMS: { id: string; label: string }[] = [
  { id: 'all', label: 'All platforms' },
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'paper', label: 'Paper' },
  { id: 'purpur', label: 'Purpur' },
  { id: 'folia', label: 'Folia' },
]

export function isMcServer(server: Server) {
  return server.blueprintId === 'bp-minecraft' || server.blueprintId === 'bp-paper'
}

export function VersionManager({ server, open, onClose }: { server: Server; open: boolean; onClose: () => void }) {
  const [catalog, setCatalog] = useState<{ versions: CatalogVersion[]; plugins: PluginInfo[] } | null>(null)
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('all')
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    api.get('/catalog').then((d) => setCatalog(d.catalog)).catch((e: any) => toast.err(e?.message))
    setTarget(null)
    setQuery('')
    setPlatform('all')
  }, [open])

  const versions = useMemo(() => {
    const list = catalog?.versions || []
    let filtered = platform === 'all' ? list : list.filter((v) => v.type === platform)
    const q = query.trim().toLowerCase()
    if (q) filtered = filtered.filter((v) => v.name.toLowerCase().includes(q) || v.type.toLowerCase().includes(q))
    const cur = server.mcVersion
    const curPlat = server.mcPlatform
    const sorted = [...filtered].sort((a, b) => {
      const ac = a.type === curPlat && a.name === cur ? 0 : 1
      const bc = b.type === curPlat && b.name === cur ? 0 : 1
      return ac - bc
    })
    return sorted
  }, [catalog, query, platform, server.mcVersion, server.mcPlatform])

  const apply = async () => {
    if (!target) return
    setBusy(true)
    try {
      await api.post(`/servers/${server.id}/version`, { version: target })
      toast.ok(`Switched to ${target} — server ready`)
      onClose()
    } catch (e: any) { toast.err(e?.message || 'Failed to change version') }
    finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Change version — ${server.name}`} width={600}>
      <div className="flex gap-2 panel-row mb-2">
        <input className="input flex-1" placeholder="Search versions or platform…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="select" style={{ width: 150 }} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div className="xs text-3 mb-2">Current: <b style={{ color: 'var(--text)' }}>{server.mcPlatform || '—'} {server.mcVersion || ''}</b></div>
      <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
        {!catalog ? (
          <div className="center" style={{ padding: 30 }}><Spinner size={22} /></div>
        ) : versions.length === 0 ? (
          <div className="center xs text-3" style={{ padding: 30 }}>No versions found</div>
        ) : (
          versions.map((v) => {
            const isCur = v.type === server.mcPlatform && v.name === server.mcVersion
            const selected = target === v.id
            return (
              <div
                key={v.id}
                className="select-row"
                style={{ cursor: 'pointer' }}
                onClick={() => setTarget(v.id)}
              >
                <Icon name="box" size={15} className={isCur ? 'text-3' : 'accent'} />
                <div style={{ flex: 1 }}>
                  <div className="cell-main">
                    {v.name} {!v.release && <span className="badge amber xs">build</span>} {isCur && <span className="badge gray xs">current</span>}
                  </div>
                  <div className="cell-sub mono xs">
                    <span className={`badge xs ${v.type === 'vanilla' ? 'green' : v.type === 'purpur' ? 'cyan' : v.type === 'folia' ? 'blue' : 'amber'}`}>{v.type}</span>
                    {' '}· Java {v.java || '—'}
                  </div>
                </div>
                {!isCur && (
                  <input type="radio" checked={selected} readOnly />
                )}
              </div>
            )
          })
        )}
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <div style={{ flex: 1 }} />
        <button className="btn primary" disabled={!target || busy} onClick={apply}>
          {busy ? <Spinner size={15} /> : <><Icon name="box" size={14} /> Switch to {target ? target.replace('@', ' ') : '…'}</>}
        </button>
      </div>
      <div className="xs text-3 mt-2">Only server.jar is replaced — world data and plugins are preserved. The server must be stopped to switch.</div>
    </Modal>
  )
}

export function PluginManager({ server, open, onClose }: { server: Server; open: boolean; onClose: () => void }) {
  const [catalog, setCatalog] = useState<{ versions: CatalogVersion[]; plugins: PluginInfo[] } | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'spigot' | 'modrinth'>('all')
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    api.get('/catalog').then((d) => setCatalog(d.catalog)).catch((e: any) => toast.err(e?.message))
    setQuery('')
  }, [open])

  const plugins = useMemo(() => {
    const list = catalog?.plugins || []
    const q = query.trim().toLowerCase()
    return list.filter((p) => {
      if (p.kind === 'mod') return false
      if (source !== 'all' && p.source !== source) return false
      if (!q) return true
      return p.name.toLowerCase().includes(q) || (p.author || '').toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    })
  }, [catalog, query, source])

  const install = async (p: PluginInfo) => {
    setBusy(p.id)
    try {
      await api.post(`/servers/${server.id}/plugins`, { pluginId: p.id })
      toast.ok(`Installed ${p.name} — restart server to load`)
    } catch (e: any) { toast.err(e?.message || 'Failed to install') }
    finally { setBusy(null) }
  }

  const fmt = (n: number) => n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  return (
    <Modal open={open} onClose={onClose} title={`Install plugins — ${server.name}`} width={600}>
      <div className="flex gap-2 panel-row mb-2">
        <input className="input flex-1" placeholder="Search plugins by name, author, or description…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="select" style={{ width: 130 }} value={source} onChange={(e) => setSource(e.target.value as any)}>
          <option value="all">All sources</option>
          <option value="spigot">SpigotMC</option>
          <option value="modrinth">Modrinth</option>
        </select>
      </div>
      <div className="xs text-3 mb-2">Downloaded to <b style={{ color: 'var(--text)' }}>plugins/</b> — restart the server to load.</div>
      <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
        {!catalog ? (
          <div className="center" style={{ padding: 30 }}><Spinner size={22} /></div>
        ) : plugins.length === 0 ? (
          <div className="center xs text-3" style={{ padding: 30 }}>No plugins found</div>
        ) : (
          plugins.map((p) => (
            <div key={p.id} className="select-row">
              {p.icon
                ? <img src={p.icon} alt="" style={{ width: 26, height: 26, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                : <Icon name="box" size={18} className="accent" />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cell-main" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.name}
                  <span className={`badge xs ${p.source === 'spigot' ? 'amber' : 'cyan'}`}>{p.source}</span>
                </div>
                <div className="cell-sub xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.description || '—'} · {p.author ? `${p.author} · ` : ''}{fmt(p.downloads)} downloads
                </div>
              </div>
              {busy === p.id
                ? <Spinner size={16} />
                : <button className="btn sm primary" onClick={() => install(p)}><Icon name="download" size={13} /> Install</button>}
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}
