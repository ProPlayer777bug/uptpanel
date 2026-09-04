// Auth "provider" integration for the public panel.
//
// All credentials are stored in the panel DB (store.db.settings.auth) so an
// admin can configure them through the UI — no env vars or secret files needed.
//
// Supported methods:
//   - email OTP   via SMTP (host/port/user/pass/from)
//   - phone OTP   via SMS (Twilio HTTP API or any generic webhook URL)
//   - Google OAuth + GitHub OAuth (clientId/clientSecret/redirectUri)
//
// Whenever a provider has no credentials configured, the login UI renders it
// as "not configured" and the backend refuses to send the code / start OAuth.

import { createHash, randomInt, randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { Store } from '../store/store.js'

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
export interface AuthSettings {
  smtp?: { host?: string; port?: number; user?: string; pass?: string; from?: string; secure?: boolean }
  sms?: { provider?: 'twilio' | 'webhook'; accountSid?: string; authToken?: string; from?: string; webhookUrl?: string }
  google?: { clientId?: string; clientSecret?: string; redirectUri?: string }
  github?: { clientId?: string; clientSecret?: string; redirectUri?: string }
  otpTtlSec?: number
}

export function getAuthSettings(store: Store): AuthSettings {
  return (store.db.settings?.auth as AuthSettings) || {}
}

export function setAuthSettings(store: Store, s: AuthSettings) {
  if (!store.db.settings) store.db.settings = {}
  const merged = sanitizeSettings(store, s)
  // Auto-default a blank redirectUri to the server-side OAuth callback so an
  // admin who configures Google without filling the field never gets
  // redirect_uri=undefined. An explicit value is always preserved.
  for (const provider of ['google', 'github'] as const) {
    const cfg = merged[provider]
    if (cfg && (cfg.clientId || cfg.clientSecret) && !(cfg.redirectUri && cfg.redirectUri.trim())) {
      cfg.redirectUri = oauthCallbackUrl(provider, appBaseUrl())
    }
  }
  store.db.settings.auth = merged
  store.persist()
  return merged
}

function clean(s: any): AuthSettings {
  const o: AuthSettings = {}
  if (s?.smtp) {
    o.smtp = {
      host: s.smtp.host, port: s.smtp.port, user: s.smtp.user,
      pass: s.smtp.pass, from: s.smtp.from, secure: !!s.smtp.secure,
    }
  }
  if (s?.sms) {
    o.sms = {
      provider: s.sms.provider === 'webhook' ? 'webhook' : 'twilio',
      accountSid: s.sms.accountSid, authToken: s.sms.authToken,
      from: s.sms.from, webhookUrl: s.sms.webhookUrl,
    }
  }
  if (s?.google) { o.google = { clientId: s.google.clientId, clientSecret: s.google.clientSecret, redirectUri: s.google.redirectUri } }
  if (s?.github) { o.github = { clientId: s.github.clientId, clientSecret: s.github.clientSecret, redirectUri: s.github.redirectUri } }
  if (s?.otpTtlSec) o.otpTtlSec = Number(s.otpTtlSec) || 300
  return o
}
// keep secret fields out of the public "is configured" shape
export function publicAuthSettings(store: Store) {
  const a = getAuthSettings(store)
  const mask = (v?: string) => (v ? (v.length > 8 ? v.slice(0, 4) + '••••••••' : '••••') : '')
  return {
    smtp: { host: a.smtp?.host || '', port: a.smtp?.port || 587, from: a.smtp?.from || '', user: a.smtp?.user || '', hasPass: !!a.smtp?.pass, configured: !!a.smtp?.host && !!a.smtp?.user },
    sms: { provider: a.sms?.provider || 'twilio', from: a.sms?.from || '', hasAuth: !!a.sms?.authToken || !!a.sms?.webhookUrl, configured: !!a.sms?.from && (!!a.sms?.authToken || !!a.sms?.webhookUrl) },
    google: { clientId: mask(a.google?.clientId), hasSecret: !!a.google?.clientSecret, redirectUri: a.google?.redirectUri || '', configured: !!a.google?.clientId && !!a.google?.clientSecret },
    github: { clientId: mask(a.github?.clientId), hasSecret: !!a.github?.clientSecret, redirectUri: a.github?.redirectUri || '', configured: !!a.github?.clientId && !!a.github?.clientSecret },
  }
}

function sanitizeSettings(store: Store, input: AuthSettings): AuthSettings {
  // Merge with existing to preserve secrets the UI left blank, then drop any
  // field sent as "" (that means "clear it").
  const existing = getAuthSettings(store)
  const merged: AuthSettings = {
    smtp: { ...(existing.smtp || {}), ...(input.smtp || {}) },
    sms: { ...(existing.sms || {}), ...(input.sms || {}) },
    google: { ...(existing.google || {}), ...(input.google || {}) },
    github: { ...(existing.github || {}), ...(input.github || {}) },
    otpTtlSec: input.otpTtlSec || existing.otpTtlSec,
  }
  for (const g of ['smtp', 'sms', 'google', 'github'] as const) {
    const src = (input as any)[g]
    if (!src) continue
    const dst = merged[g] as any
    for (const k of Object.keys(src)) {
      if (src[k] === '') delete dst[k]
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// OTP codes
// ---------------------------------------------------------------------------
export function generateOtpCode() {
  return String(randomInt(100000, 999999))
}

// issue stores a hashed code bound to an identifier (email or phone) so the raw
// code is never persisted.
export function issueOtp(store: Store, target: string, channel: 'email' | 'sms') {
  const code = generateOtpCode()
  const ttl = (getAuthSettings(store).otpTtlSec || 300) * 1000
  const h = hashCode(code)
  // prune expired
  store.db.otp = store.db.otp.filter((o) => o.expiresAt > Date.now())
  store.db.otp.push({ id: nanoid(10), target: target.toLowerCase(), channel, hash: h, createdAt: Date.now(), expiresAt: Date.now() + ttl, attempts: 0 })
  store.persist()
  return code
}

export function verifyOtp(store: Store, target: string, code: string) {
  const t = target.toLowerCase()
  const rec = store.db.otp.find((o) => o.target === t && o.expiresAt > Date.now())
  if (!rec) return false
  if (rec.attempts >= 5) { store.db.otp = store.db.otp.filter((o) => o.id !== rec.id); store.persist(); return false }
  rec.attempts += 1
  const ok = createHash('sha256').update(String(code).trim()).digest('hex') === rec.hash
  if (ok) store.db.otp = store.db.otp.filter((o) => o.id !== rec.id)
  store.persist()
  return ok
}

function hashCode(code: string) {
  return createHash('sha256').update(String(code).trim()).digest('hex')
}

// ---------------------------------------------------------------------------
// Email (SMTP) — small RFC5321 client using node:net / node:tls
// ---------------------------------------------------------------------------
import { connect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

function smtpLine(sock: Socket) {
  return new Promise<number>((resolve) => {
    const onData = (buf: Buffer) => {
      const s = buf.toString('utf8')
      if (/^\d{3} /.test(s)) {
        sock.removeListener('data', onData)
        resolve(Number(s.slice(0, 3)))
      }
    }
    sock.on('data', onData)
  })
}

async function smtpSend(cfg: NonNullable<AuthSettings['smtp']>, to: string, subject: string, text: string): Promise<void> {
  const host = cfg.host!
  const port = cfg.port || 587
  const useTls = cfg.secure || port === 465
  const user = cfg.user || ''
  const pass = cfg.pass || ''
  const from = cfg.from || user
  const ehlo = randomBytes(8).toString('hex')

  let sock: Socket
  if (useTls) {
    sock = tlsConnect({ host, port, servername: host }) as unknown as Socket
  } else {
    sock = connect(port, host)
  }
  const line = smtpLine(sock)
  const send = (cmd: string) => { sock.write(cmd + '\r\n'); return smtpLine(sock) }
  // 220 greeting
  const g = await Promise.race<number>([line, new Promise<number>((_, rej) => sock.once('error', rej))])
  if (g !== 220) { sock.destroy(); throw new Error(`SMTP greeting failed (${g})`) }
  const c = await send(`EHLO ${ehlo}`)
  if (c !== 250) { sock.destroy(); throw new Error(`EHLO failed (${c})`) }
  if (user) {
    const a = await send('AUTH LOGIN')
    if (a !== 334) { sock.destroy(); throw new Error(`AUTH not supported (${a})`) }
    if ((await send(Buffer.from(user).toString('base64'))) !== 334) { sock.destroy(); throw new Error('AUTH user rejected') }
    if ((await send(Buffer.from(pass).toString('base64'))) !== 235) { sock.destroy(); throw new Error('AUTH failed') }
  }
  if ((await send(`MAIL FROM:<${from}>`)) !== 250) { sock.destroy(); throw new Error('MAIL FROM rejected') }
  if ((await send(`RCPT TO:<${to}>`)) !== 250) { sock.destroy(); throw new Error('RCPT TO rejected') }
  if ((await send('DATA')) !== 354) { sock.destroy(); throw new Error('DATA rejected') }
  const msg = `From: UptimeHost <${from}>\r\nTo: <${to}>\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\n${text}\r\n.`
  sock.write(msg + '\r\n')
  if ((await smtpLine(sock)) !== 250) { sock.destroy(); throw new Error('message rejected') }
  await send('QUIT')
  sock.destroy()
}

// ---------------------------------------------------------------------------
// SMS — Twilio HTTP API or generic webhook
// ---------------------------------------------------------------------------
async function sendSms(cfg: NonNullable<AuthSettings['sms']>, to: string, body: string): Promise<void> {
  if (cfg.provider === 'webhook' && cfg.webhookUrl) {
    const r = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body }),
    })
    if (!r.ok) throw new Error(`SMS webhook returned ${r.status}`)
    return
  }
  if (!cfg.accountSid || !cfg.authToken) throw new Error('SMS not configured')
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`
  const cred = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')
  const form = new URLSearchParams({ To: to, From: cfg.from || '', Body: body }).toString()
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${cred}` },
    body: form,
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Twilio error ${r.status}: ${t.slice(0, 160)}`)
  }
}

// ---------------------------------------------------------------------------
// OAuth redirect URI / callback URL
// ---------------------------------------------------------------------------
// The OAuth callback lives on the API itself so the browser (and the provider)
// redirect to a stable, server-side endpoint. We never hardcode it: the base
// URL comes from the UH_PANEL_URL environment variable (set by the service
// unit to https://panel.uptimehost.in) with a request-derived fallback, and an
// admin may still override it per-provider in the panel. This guarantees the
// authorize + token-exchange requests always carry a real redirect_uri.
export function appBaseUrl(req?: { protocol?: string; host?: string }): string {
  if (process.env.UH_PANEL_URL) return process.env.UH_PANEL_URL.replace(/\/+$/, '')
  if (req) {
    const proto = req.protocol === 'http' ? 'http' : 'https'
    if (req.host) return `${proto}://${req.host}`
  }
  return 'https://panel.uptimehost.in'
}

export function oauthCallbackUrl(provider: 'google' | 'github', baseUrl: string): string {
  return `${baseUrl}/api/auth/oauth/${provider}`
}

// Resolve the redirect URI for a provider: an explicitly configured value wins,
// otherwise we derive one from the app base URL. Never returns undefined.
function resolveRedirectUri(provider: 'google' | 'github', s: AuthSettings, baseUrl: string): string {
  const cfg = provider === 'google' ? s.google : s.github
  if (cfg?.redirectUri && cfg.redirectUri.trim()) return cfg.redirectUri.trim()
  return oauthCallbackUrl(provider, baseUrl)
}

async function googleExchange(cfg: NonNullable<AuthSettings['google']>, code: string, redirectUri: string) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.clientId!, client_secret: cfg.clientSecret!,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }).toString(),
  })
  const tok = await tokenRes.json().catch(() => ({})) as any
  if (!tok.access_token) throw new Error('Google token exchange failed')
  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  })
  const info = await infoRes.json().catch(() => ({})) as any
  return { email: String(info.email || '').toLowerCase(), name: info.name || (info.email || '').split('@')[0] || 'Google User', avatar: info.picture || '' }
}

async function githubExchange(cfg: NonNullable<AuthSettings['github']>, code: string, redirectUri: string) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId!, client_secret: cfg.clientSecret!, code, redirect_uri: redirectUri }),
  })
  const tok = await tokenRes.json().catch(() => ({})) as any
  // Do not surface the access token; it's only used server-side for the calls below.
  if (!tok.access_token) throw new Error('GitHub token exchange failed')
  const auth = { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'uptimehost', Accept: 'application/vnd.github+json' }
  const infoRes = await fetch('https://api.github.com/user', { headers: auth })
  if (!infoRes.ok) throw new Error(`GitHub user API error (${infoRes.status})`)
  const info = await infoRes.json().catch(() => ({})) as any

  // GitHub's /user only includes `email` when the user made it public. To get a
  // usable verified email (required to build an UptimeHost account), query
  // /user/emails and pick the primary verified address. Scope `user:email` is
  // already requested in the authorize URL.
  let email = String(info.email || '').toLowerCase()
  if (!email) {
    try {
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers: auth })
      if (emailsRes.ok) {
        const emails = await emailsRes.json().catch(() => []) as any[]
        const pick = emails.find((e) => e && e.verified && e.primary) || emails.find((e) => e && e.verified)
        if (pick && pick.email) email = String(pick.email).toLowerCase()
      }
    } catch { /* leave email empty; route will surface OAUTH_NO_EMAIL */ }
  }

  return { email, name: info.name || info.login || 'GitHub User', avatar: info.avatar_url || '' }
}

// ---------------------------------------------------------------------------
// Public entry points used by routes
// ---------------------------------------------------------------------------
export async function sendOtp(store: Store, target: string, channel: 'email' | 'sms'): Promise<{ ok: boolean; error?: string }> {
  const a = getAuthSettings(store)
  let code = ''
  try {
    if (channel === 'email') {
      if (!a.smtp?.host || !a.smtp?.user) return { ok: false, error: 'EMAIL_OTP_NOT_CONFIGURED' }
      code = issueOtp(store, target, 'email')
      await smtpSend(a.smtp, target, 'Your UptimeHost verification code', `Your verification code is: ${code}\n\nIt expires in ${(a.otpTtlSec || 300) / 60} minutes.`)
    } else {
      if (!a.sms?.from && !(a.sms?.provider === 'webhook')) return { ok: false, error: 'SMS_OTP_NOT_CONFIGURED' }
      code = issueOtp(store, target, 'sms')
      await sendSms(a.sms, target, `Your UptimeHost verification code is: ${code}`)
    }
    return { ok: true }
  } catch (e: any) {
    // roll back the issued code on delivery failure so it can't be brute-forced later
    store.db.otp = store.db.otp.filter((o) => o.channel !== channel || !target.toLowerCase().includes(o.target))
    store.persist()
    return { ok: false, error: e?.message || 'DELIVERY_FAILED' }
  }
}

export function oauthAuthorizeUrl(provider: 'google' | 'github', store: Store, baseUrl?: string): string {
  const s = getAuthSettings(store)
  const base = baseUrl || appBaseUrl()
  // CSRF protection: generate a random state nonce, remember it (with TTL), and
  // verify it on the callback. It is never persisted or logged.
  const state = nanoid(24)
  registerOAuthState(state, provider)
  if (provider === 'google') {
    const c = s.google!
    const redirectUri = resolveRedirectUri('google', s, base)
    const p = new URLSearchParams({
      client_id: c.clientId!, redirect_uri: redirectUri, response_type: 'code',
      scope: 'openid email profile', state, prompt: 'select_account',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`
  }
  const c = s.github!
  const redirectUri = resolveRedirectUri('github', s, base)
  const p = new URLSearchParams({ client_id: c.clientId!, redirect_uri: redirectUri, scope: 'read:user user:email', state })
  return `https://github.com/login/oauth/authorize?${p.toString()}`
}

// ---------------------------------------------------------------------------
// OAuth state (CSRF) validation
// ---------------------------------------------------------------------------
// Short-lived, in-memory store of pending OAuth state nonces. Fastify here is
// single-process, so in-memory is correct; entries expire after 10 minutes and
// are consumed (removed) on first use to prevent replay.
const pendingStates = new Map<string, { provider: string; exp: number }>()
const STATE_TTL = 10 * 60 * 1000

function registerOAuthState(state: string, provider: string) {
  pruneOAuthStates()
  pendingStates.set(state, { provider, exp: Date.now() + STATE_TTL })
}

function pruneOAuthStates() {
  const now = Date.now()
  for (const [k, v] of pendingStates) if (v.exp < now) pendingStates.delete(k)
}

// Returns true iff the state nonce was issued for this provider and hasn't
// expired; consumes it on success so it can't be replayed.
export function validateOAuthState(state: string | undefined, provider: string): boolean {
  if (!state) return false
  pruneOAuthStates()
  const rec = pendingStates.get(String(state))
  if (!rec || rec.provider !== provider) return false
  pendingStates.delete(String(state))
  return true
}

export async function oauthCallback(store: Store, provider: 'google' | 'github', code: string, baseUrl?: string) {
  const s = getAuthSettings(store)
  const base = baseUrl || appBaseUrl()
  if (provider === 'google') {
    if (!s.google?.clientId || !s.google?.clientSecret) throw new Error('OAUTH_NOT_CONFIGURED')
    return googleExchange(s.google, code, resolveRedirectUri('google', s, base))
  }
  if (!s.github?.clientId || !s.github?.clientSecret) throw new Error('OAUTH_NOT_CONFIGURED')
  return githubExchange(s.github, code, resolveRedirectUri('github', s, base))
}

// Public provider flags for the login screen: which methods are available.
export function providerFlags(store: Store) {
  const a = getAuthSettings(store)
  return {
    emailOtp: !!a.smtp?.host && !!a.smtp?.user,
    sms: !!a.sms?.from && (!!a.sms?.authToken || !!a.sms?.webhookUrl),
    google: !!a.google?.clientId && !!a.google?.clientSecret,
    github: !!a.github?.clientId && !!a.github?.clientSecret,
  }
}
