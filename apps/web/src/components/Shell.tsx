import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../state/auth'
import { useTheme } from '../theme/useTheme'
import { CommandPalette } from './CommandPalette'
import { Icon, Tooltip, Menu, Breadcrumbs } from './ui'

type NavItem = { to: string; label: string; icon: any; admin?: boolean; soon?: boolean }

// Pterodactyl-style grouped navigation. The "Main" group is always visible;
// the Administration / Management / Service groups appear only for admins.
const NAV_GROUPS: { title: string; admin?: boolean; items: NavItem[] }[] = [
  {
    title: 'General',
    items: [
      { to: '/', label: 'Dashboard', icon: 'home' },
      { to: '/servers', label: 'Servers', icon: 'server' },
      { to: '/account', label: 'Settings', icon: 'gear' },
    ],
  },
  {
    title: 'Administration',
    admin: true,
    items: [
      { to: '/', label: 'Overview', icon: 'home' },
      { to: '/account/api-keys', label: 'Application API', icon: 'key' },
      { to: '/auth-providers', label: 'Auth Providers', icon: 'shield' },
    ],
  },
  {
    title: 'Management',
    admin: true,
    items: [
      { to: '/users', label: 'Users', icon: 'user' },
      { to: '/servers', label: 'Servers', icon: 'server' },
      { to: '/nodes', label: 'Nodes', icon: 'node' },
      { to: '/locations', label: 'Locations', icon: 'map' },
      { to: '/databases', label: 'Databases', icon: 'database' },
      { to: '/activity', label: 'Activity', icon: 'activity' },
      { to: '/alerts', label: 'Alerts', icon: 'alert' },
    ],
  },
  {
    title: 'Service Management',
    admin: true,
    items: [
      { to: '/templates', label: 'Templates', icon: 'layers' },
    ],
  },
]

const BOTTOM_NAV: { to: string; label: string; icon: any }[] = [
  { to: '/', label: 'Dashboard', icon: 'home' },
  { to: '/servers', label: 'Servers', icon: 'server' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/account', label: 'Account', icon: 'user' },
]

export function Shell({ children, subnav }: { children: React.ReactNode; subnav?: React.ReactNode }) {
  const { user, logout, canAdmin } = useApp()
  const { mode, applyMode } = useTheme()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [palette, setPalette] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('uh_side_collapsed') === '1')
  const [drawer, setDrawer] = useState(false)

  const toggleCollapse = () => {
    const v = !collapsed
    setCollapsed(v)
    localStorage.setItem('uh_side_collapsed', v ? '1' : '0')
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Close the mobile drawer on route change.
  useEffect(() => { setDrawer(false) }, [pathname])

  // Breadcrumbs derived from the active route.
  const crumbs: { label: string; to?: string }[] = pathname === '/'
    ? [{ label: 'Dashboard' }]
    : [{ label: 'Dashboard', to: '/' }, { label: crumbLabel(pathname) }]

  // Visible nav groups (hide admin groups from non-admins).
  const visibleGroups = NAV_GROUPS.filter((g) => !g.admin || canAdmin)

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      {/* ============ Left sidebar (desktop) ============ */}
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-top">
          <Link to="/" className="sidebar-brand">
            <div className="brand-mark">U</div>
            {!collapsed && <div className="brand-word">Uptime<span>Host</span></div>}
          </Link>
          {!collapsed && (
            <div className="workspace-selector" title="Workspace">
              <span className="ws-ico"><Icon name="layers" size={14} /></span>
              <span className="ws-name">Default</span>
              <Icon name="chevD" size={14} />
            </div>
          )}
        </div>

        <nav className="sidebar-nav">
          {visibleGroups.map((group) => (
            <div className="sidebar-group" key={group.title}>
              {!collapsed && <div className="sidebar-group-title">{group.title}</div>}
              {group.items.map((n) => n.soon ? (
                <Tooltip key={n.label} tip={`${n.label} — coming soon`} side="right">
                  <span className={`side-link soon ${collapsed ? 'icon-only' : ''}`}>
                    <span className="side-ico"><Icon name={n.icon} size={16} /></span>
                    {!collapsed && <span className="side-label">{n.label}</span>}
                  </span>
                </Tooltip>
              ) : (
                <Tooltip key={n.to + n.label} tip={n.label} side="right">
                  <Link to={n.to} className={`side-link ${isActive(pathname, n) ? 'active' : ''} ${collapsed ? 'icon-only' : ''}`}>
                    <span className="side-ico"><Icon name={n.icon} size={16} /></span>
                    {!collapsed && <span className="side-label">{n.label}</span>}
                  </Link>
                </Tooltip>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <Tooltip tip="Help" side="right"><span className="side-link icon-only soon"><span className="side-ico"><Icon name="help" size={16} /></span></span></Tooltip>
          <Tooltip tip={`Switch to ${mode === 'dark' ? 'light' : 'dark'}`} side="right">
            <button className="side-link icon-only" onClick={() => applyMode(mode === 'dark' ? 'light' : 'dark')}>
              <span className="side-ico"><Icon name={mode === 'dark' ? 'sun' : 'moon'} size={16} /></span>
            </button>
          </Tooltip>
          <Tooltip tip="Account" side="right">
            <Link to="/account" className="side-link icon-only">
              <span className="avatar" style={{ width: 24, height: 24, fontSize: 10, background: `hsl(${user?.avatarHue || 0} 65% 45%)` }}>
                {user?.name?.[0] || '?'}
              </span>
            </Link>
          </Tooltip>
          <Tooltip tip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} side="right">
            <button className="side-link icon-only" onClick={toggleCollapse}>
              <span className="side-ico"><Icon name="collapse" size={16} /></span>
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* ============ Main column ============ */}
      <div className="shell-main">
        {/* Top bar */}
        <header className="topbar">
          <button className="nav-icon-btn topbar-burger" onClick={() => setDrawer(true)} aria-label="Open menu">
            <Icon name="list" size={18} />
          </button>
          <Breadcrumbs items={crumbs} />
          <div className="topbar-spacer" />
          <button className="topbar-search" onClick={() => setPalette(true)} title="Search (Ctrl+K)">
            <Icon name="search" size={15} />
            <span className="topbar-search-text">Search…</span>
            <kbd>⌘K</kbd>
          </button>
          <button className="nav-icon-btn" onClick={() => setPalette(true)} title="Command palette (Ctrl+K)">
            <Icon name="search" size={16} />
          </button>
          <Menu align="right" trigger={
            <button className="nav-icon-btn" title="Notifications"><Icon name="bell" size={16} /></button>
          } items={[
            { label: 'No new notifications', icon: 'bell', onClick: () => {} },
          ]} />
          <Menu align="right" trigger={
            <span className="avatar" style={{ width: 30, height: 30, fontSize: 12, cursor: 'pointer', background: `hsl(${user?.avatarHue || 0} 65% 45%)` }}>
              {user?.name?.[0] || '?'}
            </span>
          } items={[
            { label: 'Account', icon: 'user', onClick: () => navigate('/account') },
            { label: 'Theme', icon: mode === 'dark' ? 'sun' : 'moon', onClick: () => applyMode(mode === 'dark' ? 'light' : 'dark') },
            { label: 'Sign out', icon: 'logout', danger: true, onClick: () => logout() },
          ]} />
        </header>

        {/* Optional sub-nav (server workspace tabs) */}
        {subnav && <div className="subnav"><div className="subnav-inner">{subnav}</div></div>}

        <div className="main">
          <div className="content-wrapper">{children}</div>
        </div>
      </div>

      {/* ============ Mobile drawer ============ */}
      {drawer && (
        <div className="drawer-overlay" onClick={() => setDrawer(false)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <span className="brand-word">Uptime<span>Host</span></span>
              <button className="nav-icon-btn" onClick={() => setDrawer(false)} aria-label="Close">
                <Icon name="plus" size={16} />
              </button>
            </div>
            <nav className="drawer-nav">
              {visibleGroups.map((group) => (
                <div key={group.title} className="sidebar-group">
                  <div className="sidebar-group-title">{group.title}</div>
                  {group.items.map((n) => n.soon ? (
                    <span key={n.label} className="drawer-item soon"><Icon name={n.icon} size={16} />{n.label}<em>soon</em></span>
                  ) : (
                    <Link key={n.to + n.label} to={n.to} className={`drawer-item ${isActive(pathname, n) ? 'active' : ''}`}>
                      <Icon name={n.icon} size={16} />{n.label}
                    </Link>
                  ))}
                </div>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* ============ Bottom nav (mobile) ============ */}
      <nav className="bottom-nav">
        {BOTTOM_NAV.map((n) => (
          <Link key={n.to} to={n.to} className={`bottom-item ${isActive(pathname, n) ? 'active' : ''}`}>
            <Icon name={n.icon} size={18} />
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}

function isActive(pathname: string, n: { to: string }) {
  if (n.to === '/') return pathname === '/'
  return pathname === n.to || pathname.startsWith(n.to)
}

function crumbLabel(pathname: string): string {
  if (pathname.startsWith('/servers')) return 'Servers'
  if (pathname.startsWith('/users')) return 'Users'
  if (pathname.startsWith('/nodes')) return 'Nodes'
  if (pathname.startsWith('/locations')) return 'Locations'
  if (pathname.startsWith('/databases')) return 'Databases'
  if (pathname.startsWith('/activity')) return 'Activity'
  if (pathname.startsWith('/auth-providers')) return 'Auth Providers'
  if (pathname.startsWith('/account')) return 'Account'
  const seg = pathname.split('/').filter(Boolean)
  return (seg[seg.length - 1] || 'Page').replace(/^./, (c) => c.toUpperCase())
}