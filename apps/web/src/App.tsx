import { Routes, Route, Navigate } from 'react-router-dom'
import { Shell } from './components/Shell'
import { ToastHost } from './components/ui'
import { useApp } from './state/auth'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Servers } from './pages/Servers'
import { ServerWorkspace } from './pages/server/ServerWorkspace'
import { Nodes } from './pages/Nodes'
import { NodeDetail } from './pages/NodeDetail'
import { Locations } from './pages/Locations'
import { Activity } from './pages/Activity'
import { Account } from './pages/Account'

function Splash() {
  return (
    <div className="center" style={{ height: '100vh' }}>
      <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 18 }}>U</div>
    </div>
  )
}

// Admin-only pages (Infrastructure/System) — non-admins are redirected home.
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { canAdmin } = useApp()
  return canAdmin ? <>{children}</> : <Navigate to="/servers" replace />
}

export default function App() {
  const { user, booting } = useApp()

  if (booting) return <Splash />
  if (!user) return <Login />

  return (
    <>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/servers" element={<Servers />} />
          <Route path="/servers/new" element={<Servers />} />
          <Route path="/servers/:id" element={<ServerWorkspace />} />
          <Route path="/nodes" element={<AdminRoute><Nodes /></AdminRoute>} />
          <Route path="/nodes/:id" element={<AdminRoute><NodeDetail /></AdminRoute>} />
          <Route path="/locations" element={<AdminRoute><Locations /></AdminRoute>} />
          <Route path="/activity" element={<AdminRoute><Activity /></AdminRoute>} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
      <ToastHost />
    </>
  )
}
