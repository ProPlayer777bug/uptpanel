import { Icon } from '../../components/ui'
import { ApiKeys } from '../../components/ApiKeys'

export function ApiTab({ server }: { server: any }) {
  return (
    <div className="card" style={{ maxWidth: 820 }}>
      <div className="card-h"><Icon name="key" size={15} /> API keys for this server</div>
      <div className="card-b">
        <p className="sub" style={{ marginBottom: 12 }}>
          A key created here is scoped to <b>{server.name}</b> only — it can read and control this server via the panel API
          (e.g. from a Discord bot or a status widget). Use an account key to manage many servers at once.
        </p>
        <ApiKeys kind="server" serverId={server.id} />
      </div>
    </div>
  )
}
