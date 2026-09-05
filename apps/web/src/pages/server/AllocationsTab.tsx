import { useState } from 'react'
import { publicAddress } from '../../utils/mask'
import { api } from '../../api/client'
import { useApp } from '../../state/auth'
import { Icon, Spinner, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

// Allocations tab: lets any collaborator see the ports assigned to the server
// and pick which one is advertised as the connect address (primary). The
// remaining allocations stay usable for plugins that bind their own port, e.g.
// a GeyserMC Bedrock listener on a UDP port.
export function AllocationsTab({ server }: { server: Server }) {
  const { refresh } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const allocs = server.allocations || []
  const canManage = !!server.permissions?.files
  const primaryId = (server as any).primaryAllocationId

  const makePrimary = async (a: any) => {
    setBusy(a.id)
    try {
      await api.post(`/servers/${server.id}/allocations/${a.id}/primary`, {})
      toast.ok(`Port ${a.port} is now the primary allocation`)
      refresh()
    } catch (e: any) {
      toast.err(e?.message || 'Failed to set primary allocation')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="grid cols-1">
      <div className="card">
        <div className="card-h">
          <Icon name="node" size={15} /> Allocations <span className="h-sub">the ports assigned to this server</span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 8 }}>
          {allocs.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}><p>No allocations assigned yet.</p></div>
          ) : (
            allocs.map((a) => {
              const addr = publicAddress(a, server.node) || `${(a as any).alias || (a as any).ip || '—'}:${a.port}`
              const isPrimary = a.id === primaryId
              return (
                <div key={a.id} className="alloc" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="mono sm">{addr}</span>
                    {isPrimary && <span className="badge success xs ml-2">primary</span>}
                    <div className="xs text-3 mt-1">TCP port {a.port}{a.proto && a.proto !== 'tcp' ? ` · ${a.proto}` : ''} — players connect here</div>
                  </div>
                  {canManage ? (
                    <button
                      className="btn sm"
                      disabled={busy === a.id || isPrimary}
                      title={isPrimary ? 'This is already the connect address' : 'Make this the port players connect to'}
                      onClick={() => makePrimary(a)}
                    >
                      {busy === a.id ? <Spinner size={13} /> : <Icon name="check" size={13} />} {isPrimary ? 'Primary' : 'Make primary'}
                    </button>
                  ) : (
                    isPrimary && <span className="badge gray xs">primary</span>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><Icon name="help" size={15} /> About extra allocations</div>
        <div className="p-3 xs" style={{ color: 'var(--text-3)', lineHeight: 1.7 }}>
          The <b>primary</b> allocation is the address players put in their server list. Any additional allocations are
          free ports you can bind plugins or proxies to without touching the game port. For example, a GeyserMC install
          adds a Bedrock listener — set it to one of your other ports (Bedrock defaults to <span className="mono">UDP 19132</span>)
          so Bedrock players can join on that address while Java players keep using the primary.
          {!canManage && <span> You don't have permission to change the primary allocation.</span>}
        </div>
      </div>
    </div>
  )
}