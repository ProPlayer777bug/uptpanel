import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import { useApp } from '../../state/auth'
import { Icon, Modal, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

export function SettingsTab({ server }: { server: Server }) {
  const navigate = useNavigate()
  const { refresh } = useApp()
  const [confirm, setConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reinstalling, setReinstalling] = useState(false)
  const [typedName, setTypedName] = useState('')

  const reinstall = async () => {
    if (!window.confirm(`Reinstall ${server.name}? This wipes its files and rebuilds from the image.`)) return
    setReinstalling(true)
    try { await api.post(`/servers/${server.id}/reinstall`, {}); toast.ok('Reinstall complete — server rebuilt'); refresh() }
    catch (e: any) { toast.err(e?.message) }
    finally { setReinstalling(false) }
  }

  const remove = async () => {
    setDeleting(true)
    try {
      await api.del(`/servers/${server.id}`)
      toast.ok('Server deleted')
      refresh()
      navigate('/servers')
    } catch (e: any) { toast.err(e?.message) }
    finally { setDeleting(false); setConfirm(false) }
  }

  const env = server.extraEnv || {}
  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="card-h"><Icon name="gear" size={15} /> Environment & limits</div>
        <div className="card-b">
          <InfoRow k="Runtime" v={<div className="sm">{friendlyRuntime(server.blueprint?.image)}</div>} />
          <InfoRow k="Startup" v={<div className="sm">{friendlyStartup(server.blueprint?.startup)}</div>} />
          <InfoRow k="Memory limit" v={<div className="mono sm">{server.memoryLimitMb} MB</div>} />
          <InfoRow k="CPU limit" v={<div className="mono sm">{server.cpuPercent}%</div>} />
          <InfoRow k="Disk" v={<div className="mono sm">{server.storageGb} GB</div>} />
          {Object.keys(env).length > 0 && (
            <div className="mt-3">
              <div className="xs text-3 mb-2" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Environment variables</div>
              <div className="code-block">{Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}</div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ borderColor: 'rgba(242,95,92,0.35)' }}>
        <div className="card-h"><Icon name="trash" size={15} /> Danger zone</div>
        <div className="card-b">
          <p className="sm text-2 mb-3">Reinstall wipes the server's files and rebuilds it from the image. Deleting removes the container, files and all associated data permanently.</p>
          <div className="flex gap-2">
            <button className="btn" onClick={reinstall} disabled={reinstalling}><Icon name="restart" size={14} /> {reinstalling ? 'Reinstalling…' : 'Reinstall'}</button>
            <button className="btn danger" onClick={() => { setTypedName(''); setConfirm(true) }}><Icon name="trash" size={14} /> Delete server</button>
          </div>
        </div>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete server?" width={440}>
        <p className="sm text-2 mb-3">
          Permanently delete <b>{server.name}</b> and its container, files and data. This cannot be undone.
          To confirm, type the server name <b className="mono">{server.name}</b> below.
        </p>
        <div className="field">
          <input
            className="input mono"
            placeholder={server.name}
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
          />
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn danger" onClick={remove} disabled={deleting || typedName !== server.name}>
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </Modal>
    </div>
  )
}

function InfoRow({ k, v }: { k: string; v: any }) {
  return <div className="info-row"><span className="k">{k}</span><span>{v}</span></div>
}

function friendlyRuntime(img: string | undefined): string {
  if (!img) return '—'
  const m = /(?:java|openjdk)[_-]?(\d+)/i.exec(img)
  if (m) return `Java ${m[1]} runtime`
  const tag = img.split(':').pop()
  if (tag) return tag.charAt(0).toUpperCase() + tag.slice(1)
  return img
}

function friendlyStartup(startup: string | undefined): string {
  if (!startup) return '—'
  if (/java\b/.test(startup)) return 'Minecraft runtime launcher'
  return startup.trim().split(/\s+/)[0] || '—'
}
