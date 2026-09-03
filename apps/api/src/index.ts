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
import { requireAuth, createSession, verifyPw, hashPw, can, audit, isGlobalAdmin, serverAccess } from './modules/auth.js'
import { AgentClient, agentFor } from './modules/agentClient.js'
import WebSocket from 'ws'

const PORT = Number(process.env.UH_API_PORT || 8081)

const app = Fastify({ logger: false })
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
const hub = new WsHub()

await app.register(cors, { origin: true })
await app.register(rateLimit, { max: 600, timeWindow: '1 minute' })
await app.register(websocket)

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (req, reply) => {
  const { email, password } = (req.body || {}) as any
  const user = store.db.users.find((u) => u.email === email)
  if (!user || !verifyPw(password, user.passwordHash)) {
    return reply.code(401).send({ ok: false, error: 'Invalid credentials' })
  }
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

// Update an existing user's role (admin only) — used e.g. by setup.py or an
// operator to promote someone to admin/owner.
app.patch('/api/users/:id', async (req, reply) => {
  const actor = me(req)
  if (!actor) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(actor, 'admin')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
  const u = store.db.users.find((x) => x.id === id)
  if (!u) return reply.code(404).send({ ok: false, error: 'USER_NOT_FOUND' })
  const { role, name } = (req.body || {}) as any
  const ROLES = ['viewer', 'developer', 'operator', 'admin', 'owner']
  if (role !== undefined) {
    if (!ROLES.includes(role)) return reply.code(400).send({ ok: false, error: 'INVALID_ROLE' })
    u.role = role
  }
  if (name !== undefined && String(name).trim()) u.name = String(name).trim()
  store.persist()
  audit(store, actor.name, 'UPDATE_USER', `${u.email} role=${u.role}`)
  activity(actor, 'admin', 'info', `Updated user ${u.name} (role=${u.role})`, { userId: u.id })
  return { ok: true, user: publicUser(u) }
})

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (token) {
    store.db.sessions = store.db.sessions.filter((s) => s.token !== token)
    store.persist()
  }
  return { ok: true }
})

function me(req: any) {
  return requireAuth(req, store)
}
function publicUser(u: any) {
  const { passwordHash, ...rest } = u
  return rest
}
function activity(user: any, kind: string, severity: string, message: string, extra: any = {}) {
  store.db.activity.unshift({ id: nanoid(10), ts: Date.now(), kind, severity, message, actor: user?.name || 'system', ...extra })
  if (store.db.activity.length > 500) store.db.activity.length = 500
  store.persist()
  hub.to('all', { type: 'activity', data: store.db.activity[0] })
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
  error: ['offline', 'starting', 'restarting', 'provisioning'],
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

// Install command handed to the operator to enroll any machine. It carries:
//  - PANEL_REG_URL   -> panel endpoint the agent calls to register (outbound).
//  - UH_NODE_ID      -> the node id to enroll.
//  - UH_REG_TOKEN    -> one-time secret authorizing the enrollment.
//  - UH_AGENT_ADDR/UH_AGENT_TOKEN -> inbound listener + shared secret for the
//    panel to talk to this agent afterwards.
function buildInstallCommand(node: any): string {
  const up = process.env.UH_PANEL_URL || `http://${defaultHost(node.agentUrl, node.scheme) || 'localhost'}:8081`
  const base = up.replace(/\/$/, '')
  return [
    `# UptimeHost Node Agent — install on any host that can reach the panel.`,
    `export UH_CORE_URL="${base}/api/nodes/register"`,
    `export UH_NODE_ID="${node.id}"`,
    `export UH_REG_TOKEN="${node.registrationToken}"`,
    `export UH_AGENT_ADDR=":${node.port}"`,
    `export UH_AGENT_TOKEN="${node.agentToken}"`,
    `export UH_CONTAINER_BASE="/var/lib/uptimehost/data"`,
    `# then run the agent binary (go build ./cmd/agent && ./agent) with these env vars`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Session context (drives the whole app)
// ---------------------------------------------------------------------------
app.get('/api/session/context', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const nodes = store.db.nodes.map(withHealth)
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
  const { name, locationId, scheme, host, port, agentUrl, agentToken, memoryMb, diskGb, overcommit } = (req.body || {}) as any
  const node: any = {
    id: nanoid(10),
    name: name || 'New Node',
    locationId: locationId || store.db.locations[0]?.id || null,
    // FQDN connection: protocol (http/https) + host + port. If a legacy raw
    // agentUrl is supplied, parse out scheme/host/port for backward compat.
    scheme: normalizeScheme(scheme, agentUrl),
    host: host || parseHost(agentUrl) || '',
    port: port != null ? Number(port) : parsePort(agentUrl) || 7373,
    agentUrl: agentUrl || '',
    agentToken: agentToken || '',
    registrationToken: '',
    installCommand: '',
    memoryMb: memoryMb || 8192,
    diskGb: diskGb || 100,
    overcommit: !!overcommit,
    maintenance: false,
    tokenCreatedAt: agentToken ? Date.now() : null,
    status: 'offline',
    dockerHealthy: false,
    agentVersion: null,
    createdAt: Date.now(),
    health: null,
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
  if (scheme) node.scheme = normalizeScheme(scheme, undefined)
  if (host) node.host = host
  if (port) node.port = Number(port)
  node.agentUrl = buildAgentUrl(node)
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
    node.cpuPercent = info.cpuPercent
    node.memoryPercent = info.memoryPercent
    node.diskPercent = info.diskPercent
    node.containerCount = info.containers ?? node.containerCount
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

// ---------------------------------------------------------------------------
// Blueprints (deployable catalog)
// ---------------------------------------------------------------------------
app.get('/api/blueprints', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  return { ok: true, blueprints: store.db.blueprints }
})

// ---------------------------------------------------------------------------
// Servers — real Docker containers managed by the node agent
// ---------------------------------------------------------------------------
function withRelations(s: any, user?: any) {
  const node = store.db.nodes.find((n) => n.id === s.nodeId)
  const bp = store.db.blueprints.find((b) => b.id === s.blueprintId)
  const acc = user ? serverAccess(user, s, store) : { ok: false, permissions: {} }
  return { ...s, node: node ? { id: node.id, name: node.name, status: node.status, agentUrl: node.agentUrl } : null, blueprint: bp, permissions: acc.permissions, role: yourRole(user, s) }
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
    allocations: bp.ports.map((p: number) => ({ id: nanoid(8), port: p, proto: 'tcp' })),
    createdAt: Date.now(),
    installed: false,
    startedAt: null,
  }
  store.db.servers.push(server)
  store.persist()

  // Forward the container to the node agent (asynchronous install: pull image).
  const client = agentFor(node)!
  const manifest = {
    id,
    name: server.name,
    image: bp.image,
    startup: bp.startup ? bp.startup.trim().split(/\s+/) : undefined,
    env: { ...bp.environment, ...server.extraEnv },
    ports: Object.fromEntries(server.allocations.map((a: any) => [`${a.port}/tcp`, String(a.port)])),
    memoryMb: server.memoryLimitMb,
    cpuPercent: server.cpuPercent,
    diskMb: server.storageGb * 1024,
    mountData: '',
  }
  launch(server, client, manifest, user)
  audit(store, user.name, 'CREATE_SERVER', `server:${server.name}`)
  activity(user, 'server', 'info', `Creating ${server.name}`, { serverId: id })
  return reply.code(201).send({ ok: true, server: withRelations(server) })
})

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
    await client.power(server.id, action)
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
    try { await client.remove(server.id) } catch { /* best-effort */ }
  }
  store.db.servers = store.db.servers.filter((s) => s.id !== id)
  store.persist()
  audit(store, user.name, 'DELETE_SERVER', `server:${server.name}`)
  activity(user, 'server', 'info', `Deleted ${server.name}`)
  return { ok: true }
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
app.get('/api/servers/:id/files', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return { ok: false, error: found.error }
  const server = found.server
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return { ok: false, error: 'NODE_UNREACHABLE' }
  const path = (req.query as any)?.path || '/'
  return await client.listFiles(server.id, path)
})

app.get('/api/servers/:id/files/content', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const found = findServer(user, id)
  if ('error' in found) return { ok: false, error: found.error }
  const server = found.server
  const client = agentFor(store.db.nodes.find((n) => n.id === server.nodeId))
  if (!client) return { ok: false, error: 'NODE_UNREACHABLE' }
  const path = (req.query as any)?.path || '/'
  return await client.readFile(server.id, path)
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
  const res = await client.writeFile(server.id, path, content)
  audit(store, user.name, 'EDIT_FILE', `file:${path}`)
  return res
})

// ---------------------------------------------------------------------------
// Backups — real ZIP archives created/extracted by the node agent
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/backups', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
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
app.get('/api/servers/:id/startup', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const server = store.db.servers.find((s) => s.id === id)
  if (!server) return { ok: false, error: 'SERVER_NOT_FOUND' }
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
    const bp = store.db.blueprints.find((b) => b.id === server.blueprintId)
    await client.createContainer({
      id: server.id,
      name: server.name,
      image: bp?.image,
      startup: bp?.startup ? bp.startup.trim().split(/\s+/) : undefined,
      env: { ...(bp?.environment || {}), ...(server.extraEnv || {}) },
      ports: Object.fromEntries(server.allocations.map((a: any) => [`${a.port}/tcp`, String(a.port)])),
      memoryMb: server.memoryLimitMb,
      cpuPercent: server.cpuPercent,
      diskMb: server.storageGb * 1024,
      mountData: '',
    })
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
app.get('/api/servers/:id/schedules', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
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
  store.db.schedules = store.db.schedules.filter((s: any) => !(s.id === sid && s.serverId === id))
  store.persist()
  return { ok: true }
})

app.post('/api/servers/:id/schedules/:sid/run', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'command')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id, sid } = req.params as any
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
app.get('/api/servers/:id/databases', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
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
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
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
app.get('/api/servers/:id/snapshots', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  return { ok: true, snapshots: store.db.snapshots.filter((s) => s.serverId === id) }
})

app.post('/api/servers/:id/snapshots', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  if (!can(user, 'modify')) return reply.code(403).send({ ok: false, error: 'FORBIDDEN' })
  const { id } = req.params as any
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
  const { sid } = req.params as any
  const snap = store.db.snapshots.find((s) => s.id === sid)
  if (!snap) return reply.code(404).send({ ok: false, error: 'SNAPSHOT_NOT_FOUND' })
  audit(store, user.name, 'RESTORE_SNAPSHOT', `snapshot:${snap.name}`)
  return { ok: true, restored: true }
})

app.delete('/api/servers/:id/snapshots/:sid', async (req, reply) => {
  const user = me(req)
  if (!user) return reply.code(401).send({ ok: false, error: 'UNAUTHENTICATED' })
  const { sid } = req.params as any
  store.db.snapshots = store.db.snapshots.filter((s) => s.id !== sid)
  store.persist()
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Terminal history + broadcast
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/terminal', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  return { ok: true, lines: store.db.terminal[id] || [] }
})

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
  store.persist()
}

// ---------------------------------------------------------------------------
// Access / permissions metadata
// ---------------------------------------------------------------------------
app.get('/api/servers/:id/access', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const { id } = req.params as any
  const s = store.db.servers.find((x) => x.id === id)
  return { ok: true, owner: user, access: store.db.access.filter((a) => a.serverId === id) }
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
// Activity, notifications, health
// ---------------------------------------------------------------------------
app.get('/api/activity', async (req) => {
  const user = me(req)
  if (!user) return { ok: false, error: 'UNAUTHENTICATED' }
  const kind = (req.query as any)?.kind
  let items = store.db.activity
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
    const client = hub.add(socket)
    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'subscribe' && msg.topic) hub.subscribe(client, msg.topic)
        if (msg.type === 'unsubscribe' && msg.topic) hub.unsubscribe(client, msg.topic)
      } catch { /* ignore */ }
    })
    socket.on('close', () => hub.remove(client))
  })

  // Console proxy: browser -> panel (auth) -> node agent (docker).
  app.get('/ws/server/:id/console', { websocket: true }, (socket, req) => {
    const user = me(req)
    if (!user) { socket.close(4001, 'unauthorized'); return }
    const { id } = req.params as any
    const server = store.db.servers.find((s) => s.id === id)
    if (!server) { socket.close(4004, 'not found'); return }
    const node = store.db.nodes.find((n) => n.id === server.nodeId)
    if (!node?.agentUrl) { socket.close(4009, 'node unreachable'); return }
    const wsUrl = node.agentUrl.replace(/^http/, 'ws').replace(/\/$/, '') + `/api/containers/${server.id}/ws`
    const agent = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${node.agentToken}` } })
    agent.on('open', () => socket.send(JSON.stringify({ type: 'system', line: 'console attached' })))
    agent.on('message', (data) => socket.send(String(data)))
    agent.on('close', () => socket.send(JSON.stringify({ type: 'status', line: 'console detached' })))
    agent.on('error', () => socket.send(JSON.stringify({ type: 'status', line: 'console error' })))
    socket.on('message', (raw: Buffer) => { if (agent.readyState === WebSocket.OPEN) agent.send(String(raw)) })
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
  reply.status(500).send({ ok: false, code: `UH-${id}`, error: (err as any).code || 'INTERNAL', message: (err as Error).message })
})

app.listen({ port: PORT, host: '0.0.0.0' }).then((addr) => {
  console.log(`[UptimeHost] Control Core listening on ${addr}`)
  console.log(`[UptimeHost] REST API → http://localhost:${PORT}/api`)
  console.log(`[UptimeHost] WS → ws://localhost:${PORT}/ws`)
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
