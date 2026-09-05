import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useServer } from '../../api/hooks'
import { Spinner, StatePill, Icon, Tabs, Menu } from '../../components/ui'
import { Shell } from '../../components/Shell'
import { OverviewTab } from './OverviewTab'
import { ConsoleTab } from './ConsoleTab'
import { FilesTab } from './FilesTab'
import { SnapshotsTab } from './SnapshotsTab'
import { BackupsTab } from './BackupsTab'
import { SchedulesTab } from './SchedulesTab'
import { DatabasesTab } from './DatabasesTab'
import { StartupTab } from './StartupTab'
import { NetworkTab } from './NetworkTab'
import { AccessTab } from './AccessTab'
import { ApiTab } from './ApiTab'
import { SettingsTab } from './SettingsTab'
import { VersionManager, PluginManager, isMcServer } from './VersionPluginModals'
import { publicAddress } from '../../utils/mask'

type Tab = 'overview' | 'console' | 'files' | 'snapshots' | 'backups' | 'schedules' | 'databases' | 'startup' | 'network' | 'access' | 'api' | 'settings'
const ADMIN_TABS: Tab[] = ['startup', 'network', 'snapshots', 'access', 'api', 'settings', 'databases', 'schedules', 'backups']
const TABS: { id: Tab; label: string; icon: any; admin?: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'console', label: 'Console', icon: 'terminal' },
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'startup', label: 'Startup', icon: 'gear', admin: true },
  { id: 'network', label: 'Network', icon: 'node', admin: true },
  { id: 'backups', label: 'Backups', icon: 'download', admin: true },
  { id: 'schedules', label: 'Schedules', icon: 'activity', admin: true },
  { id: 'databases', label: 'Databases', icon: 'chip', admin: true },
  { id: 'snapshots', label: 'Snapshots', icon: 'snap', admin: true },
  { id: 'access', label: 'Users', icon: 'lock', admin: true },
  { id: 'api', label: 'API', icon: 'key', admin: true },
  { id: 'settings', label: 'Settings', icon: 'gear', admin: true },
]

export function ServerWorkspace() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading } = useServer(id)
  const server = data?.server
  const [tab, setTab] = useState<Tab>('overview')
  const [showVersions, setShowVersions] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)

  const perms = server?.permissions || {}
  const role = server?.role
  const canAdminServer = perms.admin === true || role === 'admin' || role === 'owner'
  const visibleTabs = TABS.filter((t) => !t.admin || canAdminServer)

  useEffect(() => {
    if (server && !canAdminServer && ADMIN_TABS.includes(tab)) setTab('overview')
  }, [server])

  if (loading && !server) return <div className="center" style={{ padding: 80 }}><Spinner size={28} /></div>
  if (!server) return <div className="center" style={{ padding: 80, color: 'var(--text-3)' }}>Server not found</div>

  const a0 = server.allocations?.[0]
  // The address users actually connect with: alias hostname if set, else the
  // node's public host/IP, plus the port. Never masked — it must be usable.
  const address = a0 ? publicAddress(a0, server.node) || `${a0.ip || server.node?.host || '—'}:${a0.port}` : '—'

  const subnav = (
    <Tabs
      tabs={visibleTabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon }))}
      value={tab}
      onChange={setTab}
    />
  )

  return (
    <Shell subnav={subnav}>
      <div className="page" style={{ paddingTop: 20 }}>
        {/* Server header */}
        <div className="anim-in">
          <div className="flex items-center gap-3" style={{ marginBottom: 8 }}>
            <span className="avatar" style={{ width: 34, height: 34, fontSize: 14, background: 'var(--cyan-soft)', color: 'var(--cyan-strong)' }}>
              <Icon name="server" size={16} />
            </span>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>{server.name}</h1>
            <StatePill state={server.state} pulse />
            <div style={{ flex: 1 }} />
            {isMcServer(server) && canAdminServer && (
              <>
                <button className="btn sm" onClick={() => setShowPlugins(true)}><Icon name="box" size={14} /> Plugins</button>
                <button className="btn sm" onClick={() => setShowVersions(true)}><Icon name="activity" size={14} /> Version</button>
              </>
            )}
            <Menu trigger={<span className="nav-icon-btn"><Icon name="dots" size={16} /></span>} align="right"
              items={[{ label: 'Copy address', icon: 'copy', onClick: () => navigator.clipboard?.writeText(address) }]}
            />
          </div>
          <div className="flex items-center gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
            <span className="badge gray mono xs">{server.id}</span>
            <span className="badge mono xs"><Icon name="node" size={11} /> {address}</span>
            {server.blueprint && <span className="badge blue xs">{server.blueprint.name}</span>}
            {server.mcVersion && <span className="badge cyan xs">MC {server.mcVersion}</span>}
            {server.node && <span className="badge cyan xs"><Icon name="node" size={11} /> {server.node.name}</span>}
            {server.error && <span className="badge red xs">{server.error}</span>}
          </div>
        </div>

        {/* Tab content */}
        <div className="anim-in" key={tab}>
          {tab === 'overview' && <OverviewTab server={server} />}
          {tab === 'console' && <ConsoleTab server={server} />}
          {tab === 'files' && <FilesTab server={server} />}
          {tab === 'startup' && <StartupTab server={server} />}
          {tab === 'backups' && <BackupsTab server={server} />}
          {tab === 'schedules' && <SchedulesTab server={server} />}
          {tab === 'databases' && <DatabasesTab server={server} />}
          {tab === 'network' && <NetworkTab server={server} />}
          {tab === 'snapshots' && <SnapshotsTab server={server} />}
          {tab === 'access' && <AccessTab server={server} />}
          {tab === 'api' && <ApiTab server={server} />}
          {tab === 'settings' && <SettingsTab server={server} />}
        </div>
      </div>

      <VersionManager server={server} open={showVersions} onClose={() => setShowVersions(false)} />
      <PluginManager server={server} open={showPlugins} onClose={() => setShowPlugins(false)} />
    </Shell>
  )
}