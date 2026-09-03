import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useServer } from '../../api/hooks'
import { Spinner, StatePill, Icon } from '../../components/ui'
import { PowerControls } from './PowerControls'
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
import { SettingsTab } from './SettingsTab'

type Tab = 'overview' | 'console' | 'files' | 'snapshots' | 'backups' | 'schedules' | 'databases' | 'startup' | 'network' | 'access' | 'settings'
// Admin-only tabs are hidden from users who only have view/command/files access.
const ADMIN_TABS: Tab[] = ['startup', 'network', 'snapshots', 'access', 'settings', 'databases', 'schedules', 'backups']
const TABS: { id: Tab; label: string; icon: any; admin?: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: Icon({ name: 'cpu', size: 15 }) },
  { id: 'console', label: 'Console', icon: Icon({ name: 'terminal', size: 15 }) },
  { id: 'files', label: 'Files', icon: Icon({ name: 'folder', size: 15 }) },
  { id: 'startup', label: 'Startup', icon: Icon({ name: 'gear', size: 15 }), admin: true },
  { id: 'backups', label: 'Backups', icon: Icon({ name: 'download', size: 15 }), admin: true },
  { id: 'schedules', label: 'Schedules', icon: Icon({ name: 'activity', size: 15 }), admin: true },
  { id: 'databases', label: 'Databases', icon: Icon({ name: 'chip', size: 15 }), admin: true },
  { id: 'network', label: 'Network', icon: Icon({ name: 'node', size: 15 }), admin: true },
  { id: 'snapshots', label: 'Snapshots', icon: Icon({ name: 'snap', size: 15 }), admin: true },
  { id: 'access', label: 'Access', icon: Icon({ name: 'lock', size: 15 }), admin: true },
  { id: 'settings', label: 'Settings', icon: Icon({ name: 'server', size: 15 }), admin: true },
]

export function ServerWorkspace() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading } = useServer(id)
  const server = data?.server
  const [tab, setTab] = useState<Tab>('overview')

  // Users without admin rights on a server only get view/command/files — so the
  // admin-only management tabs are filtered out.
  const perms = server?.permissions || {}
  const role = server?.role
  const canAdminServer = perms.admin === true || role === 'admin' || role === 'owner'
  const visibleTabs = TABS.filter((t) => !t.admin || canAdminServer)

  useEffect(() => {
    if (server && !canAdminServer && ADMIN_TABS.includes(tab)) setTab('overview')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server])

  if (loading && !server) return <div className="center" style={{ padding: 80 }}><Spinner size={28} /></div>
  if (!server) return <div className="center" style={{ padding: 80, color: 'var(--text-3)' }}>Server not found</div>

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="anim-in">
        <div className="flex items-center gap-3" style={{ marginBottom: 6 }}>
          <a className="text-3 sm" onClick={() => navigate('/servers')} style={{ cursor: 'pointer' }}>Servers</a>
          <span className="text-3 sm">/</span>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>{server.name}</h1>
          <StatePill state={server.state} pulse />
          <div style={{ flex: 1 }} />
          <PowerControls server={server} />
        </div>
        <div className="flex items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
          <span className="badge gray mono xs">{server.id}</span>
          {server.blueprint && <span className="badge blue xs">{server.blueprint.name}</span>}
          {server.node && <span className="badge cyan xs"><Icon name="node" size={11} /> {server.node.name}</span>}
          {server.lastAction && <span className="xs text-3">last action: {server.lastAction}</span>}
          {server.error && <span className="badge red xs">{server.error}</span>}
        </div>
      </div>

      <div className="tabs">
        {visibleTabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <span className="ico">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

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
        {tab === 'settings' && <SettingsTab server={server} />}
      </div>
    </div>
  )
}
