import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { ConfirmDialog, Icon, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface SftpCreds { host: string; port: number; username: string; password: string }

export function SftpTab({ server }: { server: Server }) {
  const [creds, setCreds] = useState<SftpCreds | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true); setErr('')
    api.get(`/servers/${server.id}/sftp`)
      .then((d) => setCreds(d.sftp))
      .catch((e: any) => setErr(e?.message || 'Failed to load SFTP credentials'))
      .finally(() => setLoading(false))
  }, [server.id])

  useEffect(() => load(), [load])

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast.ok(`${label} copied`) }
    catch { toast.err('Copy failed') }
  }

  const rotate = async () => {
    setBusy(true)
    setConfirmRotate(false)
    try {
      const d = await api.post(`/servers/${server.id}/sftp/rotate`, {})
      setCreds(d.sftp)
      toast.ok('SFTP password regenerated')
    } catch (e: any) { toast.err(e?.message || 'Failed to rotate password') }
    finally { setBusy(false) }
  }

  const host = server.node?.host || creds?.host || ''

  return (
    <div className="card">
      <div className="card-h"><Icon name="key" size={15} /> SFTP access</div>

      {loading ? (
        <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
      ) : err ? (
        <div className="empty"><h3 className="sm">{err}</h3></div>
      ) : creds ? (
        <div style={{ padding: '16px 18px', display: 'grid', gap: 12 }}>
          <p className="sm text-2" style={{ margin: 0, maxWidth: 640 }}>
            Connect to this server's files with any SFTP client, your terminal, or a code editor's
            remote panel. Sessions are sandboxed to this server's data directory only.
          </p>

          <div className="grid panel-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
            {[['Host', host], ['Port', String(creds.port)], ['Username', creds.username], ['Password', creds.password]].map(([label, value]) => (
              <div key={label} className="flex items-center gap-2" style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}>
                <span className="xs text-3" style={{ width: 60 }}>{label}</span>
                <input readOnly className="input sm mono" style={{ flex: 1, minWidth: 0 }} value={value} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn sm ghost icon" title={`Copy ${label.toLowerCase()}`} onClick={() => copy(value, label)}><Icon name="copy" size={14} /></button>
              </div>
            ))}
          </div>

          <div style={{ background: 'var(--code-bg)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }} className="mono sm">
            <span className="text-2">$ </span>sftp {creds.username}@{host}{creds.port !== 22 ? ` -P ${creds.port}` : ''}
          </div>

          <div className="flex items-center gap-2">
            <span className="xs text-3">Need a client? </span>
            <a className="link sm" href="https://filezilla-project.org/" target="_blank" rel="noreferrer">FileZilla</a>
            <span className="text-3 xs">·</span>
            <a className="link sm" href="https://winscp.net/" target="_blank" rel="noreferrer">WinSCP</a>
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" disabled={busy} onClick={() => setConfirmRotate(true)}><Icon name="restart" size={13} /> Regenerate password</button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRotate}
        title="Regenerate SFTP password?"
        message="The current SFTP password will stop working immediately. Connections using it will be rejected."
        confirmLabel="Regenerate"
        danger
        busy={busy}
        onClose={() => setConfirmRotate(false)}
        onConfirm={rotate}
      />
    </div>
  )
}