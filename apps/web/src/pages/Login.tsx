import { useEffect, useState, type FormEvent } from 'react'
import { useApp } from '../state/auth'
import { Icon, Spinner } from '../components/ui'

type Tab = 'email' | 'phone'
type EmailMode = 'password' | 'otp'

interface Methods { emailOtp: boolean; sms: boolean; google: boolean; github: boolean }

export function Login() {
  const { login, register, authenticate } = useApp()
  const [methods, setMethods] = useState<Methods>({ emailOtp: false, sms: false, google: false, github: false })

  // General page state
  const [mode, setMode] = useState<'login' | 'register'>('login')

  // Email (password) form
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')

  // OTP flow
  const [otpChannel, setOtpChannel] = useState<null | 'email' | 'sms'>(null)
  const [otpTarget, setOtpTarget] = useState('') // email or phone
  const [otpCode, setOtpCode] = useState('')
  const [sent, setSent] = useState(false)
  const [resendIn, setResendIn] = useState(0)

  const [tab, setTab] = useState<Tab>('email')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    apiGet('/auth/methods').then((m) => setMethods(m)).catch(() => {})
  }, [])

  async function apiGet(p: string) {
    const res = await fetch(`/api${p}`)
    return res.json()
  }

  // Countdown for resend button
  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  const submitEmailPassword = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      if (mode === 'register') await register(name, email, password)
      else await login(email, password)
    } catch (ee: any) {
      setErr(ee?.message || (mode === 'register' ? 'Registration failed' : 'Login failed'))
    } finally { setBusy(false) }
  }

  const switchMode = (m: 'login' | 'register') => { setMode(m); setErr('') }

  // Start OTP: send a code to email or SMS
  const startOtp = async (channel: 'email' | 'sms') => {
    setErr(''); setBusy(true)
    try {
      const target = channel === 'email' ? email.trim() : (document.getElementById('phone-input') as HTMLInputElement)?.value || ''
      if (!target) { setErr(channel === 'email' ? 'Enter your email' : 'Enter your phone number'); setBusy(false); return }
      const body = channel === 'email' ? { email: target } : { phone: target }
      const res = await fetch(`/api/auth/otp/${channel === 'email' ? 'email' : 'sms'}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error === 'EMAIL_OTP_NOT_CONFIGURED' || d.error === 'SMS_OTP_NOT_CONFIGURED' ? 'This login method is not configured yet' : d.error || 'Failed to send code')
      if (channel === 'email') { setOtpTarget(email.trim().toLowerCase()) } else { setOtpTarget(target) }
      setOtpChannel(channel)
      setSent(true)
      setOtpCode('')
      setResendIn(30)
    } catch (ee: any) {
      setErr(ee?.message || 'Failed to send code')
    } finally { setBusy(false) }
  }

  const verifyOtp = async (e: FormEvent) => {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: otpTarget, code: otpCode, name: name || undefined }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error === 'INVALID_OR_EXPIRED_CODE' ? 'Invalid or expired code' : d.error || 'Verification failed')
      await authenticate(d)
    } catch (ee: any) {
      setErr(ee?.message || 'Verification failed')
    } finally { setBusy(false) }
  }

  // OAuth popup flow: open the provider in a popup. The provider redirects back
  // to our /oauth/callback/:provider page, which exchanges the code for a token
  // and postMessage's it back to this window.
  const oauth = async (provider: 'google' | 'github') => {
    setErr('')
    try {
      const res = await fetch(`/api/auth/oauth/${provider}/url`, { method: 'POST' })
      const d = await res.json()
      if (!res.ok || !d.url) throw new Error(d.error === 'OAUTH_NOT_CONFIGURED' ? 'This login method is not configured yet' : d.error || 'OAuth unavailable')
      const width = 520, height = 640, left = screen.width / 2 - width / 2, top = screen.height / 2 - height / 2
      window.open(d.url, 'oauth', `width=${width},height=${height},left=${left},top=${top}`)
      window.addEventListener('message', async (ev) => {
        if (ev.origin !== location.origin || !ev.data?.uhOauth) return
        if (ev.data.token) await authenticate(ev.data)
        else setErr('OAuth failed: ' + (ev.data.error || 'unknown error'))
      })
    } catch (ee: any) {
      setErr(ee?.message || 'OAuth unavailable')
    }
  }

  // Tab styling helper
  const tabCls = (t: Tab) => `login-tab ${tab === t ? 'active' : ''}`

  return (
    <div className="login-wrap">
      <div className="login login-wide">
        <div className="login-brand-row">
          <div className="brand-mark" style={{ width: 48, height: 48, fontSize: 22 }}>U</div>
          <div>
            <h1 style={{ margin: 0 }}>{mode === 'register' ? 'Create an account' : 'Welcome back'}<span>!</span></h1>
            <p style={{ margin: '4px 0 0', fontSize: 12 }}>UptimeHost control plane</p>
          </div>
        </div>

        {/* OAuth buttons */}
        <div className="login-oauth">
          <button className="oauth-btn" disabled={!methods.google} onClick={() => oauth('google')}>
            <Icon name="google" size={18} /> Google
            {!methods.google && <span className="tag">not configured</span>}
          </button>
          <button className="oauth-btn" disabled={!methods.github} onClick={() => oauth('github')}>
            <Icon name="github" size={18} /> GitHub
            {!methods.github && <span className="tag">not configured</span>}
          </button>
        </div>

        <div className="login-divider"><span>or continue with</span></div>

        {/* Tabs */}
        <div className="login-tabs">
          <button className={tabCls('email')} onClick={() => { setTab('email'); setErr(''); setSent(false); setOtpChannel(null) }}>Email</button>
          <button className={tabCls('phone')} onClick={() => { setTab('phone'); setErr(''); setSent(false); setOtpChannel(null) }}>Phone &amp; SMS</button>
        </div>

        {tab === 'phone' ? (
          !sent ? (
            <form onSubmit={(e) => { e.preventDefault(); startOtp('sms') }} className="login-form">
              <div className="field">
                <label htmlFor="phone-input">Phone number (E.164, e.g. +15551234567)</label>
                <input id="phone-input" className="input" placeholder="+15551234567" autoComplete="tel" />
              </div>
              {err && <div className="login-err">{err}</div>}
              <button className="btn primary w-100" type="submit" disabled={busy} style={{ padding: '10px 16px' }}>
                {busy ? <Spinner size={16} /> : 'Send SMS code'}
              </button>
            </form>
          ) : (
            <OtpForm target={otpTarget} channel="sms" code={otpCode} setCode={setOtpCode} resendIn={resendIn}
              onResend={() => startOtp('sms')} onSubmit={verifyOtp} busy={busy} err={err} onBack={() => { setSent(false); setErr('') }} />
          )
        ) : otpChannel === 'email' ? (
          !sent ? null : (
            <OtpForm target={otpTarget} channel="email" code={otpCode} setCode={setOtpCode} resendIn={resendIn}
              onResend={() => startOtp('email')} onSubmit={verifyOtp} busy={busy} err={err} onBack={() => { setSent(false); setOtpChannel(null); setErr('') }} />
          )
        ) : (
          <div className="login-form">
            {mode === 'register' && (
              <div className="field">
                <label htmlFor="reg-name">Username</label>
                <input id="reg-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </div>
            )}
            <div className="field">
              <label htmlFor="auth-email">Email Address</label>
              <input id="auth-email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
            </div>
            {mode !== 'register' && (
              <div className="field">
                <label htmlFor="auth-pass">Password</label>
                <input id="auth-pass" className="input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
              </div>
            )}
            {err && <div className="login-err">{err}</div>}
            <button className="btn primary w-100" onClick={submitEmailPassword} disabled={busy} style={{ padding: '10px 16px' }}>
              {busy ? <Spinner size={16} /> : (mode === 'register' ? 'Create Account' : 'Sign In')}
            </button>

            {mode === 'login' && methods.emailOtp && (
              <button type="button" className="btn subtle w-100" disabled={busy} onClick={() => startOtp('email')}>
                <Icon name="key" size={14} /> Sign in with email code
              </button>
            )}
          </div>
        )}

        <div className="login-switch">
          {mode === 'login' ? (
            <>
              <span className="sm text-3">Don't have an account? </span>
              <button className="link" onClick={() => switchMode('register')}>Register</button>
            </>
          ) : (
            <>
              <span className="sm text-3">Already have an account? </span>
              <button className="link" onClick={() => switchMode('login')}>Sign in</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function OtpForm({ target, channel, code, setCode, resendIn, onResend, onSubmit, busy, err, onBack }: {
  target: string; channel: 'email' | 'sms'; code: string; setCode: (s: string) => void
  resendIn: number; onResend: () => void; onSubmit: (e: FormEvent) => void; busy: boolean; err: string; onBack: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="login-form">
      <div className="otp-info">
        <Icon name={channel === 'email' ? 'key' : 'phone'} size={16} />
        <span>Enter the 6-digit code we sent to <b>{target}</b></span>
      </div>
      <div className="field">
        <label htmlFor="otp-code">Verification code</label>
        <input id="otp-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="••••••" inputMode="numeric" autoFocus />
      </div>
      {err && <div className="login-err">{err}</div>}
      <button className="btn primary w-100" type="submit" disabled={busy || code.length < 6} style={{ padding: '10px 16px' }}>
        {busy ? <Spinner size={16} /> : 'Verify & Sign In'}
      </button>
      <div className="flex items-center gap-3" style={{ justifyContent: 'center' }}>
        <button type="button" className="link sm" onClick={onBack}>← Back</button>
        <span className="sm text-3">·</span>
        {resendIn > 0 ? (
          <span className="sm text-3">Resend in {resendIn}s</span>
        ) : (
          <button type="button" className="link sm" onClick={onResend}>Resend code</button>
        )}
      </div>
    </form>
  )
}
