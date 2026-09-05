// Auth helpers — sessions, current user resolution.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { nanoid } from 'nanoid'
import { Store } from '../store/store.js'
import { hashPw, verifyPw } from '../sim/seed.js'

const SESSION_TTL = 7 * 24 * 3600 * 1000
const MAX_SESSIONS_PER_USER = 10

// API keys: per-server keys start with sk_, account keys with ak_. Tokens are
// high-entropy and stored in plaintext (they are shown once at creation).
export function generateKeyToken(scope: 'server' | 'account') {
  const prefix = scope === 'server' ? 'sk_' : 'ak_'
  return prefix + nanoid(48)
}

export function requireAuth(req: FastifyRequest, store: Store) {
  const raw = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  // 1. Normal logged-in session (opaque token).
  const session = store.db.sessions.find((s) => s.token === raw)
  if (session && session.expiresAt > Date.now()) {
    return store.db.users.find((u) => u.id === session.userId) || null
  }
  // 2. API key — either a per-server key (scoped to one server) or an account
  //    key. We return a synthetic user that carries the key's scope so the
  //    existing authz helpers enforce it without touching every route.
  if (raw.startsWith('sk_') || raw.startsWith('ak_')) {
    const key = store.db.apiKeys.find((k) => k.token === raw)
    if (!key) return null
    const owner = store.db.users.find((u) => u.id === key.userId)
    if (!owner) return null
    if (key.permissions?.view === false) return null
    key.lastUsedAt = Date.now()
    // A server-scoped key (sk_) is confined to ONE server: never inherit the
    // owner's global role, or it could pass can() checks and act on any server.
    // Its capabilities come from key.permissions via serverAccess(); role is
    // only used for global-admin checks and can() gates. Account keys (ak_) act
    // as their owner.
    const role = key.scope === 'server' ? 'viewer' : owner.role
    return {
      id: owner.id,
      email: owner.email,
      name: owner.name,
      role,
      avatarHue: owner.avatarHue,
      passwordHash: owner.passwordHash,
      key: { scope: key.scope, serverId: key.serverId, permissions: key.permissions, id: key.id, userId: owner.id },
    }
  }
  return null
}

export function createSession(store: Store, userId: string) {
  const now = Date.now()
  // Prune expired sessions and cap per-user sessions (rotate the oldest) so the
  // sessions table cannot grow unboundedly or pile up stale tokens.
  store.db.sessions = store.db.sessions.filter((s) => s.expiresAt > now)
  const userSessions = store.db.sessions.filter((s) => s.userId === userId)
  if (userSessions.length >= MAX_SESSIONS_PER_USER) {
    const oldest = userSessions.sort((a, b) => a.createdAt - b.createdAt)[0]
    store.db.sessions = store.db.sessions.filter((s) => s !== oldest)
  }
  const token = nanoid(40)
  store.db.sessions.push({
    token,
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL,
  })
  store.persist()
  return token
}

export function can(user: any, perm: string) {
  if (!user) return false
  const rank = roleRank(user.role)
  if (perm === 'view') return rank >= 1
  if (perm === 'command') return rank >= 3
  if (perm === 'files' || perm === 'modify') return rank >= 4
  if (perm === 'admin') return rank >= 4
  return rank >= 3
}

// Global admins (owner + admin) may administer the whole control plane: nodes,
// locations, audit, and see every server on the panel.
export function isGlobalAdmin(user: any): boolean {
  return !!user && roleRank(user.role) >= 4
}

function roleRank(role: string | undefined): number {
  const ranks: Record<string, number> = { viewer: 1, developer: 2, operator: 3, admin: 4, owner: 5 }
  return ranks[role || ''] || 0
}

// serverAccess resolves whether a user may act on a given server and with which
// capabilities. Global admins/Owners see everything. Other users only get
// access through a matching access entry (by email) or if they own the server.
export function serverAccess(user: any, server: any, store: Store): { ok: boolean; permissions: Record<string, boolean> } {
  if (!user) return { ok: false, permissions: {} }
  // API-key scoping: a server key only touches its own server; an account key
  // acts as its owner (global-admin account keys manage everything).
  if (user.key) {
    if (user.key.scope === 'server') {
      const perms = user.key.permissions || defaultServerPerms('developer')
      const ok = server.id === user.key.serverId && perms.view === true
      return { ok, permissions: ok ? perms : {} }
    }
    // account key
    if (roleRank(user.role) >= 4) return { ok: true, permissions: { view: true, command: true, files: true, modify: true, access: true, admin: true } }
    // account key owned by a non-admin user: fall through to owner/access logic
  }
  if (roleRank(user.role) >= 4) return { ok: true, permissions: { view: true, command: true, files: true, modify: true, access: true, admin: true } }

  const entry = store.db.access.find((a) => a.serverId === server.id && a.email === user.email)
  const perms: Record<string, boolean> = entry?.permissions || defaultServerPerms(entry?.role)
  // Owner-by-email implicitly has full rights.
  const isOwner = server.ownerEmail && server.ownerEmail === user.email
  if (isOwner) return { ok: true, permissions: { view: true, command: true, files: true, modify: true, access: true, admin: true } }
  if (entry) return { ok: perms.view === true, permissions: perms }
  return { ok: false, permissions: {} }
}

function defaultServerPerms(role: string | undefined): Record<string, boolean> {
  const owner: Record<string, boolean> = { view: true, command: true, files: true, snapshot: true, restore: true, access: true, admin: true }
  if (role === 'admin') return { ...owner }
  if (role === 'operator') return { ...owner, admin: false }
  if (role === 'developer') return { view: true, command: true, files: true, snapshot: false, restore: false, access: false, admin: false }
  return { view: true, command: false, files: false, snapshot: false, restore: false, access: false, admin: false }
}

export function audit(store: Store, actor: string, action: string, target: string, before?: unknown, after?: unknown) {
  store.db.audit.unshift({
    id: nanoid(10),
    ts: Date.now(),
    actor,
    action,
    target,
    before,
    after,
  })
  if (store.db.audit.length > 500) store.db.audit.length = 500
  store.persist()
}

export { hashPw, verifyPw }
