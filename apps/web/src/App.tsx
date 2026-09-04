import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ToastHost } from './components/ui'
import { useApp } from './state/auth'
import { Login } from './pages/Login'
import { OAuthCallback } from './pages/OAuthCallback'
import { PrivacyPolicy } from './pages/PrivacyPolicy'
import { Shell } from './components/Shell'

const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const Servers = lazy(() => import('./pages/Servers').then((m) => ({ default: m.Servers })))
const ServerWorkspace = lazy(() => import('./pages/server/ServerWorkspace').then((m) => ({ default: m.ServerWorkspace })))
const Nodes = lazy(() => import('./pages/Nodes').then((m) => ({ default: m.Nodes })))
const NodeDetail = lazy(() => import('./pages/NodeDetail').then((m) => ({ default: m.NodeDetail })))
const Locations = lazy(() => import('./pages/Locations').then((m) => ({ default: m.Locations })))
const Activity = lazy(() => import('./pages/Activity').then((m) => ({ default: m.Activity })))
const Account = lazy(() => import('./pages/Account').then((m) => ({ default: m.Account })))
const Alerts = lazy(() => import('./pages/Alerts').then((m) => ({ default: m.Alerts })))
const Templates = lazy(() => import('./pages/Templates').then((m) => ({ default: m.Templates })))
const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })))
const Databases = lazy(() => import('./pages/Databases').then((m) => ({ default: m.Databases })))
const AuthProviders = lazy(() => import('./pages/AuthProviders').then((m) => ({ default: m.AuthProviders })))
const Themes = lazy(() => import('./pages/Themes').then((m) => ({ default: m.Themes })))

function Splash() {
  return (
    <div className="center" style={{ height: '100vh' }}>
      <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 18 }}>U</div>
    </div>
  )
}

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<Shell><div className="center" style={{ padding: 120 }}><div className="brand-mark" style={{ width: 34, height: 34, fontSize: 15 }}>U</div></div></Shell>}>{children}</Suspense>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { canAdmin } = useApp()
  return canAdmin ? <>{children}</> : <Navigate to="/servers" replace />
}

export default function App() {
  const { user, booting } = useApp()
  const { pathname } = useLocation()

  // OAuth callback must render even while logged out (it runs in a popup during
  // the sign-in flow, before a session exists).
  if (pathname.startsWith('/oauth/callback/')) {
    return <Routes><Route path="/oauth/callback/:provider" element={<OAuthCallback />} /></Routes>
  }

  // Public pages accessible without any authentication (e.g. for Google OAuth
  // verification). Rendered before the auth gate so no login/session is needed.
  if (pathname === '/privacy') {
    return <Routes><Route path="/privacy" element={<PrivacyPolicy />} /></Routes>
  }

  if (booting) return <Splash />
  if (!user) return <Login />

  return (
    <>
      <Routes>
        <Route path="/" element={<Page><Dashboard /></Page>} />
        <Route path="/servers" element={<Page><Servers /></Page>} />
        <Route path="/servers/new" element={<Page><Servers /></Page>} />
        <Route path="/servers/:id" element={<Page><ServerWorkspace /></Page>} />
        <Route path="/nodes" element={<Page><AdminRoute><Nodes /></AdminRoute></Page>} />
        <Route path="/nodes/:id" element={<Page><AdminRoute><NodeDetail /></AdminRoute></Page>} />
        <Route path="/locations" element={<Page><AdminRoute><Locations /></AdminRoute></Page>} />
        <Route path="/activity" element={<Page><AdminRoute><Activity /></AdminRoute></Page>} />
        <Route path="/alerts" element={<Page><AdminRoute><Alerts /></AdminRoute></Page>} />
        <Route path="/templates" element={<Page><AdminRoute><Templates /></AdminRoute></Page>} />
        <Route path="/users" element={<Page><AdminRoute><Users /></AdminRoute></Page>} />
        <Route path="/databases" element={<Page><AdminRoute><Databases /></AdminRoute></Page>} />
        <Route path="/auth-providers" element={<Page><AdminRoute><AuthProviders /></AdminRoute></Page>} />
        <Route path="/account" element={<Page><Account /></Page>} />
        <Route path="/account/api-keys" element={<Page><Account focus="api-keys" /></Page>} />
        <Route path="/themes" element={<Page><Themes /></Page>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </>
  )
}
