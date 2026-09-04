import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Button, Icon, Spinner, toast, ConfirmDialog, EmptyState } from './ui'

// Generic API-key manager. Works for account-level keys (/api/account/api-keys)
// or server-scoped keys (/api/servers/:id/api-keys).
export function ApiKeys({ kind, serverId }: { kind: 'account' | 'server'; serverId?: string }) {
  const [keys, setKeys] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<any | null>(null)

  const base = kind === 'server' && serverId ? `/servers/${serverId}/api-keys` : '/account/api-keys'

  const load = async () => {
    setLoading(true)
    try { setKeys((await api.get(base)).keys || []) }
    catch (e: any) { toast.err(e?.message || 'Failed to load keys') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [base])

  const create = async () => {
    setBusy(true)
    try {
      const r = await api.post(base, { label })
      setKeys((prev) => [...prev, r.key].map((k) => ({ ...k, masked: k.token ? k.token.slice(0, 6) + '…' + k.token.slice(-4) : k.masked })))
      setRevealed(r.key.token) // show token exactly once
      setLabel('')
      toast.ok('Key created — copy it now, it is shown only once')
    } catch (e: any) { toast.err(e?.message || 'Create failed') }
    finally { setBusy(false) }
  }

  const remove = async () => {
    try {
      await api.del(`${base}/${deleting.id}`)
      setKeys((prev) => prev.filter((k) => k.id !== deleting.id))
      setDeleting(null)
      toast.ok('Key deleted')
    } catch (e: any) { toast.err(e?.message || 'Delete failed') }
  }

  return (
    <div className="flex-col gap-3" style={{ minWidth: 0 }}>
      <div className="flex gap-2 items-center">
        <input className="input flex-1 mono" placeholder={kind === 'account' ? 'Label e.g. my-discord-bot' : 'Label e.g. discord-bot'} value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button variant="primary" size="sm" icon="plus" loading={busy} disabled={!label.trim()} onClick={create}>Create key</Button>
      </div>

      {revealed && (
        <div className="card" style={{ borderColor: 'var(--accent)', padding: 14 }}>
          <div className="flex items-center justify-between gap-2">
            <div style={{ minWidth: 0 }}>
              <div className="xs text-3 bold" style={{ marginBottom: 4 }}>New API key — copy and store it securely. You will not see it again.</div>
              <code className="err-code" style={{ wordBreak: 'break-all' }}>{revealed}</code>
            </div>
            <Button variant="subtle" size="sm" icon="copy" onClick={() => { navigator.clipboard?.writeText(revealed); toast.ok('Copied') }}>Copy</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="center" style={{ padding: 30 }}><Spinner size={22} /></div>
      ) : keys.length === 0 ? (
        <div className="card"><EmptyState icon="key" title="No API keys" desc="Create a key to let external tools (e.g. a Discord bot) talk to this {kind} via the API." action={undefined} /></div>
      ) : (
        <div className="flex-col gap-2">
          {keys.map((k) => (
            <div key={k.id} className="card" style={{ padding: 12 }}>
              <div className="flex items-center gap-2">
                <Icon name="key" size={15} />
                <span className="cell-main">{k.label}</span>
                <div style={{ flex: 1 }} />
                <span className="xs text-3 mono">{k.masked}</span>
                <Button variant="ghost" size="icon" icon="trash" onClick={() => setDeleting(k)} title="Delete" />
              </div>
              <div className="cell-sub mono xs">Created {new Date(k.createdAt || Date.now()).toLocaleDateString()} · Permissions: {Object.keys(k.permissions || {}).filter((p) => k.permissions[p]).join(', ') || 'view'}</div>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
          title="Delete API key"
          message={`Delete key "${deleting.label}"? Anything using it will immediately stop working.`}
          confirmLabel="Delete key"
          danger
        />
      )}
    </div>
  )
}
