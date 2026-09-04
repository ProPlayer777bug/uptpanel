import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { Shell } from '../components/Shell'
import { Icon, Spinner, toast } from '../components/ui'

interface Providers {
  smtp: { host: string; port: number; from: string; user: string; hasPass: boolean; configured: boolean }
  sms: { provider: 'twilio' | 'webhook'; from: string; hasAuth: boolean; configured: boolean }
  google: { clientId: string; hasSecret: boolean; redirectUri: string; configured: boolean }
  github: { clientId: string; hasSecret: boolean; redirectUri: string; configured: boolean }
}

const emptyForm = {
  smtp: { host: '', port: 587, from: '', user: '', pass: '' },
  sms: { provider: 'twilio' as 'twilio' | 'webhook', accountSid: '', authToken: '', from: '', webhookUrl: '' },
  google: { clientId: '', clientSecret: '', redirectUri: '' },
  github: { clientId: '', clientSecret: '', redirectUri: '' },
  otpTtlSec: 300,
}

export function AuthProviders() {
  const [providers, setProviders] = useState<Providers | null>(null)
  const [form, setForm] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testMsg, setTestMsg] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await api.get('/admin/auth-providers')
      setProviders(d.providers)
      setForm({
        smtp: { host: d.providers.smtp.host || '', port: d.providers.smtp.port || 587, from: d.providers.smtp.from || '', user: d.providers.smtp.user || '', pass: '' },
        sms: { provider: d.providers.sms.provider || 'twilio', accountSid: '', authToken: '', from: d.providers.sms.from || '', webhookUrl: '' },
        google: { clientId: d.providers.google.clientId || '', clientSecret: '', redirectUri: d.providers.google.redirectUri || '' },
        github: { clientId: d.providers.github.clientId || '', clientSecret: '', redirectUri: d.providers.github.redirectUri || '' },
        otpTtlSec: 300,
      })
    } catch (e: any) { toast.err(e?.message || 'Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const set = (group: string, k: string, v: any) => setForm((f: any) => ({ ...f, [group]: { ...f[group], [k]: v } }))

  const save = async () => {
    setSaving(true); setTestMsg('')
    try {
      const d = await api.put('/admin/auth-providers', form)
      setProviders(d.providers)
      toast.ok('Auth providers saved')
    } catch (e: any) { toast.err(e?.message || 'Save failed') }
    finally { setSaving(false) }
  }

  if (loading || !form || !providers) {
    return <Shell><div className="center" style={{ padding: 80 }}><Spinner size={26} /></div></Shell>
  }

  const cb = 'https://panel.uptimehost.in/api/auth/oauth'
  const Sect = ({ title, icon, configured, children }: any) => (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-h">
        <Icon name={icon} size={15} />
        <span style={{ marginRight: 8 }}>{title}</span>
        <span className={`badge ${configured ? 'green' : 'gray'}`}>{configured ? 'Configured' : 'Not configured'}</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {children}
      </div>
    </div>
  )

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 860 }}>
        <div className="page-h">
          <h1>Auth Providers</h1>
          <span className="sub">Works for public sign-in — configured here, no env vars needed</span>
          <div style={{ flex: 1 }} />
          <button className="btn primary" disabled={saving} onClick={save}>{saving ? <Spinner size={15} /> : <Icon name="check" size={14} />} Save changes</button>
        </div>
        {testMsg && <div className="login-err" style={{ marginBottom: 16 }}>{testMsg}</div>}

        <Sect title="SMTP (email OTP)" icon="globe" configured={providers.smtp.configured}>
          <p className="sub sm">Used to send email verification codes. Fill your SMTP server details.</p>
          <div className="grid-2">
            <div className="field"><label>Host</label><input className="input" placeholder="smtp.gmail.com" value={form.smtp.host} onChange={(e) => set('smtp', 'host', e.target.value)} /></div>
            <div className="field"><label>Port</label><input className="input" type="number" value={form.smtp.port} onChange={(e) => set('smtp', 'port', Number(e.target.value))} /></div>
          </div>
          <div className="grid-2">
            <div className="field"><label>Username</label><input className="input" placeholder="you@example.com" value={form.smtp.user} onChange={(e) => set('smtp', 'user', e.target.value)} /></div>
            <div className="field"><label>From address</label><input className="input" placeholder="no-reply@example.com" value={form.smtp.from} onChange={(e) => set('smtp', 'from', e.target.value)} /></div>
          </div>
          <div className="field">
            <label>Password {providers.smtp.hasPass && <span className="tag" style={{ color: 'var(--text-3)', fontSize: 11 }}>(saved — leave blank to keep)</span>}</label>
            <input className="input" type="password" placeholder={providers.smtp.hasPass ? '••••••••' : 'SMTP password'} value={form.smtp.pass} onChange={(e) => set('smtp', 'pass', e.target.value)} />
          </div>
        </Sect>

        <Sect title="SMS (phone OTP)" icon="phone" configured={providers.sms.configured}>
          <p className="sub sm">Send text-message codes. Use Twilio (free trial works) or a generic webhook.</p>
          <div className="field">
            <label>Delivery method</label>
            <div className="flex gap-2">
              <button className={`btn ${form.sms.provider === 'twilio' ? 'subtle' : 'ghost'}`} onClick={() => set('sms', 'provider', 'twilio')}>Twilio</button>
              <button className={`btn ${form.sms.provider === 'webhook' ? 'subtle' : 'ghost'}`} onClick={() => set('sms', 'provider', 'webhook')}>Webhook</button>
            </div>
          </div>
          <div className="field"><label>From / sender</label><input className="input" placeholder="+15551234567 or sender ID" value={form.sms.from} onChange={(e) => set('sms', 'from', e.target.value)} /></div>
          {form.sms.provider === 'twilio' ? (
            <div className="grid-2">
              <div className="field"><label>Account SID</label><input className="input" value={form.sms.accountSid} onChange={(e) => set('sms', 'accountSid', e.target.value)} /></div>
              <div className="field"><label>Auth token {providers.sms.hasAuth && '(saved)'}</label><input className="input" type="password" placeholder={providers.sms.hasAuth ? '••••••••' : 'Auth token'} value={form.sms.authToken} onChange={(e) => set('sms', 'authToken', e.target.value)} /></div>
            </div>
          ) : (
            <div className="field"><label>Webhook URL (receives POST {`{to, body}`})</label><input className="input" placeholder="https://sms.example.com/send" value={form.sms.webhookUrl} onChange={(e) => set('sms', 'webhookUrl', e.target.value)} /></div>
          )}
        </Sect>

        <Sect title="Google OAuth" icon="google" configured={providers.google.configured}>
          <p className="sub sm">Create an OAuth client at Google Cloud → Credentials. Set the redirect URI to the value below.</p>
          <div className="grid-2">
            <div className="field"><label>Client ID {providers.google.clientId && '(set)'}</label><input className="input mono" value={form.google.clientId} onChange={(e) => set('google', 'clientId', e.target.value)} /></div>
            <div className="field"><label>Client Secret {providers.google.hasSecret && '(saved)'}</label><input className="input mono" type="password" placeholder={providers.google.hasSecret ? '••••••••' : 'Client secret'} value={form.google.clientSecret} onChange={(e) => set('google', 'clientSecret', e.target.value)} /></div>
          </div>
          <div className="field"><label>Redirect URI</label><input className="input mono" value={form.google.redirectUri || cb && `${cb}/google`} onChange={(e) => set('google', 'redirectUri', e.target.value)} placeholder={`${cb}/google`} /></div>
        </Sect>

        <Sect title="GitHub OAuth" icon="github" configured={providers.github.configured}>
          <p className="sub sm">Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps).</p>
          <div className="grid-2">
            <div className="field"><label>Client ID {providers.github.clientId && '(set)'}</label><input className="input mono" value={form.github.clientId} onChange={(e) => set('github', 'clientId', e.target.value)} /></div>
            <div className="field"><label>Client Secret {providers.github.hasSecret && '(saved)'}</label><input className="input mono" type="password" placeholder={providers.github.hasSecret ? '••••••••' : 'Client secret'} value={form.github.clientSecret} onChange={(e) => set('github', 'clientSecret', e.target.value)} /></div>
          </div>
          <div className="field"><label>Redirect URI</label><input className="input mono" value={form.github.redirectUri || `${cb}/github`} onChange={(e) => set('github', 'redirectUri', e.target.value)} placeholder={`${cb}/github`} /></div>
        </Sect>
      </div>
    </Shell>
  )
}
