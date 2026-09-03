// Auth helpers — sessions, current user resolution.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { nanoid } from 'nanoid'
import { Store } from '../store/store.js'
import { hashPw, verifyPw } from '../sim/seed.js'

const SESSION_TTL = 7 * 24 * 3600 * 1000

export function requireAuth(req: FastifyRequest, store: Store) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''
  const session = store.db.sessions.find((s) => s.token === token)
  if (!session || session.expiresAt < Date.now()) return null
  return store.db.users.find((u) => u.id === session.userId) || null
}

export function createSession(store: Store, userId: string) {
  const token = nanoid(40)
  store.db.sessions.push({
    token,
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
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
  if (roleRank(user.role) >= 4) return { ok: true, permissions: { view: true, command: true, files: true, modify: true, access: true, admin: true } }

  const entry = store.db.access.find((a) => a.serverId === server.id && a.email === user.email)
  const perms: Record<string, boolean> = entry?.permissions || defaultServerPerms(entry?.role)
  // Owner-by-email implicitly has full rights.
  const isOwner = server.ownerEmail && server.ownerEmail === user.email
  if (isOwner) return { ok: true, permissions: { view: true, command: true, files: true, modify: true, access: true, admin: true } }
  if (entry) return { ok: entry.permissions.view === true, permissions: perms }
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
