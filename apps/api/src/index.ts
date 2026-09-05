// UptimeHost Control Core (Panel) — a real control plane.
//
// The Panel manages nodes (hosts running the Go agent), locations and servers.
// Server lifecycle, console, files and metrics are forwarded to the node's Go
// agent, which manages real Docker containers. The panel starts empty: the
// operator adds nodes and creates servers themselves.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import rateLimit from '@fastify/rate-limit'
import { Store } from './store/store.js'
import { seed } from './sim/seed.js'
import { WsHub } from './ws/hub.js'
import { randomBytes } from 'node:crypto'
import { nanoid } from 'nanoid'
import { requireAuth, createSession, verifyPw, hashPw, can, audit, isGlobalAdmin, serverAccess, generateKeyToken } from './modules/auth.js'
import { issueOtp, verifyOtp, sendOtp, oauthAuthorizeUrl, oauthCallback, oauthCallbackUrl, appBaseUrl, providerFlags, getAuthSettings, setAuthSettings, publicAuthSettings, validateOAuthState } from './modules/providers.js'
import { AgentClient, agentFor } from './modules/agentClient.js'
import { sshProbe, sshInstall } from './modules/sshConnect.js'
import { startMCVersionWatcher, currentDefaults, javaImage, mcState, refreshMCManifest } from './modules/mcVersions.js'
import { refreshCatalog, snapshot as catalogSnapshot, resolveVersionDownload, resolvePluginDownload, startCatalogWatcher } from './modules/catalog.js'
import WebSocket from 'ws'

const PORT = Number(process.env.UH_API_PORT || 8081)

// Pterodactyl-style Paper jar pinned to 1.21.11 build 132 (Java-21 compatible,
// matching the PaperMC yolks image). Downloaded into the server data dir by the
// node agent during provisioning/reinstall.
const PAPER_21_11_JAR =
  'https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar'

// Tracks servers for which the panel has already auto-accepted the Minecraft
// EULA during this process lifetime, so we only write eula=true once per boot.
const autoEulaAccepted = new Set<string>()

// Trust the reverse proxy (nginx) so X-Forwarded-Proto/Host are honored when
// deriving the public base URL for OAuth redirects. UH_PANEL_URL also takes
// precedence as a hard override.
const app = Fastify({ logger: false, trustProxy: true })
const store = new Store()
seed(store)
// Backfill: ensure capacity/maintenance/connectivity fields exist on nodes
// persisted before they were introduced so checks and the UI are consistent.
for (const node of store.db.nodes) {
  if (typeof node.overcommit !== 'boolean') node.overcommit = false
  if (typeof node.maintenance !== 'boolean') node.maintenance = false
  if (!node.scheme || !node.host) {
    node.scheme = node.scheme || normalizeScheme(undefined, node.agentUrl)
    node.host = node.host || parseHost(node.agentUrl) || 'localhost'
    node.port = node.port != null ? Number(node.port) : parsePort(node.agentUrl) || 7373
    node.agentUrl = buildAgentUrl(node)
  }
  if (!node.registrationToken) node.registrationToken = generateNodeToken()
  if (!node.installCommand) node.installCommand = buildInstallCommand(node)
}

// ---------------------------------------------------------------------------
// Minecraft version-awareness migration. Upgrades persisted blueprints that
// predate version tracking and snapshots a pinned version onto existing
// Minecraft servers so they are never silently mutated later (a reinstall is
// required to change a server's pinned version).
// ---------------------------------------------------------------------------
{
  const knownJavaByImage: Record<string, number> = {
    'ghcr.io/pterodactyl/yolks:java_25': 25,
    'ghcr.io/pterodactyl/yolks:java_21': 21,
    'ghcr.io/pterodactyl/yolks:java_17': 17,
    'ghcr.io/pterodactyl/yolks:java_16': 16,
    'ghcr.io/pterodactyl/yolks:java_11': 11,
    'ghcr.io/pterodactyl/yolks:java_8': 8,
    'itzg/minecraft-server:java21': 21,
  }
  const defaults = currentDefaults()
  const defaultJava = defaults.defaultJava || 21
  for (const bp of store.db.blueprints) {
    if (bp.id === 'bp-minecraft' || bp.id === 'bp-paper') {
      const java = bp.javaVersion = Number(bp.javaVersion) || knownJavaByImage[bp.image] || defaultJava
      if (/itzg|java_21:|java_25:|java_17:/.test(bp.image)) bp.image = javaImage(java)
      bp.startup = 'java -Xms128M -XX:MaxRAMPercentage=95.0 -jar server.jar nogui'
      bp.mcCatalog = true
      bp.dockerImages = { 8: javaImage(8), 11: javaImage(11), 16: javaImage(16), 17: javaImage(17), 21: javaImage(21), 25: javaImage(25) }
      bp.environment = { EULA: 'TRUE' }
    }
  }
  for (const s of store.db.servers) {
    if ((s.blueprintId === 'bp-minecraft' || s.blueprintId === 'bp-paper') && s.mcVersion == null) {
      const bp = store.db.blueprints.find((b: any) => b.id === s.blueprintId)
      s.mcVersion = (defaults.release?.id as string) || '1.21.11'
      s.javaVersion = Number(bp?.javaVersion) || knownJavaByImage[bp?.image] || defaultJava
    }
  }
  store.persist()
}

const hub = new WsHub((user, topic) => {
  if (!user) return false
  if (topic.startsWith('srv:')) {
    const sid = topic.slice(4)
    const s = store.db.servers.find((x) => x.id === sid)
    return !!s && serverAccess(user, s, store).ok
  }
  return true
})

await app.register(cors, { origin: ['https://panel.uptimehost.in', 'https://gp.uptimehost.in', 'https://panel.gp.uptimehost.in', 'https://gp1.uptimehost.in'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
await app.register(rateLimit, {
  max: 600,
  timeWindow: '1 minute',
  // Key on the edge-verified client IP (set by Cloudflare, forwarded by nginx)
  // so an attacker cannot rotate X-Forwarded-For to dodge the limit. Fall back
  // to the socket identity when the header is absent.
  keyGenerator: (req: any) => String((req.headers as any)['cf-connecting-ip'] || req.ip),
})
await app.register(websocket)

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// In-memory brute-force guards, keyed by normalized email, in addition to the
// IP rate limit. Tracks failed attempts and cooldown windows on the box itself
// (not spoofable via X-Forwarded-For).
const loginFails = new Map<string, { fails: number; lockedUntil: number }>()
const LOGIN_MAX_FAILS = 10
const LOGIN_LOCK_SEC = 5 * 60 * 1000
// A fixed scrypt-format hash used only to equalize login timing for
// nonexistent accounts (never assigned to a real user).
const DUMMY_PW_HASH = '0'.repeat(32) + ':' + '0'.repeat(128)

app.post('/api/auth/login', async (req, reply) => {
  const { email, password } = (req.body || {}) as any
  const normEmail = String(email || '').trim().toLowerCase()

  // Per-account lockout after repeated failures (independent of IP header).
  const state = loginFails.get(normEmail)
  if (state && state.lockedUntil > Date.now()) {
    return reply.code(429).send({ ok: false, error: 'TOO_MANY_ATTEMPTS' })
  }

  const user = store.db.users.find((u) => u.email.toLowerCase() === normEmail)

  // Timing equalization: run a scrypt verify even when the account does not
  // exist, so response time does not reveal which addresses are registered.
  const ok = user ? verifyPw(password, user.passwordHash) : verifyPw(password, DUMMY_PW_HASH)
  if (!user || !ok) {
    const next = { fails: (state?.fails || 0) + 1, lockedUntil: 0 }
    if (next.fails >= LOGIN_MAX_FAILS) next.lockedUntil = Date.now() + LOGIN_LOCK_SEC
    loginFails.set(normEmail, next)
    if (loginFails.size > 10000) {
      const oldest = loginFails.keys().next().value
      if (oldest) loginFails.delete(oldest)
    }
    return reply.code(401).send({ ok: false, error: 'Invalid credentials' })
  }

  loginFails.delete(normEmail)
  const token = createSession(store, user.id)
  activity(user, 'auth', 'info', `${user.name} signed in`)
  return { ok: true, token, user: publicUser(user) }
})

// Self-registration for the panel. New users get the most restricted role
// (viewer) by default — they can log in and see (only) what an admin grants
// them. Registration can be disabled entirely via UH_ALLOW_REGISTER=false.
app.post('/api/auth/register', async (req, reply) => {
  if (process.env.UH_ALLOW_REGISTER === 'false') {
    return reply.code(403).send({ ok: false, error: 'REGISTRATION_DISABLED' })
  }
  const { email, name, password } = (req.body || {}) as any
  const normEmail = String(email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail)) {
    return reply.code(400).send({ ok: false, error: 'INVALID_EMAIL' })
  }
  if (!name || !String(name).trim()) {
    return reply.code(400).send({ ok: false, error: 'NAME_REQUIRED' })
  }
  if (!password || String(password).length < 6) {
    return reply.code(400).send({ ok: false, error: 'WEAK_PASSWORD' })
  }
  if (store.db.users.some((u) => u.email.toLowerCase() === normEmail)) {
    return reply.code(409).send({ ok: false, error: 'EMAIL_IN_USE' })
  }
  const user = {
    id: 'u-' + nanoid(14),
    email: normEmail,
    name: String(name).trim(),
    role: 'viewer',
    avatarHue: Math.floor(Math.random() * 360),
    passwordHash: hashPw(password),
    createdAt: Date.now(),
  }
  store.db.users.push(user)
  store.persist()
  const token = createSession(store, user.id)
  activity(user, 'auth', 'info', `${user.name} registered and signed in`)
  return reply.code(201).send({ ok: true, token, user: publicUser(user) })
})

app.get('/api/auth/me', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, user: publicUser(user) }
})

// Self-service password change. Validates the current password, updates the
// hash, and revokes every other session so a leaked token cannot outlive the
// rotation. Only accounts with a password can call this.
app.post('/api/auth/change-password', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { currentPassword, newPassword } = (req.body || {}) as any
  const target = store.db.users.find((u) => u.id === user.id)
  if (!target || !target.passwordHash) {
    return reply.code(400).send({ ok: false, error: 'NO_PASSWORD', detail: 'This account uses OTP/OAuth and has no password.' })
  }
  if (!currentPassword || !verifyPw(String(currentPassword), target.passwordHash)) {
    return reply.code(401).send({ ok: false, error: 'INVALID_CURRENT_PASSWORD' })
  }
  if (!newPassword || String(newPassword).length < 8) {
    return reply.code(400).send({ ok: false, error: 'WEAK_PASSWORD', detail: 'New password must be at least 8 characters.' })
  }
  target.passwordHash = hashPw(String(newPassword))
  store.persist()
  // Revoke all other sessions for this account.
  const presented = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  store.db.sessions = store.db.sessions.filter((s) => s.userId !== user.id || s.token === presented)
  store.persist()
  audit(store, user.name, 'CHANGE_PASSWORD', `user:${user.email}`)
  activity(user, 'auth', 'info', `${user.name} changed password`)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Public-panel auth: email/phone OTP + Google/GitHub OAuth.
// All methods are configured by an admin in the panel (Settings → Auth), and
// are only offered on the login screen once a provider is configured.
// ---------------------------------------------------------------------------

// Which login methods are currently configured (for the login screen).
app.get('/api/auth/methods', async () => {
  const flags = providerFlags(store)
  return { ok: true, ...flags }
})

// Email OTP: send a code to an inbox. Also used for a "magic link"-style login
// where no separate password is needed. Target is a raw email address.
app.post('/api/auth/otp/email/send', async (req, reply) => {
  const { email } = (req.body || {}) as any
  const norm = String(email || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm)) return reply.code(400).send({ ok: false, error: 'INVALID_EMAIL' })
  const r = await sendOtp(store, norm, 'email')
  if (!r.ok) return reply.code(r.error === 'EMAIL_OTP_NOT_CONFIGURED' ? 400 : 502).send({ ok: false, error: r.error })
  return { ok: true, target: norm, expiresInSec: getAuthSettings(store).otpTtlSec || 300 }
})

// Phone OTP: send a code via SMS. Target is an E.164 phone number.
app.post('/api/auth/otp/sms/send', async (req, reply) => {
  const { phone } = (req.body || {}) as any
  const norm = String(phone || '').trim()
  if (!/^\+[1-9]\d{6,14}$/.test(norm)) return reply.code(400).send({ ok: false, error: 'INVALID_PHONE' })
  const r = await sendOtp(store, norm, 'sms')
  if (!r.ok) return reply.code(r.error === 'SMS_OTP_NOT_CONFIGURED' ? 400 : 502).send({ ok: false, error: r.error })
  return { ok: true, target: norm, expiresInSec: getAuthSettings(store).otpTtlSec || 300 }
})

// OTP verify → login. The target (email or phone) is the account key. If no
// account exists for it yet, one is auto-created (public signup) as a viewer.
app.post('/api/auth/otp/verify', async (req, reply) => {
  const { target, code, name } = (req.body || {}) as any
  const t = String(target || '').trim().toLowerCase()
  if (!t || !code) return reply.code(400).send({ ok: false, error: 'INVALID_REQUEST' })
  if (!verifyOtp(store, t, code)) return reply.code(401).send({ ok: false, error: 'INVALID_OR_EXPIRED_CODE' })

  let user = store.db.users.find((u) => u.email?.toLowerCase() === t || u.phone === t)
  if (!user) {
    const displayName = (name && String(name).trim()) || t.split('@')[0] || 'User'
    user = {
      id: 'u-' + nanoid(14),
      email: t.includes('@') ? t : undefined,
      phone: t.startsWith('+') ? t : undefined,
      name: displayName,
      role: 'viewer',
      avatarHue: Math.floor(Math.random() * 360),
      passwordHash: null,
      createdAt: Date.now(),
    }
    store.db.users.push(user)
    activity(user, 'auth', 'info', `${user.name} signed up via OTP`)
  }
  const token = createSession(store, user.id)
  activity(user, 'auth', 'info', `${user.name} signed in via OTP`)
  return { ok: true, token, user: publicUser(user) }
})

// OAuth start — return the provider's authorize URL (client should redirect).
// The popup's redirect_uri is always an absolute callback on this API, derived
// from the app base URL (UH_PANEL_URL), so it is never undefined.
app.post('/api/auth/oauth/:provider/url', async (req, reply) => {
  const { provider } = req.params as any
  if (provider !== 'google' && provider !== 'github') return reply.code(400).send({ ok: false, error: 'UNKNOWN_PROVIDER' })
  const flags = providerFlags(store)
  if ((provider === 'google' && !flags.google) || (provider === 'github' && !flags.github)) {
    return reply.code(400).send({ ok: false, error: 'OAUTH_NOT_CONFIGURED' })
  }
  const baseUrl = appBaseUrl(req)
  return { ok: true, url: oauthAuthorizeUrl(provider, store, baseUrl), redirectUri: oauthCallbackUrl(provider, baseUrl) }
})

// OAuth callback — the browser is redirected here by the provider with ?code=.
// We exchange the code server-side, create a session, and bounce the popup
// back to the SPA, which delivers the token to the opener (Login) window.
app.get('/api/auth/oauth/:provider', async (req, reply) => {
  const { provider } = req.params as any
  if (provider !== 'google' && provider !== 'github') return reply.code(400).send({ ok: false, error: 'UNKNOWN_PROVIDER' })
  const q = (req.query || {}) as any
  const baseUrl = appBaseUrl(req)
  const err = q.error
  if (err) {
    return reply.redirect(`${baseUrl}/oauth/callback/${provider}?error=${encodeURIComponent(String(err))}`)
  }
  const code = String(q.code || '')
  if (!code) {
    return reply.redirect(`${baseUrl}/oauth/callback/${provider}?error=${encodeURIComponent('missing authorization code')}`)
  }
  // CSRF protection: the state nonce must match one this server issued for the
  // callback. Rejects forged/replayed callbacks.
  if (!validateOAuthState(q.state, provider)) {
    return reply.redirect(`${baseUrl}/oauth/callback/${provider}?error=${encodeURIComponent('invalid state')}`)
  }
  let info: any
  try {
    info = await oauthCallback(store, provider, code, baseUrl)
  } catch (e: any) {
    return reply.redirect(`${baseUrl}/oauth/callback/${provider}?error=${encodeURIComponent(e?.message || 'OAUTH_FAILED')}`)
  }
  if (!info.email) {
    return reply.redirect(`${baseUrl}/oauth/callback/${provider}?error=${encodeURIComponent('OAUTH_NO_EMAIL')}`)
  }

  // find-or-create the account bound to this provider + email. The provider id
  // must match THIS identity — a bare predicate would resolve every provider
  // login to the first user who ever used that provider (identity confusion).
  const providerId = `${provider}:${info.email}`
  const byProvider = store.db.users.find((u) => u[`${provider}Id`] === providerId)
  const byEmail = store.db.users.find((u) => u.email?.toLowerCase() === info.email)
  let user = byProvider || byEmail
  if (!user) {
    user = {
      id: 'u-' + nanoid(14),
      email: info.email,
      name: info.name || info.email.split('@')[0],
      role: 'viewer',
      avatarHue: Math.floor(Math.random() * 360),
      passwordHash: null,
      [`${provider}Id`]: `${provider}:${info.email}`,
      createdAt: Date.now(),
    }
    store.db.users.push(user)
    activity(user, 'auth', 'info', `${user.name} signed up via ${provider}`)
  }
  if (!user[`${provider}Id`]) {
    user[`${provider}Id`] = `${provider}:${info.email}`
    if (info.avatar) user.avatar = info.avatar
    store.persist()
  }

  const token = createSession(store, user.id)
  activity(user, 'auth', 'info', `${user.name} signed in via ${provider}`)
  const qs = new URLSearchParams({ token, name: user.name || '', email: info.email, role: user.role || 'viewer', avatarHue: String(user.avatarHue ?? '') })
  return reply.redirect(`${baseUrl}/oauth/callback/${provider}?${qs.toString()}`)
})

// OAuth popup completion posted from a non-server flow (kept for compat): the
// frontend exchanges the code and receives { token, user } directly.
app.post('/api/auth/oauth/:provider/callback', async (req, reply) => {
  const { provider } = req.params as any
  if (provider !== 'google' && provider !== 'github') return reply.code(400).send({ ok: false, error: 'UNKNOWN_PROVIDER' })
  const { code } = (req.body || {}) as any
  if (!code) return reply.code(400).send({ ok: false, error: 'MISSING_CODE' })
  let info: any
  try {
    info = await oauthCallback(store, provider, code, appBaseUrl(req))
  } catch (e: any) {
    return reply.code(400).send({ ok: false, error: e?.message || 'OAUTH_FAILED' })
  }
  if (!info.email) return reply.code(400).send({ ok: false, error: 'OAUTH_NO_EMAIL' })

  const byEmail = store.db.users.find((u) => u.email?.toLowerCase() === info.email)
  const providerId = `${provider}:${info.email}`
  const byProvider = store.db.users.find((u) => u[`${provider}Id`] === providerId)
  let user = byProvider || byEmail
  if (!user) {
    user = {
      id: 'u-' + nanoid(14),
      email: info.email,
      name: info.name || info.email.split('@')[0],
      role: 'viewer',
      avatarHue: Math.floor(Math.random() * 360),
      passwordHash: null,
      [`${provider}Id`]: `${provider}:${info.email}`,
      createdAt: Date.now(),
    }
    store.db.users.push(user)
    activity(user, 'auth', 'info', `${user.name} signed up via ${provider}`)
  }
  // persist linkage from then on
  if (!user[`${provider}Id`]) {
    user[`${provider}Id`] = `${provider}:${info.email}`
    if (info.avatar) user.avatar = info.avatar
    store.persist()
  }

  const token = createSession(store, user.id)
  activity(user, 'auth', 'info', `${user.name} signed in via ${provider}`)
  return { ok: true, token, user: publicUser(user) }
})

// Fetch the public "is it configured + masked secrets" state (admin) — used by
// the Settings → Auth page.
app.get('/api/admin/auth-providers', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, providers: publicAuthSettings(store), flags: providerFlags(store) }
})

// Save auth-provider credentials (admin). Empty strings clear a field.
app.put('/api/admin/auth-providers', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const body = (req.body || {}) as any
  const merged = setAuthSettings(store, {
    smtp: body.smtp, sms: body.sms, google: body.google, github: body.github, otpTtlSec: body.otpTtlSec,
  })
  const saved = publicAuthSettings(store)
  audit(store, user.name, 'UPDATE_AUTH_PROVIDERS', 'auth providers')
  activity(user, 'admin', 'info', 'Updated auth provider configuration')
  void merged
  return { ok: true, providers: saved, flags: providerFlags(store) }
})

// ---------------------------------------------------------------------------
// Users (admin only) — lets an operator add additional panel accounts, e.g.
// via the CLI setup.py "add admin" step. Only global admins (owner+admin) may
// create or list users.
// ---------------------------------------------------------------------------
app.get('/api/users', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!isGlobalAdmin(user)) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, users: store.db.users.map(publicUser) }
})

app.post('/api/users', async (req, reply) => {
  const actor = me(req)
  if (!actor) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(actor, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { name, email, password, role } = (req.body || {}) as any
  const normEmail = String(email || '').trim().toLowerCase()
  const ROLES = ['viewer', 'developer', 'operator', 'admin', 'owner']
  const normRole = ROLES.includes(role) ? role : 'viewer'
  // Only the owner may grant admin/owner rights. A lower admin cannot create
  // another admin user.
  if ((normRole === 'admin' || normRole === 'owner') && actor.role !== 'owner') {
    return reply.code(403).send({ ok: false, error: 'OWNER_ONLY', detail: 'Only the owner can add admin users.' })
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail)) {
    return reply.code(400).send({ ok: false, error: 'INVALID_EMAIL' })
  }
  if (!name || !String(name).trim()) {
    return reply.code(400).send({ ok: false, error: 'NAME_REQUIRED' })
  }
  if (!password || String(password).length < 6) {
    return reply.code(400).send({ ok: false, error: 'WEAK_PASSWORD' })
  }
  if (store.db.users.some((u) => u.email.toLowerCase() === normEmail)) {
    return reply.code(409).send({ ok: false, error: 'EMAIL_IN_USE' })
  }
  const u = {
    id: 'u-' + nanoid(14),
    email: normEmail,
    name: String(name).trim(),
    role: normRole,
    avatarHue: Math.floor(Math.random() * 360),
    passwordHash: hashPw(password),
    createdAt: Date.now(),
  }
  store.db.users.push(u)
  store.persist()
  audit(store, actor.name, 'ADD_USER', `${normRole}:${normEmail}`)
  activity(actor, 'admin', 'info', `Added user ${u.name} (${normRole})`, { userId: u.id })
  return reply.code(201).send({ ok: true, user: publicUser(u) })
})

// Update an existing user (admin only): role (enable/promote admin), name,
// email (unique) and password. An admin cannot demote or strip their own
// admin rights, or promote anyone to owner unless they are themselves owner.
app.patch('/api/users/:id', async (req, reply) => {
  const actor = me(req)
  if (!actor) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(actor, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const u = store.db.users.find((x) => x.id === id)
  if (!u) return reply.code(404).send({ ok: false, error: 'USER_NOT_FOUND' })
  const { role, name, email, password } = (req.body || {}) as any
  const ROLES = ['viewer', 'developer', 'operator', 'admin', 'owner']
  const isSelf = actor.id === id

  // Only the owner may alter admin/owner accounts at all. Otherwise an admin
  // could send { email, password } (without role) and overwrite the owner's
  // credentials, taking over the whole panel.
  if ((u.role === 'admin' || u.role === 'owner') && actor.role !== 'owner') {
    return reply.code(403).send({ ok: false, error: 'OWNER_ONLY', detail: 'Only the owner can modify admin accounts.' })
  }

  if (role !== undefined) {
    if (!ROLES.includes(role)) return reply.code(400).send({ ok: false, error: 'INVALID_ROLE' })
    // Never allow stripping the last admin/owner (including yourself).
    if (role !== 'admin' && role !== 'owner' && (u.role === 'admin' || u.role === 'owner')) {
      return reply.code(400).send({ ok: false, error: 'CANNOT_DEMOTE_ADMIN' })
    }
    // Only the owner may grant admin or owner rights; an admin cannot promote
    // anyone to (or beyond) admin.
    if ((role === 'admin' || role === 'owner') && actor.role !== 'owner') {
      return reply.code(403).send({ ok: false, error: 'OWNER_ONLY', detail: 'Only the owner can manage admin users.' })
    }
    u.role = role
  }
  if (name !== undefined && String(name).trim()) u.name = String(name).trim()

  if (email !== undefined) {
    const normEmail = String(email).trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail)) {
      return reply.code(400).send({ ok: false, error: 'INVALID_EMAIL' })
    }
    if (store.db.users.some((x: any) => x.id !== u.id && x.email.toLowerCase() === normEmail)) {
      return reply.code(409).send({ ok: false, error: 'EMAIL_IN_USE' })
    }
    u.email = normEmail
  }
  if (password !== undefined && password !== '') {
    if (String(password).length < 6) return reply.code(400).send({ ok: false, error: 'WEAK_PASSWORD' })
    u.passwordHash = hashPw(password)
  }

  store.persist()
  audit(store, actor.name, 'UPDATE_USER', `${u.email} role=${u.role}`)
  activity(actor, 'admin', 'info', `Updated user ${u.name} (role=${u.role})`, { userId: u.id })
  return { ok: true, user: publicUser(u) }
})

// Delete a user (admin only). You cannot delete yourself; deleting a user also
// revokes their sessions and removes their per-server access grants.
app.delete('/api/users/:id', async (req, reply) => {
  const actor = me(req)
  if (!actor) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(actor, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const u = store.db.users.find((x) => x.id === id)
  if (!u) return reply.code(404).send({ ok: false, error: 'USER_NOT_FOUND' })
  if (u.id === actor.id) return reply.code(400).send({ ok: false, error: 'CANNOT_DELETE_SELF' })
  if (u.role === 'owner') return reply.code(400).send({ ok: false, error: 'CANNOT_DELETE_OWNER' })
  const email = u.email
  store.db.users = store.db.users.filter((x) => x.id !== id)
  store.db.sessions = store.db.sessions.filter((s) => s.userId !== id)
  store.db.access = store.db.access.filter((a) => a.email !== email)
  store.persist()
  audit(store, actor.name, 'DELETE_USER', email)
  activity(actor, 'admin', 'info', `Deleted user ${u.name} (${email})`, { userId: id })
  return { ok: true }
})

// List the servers a given user can access (admin only) — the per-user server
// view used by the admin Users tab.
app.get('/api/users/:id/servers', async (req, reply) => {
  const actor = me(req)
  if (!actor) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(actor, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const u = store.db.users.find((x) => x.id === id)
  if (!u) return reply.code(404).send({ ok: false, error: 'USER_NOT_FOUND' })
  const accessible = store.db.servers
    .filter((s) => serverAccess(u, s, store).ok)
    .map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      nodeId: s.nodeId,
      blueprintId: s.blueprintId,
      memoryLimitMb: s.memoryLimitMb,
      storageGb: s.storageGb,
      createdAt: s.createdAt,
      ownerEmail: s.ownerEmail,
    }))
  return { ok: true, servers: accessible }
})

app.post('/api/auth/logout', async (req, reply) => {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (token) {
      store.db.sessions = store.db.sessions.filter((s) => s.token !== token)
      store.persist()
    }
    return { ok: true }
  } catch (e) {
    return reply.code(500).send({ ok: false, error: 'logout failed' })
  }
})

function me(req: any) {
  return requireAuth(req, store)
}
function meFromToken(store: any, token: string) {
  return requireAuth({ headers: { authorization: `Bearer ${token}` } } as any, store)
}
function publicUser(u: any) {
  const { passwordHash, phone, googleId, githubId, ...rest } = u
  return rest
}
function activity(user: any, kind: string, severity: string, message: string, extra: any = {}) {
  const item = { id: nanoid(10), ts: Date.now(), kind, severity, message, actor: user?.name || 'system', actorId: user?.id, ...extra }
  store.db.activity.unshift(item)
  if (store.db.activity.length > 500) store.db.activity.length = 500
  store.persist()
  // Live broadcast, scoped so simple users only receive activity for servers
  // they can access or their own actions (not everyone's).
  hub.broadcastActivity(item, (u) => canSeeActivity(u, item))
}

// Whether a user may see a given activity record. Global admins see everything.
// Regular users only see their own actions and events on servers they can access.
function canSeeActivity(user: any, item: any): boolean {
  if (isGlobalAdmin(user)) return true
  if (!user) return false
  // own actions (auth, or anything they explicitly performed)
  if (item.actorId && item.actorId === user.id) return true
  if (item.userId && item.userId === user.id) return true
  // server-scoped events: only if the user has access to that server
  if (item.serverId) {
    const server = store.db.servers.find((s) => s.id === item.serverId)
    if (server && serverAccess(user, server, store).ok) return true
    return false
  }
  // non-server events with no own-actor match (node/admin/etc.) stay hidden
  return false
}

// ---------------------------------------------------------------------------
// Server state machine (§25) — only allow valid transitions.
// States: provisioning, starting, running, stopping, restarting, killing,
// offline, suspended, error.
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<string, string[]> = {
  provisioning: ['offline', 'error', 'starting', 'restarting'],
  offline: ['starting', 'restarting', 'provisioning', 'error'],
  starting: ['running', 'error', 'stopping', 'killing', 'offline'],
  running: ['stopping', 'restarting', 'killing', 'suspended', 'error', 'offline'],
  stopping: ['offline', 'error', 'killing', 'running'],
  restarting: ['running', 'error', 'stopping', 'killing', 'offline'],
  killing: ['offline', 'error'],
  suspended: ['starting', 'offline', 'error', 'restarting'],
  // An errored server must always be recoverable: allow start, restart, stop,
  // kill, and offline so the operator can retry or clean up.
  error: ['offline', 'starting', 'restarting', 'stopping', 'killing', 'provisioning', 'suspended'],
}
function canTransition(from: string, to: string): boolean {
  if (from === to) return true
  const allowed = VALID_TRANSITIONS[from]
  return !!allowed && allowed.includes(to)
}

// ---------------------------------------------------------------------------
// Node capacity (§28) — allocation tracking with optional overcommit.
// ---------------------------------------------------------------------------
function allocatedFor(node: any) {
  const servers = store.db.servers.filter((s) => s.nodeId === node.id)
  return {
    memoryMb: servers.reduce((a: number, s: any) => a + (s.memoryLimitMb || 0), 0),
    diskGb: servers.reduce((a: number, s: any) => a + (s.storageGb || 0), 0),
    servers: servers.length,
  }
}
function remaining(node: any) {
  const used = allocatedFor(node)
  // Disk is always subject to total; memory can overcommit only if node.overcommit.
  const memAvail = node.overcommit ? Number.MAX_SAFE_INTEGER : Math.max(0, (node.memoryMb || 0) - used.memoryMb)
  const diskAvail = Math.max(0, (node.diskGb || 0) - used.diskGb)
  return { ...used, memAvail, diskAvail }
}

// Port allocation from node's configured range (e.g., 25565-25597).
// Returns an array of allocation objects, one per needed port.
function allocatePorts(node: any, count: number): { id: string; port: number; proto: string }[] {
  if (!node.portRangeStart || !node.portRangeEnd || node.portRangeEnd < node.portRangeStart) {
    return [] // no range configured
  }
  const used = new Set<number>()
  for (const s of store.db.servers) {
    if (s.nodeId === node.id) {
      for (const a of s.allocations || []) {
        if (typeof a.port === 'number') used.add(a.port)
      }
    }
  }
  const out: { id: string; port: number; proto: string }[] = []
  for (let i = 0; i < count; i++) {
    let port = -1
    for (let p = node.portRangeStart; p <= node.portRangeEnd; p++) {
      if (!used.has(p)) {
        port = p
        used.add(p)
        break
      }
    }
    if (port === -1) break // range exhausted
    out.push({ id: nanoid(8), port, proto: 'tcp' })
  }
  return out
}

// Draw allocations from the node's manually-defined pool (set in the
// Allocations tab, each with an optional bind IP + public alias). Prefers free
// pool entries and never auto-creates new ones. Returns null when the pool has
// fewer free entries than requested so the caller can fall back.
function allocateFromNodePool(node: any, count: number): { id: string; ip?: string; port: number; proto: string; alias?: string }[] | null {
  const pool = node.allocations || []
  const used = new Set<string>()
  for (const s of store.db.servers) {
    if (s.nodeId === node.id) for (const a of s.allocations || []) used.add(a.id)
  }
  const free = pool.filter((a: any) => !used.has(a.id))
  if (free.length < count) return null
  return free.slice(0, count).map((a: any) => ({ id: a.id, ip: a.ip, port: a.port, proto: a.proto || 'tcp', alias: a.alias }))
}

// ---------------------------------------------------------------------------
// Node security (§4) — cryptographically random, revocable, rotatable tokens.
// Returns the plaintext once; callers must store it in agent config.
// ---------------------------------------------------------------------------
function generateNodeToken(): string {
  return 'uh_nt_' + randomBytes(24).toString('hex')
}

// ---------------------------------------------------------------------------
// Node connectivity (§ node connect) — FQDN + scheme(http/https) + port.
// The panel stores a connectivity descriptor and an install command that any
// operator can run on a target machine to enroll it into the panel.
// ---------------------------------------------------------------------------
function normalizeScheme(scheme: string | undefined, url: string | undefined): 'http' | 'https' {
  if (scheme === 'http' || scheme === 'https') return scheme
  const u = (url || '').toLowerCase()
  if (u.startsWith('https://')) return 'https'
  return 'http'
}

function parseHost(url: string | undefined): string {
  const u = (url || '').replace(/^https?:\/\//i, '').split('/')[0]
  const host = u.includes(':') ? u.split(':')[0] : u
  return host || ''
}

function parsePort(url: string | undefined): number | null {
  const m = /https?:\/\/([^/:]+):(\d+)/.exec(url || '')
  return m ? Number(m[2]) : null
}

// Hostnames the agent may advertise/use: strict FQDN/IP charset, no whitespace,
// no shell metacharacters, and no loopback/private/link-local addresses (which
// would let an enrolled agent point the panel at internal tooling instead).
function validAgentHost(h: string): boolean {
  if (typeof h !== 'string' || !h.length || h.length > 255) return false
  if (!/^[A-Za-z0-9._:-]+$/.test(h)) return false
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fe80:|::1|fd[0-9a-f]:|fc[0-9a-f]:|fec0:)/i.test(h)) return false
  return true
}

// Panel-side guard for file-manager paths before they are forwarded to the
// node agent: blocks traversal (..), NUL bytes, backslashes (which can confuse
// the agent's path handling), empty targets and absurd lengths. The agent
// remains the final authority on the filesystem, this is defense in depth.
function validPanelPath(p: any): boolean {
  if (typeof p !== 'string' || !p.trim() || p.length > 4096) return false
  if (p.includes('\0') || p.includes('\\')) return false
  if (p.split('/').some((seg) => seg === '..')) return false
  return true
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
const MAX_WRITE_BYTES = 1024 * 1024

function buildAgentUrl(node: any): string {
  if (node.agentUrl) {
    try {
      const u = new URL(node.agentUrl)
      if (u.protocol === 'https:' || u.protocol === 'http:') return node.agentUrl
    } catch { /* fall through */ }
  }
  return `${node.scheme}://${node.host}:${node.port}`
}

function defaultHost(url: string | undefined, scheme: string): string {
  const h = parseHost(url)
  return h || (scheme === 'https' ? 'localhost' : '')
}

// Install command handed to the operator to enroll any machine. It is a single
// self-contained command: paste it on the node (which only needs Go + git) and
// it clones the agent, builds the binary, writes every credential to the proper
// path (/etc/uptimehost/agent.env), then installs/starts a systemd service
// (restarting it if already running; nohup fallback where systemd is absent).
function buildInstallCommand(node: any): string {
  // UH_CORE_URL is where the AGENT talks back to the PANEL. It must be the
  // panel's own register endpoint (reachable from the node) — NOT the node's
  // address. Operators set UH_PANEL_URL to the public panel API base.
  const panel = (process.env.UH_PANEL_URL || '').replace(/\/$/, '')
  const regUrl = panel ? `${panel}/api/nodes/register` : `${node.agentUrl}/api/nodes/register`
  const id = node.id
  const regToken = node.registrationToken
  const port = node.port
  const agentToken = node.agentToken
  const scheme = node.scheme || 'http'
  const host = node.host || 'localhost'
  const repo = 'https://github.com/ProPlayer777bug/uptpanel.git'

  // For https nodes the agent needs a TLS cert + key. The command provisions a
  // self-signed cert so the listener actually serves TLS; the panel trusts it
  // via its dev-only UH_AGENT_INSECURE=1 override (real deployments should
  // supply a proper cert/key instead).
  const tlsProvision = scheme === 'https'
    ? [
        `CERT=/etc/uptimehost/server.crt`,
        `KEY=/etc/uptimehost/server.key`,
        `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \\`,
        `  -keyout "$KEY" -out "$CERT" -subj "/CN=${host}" >/dev/null 2>&1 || true`,
      ]
    : []
  const tlsEnv = tlsProvision.length
    ? [`UH_AGENT_TLS_CERT=/etc/uptimehost/server.crt`, `UH_AGENT_TLS_KEY=/etc/uptimehost/server.key`]
    : []

  return [
    `# One-command UptimeHost node install. Requires: git + go (and openssl for https).`,
    `# Paste on the node, then the agent configures + starts itself (idempotent: re-running restarts it).`,
    `# Registers the node back to the panel at ${regUrl}.`,
    `bash -s <<'UH'`,
    `set -e`,
    `REPO=/tmp/uptimehost-agent`,
    `BIN=/usr/local/bin/uh-agent`,
    `ENVF=/etc/uptimehost/agent.env`,
    `mkdir -p /etc/uptimehost /var/lib/uptimehost/data`,
    ...tlsProvision,
    `if [ ! -d "$REPO/.git" ]; then git clone -q --depth 1 ${repo} "$REPO"; else (cd "$REPO" && git fetch -q origin && git reset -q --hard origin/main); fi`,
    `(cd "$REPO/services/agent" && go build -o "$BIN" ./cmd/agent)`,
    `cat > "$ENVF" <<'ENV'`,
    `UH_CORE_URL=${regUrl}`,
    `UH_NODE_ID=${id}`,
    `UH_REG_TOKEN=${regToken}`,
    `UH_AGENT_ADDR=:${port}`,
    `UH_AGENT_TOKEN=${agentToken}`,
    `UH_AGENT_SCHEME=${scheme}`,
    `UH_AGENT_HOST=${host}`,
    `UH_CONTAINER_BASE=/var/lib/uptimehost/data`,
    ...tlsEnv,
    `ENV`,
    `if command -v systemctl >/dev/null 2>&1; then`,
    `  cat > /etc/systemd/system/uh-agent.service <<'SVC'`,
    `[Unit]`,
    `Description=UptimeHost Node Agent`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    `[Service]`,
    `Type=simple`,
    `EnvironmentFile=/etc/uptimehost/agent.env`,
    `ExecStart=/usr/local/bin/uh-agent`,
    `Restart=always`,
    `RestartSec=3`,
    `[Install]`,
    `WantedBy=multi-user.target`,
    `SVC`,
    `  systemctl daemon-reload`,
    `  systemctl enable uh-agent >/dev/null 2>&1 || true`,
    `  systemctl restart uh-agent`,
    `else`,
    `  pkill -f uh-agent >/dev/null 2>&1 || true`,
    `  nohup /bin/sh -c '. "$ENVF"; exec "$BIN"' >/var/log/uh-agent.log 2>&1 &`,
    `fi`,
    `echo "UH-NODE-OK node=${id} scheme=${scheme} host=${host} port=${port}"`,
    `UH`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Session context (drives the whole app)
// ---------------------------------------------------------------------------
app.get('/api/session/context', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const nodes = store.db.nodes.map(withHealth).map((n) => (isGlobalAdmin(user) ? n : publicNode(n)))
  return {
    ok: true,
    user: publicUser(user),
    locations: store.db.locations,
    nodes,
    blueprints: store.db.blueprints,
    servers: visibleServers(user).map((s) => withRelations(s, user)),
    summary: summarize(user),
  }
})

// ---------------------------------------------------------------------------
// Locations (admin)
// ---------------------------------------------------------------------------
app.get('/api/locations', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, locations: store.db.locations }
})

app.post('/api/locations', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { name, shortCode, description } = (req.body || {}) as any
  const loc = { id: nanoid(10), name: name || 'New Location', shortCode: (shortCode || (name || 'LOC').slice(0, 4).toUpperCase()), description: description || '', createdAt: Date.now() }
  store.db.locations.push(loc)
  store.persist()
  audit(store, user.name, 'CREATE_LOCATION', `location:${loc.name}`)
  activity(user, 'admin', 'info', `Created location ${loc.name}`)
  return reply.code(201).send({ ok: true, location: loc })
})

app.delete('/api/locations/:id', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const nodesHere = store.db.nodes.filter((n) => n.locationId === id)
  if (nodesHere.length) return reply.code(409).send({ ok: false, error: 'LOCATION_HAS_NODES', nodes: nodesHere.length })
  store.db.locations = store.db.locations.filter((l) => l.id !== id)
  store.persist()
  audit(store, user.name, 'DELETE_LOCATION', `location:${id}`)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Nodes (admin) — each node runs the Go agent
// ---------------------------------------------------------------------------
app.get('/api/nodes', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!isGlobalAdmin(user)) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, nodes: store.db.nodes.map(withHealth), locations: store.db.locations }
})

app.post('/api/nodes', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { name, locationId, scheme, host, port, agentUrl, agentToken, memoryMb, diskGb, overcommit, portRangeStart, portRangeEnd } = (req.body || {}) as any
  const finalHost = host || parseHost(agentUrl) || ''
  if (!validAgentHost(finalHost)) {
    return reply.code(400).send({ ok: false, error: 'INVALID_HOST', detail: 'Host must be a public FQDN/IP. Loopback and private addresses are not allowed.' })
  }
  const node: any = {
    id: nanoid(10),
    name: name || 'New Node',
    locationId: locationId || store.db.locations[0]?.id || null,
    // FQDN connection: protocol (http/https) + host + port. If a legacy raw
    // agentUrl is supplied, parse out scheme/host/port for backward compat.
    scheme: normalizeScheme(scheme, agentUrl),
    host: finalHost,
    port: port != null ? Number(port) : parsePort(agentUrl) || 7373,
    agentUrl: agentUrl || '',
    agentToken: agentToken || generateNodeToken(),
    registrationToken: '',
    installCommand: '',
    memoryMb: memoryMb || 8192,
    diskGb: diskGb || 100,
    overcommit: !!overcommit,
    maintenance: false,
    tokenCreatedAt: (agentToken || true) ? Date.now() : null,
    status: 'offline',
    dockerHealthy: false,
    agentVersion: null,
    createdAt: Date.now(),
    health: null,
    portRangeStart: portRangeStart ? Number(portRangeStart) : undefined,
    portRangeEnd: portRangeEnd ? Number(portRangeEnd) : undefined,
  }
  node.agentUrl = buildAgentUrl(node)
  node.registrationToken = generateNodeToken()
  node.installCommand = buildInstallCommand(node)
  store.db.nodes.push(node)
  store.persist()
  audit(store, user.name, 'CREATE_NODE', `node:${node.name}`)
  activity(user, 'admin', 'info', `Added node ${node.name}`, { nodeId: node.id })
  await refreshNode(node)
  return reply.code(201).send({ ok: true, node: withHealth(node) })
})

// ---------------------------------------------------------------------------
// AutoNodeConnect — provision + enroll a node entirely over SSH.
//   POST /api/nodes/auto/probe    { host, username, password } -> host resources
//   POST /api/nodes/auto/install  { host, username, password, name, memoryMb,
//                                   diskGb, overcommit, ... }   -> creates node,
//                                   installs + starts the agent over SSH, which
//                                   registers back to the panel.
// The SSH password is used transiently and never persisted.
// ---------------------------------------------------------------------------
app.post('/api/nodes/auto/probe', async (req, reply) => {
  const user = me(req)
  if (!user || !can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { host, port, username, password } = (req.body || {}) as any
  if (!host || !username || !password) return reply.code(400).send({ ok: false, error: 'SSH_CREDS_REQUIRED' })
  const creds = { host: String(host).trim(), port: Number(port || 22), username: String(username).trim(), password: String(password) }
  try {
    const info = await sshProbe(creds)
    return { ok: true, host: creds.host, info }
  } catch (e: any) {
    return reply.code(502).send({ ok: false, error: 'SSH_PROBE_FAILED', detail: String(e?.message || e) })
  }
})

app.post('/api/nodes/auto/install', async (req, reply) => {
  const user = me(req)
  if (!user || !can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { host, port, username, password, name, memoryMb, diskGb, overcommit, locationId } = (req.body || {}) as any
  if (!host || !username || !password) return reply.code(400).send({ ok: false, error: 'SSH_CREDS_REQUIRED' })
  const creds = { host: String(host).trim(), port: Number(port || 22), username: String(username).trim(), password: String(password) }
  
  // Derive panel URL from request if env var not set
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http'
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || ''
  const panel = (process.env.UH_PANEL_URL || `${proto}://${hostHeader}`).replace(/\/$/, '')
  
  if (!panel || panel === 'http://' || panel === 'https://') return reply.code(500).send({ ok: false, error: 'UH_PANEL_URL_NOT_SET' })

  // Advertised host the panel should use to reach the agent = the IP the admin
  // typed. The agent listens on plain HTTP; the panel already tolerates self-
  // signed/https via UH_AGENT_INSECURE but http needs no special handling.
  const node: any = {
    id: nanoid(10),
    name: (name && String(name).trim() ? String(name).trim() : String(host)).replace(/[^A-Za-z0-9 _.,-]/g, ''),
    locationId: locationId || store.db.locations[0]?.id || null,
    scheme: 'http',
    host: creds.host,
    port: 7373,
    agentUrl: '',
    agentToken: generateNodeToken(),
    registrationToken: generateNodeToken(),
    installCommand: '',
    memoryMb: Number(memoryMb) || 8192,
    diskGb: Number(diskGb) || 100,
    cpuPercent: null,
    overcommit: !!overcommit,
    maintenance: false,
    tokenCreatedAt: Date.now(),
    status: 'offline',
    dockerHealthy: false,
    agentVersion: null,
    createdAt: Date.now(),
    health: null,
  }
  node.agentUrl = buildAgentUrl(node)
  node.installCommand = buildInstallCommand(node)
  // Persist the node BEFORE starting the agent so its register call finds it.
  store.db.nodes.push(node)
  store.persist()

  try {
    await sshInstall(creds, {
      nodeId: node.id,
      nodeName: node.name,
      agentToken: node.agentToken,
      regToken: node.registrationToken,
      registerUrl: `${panel}/api/nodes/register`,
      host: creds.host,
      listenPort: node.port,
      scheme: 'http',
    })
  } catch (e: any) {
    store.db.nodes = store.db.nodes.filter((n) => n.id !== node.id)
    store.persist()
    audit(store, user.name, 'CREATE_NODE', `auto-install failed for ${node.name}: ${String(e?.message || e).slice(0, 300)}`)
    return reply.code(502).send({ ok: false, error: 'SSH_INSTALL_FAILED', detail: String(e?.message || e) })
  }

  audit(store, user.name, 'CREATE_NODE', `node:${node.name} (auto via SSH ${creds.host})`)
  activity(user, 'admin', 'info', `Auto-connected node ${node.name} via SSH`, { nodeId: node.id })
  // Give the agent a beat to register, then report the live state.
  await new Promise((r) => setTimeout(r, 3000))
  return reply.code(201).send({ ok: true, node: withHealth(node) })
})

// Update node configuration (general settings, resources, server limits,
// allocation strategy, Docker/images, dirs, SFTP, overcommit, etc.). Only the
// provided fields are changed; everything else is left as-is.
app.patch('/api/nodes/:id', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  const b = (req.body || {}) as any
  const string = (v: any) => (v === undefined ? undefined : String(v).trim())
  const bool = (v: any) => (v === undefined ? undefined : !!v)
  const int = (v: any) => (v === '' || v === undefined || v === null ? undefined : Number(v))

  if (string(b.name) !== undefined) node.name = string(b.name)
  if (string(b.description) !== undefined) node.description = string(b.description)
  if (string(b.locationId) !== undefined) node.locationId = b.locationId
  if (string(b.fqdn) !== undefined) {
    if (!validAgentHost(string(b.fqdn)!)) {
      return reply.code(400).send({ ok: false, error: 'INVALID_HOST', detail: 'Host must be a public FQDN/IP. Loopback and private addresses are not allowed.' })
    }
    node.host = string(b.fqdn)
  }
  if (int(b.port) !== undefined) {
    const p = int(b.port)!
    if (!Number.isInteger(p) || p < 1 || p > 65535) return reply.code(400).send({ ok: false, error: 'INVALID_PORT' })
    node.port = p
  }
  if (string(b.timezone) !== undefined) node.timezone = string(b.timezone)

  if (bool(b.overcommit) !== undefined) node.overcommit = bool(b.overcommit)
  if (int(b.memoryMb) !== undefined) node.memoryMb = int(b.memoryMb)
  if (int(b.diskGb) !== undefined) node.diskGb = int(b.diskGb)

  // Allocation strategy and resource plan.
  const strategy = string(b.allocationStrategy)
  if ([undefined, 'least_used', 'most_available', 'round_robin', 'manual'].includes(strategy)) {
    if (strategy !== undefined) node.allocationStrategy = strategy
  }
  if (int(b.swapMb) !== undefined) node.swapMb = int(b.swapMb)
  if (int(b.overcommitCpu) !== undefined) node.overcommitCpu = int(b.overcommitCpu)
  if (int(b.overcommitMemory) !== undefined) node.overcommitMemory = int(b.overcommitMemory)
  if (int(b.overcommitDisk) !== undefined) node.overcommitDisk = int(b.overcommitDisk)

  // Server limits (independent of physical resources).
  const limits = node.serverLimits || (node.serverLimits = {})
  const limInt = (k: string) => { const v = int(b[k]); if (v !== undefined) limits[k] = v }
  limInt('maxServers')
  limInt('maxCpuPercent')
  limInt('maxRamMb')
  limInt('maxDiskGb')
  limInt('maxBackups')
  limInt('maxDatabases')

  const cfg = node.config || (node.config = {})
  const cfgStr = (k: string) => { const v = string(b[k]); if (v !== undefined) cfg[k] = v }
  const cfgInt = (k: string) => { const v = int(b[k]); if (v !== undefined) cfg[k] = v }
  cfgStr('defaultImage')
  cfgStr('defaultStartup')
  cfgStr('defaultDirectory')
  cfgInt('defaultStopTimeout')
  cfgStr('defaultRestartPolicy')
  cfgStr('dataDir')
  cfgStr('backupDir')
  cfgStr('tempDir')
  cfgStr('logsDir')
  cfgStr('networkName')
  cfgInt('maxConcurrentBackups')
  cfgInt('backupBandwidth')
  cfgInt('sftpPort')
  cfgStr('dockerImage')
  cfgInt('dockerNetwork')
  if (Array.isArray(b.images)) cfg.images = b.images.map(String).filter(Boolean)
  if (bool(b.preventNew) !== undefined) cfg.preventNew = bool(b.preventNew)
  if (bool(b.preventMigrations) !== undefined) cfg.preventMigrations = bool(b.preventMigrations)
  if (bool(b.preventAuto) !== undefined) cfg.preventAuto = bool(b.preventAuto)

  if (bool(b.dockerStatus) !== undefined) node.dockerStatus = bool(b.dockerStatus)
  if (string(b.storageDriver) !== undefined) node.storageDriver = string(b.storageDriver)
  if (bool(b.sftpStatus) !== undefined) node.sftpStatus = bool(b.sftpStatus)
  if (int(b.imageMaxSizeMb) !== undefined) node.imageMaxSizeMb = int(b.imageMaxSizeMb)

  // Security: allowed panel IPs (array) and TLS enforcement.
  if (Array.isArray(b.allowedPanelIps)) node.allowedPanelIps = b.allowedPanelIps.map(String).filter(Boolean)
  if (bool(b.tlsEnabled) !== undefined) node.tlsEnabled = bool(b.tlsEnabled)

  node.agentUrl = buildAgentUrl(node)
  node.installCommand = buildInstallCommand(node)
  store.persist()
  audit(store, user.name, 'UPDATE_NODE', `node:${node.name}`)
  await refreshNode(node)
  reconcileServers(node)
  return { ok: true, node: withHealth(node) }
})

// ---------------------------------------------------------------------------
// Node allocations — IP/port ranges available for server assignment
// ---------------------------------------------------------------------------
app.get('/api/nodes/:id/allocations', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  return { ok: true, allocations: node.allocations || [], primaryId: node.primaryAllocationId }
})

// Create allocation(s). Supports a single {ip, port} or a bulk {ip, startPort,
// endPort}. Returns the created allocation set.
app.post('/api/nodes/:id/allocations', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  const b = (req.body || {}) as any
  node.allocations = node.allocations || []
  const created: any[] = []
  // Optional public hostname alias shared by every port in this range/batch,
  // e.g. bind 0.0.0.0 + range 25565-25595 + alias play.test.in -> servers on
  // these ports are advertised as play.test.in:<port>.
  const alias = b.alias ? String(b.alias).trim() : undefined
  const addOne = (ip: string, port: number) => {
    if (node.allocations.some((a: any) => a.ip === ip && a.port === port)) return null
    const alloc = { id: nanoid(10), ip, port, ...(alias ? { alias } : {}), ...(node.allocations.length === 0 ? { primary: true, primaryId: true } : {}) }
    node.allocations.push(alloc)
    if (node.allocations.length === 1) node.primaryAllocationId = alloc.id
    return alloc
  }
  if (b.total > 1 && b.startPort && b.endPort) {
    const ip = String(b.ip || node.host || '0.0.0.0')
    const start = Number(b.startPort); const end = Number(b.endPort)
    for (let p = start; p <= end; p++) { const a = addOne(ip, p); if (a) created.push(a) }
  } else {
    const a = addOne(String(b.ip || node.host || '0.0.0.0'), Number(b.port))
    if (a) created.push(a)
  }
  store.persist()
  audit(store, user.name, 'ALLOCATION_ADD', `node:${node.name} (+${created.length})`)
  return { ok: true, allocations: node.allocations, created: created.length }
})

app.delete('/api/nodes/:id/allocations/:allocId', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, allocId } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  const inUse = store.db.servers.some((s: any) => s.nodeId === id && (s.allocations || []).some((a: any) => a.id === allocId))
  if (inUse) return reply.code(409).send({ ok: false, error: 'ALLOCATION_IN_USE' })
  const wasPrimary = node.primaryAllocationId === allocId
  node.allocations = (node.allocations || []).filter((a: any) => a.id !== allocId)
  if (wasPrimary) {
    node.primaryAllocationId = node.allocations[0]?.id || null
    node.allocations = node.allocations.map((a: any, i: number) => ({ ...a, primary: i === 0 }))
  }
  store.persist()
  audit(store, user.name, 'ALLOCATION_REMOVE', `node:${node.name}`)
  return { ok: true, allocations: node.allocations }
})

app.post('/api/nodes/:id/allocations/:allocId/primary', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, allocId } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node || !(node.allocations || []).some((a: any) => a.id === allocId)) return reply.code(404).send({ ok: false, error: 'ALLOCATION_NOT_FOUND' })
  node.primaryAllocationId = allocId
  node.allocations = node.allocations.map((a: any) => ({ ...a, primary: a.id === allocId }))
  store.persist()
  audit(store, user.name, 'ALLOCATION_PRIMARY', `node:${node.name}`)
  return { ok: true, allocations: node.allocations }
})


app.get('/api/nodes/:id', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!isGlobalAdmin(user)) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return { ok: false, error: 'NODE_NOT_FOUND' }
  const servers = store.db.servers.filter((s) => s.nodeId === id).map((s) => withRelations(s, user))
  return { ok: true, node: withHealth(node), servers }
})

app.delete('/api/nodes/:id', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const serversOn = store.db.servers.filter((s) => s.nodeId === id)
  if (serversOn.length) return reply.code(409).send({ ok: false, error: 'NODE_HAS_SERVERS', servers: serversOn.length })
  store.db.nodes = store.db.nodes.filter((n) => n.id !== id)
  store.persist()
  audit(store, user.name, 'DELETE_NODE', `node:${id}`)
  return { ok: true }
})

app.post('/api/nodes/:id/refresh', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!isGlobalAdmin(user)) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  await refreshNode(node)
  reconcileServers(node)
  return { ok: true, node: withHealth(node) }
})

// Regenerate the install command for a node (new registration token). Useful
// if the previous one leaked or the operator wants to re-enroll a node.
app.post('/api/nodes/:id/install', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  node.registrationToken = generateNodeToken()
  node.installCommand = buildInstallCommand(node)
  store.persist()
  audit(store, user.name, 'REGENERATE_NODE_INSTALL', `node:${node.name}`)
  activity(user, 'admin', 'info', `Regenerated install command for ${node.name}`, { nodeId: node.id })
  return { ok: true, node: withHealth(node) }
})

// Agent outbound registration handshake (unauthenticated by design): the Go
// agent, installed on any reachable host, calls this with its nodeId + one-time
// registration token to enroll itself and declare how the panel should reach it.
// The agent also posts here on every heartbeat tick so the panel can track
// liveness (lastSeen) and live host resources (cpu/memory/disk/containers).
app.post('/api/nodes/register', async (req, reply) => {
  const body = (req.body || {}) as any
  const { nodeId, token, scheme, host, port } = body
  const node = store.db.nodes.find((n) => n.id === nodeId)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  if (!node.registrationToken || node.registrationToken !== token) {
    return reply.code(403).send({ ok: false, error: 'INVALID_REGISTRATION_TOKEN' })
  }
  // Adopt the endpoint the agent advertises so the panel can reach it back.
  // Endpoint fields are honored only until the node's FIRST successful
  // heartbeat. After enrollment the panel endpoint is locked: dropping them
  // here stops an enrolled agent (or anyone holding a leaked token) from
  // re-pointing the panel at an arbitrary URL (SSRF). Operators move nodes via
  // the admin PATCH route instead.
  const firstEnroll = !node.lastSeen
  if (firstEnroll) {
    if (scheme) node.scheme = normalizeScheme(scheme, undefined)
    if (host) {
      if (!validAgentHost(String(host))) {
        return reply.code(400).send({ ok: false, error: 'INVALID_HOST' })
      }
      node.host = host
    }
    if (port !== undefined && port !== null && port !== '') {
      const p = Number(port)
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return reply.code(400).send({ ok: false, error: 'INVALID_PORT' })
      }
      node.port = p
    }
    node.agentUrl = buildAgentUrl(node)
  }
  // Record heartbeat liveness + live host resources reported by the agent.
  node.lastSeen = Date.now()
  node.agentVersion = body.agentVersion ?? node.agentVersion
  node.dockerHealthy = body.dockerHealthy !== false
  node.cpuPercent = body.cpu
  node.memoryPercent = body.memory
  node.diskPercent = body.disk
  node.containerCount = body.containers
  node.status = nodeStatus(node)
  store.persist()
  activity(null, 'node', 'info', `${node.name} enrolled and online via ${node.agentUrl}`, { nodeId: node.id })
  return { ok: true, enrolled: true, node: withHealth(node) }
})

// Node maintenance mode (§29): blocks new server/allocation creation but keeps
// existing servers running.
app.post('/api/nodes/:id/maintenance', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  node.maintenance = !node.maintenance
  store.persist()
  audit(store, user.name, node.maintenance ? 'NODE_MAINTENANCE_ON' : 'NODE_MAINTENANCE_OFF', `node:${node.name}`)
  activity(user, 'admin', node.maintenance ? 'warning' : 'info', `${node.name} ${node.maintenance ? 'entered maintenance' : 'exited maintenance'}`, { nodeId: node.id })
  return { ok: true, node: withHealth(node) }
})

// Node token rotation (§4): generate a fresh cryptographically random secret.
// The new token is returned exactly once so the admin can re-provision the agent.
app.post('/api/nodes/:id/rotate-token', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  const old = node.agentToken
  node.agentToken = generateNodeToken()
  node.tokenCreatedAt = Date.now()
  node.status = 'unconfigured'
  store.persist()
  audit(store, user.name, 'ROTATE_NODE_TOKEN', `node:${node.name}`, { before: old ? '****' : null })
  activity(user, 'admin', 'warning', `Rotated token for ${node.name}`, { nodeId: node.id })
  // Returned once for agent re-provisioning.
  return { ok: true, token: node.agentToken, node: withHealth(node) }
})

// Revoke token (§4): disable the node credential, forcing offline until the
// agent is re-provisioned with a fresh token.
app.post('/api/nodes/:id/revoke-token', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const node = store.db.nodes.find((n) => n.id === id)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })
  node.agentToken = ''
  node.status = 'unconfigured'
  node.dockerHealthy = false
  store.persist()
  audit(store, user.name, 'REVOKE_NODE_TOKEN', `node:${node.name}`)
  activity(user, 'admin', 'warning', `Revoked token for ${node.name}`, { nodeId: node.id })
  return { ok: true, node: withHealth(node) }
})

async function refreshNode(node: any) {
  const client = agentFor(node)
  if (!client) {
    node.status = 'unconfigured'
    node.dockerHealthy = false
    store.persist()
    return
  }
  try {
    const info = await client.ping()
    node.lastSeen = Date.now()
    node.dockerHealthy = !!info.dockerHealthy
    node.agentVersion = info.version
    node.containerCount = info.containers ?? node.containerCount
    if (info.host) {
      node.hostStats = {
        cpuPercent: info.host.cpuPercent,
        memoryBytes: info.host.memoryBytes,
        memoryUsed: info.host.memoryUsed,
        memoryPercent: info.host.memoryPercent,
        diskBytes: info.host.diskBytes,
        diskUsed: info.host.diskUsed,
        diskPercent: info.host.diskPercent,
        load1: info.host.load1,
        load5: info.host.load5,
        load15: info.host.load15,
        uptimeSec: info.host.uptimeSec,
        os: info.host.os,
        kernel: info.host.kernel,
        cpuCores: info.host.cpuCores,
        netRxBytes: info.host.netRxBytes,
        netTxBytes: info.host.netTxBytes,
      }
      node.cpuPercent = info.host.cpuPercent
      node.memoryPercent = info.host.memoryPercent
      node.diskPercent = info.host.diskPercent
    }
    node.health = { reachedAt: info.reachableAt, containers: info.containers, dockerHealthy: info.dockerHealthy }
    node.status = nodeStatus(node)
  } catch {
    node.dockerHealthy = false
    node.status = 'offline'
  }
  store.persist()
}

// Node liveness thresholds (seconds since last heartbeat). A node is ONLINE
// while heartbeats arrive within UH_NODE_ONLINE_S; WARNING within
// UH_NODE_WARNING_S; otherwise OFFLINE. Overridable via env.
const NODE_ONLINE_S = Number(process.env.UH_NODE_ONLINE_S || 60)
const NODE_WARNING_S = Number(process.env.UH_NODE_WARNING_S || 300)

// nodeStatus derives the live state from the last heartbeat. unconfigured
// nodes (no credentials) and maintenance windows short-circuit to their own
// states; otherwise the age of the last heartbeat decides online/warning/offline.
function nodeStatus(node: any): string {
  if (node.maintenance) return 'maintenance'
  if (!node.agentUrl || !node.agentToken) return 'unconfigured'
  if (!node.lastSeen) return 'offline'
  const ageSec = (Date.now() - node.lastSeen) / 1000
  if (ageSec <= NODE_ONLINE_S) return 'online'
  if (ageSec <= NODE_WARNING_S) return 'warning'
  return 'offline'
}

function withHealth(node: any) {
  const servers = store.db.servers.filter((s) => s.nodeId === node.id)
  const memUsed = servers.reduce((a: number, s: any) => a + (s.memoryLimitMb ?? s.memoryMb ?? 0), 0)
  const diskUsed = servers.reduce((a: number, s: any) => a + (s.storageGb ?? 0), 0)
  return {
    ...node,
    status: nodeStatus(node),
    serverCount: servers.length,
    allocatedMemoryMb: memUsed,
    allocatedDiskGb: diskUsed,
    remainingMemoryMb: Math.max(0, (node.memoryMb || 0) - memUsed),
    remainingDiskGb: Math.max(0, (node.diskGb || 0) - diskUsed),
  }
}

// Node shape safe for non-admin consumers. The agent bearer token, registration
// token and install command are control-plane credentials — they must never be
// sent to viewers or self-registered users.
function publicNode(node: any) {
  const { agentToken, registrationToken, installCommand, agentUrl, ...rest } = node
  return rest
}

// ---------------------------------------------------------------------------
// Blueprints (deployable catalog)
// ---------------------------------------------------------------------------
app.get('/api/blueprints', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, blueprints: store.db.blueprints }
})

// Auto-updating Minecraft version catalog. The panel polls Mojang's launcher
// meta manifest so new releases appear here (and become defaults for new
// servers) without operator action.
app.get('/api/mc/versions', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, versions: currentDefaults(), meta: mcState() }
})

// -- Marketplace catalog (versions + plugins) — refreshed every hour ---------
app.get('/api/catalog', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, catalog: catalogSnapshot() }
})

// Change a Minecraft server's version: picks the new server.jar for the pinned
// version, downloads it onto the node and reinstalls the server (world data is
// preserved — only server.jar is replaced).
app.post('/api/servers/:id/version', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const { version } = (req.body || {}) as any
  if (!version) return reply.code(400).send({ ok: false, error: 'VERSION_REQUIRED' })
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!(server.blueprintId === 'bp-minecraft' || server.blueprintId === 'bp-paper')) {
    return reply.code(400).send({ ok: false, error: 'NOT_A_MINECRAFT_SERVER' })
  }
  const resolved = await resolveVersionDownload(version, server.blueprintId)
  if (!resolved?.url) return reply.code(404).send({ ok: false, error: 'VERSION_NOT_FOUND', detail: 'Could not resolve a download for this version.' })

  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = agentFor(node)
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })

  const wasRunning = server.state !== 'offline' && server.state !== 'stopping' && server.state !== 'suspended'
  server.state = 'restarting'
  store.persist()
  hub.to(`srv:${id}`, { type: 'server-update', data: server })
  pushTerminal(id, `[version] switching to ${resolved.platform || ''} ${resolved.name} — replacing server.jar ...`, 'warn')
  try {
    // Replace only the server.jar (world/plugins preserved), then update the
    // startup image java if the new version requires a different runtime.
    await client.downloadFile(id, 'server.jar', resolved.url)
    server.mcVersion = resolved.name
    server.mcPlatform = resolved.platform || server.mcPlatform || 'paper'
    server.javaVersion = resolved.java ?? server.javaVersion
    // Reset the docker image to match the required java runtime (vanilla uses
    // its own java; paper/purpur/folia all run modern versions on Java 21).
    const prevImage = server.image
    server.image = javaImage(resolved.java)
    store.persist()
    if (server.state !== 'offline') {
      try { await client.power(id, 'stop') } catch { /* may already be stopped */ }
    }
    if (prevImage !== server.image) {
      // Recreate the container so the new java runtime image is used.
      await client.remove(id)
      await client.createContainer(buildManifest(server))
    }
    // Settle the state: after a version swap (jar replaced / container recreated)
    // the node holds a stopped container, so the server is offline until started.
    server.state = 'offline'
    server.startedAt = null
    server.error = undefined
    server.lastAction = 'version'
    store.persist()
    pushTerminal(id, `[version] now on ${resolved.name} — server ready to start`, 'info')
    activity(user, 'server', 'info', `Changed ${server.name} to Minecraft ${resolved.name}`, { serverId: id })
    audit(store, user.name, 'CHANGE_VERSION', `server:${server.name} -> ${resolved.name}`)
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
    return { ok: true, server: withRelations(server) }
  } catch (e: any) {
    // A failed version swap must not brick the server: keep it recoverable.
    server.state = server.state === 'offline' ? 'offline' : 'error'
    server.error = String(e?.message || e)
    server.startedAt = null
    store.persist()
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
    return reply.code(500).send({ ok: false, error: 'VERSION_CHANGE_FAILED', message: String(e?.message || e) })
  }
})

// Install a plugin (from SpigotMC / Modrinth catalog) onto a Minecraft server.
// The jar is downloaded onto the node into the server's plugins/ folder.
app.post('/api/servers/:id/plugins', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const { pluginId } = (req.body || {}) as any
  if (!pluginId) return reply.code(400).send({ ok: false, error: 'PLUGIN_REQUIRED' })
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!(server.blueprintId === 'bp-minecraft' || server.blueprintId === 'bp-paper')) {
    return reply.code(400).send({ ok: false, error: 'NOT_A_MINECRAFT_SERVER' })
  }
  const resolved = await resolvePluginDownload(pluginId)
  if (!resolved?.url) return reply.code(404).send({ ok: false, error: 'PLUGIN_NOT_FOUND', detail: 'Could not resolve a download for this plugin.' })

  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = agentFor(node)
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })

  const targetPath = `plugins/${resolved.fileName}`
  pushTerminal(id, `[plugins] installing ${resolved.name} ...`, 'warn')
  try {
    await client.downloadFile(id, targetPath, resolved.url)
    pushTerminal(id, `[plugins] installed ${resolved.fileName} — restart the server to load it`, 'info')
    activity(user, 'server', 'info', `Installed plugin ${resolved.name} on ${server.name}`, { serverId: id })
    audit(store, user.name, 'INSTALL_PLUGIN', `server:${server.name} plugin:${resolved.name}`)
    return { ok: true, path: targetPath, name: resolved.name }
  } catch (e: any) {
    return reply.code(502).send({ ok: false, error: 'PLUGIN_INSTALL_FAILED', message: String(e?.message || e) })
  }
})

// ---------------------------------------------------------------------------
// Servers — real Docker containers managed by the node agent
// ---------------------------------------------------------------------------
function withRelations(s: any, user?: any) {
  const node = store.db.nodes.find((n) => n.id === s.nodeId)
  const bp = store.db.blueprints.find((b) => b.id === s.blueprintId)
  const acc = user ? serverAccess(user, s, store) : { ok: false, permissions: {} }
  return { ...s, node: node ? { id: node.id, name: node.name, host: node.host, status: node.status, agentUrl: node.agentUrl } : null, blueprint: bp, permissions: acc.permissions, role: yourRole(user, s) }
}

// Non-admin users only see servers they have been granted access to (or own).
function visibleServers(user: any): any[] {
  if (isGlobalAdmin(user)) return store.db.servers
  return store.db.servers.filter((s) => serverAccess(user, s, store).ok)
}

function yourRole(user: any, s: any): string | undefined {
  if (!user) return undefined
  if (isGlobalAdmin(user)) return 'admin'
  if (s.ownerEmail === user.email) return 'owner'
  const entry = store.db.access.find((a) => a.serverId === s.id && a.email === user.email)
  return entry?.role
}

// Resolve a server with authorization: returns the server if the user may view
// it, otherwise an error signaling the appropriate HTTP status.
function findServer(user: any, id: string): { server: any } | { error: string; status: number } {
  const server = store.db.servers.find((x) => x.id === id)
  if (!server) return { error: 'SERVER_NOT_FOUND', status: 404 }
  if (!serverAccess(user, server, store).ok) return { error: 'FORBIDDEN', status: 403 }
  return { server }
}

app.get('/api/servers', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, servers: visibleServers(user).map((s) => withRelations(s, user)), summary: summarize(user) }
})

app.get('/api/servers/:id', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const s = store.db.servers.find((x) => x.id === id)
  if (!s) return { ok: false, error: 'SERVER_NOT_FOUND' }
  if (!serverAccess(user, s, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, server: withRelations(s, user) }
})

app.post('/api/servers', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { name, blueprintId, nodeId, memoryMb, cpuPercent, storageGb, extraEnv } = (req.body || {}) as any
  const node = store.db.nodes.find((n) => n.id === nodeId)
  const bp = store.db.blueprints.find((b) => b.id === blueprintId)
  if (!node) return reply.code(400).send({ ok: false, error: 'NODE_REQUIRED' })
  if (!bp) return reply.code(400).send({ ok: false, error: 'BLUEPRINT_REQUIRED' })

  // §29: node in maintenance blocks new server creation.
  if (node.maintenance) return reply.code(409).send({ ok: false, error: 'NODE_MAINTENANCE' })

  // §28: enforce node capacity against requested resources (honoring overcommit).
  const reqMem = memoryMb || bp.recommendedMemoryMb
  const reqDisk = storageGb || bp.recommendedStorageGb
  const rem = remaining(node)
  if (!node.overcommit && reqMem > rem.memAvail) {
    return reply.code(409).send({ ok: false, error: 'CAPACITY_MEMORY', requested: reqMem, available: rem.memAvail })
  }
  if (reqDisk > rem.diskAvail) {
    return reply.code(409).send({ ok: false, error: 'CAPACITY_DISK', requested: reqDisk, available: rem.diskAvail })
  }

  const id = 'srv-' + nanoid(12)
  // Minecraft catalog blueprints snapshot the current latest release + its
  // required Java runtime at creation, so each server is pinned to the version
  // that was current when it was made. Existing/new servers never get their
  // version silently bumped later; a manual reinstall is required to upgrade.
  // If the Mojang manifest isn't loaded yet (fresh boot), fetch it inline so a
  // brand-new server always pins the true latest release.
  const defaults = isMinecraftCatalogBp(bp) && !currentDefaults().release
    ? await refreshMCManifest()
    : currentDefaults()
  const mcDefaults = isMinecraftCatalogBp(bp)
    ? { mcVersion: defaults.release?.id || null, javaVersion: defaults.release?.java ?? defaults.defaultJava }
    : {}
  const server: any = {
    id,
    name: name || `${bp.name} Server`,
    ownerEmail: user?.email,
    nodeId: node.id,
    blueprintId: bp.id,
    state: 'provisioning',
    cpuPercent: cpuPercent || bp.recommendedCpu,
    memoryMb: 0,
    memoryLimitMb: memoryMb || bp.recommendedMemoryMb,
    storageGb: storageGb || bp.recommendedStorageGb,
    extraEnv: extraEnv || {},
    ...mcDefaults,
    // Allocate from the node's manual pool (Allocations tab) when it has
    // enough free ports; otherwise fall back to the node's raw port range or
    // blueprint fixed ports. The pool never auto-expands.
    allocations: (() => {
      const pool = allocateFromNodePool(node, bp.ports.length)
      if (pool) return pool
      return (node.portRangeStart && node.portRangeEnd)
        ? allocatePorts(node, bp.ports.length)
        : bp.ports.map((p: number) => ({ id: nanoid(8), port: p, proto: 'tcp' }))
    })(),
    createdAt: Date.now(),
    installed: false,
    startedAt: null,
  }
  store.db.servers.push(server)
  store.persist()

  // Forward the container to the node agent (asynchronous install: pull image).
  const client = agentFor(node)!
  const manifest = buildManifest(server)
  launch(server, client, manifest, user)
  audit(store, user.name, 'CREATE_SERVER', `server:${server.name}`)
  activity(user, 'server', 'info', `Creating ${server.name}`, { serverId: id })
  return reply.code(201).send({ ok: true, server: withRelations(server) })
})

// Build the container manifest forwarded to the node agent. Centralised so
// provisioning, reinstall and self-healing start all recreate identical
// containers from the server's stored blueprint/env/allocations.
function isMinecraftCatalogBp(bp: any): boolean {
  return !!bp && (bp.id === 'bp-minecraft' || bp.id === 'bp-paper' || bp.id === 'bp-vanilla-mc')
}

// resolveServerImage chooses the docker image for a server. Minecraft catalog
// blueprints are version-aware: the image is picked from the required Java
// runtime (snapshotted on the server at creation), so a server keeps its own
// version even when the panel's global defaults advance. Non-Minecraft
// blueprints keep their fixed blueprint image.
function resolveServerImage(server: any, bp: any): string {
  if (!isMinecraftCatalogBp(bp)) return bp?.image
  const java = server.javaVersion != null ? Number(server.javaVersion) : null
  if (java) return javaImage(java)
  // Backward compatibility: pre-versioning servers carry no javaVersion; infer
  // from the current blueprint image if it already encodes a Java runtime.
  const m = /(?:java[_-]?|:java)(\d+)/i.exec(bp?.image || '')
  if (m) return javaImage(Number(m[1]))
  return bp?.image || javaImage(currentDefaults().defaultJava)
}

function buildManifest(server: any): any {
  const bp = store.db.blueprints.find((b: any) => b.id === server.blueprintId)
  return {
    id: server.id,
    name: server.name,
    image: resolveServerImage(server, bp),
    startup: bp?.startup ? (bp.startup as string).trim().split(/\s+/) : undefined,
    env: { ...(bp?.environment || {}), ...(server.extraEnv || {}), ...(server.javaEnv || {}) },
    ports: Object.fromEntries((server.allocations || []).map((a: any) => [`${a.port}/tcp`, String(a.port)])),
    memoryMb: server.memoryLimitMb,
    cpuPercent: server.cpuPercent,
    diskMb: server.storageGb * 1024,
    mountData: '',
    uid: server.uid ?? 1001,
  }
}

function launch(server: any, client: AgentClient, manifest: any, user: any) {
  const stages = [
    { pct: 10, stage: 'Preparing environment' },
    { pct: 40, stage: 'Provisioning container' },
    { pct: 100, stage: 'Container created' },
  ]
  let i = 0
  const iv = setInterval(async () => {
    const st = stages[i]
    pushTerminal(server.id, `[control] ${st.stage} (${st.pct}%)`)
    hub.to(`srv:${server.id}`, { type: 'deploy-progress', data: { serverId: server.id, pct: st.pct, stage: st.stage } })
    if (st.pct === 100) {
      clearInterval(iv)
      try {
        await client.createContainer(manifest)
        await seedServerFiles(server, client)
        server.installed = true
        server.state = 'offline'
        store.persist()
        hub.to(`srv:${server.id}`, { type: 'server-update', data: server })
        activity(user, 'server', 'info', `${server.name} provisioned — ready to start`, { serverId: server.id })
      } catch (e: any) {
        server.state = 'error'
        server.error = String(e?.message || e)
        store.persist()
        pushTerminal(server.id, `[control] ERROR: ${server.error}`)
        hub.to(`srv:${server.id}`, { type: 'server-update', data: server })
        activity(user, 'server', 'error', `Failed to provision ${server.name}`, { serverId: server.id })
      }
      return
    }
    i++
  }, 500)
}

// Power actions forward to the node agent (real Docker).
app.post('/api/servers/:id/power', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const { action } = (req.body || {}) as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const acc = serverAccess(user, server, store)
  if (!acc.ok || !acc.permissions.command) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = agentFor(node)
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const pending = action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : action === 'restart' ? 'restarting' : 'killing'
  // §25: reject actions that don't form a valid transition from the current state.
  if (!canTransition(server.state, pending) || server.state === 'suspended') {
    return reply.code(409).send({ ok: false, error: 'INVALID_TRANSITION', from: server.state, to: pending })
  }
  server.state = pending
  store.persist()
  hub.to(`srv:${id}`, { type: 'server-update', data: server })
  pushTerminal(id, `[control] ${action} requested`)
  try {
    if (action === 'start') {
      try {
        await client.power(server.id, 'start')
      } catch (startErr: any) {
        const msg = String(startErr?.message || startErr || '')
        // The container vanished from the node ("No such container"). Rebuild
        // it from the stored manifest, then retry the start so the panel
        // self-heals instead of leaving the server stuck in 'error'.
        if (server.installed && /no such container/i.test(msg)) {
          pushTerminal(id, '[control] container missing — recreating from manifest')
          await client.createContainer(buildManifest(server))
          await client.power(server.id, 'start')
        } else {
          throw startErr
        }
      }
    } else {
      await client.power(server.id, action)
    }
    if (action === 'start') { server.state = 'running'; server.startedAt = Date.now() }
    if (action === 'stop' || action === 'kill') { server.state = 'offline'; server.startedAt = null }
    if (action === 'restart') server.state = 'running'
    server.lastAction = action
    store.persist()
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
    activity(user, 'server', 'info', `${server.name} ${action}`, { serverId: id })
    audit(store, user.name, 'POWER', `${action}:${server.name}`)
    return { ok: true, server: withRelations(server) }
  } catch (e: any) {
    server.state = 'error'
    server.error = String(e?.message || e)
    store.persist()
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
    pushTerminal(id, `[control] ERROR: ${server.error}`)
    return reply.code(500).send({ ok: false, error: 'POWER_FAILED', message: String(e?.message || e) })
  }
})

app.delete('/api/servers/:id', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (client) {
    // Close the host firewall for every allocated port before tearing down, so
    // a deleted server's ports are never left open on the node.
    for (const a of server.allocations || []) {
      if (typeof a.port === 'number') {
        try { await client.closeFirewall(server.id, a.port) } catch { /* best-effort */ }
      }
    }
    try { await client.remove(server.id) } catch { /* best-effort */ }
  }
  store.db.servers = store.db.servers.filter((s) => s.id !== id)
  store.persist()
  audit(store, user.name, 'DELETE_SERVER', `server:${server.name}`)
  activity(user, 'server', 'info', `Deleted ${server.name}`)
  return { ok: true }
})

// Attach an extra port/allocation to a server (Ports manager). The port is
// taken from the node's free pool and its host firewall is opened immediately.
app.post('/api/servers/:id/allocations', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const { port, allocationId } = (req.body || {}) as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  if (!node) return reply.code(404).send({ ok: false, error: 'NODE_NOT_FOUND' })

  const used = new Set<number>()
  for (const s of store.db.servers) {
    if (s.nodeId === node.id) for (const a of s.allocations || []) used.add(a.port)
  }

  let alloc: any = null
  const pool = node.allocations || []
  if (allocationId) {
    const cand = pool.find((a: any) => a.id === allocationId)
    if (!cand || used.has(cand.port)) return reply.code(409).send({ ok: false, error: 'ALLOCATION_UNAVAILABLE' })
    alloc = { id: cand.id, ip: cand.ip, port: cand.port, proto: cand.proto || 'tcp', alias: cand.alias }
  } else if (typeof port === 'number' && port >= 1 && port <= 65535) {
    if (used.has(port)) return reply.code(409).send({ ok: false, error: 'ALLOCATION_UNAVAILABLE', detail: 'That port is already assigned to a server on this node.' })
    // Prefer an existing free pool entry, else use any free port within the
    // node's configured range (auto-added to the pool).
    const cand = pool.find((a: any) => a.port === port)
    if (cand) {
      alloc = { id: cand.id, ip: cand.ip, port: cand.port, proto: cand.proto || 'tcp', alias: cand.alias }
    } else if (node.portRangeStart && node.portRangeEnd && port >= node.portRangeStart && port <= node.portRangeEnd) {
      const na = { id: nanoid(10), ip: '0.0.0.0', port, proto: 'tcp' }
      node.allocations = [...pool, na]
      alloc = { id: na.id, ip: na.ip, port: na.port, proto: 'tcp' }
    } else {
      return reply.code(400).send({ ok: false, error: 'PORT_OUT_OF_RANGE', detail: `Port must be within the node range ${node.portRangeStart || '?'}-${node.portRangeEnd || '?'} or already in the allocation pool.` })
    }
  } else {
    return reply.code(400).send({ ok: false, error: 'PORT_OR_ALLOCATION_REQUIRED' })
  }

  server.allocations = server.allocations || []
  server.allocations.push({ ...alloc, proto: alloc.proto || 'tcp' })
  store.persist()

  // Open the host firewall for the new port so external traffic can reach it.
  const client = agentFor(node)
  if (client) {
    try { await client.openFirewall(server.id, alloc.port) } catch (e: any) { /* best-effort */ }
  }

  hub.to(`srv:${id}`, { type: 'server-update', data: server })
  activity(user, 'server', 'info', `Added port ${alloc.port} to ${server.name}`, { serverId: id })
  audit(store, user.name, 'ADD_ALLOCATION', `${server.name}:+${alloc.port}`)
  return { ok: true, allocations: server.allocations, server: withRelations(server) }
})

// Detach a port/allocation from a server and close its host firewall.
app.delete('/api/servers/:id/allocations/:allocId', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, allocId } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const alloc = (server.allocations || []).find((a: any) => a.id === allocId)
  if (!alloc) return reply.code(404).send({ ok: false, error: 'ALLOCATION_NOT_FOUND' })
  if ((server.allocations || []).length <= 1) {
    return reply.code(400).send({ ok: false, error: 'LAST_ALLOCATION', detail: 'A server must keep at least one port.' })
  }
  server.allocations = server.allocations.filter((a: any) => a.id !== allocId)
  store.persist()

  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = node ? agentFor(node) : null
  if (client && typeof alloc.port === 'number') {
    try { await client.closeFirewall(server.id, alloc.port) } catch { /* best-effort */ }
  }

  hub.to(`srv:${id}`, { type: 'server-update', data: server })
  activity(user, 'server', 'info', `Removed port ${alloc.port} from ${server.name}`, { serverId: id })
  audit(store, user.name, 'REMOVE_ALLOCATION', `${server.name}:-${alloc.port}`)
  return { ok: true, allocations: server.allocations, server: withRelations(server) }
})

// Reconcile server live state from the node agent's Docker.
async function reconcileServers(node: any) {
  const client = agentFor(node)
  if (!client) return
  try {
    const { containers } = await client.list()
    for (const c of containers) {
      const server = store.db.servers.find((s) => s.id === c.serverId)
      if (!server) continue
      const dockerState = c.state
      const running = c.running
      let desired: string | null = null
      if (running) desired = 'running'
      else if (dockerState === 'created') desired = server.installed ? 'offline' : 'provisioning'
      else desired = 'offline'
      if (server.state !== desired && !server.state.startsWith('start') && !server.state.startsWith('stop') && !server.state.startsWith('restart')) {
        console.log(`[reconcile] ${server.id} ${server.state} -> ${desired} (docker=${dockerState} running=${running})`)
        server.state = desired
        if (!running) server.startedAt = null
        if (running && !server.startedAt) server.startedAt = Date.now()
        store.persist()
        hub.to(`srv:${server.id}`, { type: 'server-update', data: server })
      }
    }
  } catch { /* node down */ }
}

app.post('/api/servers/:id/command', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const { command } = (req.body || {}) as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.command) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { output } = await client.command(server.id, command)
  pushTerminal(id, `> ${command}`)
  return { ok: true, output }
})

app.get('/api/servers/:id/stats', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return { ok: false, error: found.error }
  const server = found.server
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return { ok: false, error: 'NODE_UNREACHABLE' }
  try {
    const stats = await client.stats(server.id)
    return { ok: true, stats: { ...stats, state: server.state } }
  } catch (e: any) {
    return { ok: true, stats: { running: false, state: server.state, error: String(e?.message || e) } }
  }
})

app.get('/api/servers/:id/logs', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return { ok: false, error: found.error }
  const server = found.server
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return { ok: false, error: 'NODE_UNREACHABLE' }
  const { output } = await client.containerLogs(server.id, 200)
  return { ok: true, output }
})

// ---------------------------------------------------------------------------
// Files (forwarded to the node agent)
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/files', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const path = (req.query as any)?.path || '/'
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.listFiles(server.id, path)
  if ((res as any)?.error) return reply.code(400).send(res)
  return res
})

app.get('/api/servers/:id/files/content', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const path = (req.query as any)?.path || '/'
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.readFile(server.id, path)
  if ((res as any)?.error) return reply.code(400).send(res)
  return res
})

app.post('/api/servers/:id/files/write', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { path, content } = (req.body || {}) as any
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  if (typeof content === 'string' && content.length > MAX_WRITE_BYTES) return reply.code(400).send({ ok: false, error: 'FILE_TOO_LARGE' })
  const res = await client.writeFile(server.id, path, content)
  audit(store, user.name, 'EDIT_FILE', `file:${path}`)
  return res
})

// Delete a file or directory (recursive).
app.post('/api/servers/:id/files/delete', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { path } = (req.body || {}) as any
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.deleteFile(server.id, path)
  audit(store, user.name, 'DELETE_FILE', `file:${path}`)
  return res
})

// Rename / move a file or directory.
app.post('/api/servers/:id/files/rename', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { from, to } = (req.body || {}) as any
  if (!validPanelPath(from) || !validPanelPath(to)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.renameFile(server.id, from, to)
  audit(store, user.name, 'RENAME_FILE', `file:${from}->${to}`)
  return res
})

// Create a directory.
app.post('/api/servers/:id/files/mkdir', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { path } = (req.body || {}) as any
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.makeDir(server.id, path)
  audit(store, user.name, 'MKDIR', `dir:${path}`)
  return res
})

// Zip a file/dir into a sibling .zip on the node.
app.post('/api/servers/:id/files/archive', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { path } = (req.body || {}) as any
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.archive(server.id, path)
  audit(store, user.name, 'ARCHIVE', `file:${path}`)
  return res
})

// Extract a zip already on the node into the current directory.
app.post('/api/servers/:id/files/archive/extract', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const { path } = (req.body || {}) as any
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const res = await client.extractArchive(server.id, path)
  audit(store, user.name, 'EXTRACT_ARCHIVE', `file:${path}`)
  return res
})

// Upload one or more files (multipart) into the given directory.
app.post('/api/servers/:id/files/upload', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const path = (req.query as any)?.path || '/'
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) {
    return reply.code(413).send({ ok: false, error: 'UPLOAD_TOO_LARGE' })
  }
  // raw multipart proxy: pass the incoming body stream through to the agent
  const url = `${client.baseUrl}/api/servers/${server.id}/files/upload?path=${encodeURIComponent(path)}`
  const up = await client.fetchTls(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      ...(req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : {}),
    },
    body: req.raw,
    duplex: 'half',
  } as any)
  if (!up.ok) {
    const text = await up.text().catch(() => '')
    return reply.code(up.status).send({ ok: false, error: 'UPLOAD_FAILED', detail: text.slice(0, 200) })
  }
  const res = await up.json().catch(() => ({ ok: true }))
  audit(store, user.name, 'UPLOAD_FILES', `dir:${path}`)
  return res
})

// Download a file's bytes to the browser.
app.get('/api/servers/:id/files/download', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send()
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return reply.code(found.status).send({ ok: false, error: found.error })
  const server = found.server
  const acc = serverAccess(user, server, store)
  if (!acc.permissions.files) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const path = (req.query as any)?.path || ''
  if (!validPanelPath(path)) return reply.code(400).send({ ok: false, error: 'INVALID_PATH' })
  const up = await client.downloadFileBytes(server.id, path)
  if (!up.ok) return reply.code(up.status).send({ ok: false, error: 'FILE_UNAVAILABLE' })
  const buf = Buffer.from(await up.arrayBuffer())
  reply.header('Content-Type', 'application/octet-stream')
  reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(path.split('/').pop() || 'file')}"`)
  reply.header('Content-Length', String(buf.length))
  audit(store, user.name, 'DOWNLOAD_FILE', `file:${path}`)
  return reply.send(buf)
})

// ---------------------------------------------------------------------------
// Backups — real ZIP archives created/extracted by the node agent
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/backups', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, backups: store.db.backups.filter((b) => b.serverId === id) }
})

app.post('/api/servers/:id/backups', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const { name } = (req.body || {}) as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = agentFor(node)
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })

  const uuid = nanoid(10)
  const file = `${uuid}.zip`
  const backup: {
    id: string
    serverId: string
    name: string
    uuid: string
    file: string
    sizeBytes: number
    status: string
    createdAt: number
    completedAt: number | null
    error: string | null
  } = {
    id: nanoid(10),
    serverId: id,
    name: name || `Backup ${new Date().toLocaleString()}`,
    uuid,
    file,
    sizeBytes: 0,
    status: 'running',
    createdAt: Date.now(),
    completedAt: null,
    error: null,
  }
  store.db.backups.unshift(backup)
  store.persist()
  hub.to(`srv:${id}`, { type: 'backup-progress', data: { backupId: backup.id, status: 'running', pct: 5 } })
  pushTerminal(id, `[backup] starting ${backup.name}`)

  // fire-and-forget: agent creates the archive and returns its real size.
  ;(async () => {
    try {
      const res = await client.createBackup(server.id, file, uuid)
      backup.status = 'completed'
      backup.completedAt = Date.now()
      backup.sizeBytes = Number(res?.bytes || 0)
      hub.to(`srv:${id}`, { type: 'backup-progress', data: { backupId: backup.id, status: 'completed', pct: 100 } })
      pushTerminal(id, `[backup] ${backup.name} completed (${fmtBytes(backup.sizeBytes)})`, 'info')
      activity(user, 'server', 'info', `Backed up ${server.name}`, { serverId: id })
      audit(store, user.name, 'CREATE_BACKUP', `backup:${backup.name}`)
    } catch (e: any) {
      backup.status = 'failed'
      backup.error = String(e?.message || e)
      hub.to(`srv:${id}`, { type: 'backup-progress', data: { backupId: backup.id, status: 'failed', pct: 0 } })
      pushTerminal(id, `[backup] ${backup.name} failed: ${backup.error}`, 'error')
    }
    store.persist()
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
  })()

  return reply.code(201).send({ ok: true, backup })
})

app.get('/api/servers/:id/backups/:bid/download', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send()
  const { id, bid } = req.params as any
  const backup = store.db.backups.find((b) => b.id === bid && b.serverId === id)
  if (!backup) return reply.code(404).send({ ok: false, error: 'BACKUP_NOT_FOUND' })
  const server = store.db.servers.find((s) => s.id === id)!
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  const up = await client.downloadBackup(server.id, backup.file)
  if (!up.ok) return reply.code(up.status).send({ ok: false, error: 'BACKUP_UNAVAILABLE' })
  const buf = Buffer.from(await up.arrayBuffer())
  reply.header('Content-Type', 'application/zip')
  reply.header('Content-Disposition', `attachment; filename="${backup.file}"`)
  reply.header('Content-Length', String(buf.length))
  reply.send(buf)
  audit(store, user.name, 'DOWNLOAD_BACKUP', `backup:${backup.name}`)
})

app.post('/api/servers/:id/backups/:bid/restore', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, bid } = req.params as any
  const backup = store.db.backups.find((b) => b.id === bid && b.serverId === id)
  if (!backup) return reply.code(404).send({ ok: false, error: 'BACKUP_NOT_FOUND' })
  const server = store.db.servers.find((s) => s.id === id)!
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  pushTerminal(id, `[restore] extracting ${backup.name} ...`, 'info')
  try {
    const res = await client.restoreBackup(server.id, backup.file)
    pushTerminal(id, `[restore] complete (${fmtBytes(res.bytes)})`, 'info')
    activity(user, 'server', 'info', `Restored ${server.name} from ${backup.name}`, { serverId: id })
    audit(store, user.name, 'RESTORE_BACKUP', `backup:${backup.name}`)
    return { ok: true, ...res }
  } catch (e: any) {
    pushTerminal(id, `[restore] failed: ${String(e?.message || e)}`, 'error')
    return reply.code(500).send({ ok: false, error: 'RESTORE_FAILED', message: String(e?.message || e) })
  }
})

app.delete('/api/servers/:id/backups/:bid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, bid } = req.params as any
  const backup = store.db.backups.find((b) => b.id === bid && b.serverId === id)
  if (!backup) return reply.code(404).send({ ok: false, error: 'BACKUP_NOT_FOUND' })
  const server = store.db.servers.find((s) => s.id === id)!
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (client) {
    try { await client.deleteBackup(server.id, backup.file) } catch { /* best-effort */ }
  }
  store.db.backups = store.db.backups.filter((b) => b.id !== bid)
  store.persist()
  audit(store, user.name, 'DELETE_BACKUP', `backup:${backup.name}`)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Startup / configuration (env + startup command) forwarded to agent
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/startup', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const bp = store.db.blueprints.find((b) => b.id === server.blueprintId)
  return {
    ok: true,
    startup: { ...(bp?.environment || {}), ...(server.extraEnv || {}) },
    extraEnv: server.extraEnv || {},
    blueprintEnv: bp?.environment || {},
    startupCommand: bp?.startup || '',
    resourceLimits: { cpuPercent: server.cpuPercent, memoryLimitMb: server.memoryLimitMb, storageGb: server.storageGb },
  }
})

app.post('/api/servers/:id/startup', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const { extraEnv, resourceLimits } = (req.body || {}) as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (resourceLimits) {
    if (resourceLimits.cpuPercent) server.cpuPercent = resourceLimits.cpuPercent
    if (resourceLimits.memoryLimitMb) server.memoryLimitMb = resourceLimits.memoryLimitMb
    if (resourceLimits.storageGb) server.storageGb = resourceLimits.storageGb
  }
  server.extraEnv = { ...(server.extraEnv || {}), ...(extraEnv || {}) }
  store.persist()

  // Re-provision the running container with the new env/limits.
  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = agentFor(node)
  if (client) {
    const bp = store.db.blueprints.find((b) => b.id === server.blueprintId)
    try {
      if (await client.exists(server.id)) {
        await client.remove(server.id)
        const manifest = {
          id: server.id,
          name: server.name,
          image: bp?.image,
          startup: bp?.startup ? bp.startup.trim().split(/\s+/) : undefined,
          env: { ...(bp?.environment || {}), ...server.extraEnv },
          ports: Object.fromEntries(server.allocations.map((a: any) => [`${a.port}/tcp`, String(a.port)])),
          memoryMb: server.memoryLimitMb,
          cpuPercent: server.cpuPercent,
          diskMb: server.storageGb * 1024,
          mountData: '',
        }
        await client.createContainer(manifest)
      }
    } catch { /* best-effort: reconcile will re-sync */ }
  }
  activity(user, 'server', 'info', `Updated startup/config for ${server.name}`, { serverId: id })
  audit(store, user.name, 'EDIT_CONFIG', `server:${server.name}`)
  await reconcileServers(node)
  return { ok: true, server: withRelations(server) }
})

// ---------------------------------------------------------------------------
// Reinstall / rebuild (wipes data, recreates container)
// ---------------------------------------------------------------------------
app.post('/api/servers/:id/reinstall', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  const client = agentFor(node)
  if (!client) return reply.code(409).send({ ok: false, error: 'NODE_UNREACHABLE' })
  server.state = 'restarting'
  store.persist()
  hub.to(`srv:${id}`, { type: 'server-update', data: server })
  pushTerminal(id, '[reinstall] wiping data and rebuilding ...', 'warn')
  try {
    await client.reinstall(server.id)
    await client.createContainer(buildManifest(server))
    await seedServerFiles(server, client)
    server.state = 'offline'
    server.installed = true
    store.persist()
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
    pushTerminal(id, '[reinstall] complete — clean rebuild ready', 'info')
    activity(user, 'server', 'info', `Reinstalled ${server.name}`, { serverId: id })
    audit(store, user.name, 'REINSTALL_SERVER', `server:${server.name}`)
    return { ok: true, server: withRelations(server) }
  } catch (e: any) {
    server.state = 'error'
    server.error = String(e?.message || e)
    store.persist()
    hub.to(`srv:${id}`, { type: 'server-update', data: server })
    return reply.code(500).send({ ok: false, error: 'REINSTALL_FAILED', message: String(e?.message || e) })
  }
})

// ---------------------------------------------------------------------------
// Schedules — cron-driven tasks executed by the control core
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/schedules', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const schedules = store.db.schedules
    .filter((s: any) => s.serverId === id)
    .map((s: any) => ({ ...s, runs: store.db.scheduleRuns.filter((r) => r.scheduleId === s.id).slice(0, 20) }))
  return { ok: true, schedules }
})

app.post('/api/servers/:id/schedules', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { name, cron, isActive = true, tasks = [] } = (req.body || {}) as any
  if (!cron || !cronValid(cron)) return reply.code(400).send({ ok: false, error: 'INVALID_CRON' })
  const schedule = {
    id: nanoid(10),
    serverId: id,
    name: name || 'Untitled schedule',
    cron,
    isActive,
    tasks: (tasks as any[]).map((t, i) => ({
      id: nanoid(8),
      sequenceId: i,
      action: t.action || 'command',
      payload: t.payload || '',
    })),
    lastRunAt: null,
    nextRunAt: nextCron(cron),
    createdAt: Date.now(),
  }
  store.db.schedules.push(schedule)
  store.persist()
  audit(store, user.name, 'CREATE_SCHEDULE', `schedule:${schedule.name}`)
  return reply.code(201).send({ ok: true, schedule })
})

app.post('/api/servers/:id/schedules/:sid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, sid } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const schedule = store.db.schedules.find((s: any) => s.id === sid && s.serverId === id)
  if (!schedule) return reply.code(404).send({ ok: false, error: 'SCHEDULE_NOT_FOUND' })
  const { name, cron, isActive, tasks } = (req.body || {}) as any
  if (name !== undefined) schedule.name = name
  if (cron) {
    if (!cronValid(cron)) return reply.code(400).send({ ok: false, error: 'INVALID_CRON' })
    schedule.cron = cron
    schedule.nextRunAt = nextCron(cron)
  }
  if (isActive !== undefined) schedule.isActive = isActive
  if (tasks !== undefined) {
    schedule.tasks = tasks.map((t: any, i: number) => ({ id: t.id || nanoid(8), sequenceId: i, action: t.action || 'command', payload: t.payload || '' }))
  }
  store.persist()
  audit(store, user.name, 'UPDATE_SCHEDULE', `schedule:${schedule.name}`)
  return { ok: true, schedule }
})

app.delete('/api/servers/:id/schedules/:sid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, sid } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  store.db.schedules = store.db.schedules.filter((s: any) => !(s.id === sid && s.serverId === id))
  store.persist()
  return { ok: true }
})

app.post('/api/servers/:id/schedules/:sid/run', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'command')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, sid } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const schedule = store.db.schedules.find((s: any) => s.id === sid && s.serverId === id)
  if (!schedule) return reply.code(404).send({ ok: false, error: 'SCHEDULE_NOT_FOUND' })
  runSchedule(schedule, user)
  return { ok: true, kicked: true }
})

// Cron supports standard 5-field expressions: * * * * *
function cronValid(cron: string): boolean {
  if (!cron || String(cron).split(/\s+/).length !== 5) return false
  return String(cron)
    .split(/\s+/)
    .every((f) => /^[*0-9,\-/]+$/.test(f))
}
function matchField(field: string, value: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [base, step] = part.split('/')
      const from = base === '*' ? 0 : parseInt(base, 10)
      const st = parseInt(step, 10)
      if (st > 0 && value >= from && (value - from) % st === 0) return true
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map((x) => parseInt(x, 10))
      if (value >= a && value <= b) return true
    } else if (parseInt(part, 10) === value) {
      return true
    }
  }
  return false
}
function nextCron(cron: string): number {
  const parts = String(cron).split(/\s+/)
  const now = new Date()
  for (let m = 0; m < 2 * 60 * 24; m++) {
    const t = new Date(now.getTime() + m * 60000)
    if (matchField(parts[4], t.getDay() === 0 ? 7 : t.getDay()) && matchField(parts[2], t.getHours()) && matchField(parts[1], t.getMinutes())) {
      return t.getTime()
    }
  }
  return Date.now() + 3600_000
}

async function runSchedule(schedule: any, user: any) {
  if (schedule.isActive === false && schedule.manualBoot !== true) return
  const server = store.db.servers.find((s) => s.id === schedule.serverId)
  const node = server && store.db.nodes.find((n) => n.id === server.nodeId)
  const client = node && agentFor(node)
  const run: { id: string; scheduleId: string; serverId: string; startedAt: number; finishedAt: number | null; status: string; output: string } = {
    id: nanoid(10),
    scheduleId: schedule.id,
    serverId: schedule.serverId,
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    output: '',
  }
  store.db.scheduleRuns.unshift(run)
  if (store.db.scheduleRuns.length > 300) store.db.scheduleRuns.length = 300
  schedule.lastRunAt = Date.now()
  schedule.nextRunAt = nextCron(schedule.cron)
  store.persist()
  hub.to(`srv:${schedule.serverId}`, { type: 'schedule-update', data: schedule })

  const log: string[] = []
  for (const task of [...schedule.tasks].sort((a: any, b: any) => a.sequenceId - b.sequenceId)) {
    log.push(`[${task.action}] ${task.payload || ''}`.trim())
    try {
      switch (task.action) {
        case 'command':
          if (client) {
            const { output } = await client.command(server.id, task.payload)
            if (output) log.push(output.trim())
          }
          break
        case 'start':
          if (client) { await client.power(server.id, 'start'); server.state = 'running'; server.startedAt = Date.now() }
          break
        case 'stop':
          if (client) { await client.power(server.id, 'stop'); server.state = 'offline'; server.startedAt = null }
          break
        case 'restart':
          if (client) { await client.power(server.id, 'restart'); server.state = 'running' }
          break
        case 'backup':
          if (client) {
            const uuid = nanoid(10)
            await client.createBackup(server.id, `${uuid}.zip`, uuid)
            const backup = { id: nanoid(10), serverId: schedule.serverId, name: `Scheduled ${new Date().toLocaleString()}`, uuid, file: `${uuid}.zip`, sizeBytes: 0, status: 'completed' as const, createdAt: Date.now(), completedAt: Date.now(), error: null }
            store.db.backups.unshift(backup)
            log.push(`backup created: ${backup.name}`)
          }
          break
      }
      store.persist()
    } catch (e: any) {
      run.status = 'failed'
      log.push(`ERROR: ${String(e?.message || e)}`)
    }
  }
  run.status = run.status === 'failed' ? 'failed' : 'success'
  run.output = log.join('\n')
  run.finishedAt = Date.now()
  store.persist()
  hub.to(`srv:${schedule.serverId}`, { type: 'schedule-run', data: run })
  if (user) {
    activity(user, 'server', 'info', `Schedule "${schedule.name}" ran (${run.status}) on ${server?.name}`, { serverId: schedule.serverId })
  }
}

// Background cron ticker — every 10s check due schedules (per-minute granularity).
setInterval(() => {
  for (const schedule of store.db.schedules) {
    if (!schedule.isActive) continue
    if (schedule.nextRunAt && Date.now() >= schedule.nextRunAt) {
      runSchedule(schedule, null)
    }
  }
}, 10000)

// ---------------------------------------------------------------------------
// Databases — connection metadata + lifecycle
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/databases', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const list = store.db.databases.filter((d) => d.serverId === id).map(withDbHost)
  return { ok: true, databases: list }
})

app.post('/api/servers/:id/databases', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const { name, type = 'mysql' } = (req.body || {}) as any
  const db = {
    id: nanoid(10),
    serverId: id,
    name: name || `srv_${server.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
    type,
    username: `u_${nanoid(6)}`,
    password: randomPassword(16),
    host: dbHostFor(server),
    port: type === 'postgres' ? 5432 : 3306,
    createdAt: Date.now(),
  }
  store.db.databases.push(db)
  store.persist()
  audit(store, user.name, 'CREATE_DATABASE', `db:${db.name}`)
  activity(user, 'server', 'info', `Provisioned database ${db.name} for ${server.name}`, { serverId: id })
  return reply.code(201).send({ ok: true, database: withDbHost(db) })
})

app.post('/api/servers/:id/databases/:did/rotate', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, did } = req.params as any
  const db = store.db.databases.find((d) => d.id === did && d.serverId === id)
  if (!db) return reply.code(404).send({ ok: false, error: 'DATABASE_NOT_FOUND' })
  db.password = randomPassword(16)
  store.persist()
  audit(store, user.name, 'ROTATE_DB_PASSWORD', `db:${db.name}`)
  return { ok: true, database: withDbHost(db) }
})

app.delete('/api/servers/:id/databases/:did', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, did } = req.params as any
  const db = store.db.databases.find((d) => d.id === did && d.serverId === id)
  if (!db) return reply.code(404).send({ ok: false, error: 'DATABASE_NOT_FOUND' })
  store.db.databases = store.db.databases.filter((d) => d.id !== did)
  store.persist()
  audit(store, user.name, 'DELETE_DATABASE', `db:${db.name}`)
  return { ok: true }
})

// Global databases overview (admin only) — every database across all servers,
// with the owning server name attached, so the admin "Databases" page works.
app.get('/api/databases', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const list = store.db.databases.map((d) => {
    const s = store.db.servers.find((x) => x.id === d.serverId)
    return { ...withDbHost(d), serverName: s?.name || d.serverId }
  })
  return { ok: true, databases: list }
})

function dbHostFor(server: any): string {
  const node = store.db.nodes.find((n) => n.id === server.nodeId)
  if (node?.agentUrl) {
    try { return new URL(node.agentUrl).hostname } catch { /* fallthrough */ }
  }
  return 'db.internal'
}
function withDbHost(d: any) {
  const server = store.db.servers.find((s) => s.id === d.serverId)
  return { ...d, host: d.host || dbHostFor(server) }
}
function randomPassword(len: number): string {
  // CSPRNG characters (no lookalike/ambiguous characters) — pull uniformly from
  // a randomBytes pool instead of Math.random() so output is cryptographically
  // unpredictable.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}
function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let u = 0
  let v = n
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v.toFixed(1)} ${units[u]}`
}

// ---------------------------------------------------------------------------
// Snapshots (metadata; container snapshots are node-side in production)
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/snapshots', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, snapshots: store.db.snapshots.filter((s) => s.serverId === id) }
})

app.post('/api/servers/:id/snapshots', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { name } = (req.body || {}) as any
  const snap = { id: nanoid(10), serverId: id, name: name || 'Restore point', kind: 'manual' as const, sizeMb: Math.round(Math.random() * 400 + 60), createdAt: Date.now() }
  store.db.snapshots.push(snap)
  store.persist()
  audit(store, user.name, 'CREATE_SNAPSHOT', `snapshot:${snap.name}`)
  return { ok: true, snapshot: snap }
})

app.post('/api/servers/:id/snapshots/:sid/restore', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { sid } = req.params as any
  const snap = store.db.snapshots.find((s) => s.id === sid)
  if (!snap) return reply.code(404).send({ ok: false, error: 'SNAPSHOT_NOT_FOUND' })
  audit(store, user.name, 'RESTORE_SNAPSHOT', `snapshot:${snap.name}`)
  return { ok: true, restored: true }
})

app.delete('/api/servers/:id/snapshots/:sid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { sid } = req.params as any
  store.db.snapshots = store.db.snapshots.filter((s) => s.id !== sid)
  store.persist()
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Terminal history + broadcast
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/terminal', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  if (!serverAccess(user, server, store).ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  return { ok: true, lines: store.db.terminal[id] || [] }
})

// resolveServerJar returns the authoritative server.jar download URL for a
// Minecraft-catalog server's pinned version.
//   - Vanilla (bp-minecraft): Mojang's signed server.jar from the version meta.
//   - Paper (bp-paper): latest build for that version via the PaperMC API,
//     falling back to the pinned 1.21.11 jar when resolution fails.
async function resolveServerJar(server: any): Promise<string> {
  const mc = server.mcVersion
  const platform = server.mcPlatform || (server.blueprintId === 'bp-minecraft' ? 'vanilla' : 'paper')
  if (platform === 'vanilla') {
    if (mc) {
      const info = mcState().infoByVersion?.[mc]
      if (info?.serverJar) return info.serverJar
      // Fallback: re-query Mojang manifest for this exact version.
      try {
        const manifest = await (await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json')).json()
        const v = (manifest.versions || []).find((x: any) => x.id === mc)
        if (v?.url) {
          const meta = await (await fetch(v.url)).json()
          if (meta?.downloads?.server?.url) return meta.downloads.server.url
        }
      } catch { /* fall through */ }
    }
    // Unknown/no version: fall back to the latest release's jar.
    const cur = currentDefaults()
    if (cur.release?.serverJar) return cur.release.serverJar
  } else if (mc) {
    // Paper / Purpur / Folia: resolve via the catalog's platform-aware id.
    const resolved = await resolveVersionDownload(`${platform}@${mc}`, 'bp-paper')
    if (resolved?.url) return resolved.url
  }
  return PAPER_21_11_JAR
}

async function seedServerFiles(server: any, client: AgentClient) {
  const defaults: Record<string, Record<string, string>> = {
    'bp-node': {
      'package.json': JSON.stringify({ name: server.name.toLowerCase().replace(/[^a-z0-9]/g, '-'), version: '1.0.0', main: 'server.js', scripts: { start: 'node server.js' } }, null, 2),
      'server.js': `const http = require('http');\nconst port = process.env.PORT || 3000;\nhttp.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('[${server.name}] UptimeHost managed service is live\\n');\n}).listen(port, () => console.log('listening on ' + port));\nsetInterval(() => console.log('[app] heartbeat tick'), 3000);\n`,
    },
    'bp-postgres': {
      '/var/lib/postgresql/data/.keep': '# postgres data volume\n',
    },
  }
  const files = defaults[server.blueprintId] || {}

  // Minecraft catalog blueprints: install the real server.jar for the server's
  // pinned version, plus the EULA agreement and a server.properties bound to
  // the server's first port (Pterodactyl-style).
  if (server.blueprintId === 'bp-minecraft' || server.blueprintId === 'bp-paper') {
    const port = (server.allocations && server.allocations[0]?.port) || 25565
    try { await client.downloadFile(server.id, 'server.jar', await resolveServerJar(server)) } catch { /* best-effort */ }
    files['eula.txt'] = 'eula=true\n'
    files['server.properties'] = [
      'server-port=' + port,
      'online-mode=true',
      'motd=UptimeHost Minecraft Server',
      'max-players=20',
      'view-distance=10',
      'spawn-protection=0',
      '',
    ].join('\n')
  }

  for (const [path, content] of Object.entries(files)) {
    try { await client.writeFile(server.id, path, content) } catch { /* best-effort */ }
  }
}

function pushTerminal(serverId: string, text: string, level: 'plain' | 'info' | 'warn' | 'error' = 'plain') {
  const ring = store.db.terminal[serverId] || (store.db.terminal[serverId] = [])
  const line = { id: nanoid(8), serverId, ts: Date.now(), text, level }
  ring.push(line)
  if (ring.length > 500) ring.splice(0, ring.length - 500)
  hub.to(`srv:${serverId}`, { type: 'terminal-line', data: line })
  // Defer the disk write: rapid bursts (e.g. long install/progress streams) are
  // coalesced so we never fsync the whole DB per line.
  terminalPersist.schedule()
}

const terminalPersist = {
  timer: null as ReturnType<typeof setTimeout> | null,
  schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try { store.persist() } catch { /* write failure is surfaced on next route */ }
    }, 1500)
  },
}

// ---------------------------------------------------------------------------
// Access / permissions metadata
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/access', async (req, reply) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((x) => x.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const acc = serverAccess(user, server, store)
  if (!acc.ok) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  // The full list holds emails/permissions of every collaborator; expose it only
  // to those who can manage access (global admins, owners, or 'access' delegants).
  const canManage = isGlobalAdmin(user) || acc.permissions.access
  return { ok: true, owner: publicUser(user), access: canManage ? store.db.access.filter((a) => a.serverId === id) : [] }
})

app.post('/api/servers/:id/access', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const { email, role, permissions } = (req.body || {}) as any
  const entry = { id: nanoid(10), serverId: id, email, role, permissions: permissions || defaultPerms(role), addedAt: Date.now() }
  store.db.access.push(entry)
  store.persist()
  audit(store, user.name, 'ADD_ACCESS', `${email} as ${role}`)
  return { ok: true, entry }
})

function defaultPerms(role: string): Record<string, boolean> {
  const owner: Record<string, boolean> = { view: true, command: true, files: true, snapshot: true, restore: true, access: true, admin: true }
  if (role === 'admin') return { ...owner }
  if (role === 'operator') return { ...owner, admin: false }
  if (role === 'developer') return { view: true, command: true, files: true, snapshot: false, restore: false, access: false, admin: false }
  return { view: true, command: false, files: false, snapshot: false, restore: false, access: false, admin: false }
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
// List the API keys. A user lists their own keys; an admin lists all keys.
function listApiKeys(user: any) {
  const all = store.db.apiKeys
  const mine = isGlobalAdmin(user) ? all : all.filter((k) => k.userId === user.id)
  return mine.map((k) => {
    const { token, ...rest } = k
    return { ...rest, masked: token.slice(0, 6) + '…' + token.slice(-4) }
  })
}

// Server-scoped API keys (each server its own key). Only the server owner or an
// admin may manage these.
app.get('/api/servers/:id/api-keys', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const server = store.db.servers.find((x) => x.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const acc = serverAccess(user, server, store)
  if (!acc.ok || !(isGlobalAdmin(user) || acc.permissions.access)) {
    return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  }
  const keys = store.db.apiKeys.filter((k) => k.scope === 'server' && k.serverId === id)
  return { ok: true, keys: keys.map((k) => {
    const { token, ...rest } = k
    return { ...rest, masked: token.slice(0, 6) + '…' + token.slice(-4) }
  }) }
})

app.post('/api/servers/:id/api-keys', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id } = req.params as any
  const server = store.db.servers.find((x) => x.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const acc = serverAccess(user, server, store)
  if (!acc.ok || !(isGlobalAdmin(user) || acc.permissions.access)) {
    return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  }
  const { label, command, files } = (req.body || {}) as any
  const permissions = { view: true, command: command !== false, files: files === true }
  const key = {
    id: nanoid(12),
    userId: user.key?.userId || user.id,
    scope: 'server',
    serverId: id,
    token: generateKeyToken('server'),
    label: String(label || `Server key`).slice(0, 80),
    permissions,
    createdAt: Date.now(),
    lastUsedAt: 0,
  }
  store.db.apiKeys.push(key)
  store.persist()
  audit(store, user.name, 'ADD_API_KEY', `server:${id} ${key.label}`)
  activity(user, 'admin', 'info', `Created API key "${key.label}" for ${server.name}`, { serverId: id })
  return { ok: true, key: { ...key } }
})

app.delete('/api/servers/:id/api-keys/:kid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { id, kid } = req.params as any
  const server = store.db.servers.find((x) => x.id === id)
  if (!server) return reply.code(404).send({ ok: false, error: 'SERVER_NOT_FOUND' })
  const acc = serverAccess(user, server, store)
  if (!acc.ok || !(isGlobalAdmin(user) || acc.permissions.access)) {
    return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  }
  const idx = store.db.apiKeys.findIndex((k) => k.id === kid && k.scope === 'server' && k.serverId === id)
  if (idx === -1) return reply.code(404).send({ ok: false, error: 'KEY_NOT_FOUND' })
  const [removed] = store.db.apiKeys.splice(idx, 1)
  store.persist()
  audit(store, user.name, 'DELETE_API_KEY', `server:${id} ${removed.label}`)
  return { ok: true }
})

// Account-level API keys. Owners/admins get a broad key to manage many/all
// servers (e.g. for a Discord bot). Users can also create their own account key
// scoped to the servers they can access.
app.get('/api/account/api-keys', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  return { ok: true, keys: listApiKeys(user).filter((k) => k.scope === 'account') }
})

app.post('/api/account/api-keys', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { label } = (req.body || {}) as any
  const key = {
    id: nanoid(12),
    userId: user.id,
    scope: 'account',
    serverId: null,
    token: generateKeyToken('account'),
    label: String(label || 'Account key').slice(0, 80),
    permissions: { view: true, command: true, files: true, admin: true },
    createdAt: Date.now(),
    lastUsedAt: 0,
  }
  store.db.apiKeys.push(key)
  store.persist()
  audit(store, user.name, 'ADD_API_KEY', `account ${key.label}`)
  return { ok: true, key }
})

app.delete('/api/account/api-keys/:kid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { kid } = req.params as any
  const idx = store.db.apiKeys.findIndex((k) => k.id === kid && k.scope === 'account' && k.userId === user.id)
  if (idx === -1) return reply.code(404).send({ ok: false, error: 'KEY_NOT_FOUND' })
  const [removed] = store.db.apiKeys.splice(idx, 1)
  store.persist()
  audit(store, user.name, 'DELETE_API_KEY', `account ${removed.label}`)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Activity, notifications, health
// ---------------------------------------------------------------------------
app.get('/api/activity', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const kind = (req.query as any)?.kind
  // Scope activity by role: admins see everything; regular users only see their
  // own actions and events on servers they can access.
  let items = store.db.activity.filter((a) => canSeeActivity(user, a))
  if (kind && kind !== 'all') items = items.filter((a) => a.kind === kind)
  return { ok: true, activity: items.slice(0, 100) }
})

app.get('/api/notifications', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, notifications: store.db.notifications.slice(0, 50) }
})

app.post('/api/notifications/read-all', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  store.db.notifications.forEach((n) => (n.read = true))
  store.persist()
  return { ok: true }
})

app.get('/api/health', async () => ({ ok: true, ts: Date.now(), version: '0.2.0-registry' }))

function summarize(user?: any) {
  const servers = user ? visibleServers(user) : store.db.servers
  return {
    total: servers.length,
    running: servers.filter((s) => s.state === 'running').length,
    offline: servers.filter((s) => s.state === 'offline').length,
    provisioning: servers.filter((s) => s.state.startsWith('start') || s.state === 'provisioning' || s.state === 'restarting').length,
    error: servers.filter((s) => s.state === 'error' || s.state === 'killing').length,
    nodesOnline: store.db.nodes.filter((n) => n.status === 'online').length,
    nodesTotal: store.db.nodes.length,
  }
}

// ---------------------------------------------------------------------------
// WebSocket gateway
// ---------------------------------------------------------------------------
app.register(async (app) => {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const queryToken = ((req as any).query && (req as any).query.token) as string | undefined
    const user = queryToken ? meFromToken(store, queryToken) : me(req)
    if (!user) { socket.close(4001, 'unauthorized'); return }
    const client = hub.add(socket, user)
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'subscribe' && msg.topic) hub.subscribe(client, msg.topic)
        if (msg.type === 'unsubscribe' && msg.topic) hub.unsubscribe(client, msg.topic)
      } catch { /* ignore */ }
    })
    socket.on('close', () => hub.remove(client))
  })

  // Console proxy: browser -> panel (auth) -> Wings daemon (docker).
  // The daemon speaks the Wings websocket JSON protocol, which we transparently
  // translate to/from the browser's lightweight {type,line} frames.

  app.get('/ws/server/:id/console', { websocket: true }, (socket, req) => {
    // Browser WS handshakes cannot set an Authorization header, so accept the
    // session token from the ?token= query param (same as the realtime /ws).
    const queryToken = ((req as any).query && (req as any).query.token) as string | undefined
    const user = queryToken ? meFromToken(store, queryToken) : me(req)
    if (!user) { socket.close(4001, 'unauthorized'); return }
    const { id } = req.params as any
    const server = store.db.servers.find((s) => s.id === id)
    if (!server) { socket.close(4004, 'not found'); return }
    // The console streams live output and (via 'command'/'power' messages below)
    // issues control actions. Require explicit access like every REST /power or
    // /command: connect requires view, sending command/power requires 'command'.
    const acc = serverAccess(user, server, store)
    if (!acc.ok) { socket.close(4003, 'forbidden'); return }
    const node = store.db.nodes.find((n) => n.id === server.nodeId)
    if (!node?.agentUrl) { socket.close(4009, 'node unreachable'); return }
    const wsUrl = node.agentUrl.replace(/^http/, 'ws').replace(/\/$/, '') + `/api/servers/${server.id}/ws`
    const agent = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${node.agentToken}` } })
    agent.on('open', () => {
      socket.send(JSON.stringify({ type: 'system', line: 'console attached' }))
      agent.send(JSON.stringify({ event: 'auth', args: [] }))
    })
    agent.on('message', (data) => {
      let wingsMsg: any = null
      try { wingsMsg = JSON.parse(String(data)) } catch { /* not json */ }
      // Forward the daemon's Wings events to the browser as console lines.
      if (wingsMsg && Array.isArray(wingsMsg.args)) {
        const line = wingsMsg.args.join(' ') || ''
        const ev = wingsMsg.event || ''
        if (ev === 'console output') {
          // Forward every line the daemon emits, unfiltered, so the console is
          // a complete feed including boot/Unpacking/JVM startup output.
          socket.send(JSON.stringify({ type: 'log', line }))
        } else if (ev === 'status') {
          socket.send(JSON.stringify({ type: 'status', line: `Server marked as ${line}` }))
        } else if (ev === 'daemon error') {
          socket.send(JSON.stringify({ type: 'status', line: `wings: ${line}` }))
        } else if (ev === 'auth success') {
          // authenticated with the daemon; nothing more to surface
        } else if (ev === 'stats') {
          // ignore; stats are polled via REST
        }
      } else {
        socket.send(String(data))
      }
      // Auto EULA acceptor: Minecraft refuses to start until eula.txt agrees.
      // When the console stream flags the EULA prompt we write eula=true into
      // the container's workdir (once per server) and restart it if stopped.
      const raw = String(data)
      const lower = raw.toLowerCase()
      const isEulaPrompt = lower.includes('eula') && (lower.includes('agree') || lower.includes('eula.txt') || lower.includes('accept the eula'))
      if (isEulaPrompt && !autoEulaAccepted.has(server.id)) {
        autoEulaAccepted.add(server.id)
        socket.send(JSON.stringify({ type: 'status', line: 'Auto-accepting Minecraft EULA (eula=true)…' }))
        const client = agentFor(node)
        client?.command(server.id, 'echo eula=true > eula.txt').then(async () => {
          socket.send(JSON.stringify({ type: 'status', line: 'EULA accepted — restarting server' }))
          if (server.state === 'offline' || server.state === 'error') {
            try {
              await client.power(server.id, 'start')
              server.state = 'running'
              server.startedAt = Date.now()
              store.persist()
              hub.to(`srv:${server.id}`, { type: 'server-update', data: server })
            } catch { /* container already starting — reconciled shortly */ }
          }
        }).catch((e: any) => {
          socket.send(JSON.stringify({ type: 'status', line: 'EULA auto-accept failed: ' + (e?.message || 'unknown') }))
        })
      }
    })
    agent.on('close', () => socket.send(JSON.stringify({ type: 'status', line: 'console detached' })))
    agent.on('error', () => socket.send(JSON.stringify({ type: 'status', line: 'console error' })))
    socket.on('message', (raw: Buffer) => {
      if (agent.readyState !== WebSocket.OPEN) return
      // Browser {type:'command', line} -> Wings {"event":"send command"}.
      try {
        const m = JSON.parse(String(raw))
        if (m && typeof m.line === 'string') {
          if (!acc.permissions.command) return
          if (m.type === 'command') {
            agent.send(JSON.stringify({ event: 'send command', args: [m.line] }))
            return
          }
          if (m.type === 'power') {
            agent.send(JSON.stringify({ event: 'set state', args: [m.line] }))
            return
          }
        }
      } catch { /* not json */ }
      agent.send(String(raw))
    })
    socket.on('close', () => { try { agent.close() } catch { /* noop */ } })
  })

  // Node agent <- panel console connection is outbound only; this accepts none.
})

// ---------------------------------------------------------------------------
// Background: node + server state reconciliation
// ---------------------------------------------------------------------------
setInterval(async () => {
  for (const node of store.db.nodes) {
    await refreshNode(node)
    reconcileServers(node)
  }
}, 8000)

app.setErrorHandler((err, req, reply) => {
  const id = nanoid(8)
  console.error(`UH-${id}`, (err as any).code, (err as Error).message)
  // Never echo raw error messages (SQL/db details, file paths, provider errors)
  // back to clients — return only the correlation id.
  reply.status(500).send({ ok: false, code: `UH-${id}`, error: 'INTERNAL' })
})

app.listen({ port: PORT, host: '127.0.0.1' }).then(async (addr) => {
  console.log(`[UptimeHost] Control Core listening on ${addr}`)
  console.log(`[UptimeHost] REST API → http://localhost:${PORT}/api`)
  console.log(`[UptimeHost] WS → ws://localhost:${PORT}/ws`)
  // Auto-updating Minecraft version defaults (Mojang launcher meta manifest).
  // Refresh on boot and every 6h so new releases become the default for new
  // servers without any manual intervention.
  startMCVersionWatcher().catch((e) => console.error('[mc] version watcher failed', e))
  // Auto-refreshing marketplace catalog (versions + SpigotMC/Modrinth plugins)
  // refreshed every hour.
  await startCatalogWatcher().catch((e) => console.error('[catalog] watcher failed', e))
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
