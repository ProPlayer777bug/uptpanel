import { useState, type FormEvent } from 'react'
import { useApp } from '../state/auth'
import { Spinner } from '../components/ui'

export function Login() {
  const { login, register } = useApp()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      if (mode === 'register') await register(name, email, password)
      else await login(email, password)
    } catch (e: any) {
      setErr(e?.message || (mode === 'register' ? 'Registration failed' : 'Login failed'))
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (m: 'login' | 'register') => {
    setMode(m); setErr('')
  }

  return (
    <div className="login-wrap">
      <div className="login">
        <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 20 }}>U</div>
        <h1>{mode === 'register' ? 'Create your account' : 'Sign in to Uptime'}<span>Host</span></h1>
        <p className="login-sub">
          {mode === 'register' ? 'Join to access the servers granted to you by an administrator.' : 'Access your servers, nodes and control plane.'}
        </p>
        <form onSubmit={submit} className="login-form">
          {mode === 'register' && (
            <div className="field">
              <label>Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label>Email</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
          </div>
          <div className="field">
            <label>Password</label>
            <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
          </div>
          {err && <div className="login-err">{err}</div>}
          <button className="btn primary w-100" type="submit" disabled={busy}>
            {busy ? <Spinner size={16} /> : (mode === 'register' ? 'Create account' : 'Sign in')}
          </button>
        </form>
        <div className="login-switch">
          {mode === 'login' ? (
            <button className="link" onClick={() => switchMode('register')}>No account? Register</button>
          ) : (
            <button className="link" onClick={() => switchMode('login')}>Already have an account? Sign in</button>
          )}
        </div>
      </div>
    </div>
  )
}
