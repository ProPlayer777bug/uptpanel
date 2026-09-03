import { Icon } from '../../components/ui'
import type { Server } from '@uptimehost/types'

export function NetworkTab({ server }: { server: Server }) {
  const allocs = server.allocations || []
  return (
    <div className="card">
      <div className="card-h">
        <Icon name="node" size={15} /> Network <span className="h-sub">allocated ports</span>
      </div>
      <div className="p-3">
        <div className="sm text-3 mb-2">Allocations</div>
        {allocs.length === 0 ? (
          <div className="empty" style={{ padding: 20 }}><p>No ports allocated.</p></div>
        ) : (
          <table className="dtable">
            <thead><tr><th>Address</th><th>Port</th><th>Protocol</th><th>Status</th></tr></thead>
            <tbody>
              {allocs.map((a: any) => (
                <tr key={a.id}>
                  <td className="mono sm">0.0.0.0</td>
                  <td className="mono sm">{a.port}</td>
                  <td><span className="badge gray xs">{a.proto || 'tcp'}</span></td>
                  <td><span className="badge green xs">Allocated</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="xs text-3 mt-3">
          Nodes run host-networked containers, so published ports bind directly to the node's address.
        </div>
      </div>
    </div>
  )
}
