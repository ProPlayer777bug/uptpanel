import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../state/auth'
import { useTheme } from '../theme/useTheme'
import { CommandPalette } from './CommandPalette'
import { Icon } from './ui'

function NavItem({ to, icon, label, onPick, collapsed }: {
  to: string; icon: any; label: string; onPick?: () => void; collapsed?: boolean
}) {
  const { pathname } = useLocation()
  const active = pathname === to || (to !== '/' && pathname.startsWith(to))
  return (
    <Link to={to} className={`rail-item ${active ? 'active' : ''}`} onClick={onPick} title={label}>
      <span className="rail-ico">{icon}</span>
      {!collapsed && <span className="rail-text">{label}</span>}
    </Link>
  )
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout, canAdmin } = useApp()
  const { mode, applyMode } = useTheme()
  const navigate = useNavigate()
  const [palette, setPalette] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="shell">
      <nav className={`rail ${collapsed ? 'collapsed' : ''}`}>
        <div className="brand" onClick={() => navigate('/')}>
          <div className="brand-mark">U</div>
          <div className="brand-word">Uptime<span>Host</span></div>
        </div>

        <div className="rail-label">Overview</div>
        <NavItem to="/" icon={<Icon name="home" />} label="Dashboard" collapsed={collapsed} />
        <NavItem to="/servers" icon={<Icon name="server" />} label="Servers" collapsed={collapsed} />

        {canAdmin && (<>
          <div className="rail-label">Infrastructure</div>
          <NavItem to="/nodes" icon={<Icon name="node" />} label="Nodes" collapsed={collapsed} />
          <NavItem to="/locations" icon={<Icon name="map" />} label="Locations" collapsed={collapsed} />

          <div className="rail-label">System</div>
          <NavItem to="/activity" icon={<Icon name="activity" />} label="Activity" collapsed={collapsed} />
        </>)}
      

        <div className="rail-spacer" />

        <div className="rail-foot">
          <button className="rail-item" onClick={() => navigate('/account')} title="Account">
            <span className="rail-ico">
              <span className="avatar" style={{ width: 18, height: 18, fontSize: 9, background: `hsl(${user?.avatarHue || 0} 70% 55%)` }}>{user?.name?.[0] || '?'}</span>
            </span>
            {!collapsed && <span className="rail-text">{user?.name || 'Account'}</span>}
          </button>
          {!collapsed && (
            <button className="rail-item rail-collapse" onClick={() => setCollapsed(true)} title="Collapse">
              <span className="rail-ico"><Icon name="chevron" /></span>
              <span className="rail-text">Collapse</span>
            </button>
          )}
          {collapsed && (
            <button className="rail-item" onClick={() => setCollapsed(false)} title="Expand">
              <span className="rail-ico"><Icon name="chevD" /></span>
            </button>
          )}
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="global-search" onClick={() => setPalette(true)}>
            <div className="gs-trigger">
              <Icon name="search" size={15} />
              <span>Search servers, pages…</span>
              <span className="kbd">⌘K</span>
            </div>
          </div>
          <div className="topbar-spacer" />
          <button className="btn ghost icon" onClick={() => applyMode(mode === 'dark' ? 'light' : 'dark')} title="Toggle theme">
            {mode === 'dark' ? <Icon name="gear" /> : <span style={{ fontSize: 15 }}>☀</span>}
          </button>
          <button className="btn ghost icon" onClick={() => navigate('/activity')} title="Activity">
            <Icon name="bell" />
          </button>
          <button className="btn ghost icon" onClick={() => navigate('/account')} title="Account">
            <span className="avatar" style={{ width: 26, height: 26, fontSize: 11, background: `hsl(${user?.avatarHue || 0} 70% 55%)` }}>{user?.name?.[0] || '?'}</span>
          </button>
          <button className="btn ghost icon" onClick={() => logout()} title="Sign out">
            <Icon name="logout" />
          </button>
        </header>
        <div className="content" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>{children}</div>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}
