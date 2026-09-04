import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, getToken, setToken, clearToken } from '../api/client'

export interface CtxUser {
  id: string
  email: string
  name: string
  role: string
  avatarHue: number
  createdAt: number
}
export interface Summary {
  total: number
  running: number
  offline: number
  provisioning: number
  error: number
  nodesOnline: number
  nodesTotal: number
}

interface AppState {
  user: CtxUser | null
  token: string
  summary: Summary | null
  booting: boolean
  canAdmin: boolean
  login: (email: string, password: string) => Promise<void>
  register: (name: string, email: string, password: string) => Promise<void>
  authenticate: (res: { token: string; user: any }) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

// Global admins (owner + admin) administer the whole panel. Everyone else only
// sees the servers granted to them, so admin-only UI is hidden.
export function isAdminRole(role?: string | null): boolean {
  return role === 'owner' || role === 'admin'
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CtxUser | null>(null)
  const [token, setTok] = useState(getToken())
  const [summary, setSummary] = useState<Summary | null>(null)
  const [booting, setBooting] = useState(!!getToken())

  const refresh = async () => {
    if (!getToken()) { setUser(null); setSummary(null); setBooting(false); return }
    try {
      const ctx = await api.get('/session/context')
      if (ctx.user) setUser(ctx.user)
      setSummary(ctx.summary)
    } catch {
      setUser(null); setSummary(null)
    } finally {
      setBooting(false)
    }
  }

  useEffect(() => { refresh() }, [token])

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password })
    await authenticate(res)
  }

  const register = async (name: string, email: string, password: string) => {
    const res = await api.post('/auth/register', { name, email, password })
    await authenticate(res)
  }

  // Persist a session established by any auth method (password, OTP, OAuth).
  const authenticate = async (res: { token?: string; user?: any }) => {
    if (!res.token) throw new Error('Authentication failed')
    setToken(res.token)
    setTok(res.token)
    setUser(res.user || null)
    const ctx = await api.get('/session/context')
    setSummary(ctx.summary)
  }

  const logout = async () => {
    try { await api.post('/auth/logout') } catch {}
    clearToken()
    setTok('')
    setUser(null)
    setSummary(null)
  }

  return (
    <Ctx.Provider value={{ user, token, summary, booting, canAdmin: isAdminRole(user?.role), login, register, authenticate, logout, refresh }}>
      {children}
    </Ctx.Provider>
  )
}

export function useApp() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}
