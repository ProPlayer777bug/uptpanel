// AIBro — natural-language server management.
//
// Users store API keys in their account (max 4 per provider) and a model
// turns plain-English requests (e.g. "change my server to offline mode") into a
// small structured action that the panel then executes against the agent.
//
// Supported providers:
//   gemini   Google Generative Language (free tier friendly)
//   claude   Anthropic Messages API
//   chatgpt  OpenAI Chat Completions
//   openrouter OpenAI-compatible (routing proxy)
//   groq     OpenAI-compatible (fast inference)

export interface AIBroKey {
  id: string
  label: string
  key: string
  createdAt: number
}

export interface AIBroProviderDef {
  id: string
  label: string
  kind: 'openai' | 'anthropic' | 'google'
  maxKeys: number
  defaultModel: string
  inputKey: string
}

export const AIBRO_PROVIDERS: AIBroProviderDef[] = [
  { id: 'gemini', label: 'Gemini', kind: 'google', maxKeys: 4, defaultModel: 'gemini-1.5-flash', inputKey: 'Google Gemini API key' },
  { id: 'claude', label: 'Claude', kind: 'anthropic', maxKeys: 4, defaultModel: 'claude-3-5-haiku-latest', inputKey: 'Anthropic API key' },
  { id: 'chatgpt', label: 'ChatGPT', kind: 'openai', maxKeys: 4, defaultModel: 'gpt-4o-mini', inputKey: 'OpenAI API key' },
  { id: 'openrouter', label: 'OpenRouter', kind: 'openai', maxKeys: 4, defaultModel: 'openrouter/auto', inputKey: 'OpenRouter API key' },
  { id: 'groq', label: 'Groq', kind: 'openai', maxKeys: 4, defaultModel: 'llama-3.3-70b-versatile', inputKey: 'Groq API key' },
]

export function providerDef(id: string): AIBroProviderDef | undefined {
  return AIBRO_PROVIDERS.find((p) => p.id === id)
}

export function maskKey(key: string): string {
  const k = String(key || '')
  if (k.length <= 8) return '****'
  return `${k.slice(0, 3)}…${k.slice(-4)}`
}

export function keysFor(user: any, providerId: string): AIBroKey[] {
  const map = user?.aibro?.keys || {}
  return Array.isArray(map[providerId]) ? map[providerId] : []
}

export function registeredKeys(user: any): { provider: string; keys: AIBroKey[] }[] {
  const map = user?.aibro?.keys || {}
  return AIBRO_PROVIDERS.map((p) => ({ provider: p.id, keys: (map[p.id] || []) as AIBroKey[] }))
    .filter((r) => r.keys.length > 0)
}

export function addKey(user: any, providerId: string, label: string, key: string): AIBroKey {
  const def = providerDef(providerId)
  if (!def) throw Object.assign(new Error('UNKNOWN_PROVIDER'), { kind: 'client' })
  const clean = String(key || '').trim()
  if (clean.length < 8) throw Object.assign(new Error('KEY_TOO_SHORT'), { kind: 'client' })
  const cur = keysFor(user, providerId)
  if (cur.length >= def.maxKeys) {
    throw Object.assign(new Error(`MAX_KEYS`), { kind: 'client', detail: `You can store up to ${def.maxKeys} ${def.label} keys.` })
  }
  const entry: AIBroKey = { id: nanoid(), label: label?.trim()?.slice(0, 40) || `${def.label} #${cur.length + 1}`, key: clean, createdAt: Date.now() }
  user.aibro = user.aibro || {}
  user.aibro.keys = user.aibro.keys || {}
  user.aibro.keys[providerId] = [...cur, entry]
  return entry
}

export function removeKey(user: any, keyId: string): boolean {
  const map = user?.aibro?.keys || {}
  for (const providerId of Object.keys(map)) {
    const before = map[providerId].length
    map[providerId] = (map[providerId] || []).filter((k: AIBroKey) => k.id !== keyId)
    if (map[providerId].length !== before) return true
  }
  return false
}

let nanoid: (size?: number) => string = () => Math.random().toString(36).slice(2)

export function setNanoid(n: (size?: number) => string) {
  nanoid = n
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

export interface AIBroContext {
  store: any
  agentFor(node?: any, ...args: any[]): any
  serverAccess(user: any, server: any, store: any): any
  withRelations(server: any): any
  broadcastServer(topic: string, server: any, user: any): void
  pushTerminal(serverId: string, line: string, level?: string): void
  activity(user: any, kind: string, severity: string, message: string, extra?: any): void
  audit(store: any, actor: string, kind: string, what: string): void
  canTransition(from: string, to: string): boolean
  performBackup(server: any, user: any, opts?: any): Promise<any>
}

const SYSTEM_PROMPT = `You are AIBro, the assistant embedded in a Minecraft server-hosting panel.
Users manage servers with plain English. You MUST always respond with a single
JSON object (no markdown, no prose) using this exact shape:
{"action": "...", "server": "...", "key": "...", "value": "...", "command": "...", "text": "..."}

Supported actions:
- {"action":"list","text":"optional user note"}          — list the user's servers
- {"action":"status","server":"exact name or id"}        — status of one server
- {"action":"set_property","server":"...","key":"online-mode","value":"false"}
    Valid keys: online-mode, white-list, enforce-whitelist, gamemode, force-gamemode,
    difficulty, max-players, motd, pvp, allow-flight, hardcore, spawn-protection,
    view-distance, simulation-distance, max-world-size, generate-structures,
    spawn-monsters, spawn-animals, spawn-npcs, level-seed, enable-command-blocks,
    network-compression-threshold, max-tick-time
- {"action":"power","server":"...","value":"start|stop|restart"}
- {"action":"command","server":"...","command":"whisper Glubz hello"}
- {"action":"backup","server":"..."}
- {"action":"answer","text":"clarifying text"}            — when you need more info

Notes:
- If the user names a server ambiguously, pick the closest match and say which
  in "text", or use "answer" to ask.
- online-mode=true means the server requires a paid Minecraft account
  (cracked servers use a proxy/log-in screen). Setting it to false effectively
  makes the server "offline" (cracked). Reversing that makes it "online" again.
- Never invent keys beyond the list above. Never execute more than one action.`

function buildUserContext(ctx: AIBroContext, user: any): string {
  const { store, serverAccess } = ctx
  const rows: string[] = []
  for (const s of store.db.servers) {
    const acc = serverAccess(user, s, store)
    if (!acc.ok) continue
    const bp = store.db.blueprints.find((b: any) => b.id === s.blueprintId)
    const port = s.allocations?.[0]?.port
    rows.push(`- "${s.name}" id=${s.id} state=${s.state} version=${s.mcVersion || '?'} platform=${s.mcPlatform || (bp?.name || '?')} port=${port} image=${s.image || bp?.image || '?'} owner=${s.ownerEmail}`)
  }
  if (rows.length === 0)
    return 'The user has no accessible servers. Recommend the list action or tell them to create one.'
  return 'User servers:\n' + rows.join('\n')
}

// Call the model. Returns raw text.
async function callModel(def: AIBroProviderDef, apiKey: string, messages: { role: string; content: string }[]): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  try {
    if (def.kind === 'google') {
      const contents = messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }))
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${def.defaultModel}:generateContent`
      const res = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j: any = await res.json()
      return j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || ''
    }
    if (def.kind === 'anthropic') {
      const body: any = {
        model: def.defaultModel,
        max_tokens: 1024,
        system: messages[0]?.content,
        messages: messages.slice(1).map((m) => ({ role: m.role, content: m.content })),
      }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Claude error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j: any = await res.json()
      return j?.content?.map((c: any) => c.text).join('') || ''
    }
    // OpenAI-compatible (chatgpt, openrouter, groq)
    if (def.id === 'chatgpt') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: def.defaultModel, messages }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j: any = await res.json()
      return j?.choices?.[0]?.message?.content || ''
    }
    const base = def.id === 'openrouter' ? 'https://openrouter.ai/api/v1' : def.id === 'groq' ? 'https://api.groq.com/openai/v1' : ''
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: def.defaultModel, messages }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${def.label} error ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j: any = await res.json()
    return j?.choices?.[0]?.message?.content || ''
  } finally {
    clearTimeout(timer)
  }
}

function extractAction(raw: string): any {
  const withoutFences = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = withoutFences.indexOf('{')
  const end = withoutFences.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(withoutFences.slice(start, end + 1))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

async function executeAction(ctx: AIBroContext, user: any, action: any): Promise<string> {
  const { store, serverAccess, agentFor } = ctx as any
  const resolve = (nameOrId?: string) => {
    if (!nameOrId) return null
    const target = String(nameOrId).trim().toLowerCase()
    return store.db.servers.find((s: any) =>
      s.id.toLowerCase() === target || s.name.toLowerCase() === target
    ) || store.db.servers.find((s: any) => s.name.toLowerCase().includes(target)) || null
  }

  if (action.action === 'answer') return action.text || 'I need a little more information.'

  if (!action.action || action.action === 'list') {
    const list = buildUserContext(ctx, user).replace('User servers:\n', '')
    if (!list || list.includes('no accessible servers')) return 'You have no accessible servers yet. Create one in the dashboard and I can manage it.'
    return 'Here are your servers:\n' + list
  }

  const server = resolve(action.server)
  if (!server) {
    if (action.action === 'status') return 'Server not found. Use the list action first, or give me the exact server name.'
    return 'Server not found. You can say "list servers" and then manage one by exact name.'
  }
  const acc = serverAccess(user, server, store)
  if (!acc.ok) return `You don't have access to "${server.name}".`

  const node = store.db.nodes.find((n: any) => n.id === server.nodeId)
  const client = node ? agentFor(node) : null
  if (!client) return 'The hosting node is unreachable right now.'

  switch (action.action) {
    case 'status':
      return `"${server.name}" is currently ${server.state.toUpperCase()} · ${server.mcVersion || '?'
      } ${server.mcPlatform || ''} · port ${server.allocations?.[0]?.port || '—'} · ${server.memoryLimitMb
      } MB / ${server.cpuPercent || '?'}% CPU · backups ${(store.db.backups.filter((b: any) => b.serverId === server.id && b.status === 'completed') || []).length}`

    case 'set_property': {
      const valid = new Set(['online-mode', 'white-list', 'enforce-whitelist', 'gamemode', 'force-gamemode', 'difficulty', 'max-players', 'motd', 'pvp', 'allow-flight', 'hardcore', 'spawn-protection', 'view-distance', 'simulation-distance', 'max-world-size', 'generate-structures', 'spawn-monsters', 'spawn-animals', 'spawn-npcs', 'level-seed', 'enable-command-blocks', 'network-compression-threshold', 'max-tick-time'])
      if (!valid.has(action.key)) return `"${action.key}" is not a property I can change. Say "game mode", "difficulty", "motd", "max players", "whitelist", "pvp", or "join mode/offline mode" and I'll change that.`
      try {
        const res = await client.mcConfigSet(server.id, { key: action.key, value: action.value })
        const pv = res?.value ?? action.value
        ctx.pushTerminal(server.id, `[aibro] set ${action.key} = ${JSON.stringify(pv)}`)
        ctx.audit(store, user.name, 'AIBRO', `${action.key}=${pv}:${server.name}`)
        const note = action.key === 'online-mode'
          ? (String(pv) === 'false' ? ' The server is now offline/cracked. Boot it for the change to apply.' : ' The server now requires a paid Minecraft account.')
          : ' Restart the server for the change to take effect.'
        return `Changed ${friendlyKey(action.key)} to ${JSON.stringify(pv)} on "${server.name}".${note}`
      } catch (e: any) {
        return `I couldn't change ${action.key}: ${String(e?.message || e).slice(0, 160)}`
      }
    }

    case 'power': {
      const want = String(action.value || '').toLowerCase()
      if (!['start', 'stop', 'restart'].includes(want)) return `Power action must be start, stop or restart.`
      const pending = want === 'start' ? 'starting' : want === 'stop' ? 'stopping' : 'restarting'
      if (!acc.permissions.command || !ctx.canTransition(server.state, pending) || server.state === 'suspended') {
        return `I can't ${want} "${server.name}" right now (state: ${server.state}).`
      }
      server.state = pending
      store.persist()
      ctx.broadcastServer(`srv:${server.id}`, server, user)
      try {
        if (want === 'start') {
          if (server.blueprintId === 'bp-minecraft' || server.blueprintId === 'bp-paper') {
            try { await client.ensureRCON(server.id) } catch { /* best-effort */ }
          }
          await client.power(server.id, 'start')
          server.state = 'running'
          server.startedAt = Date.now()
        } else {
          await client.power(server.id, want)
          if (want === 'stop') { server.state = 'offline'; server.startedAt = null }
          else server.state = 'running'
        }
        server.lastAction = want
        store.persist()
        ctx.broadcastServer(`srv:${server.id}`, server, user)
        ctx.pushTerminal(server.id, `[aibro] ${want} requested`)
        ctx.audit(store, user.name, 'AIBRO', `power ${want}:${server.name}`)
        return `Turning ${server.name} ${want === 'start' ? 'on' : want === 'stop' ? 'off' : 'off and back on'} now.`
      } catch (e: any) {
        server.state = 'error'
        server.error = String(e?.message || e)
        store.persist()
        ctx.broadcastServer(`srv:${server.id}`, server, user)
        return `I couldn't ${want} "${server.name}": ${String(e?.message || e).slice(0, 160)}`
      }
    }

    case 'command': {
      if (!acc.permissions.command) return `You don't have permission to run commands on "${server.name}".`
      try {
        const res = await client.command(server.id, String(action.command || ''))
        ctx.audit(store, user.name, 'AIBRO', `command:${server.name}`)
        const out = String(res?.output || 'sent').slice(0, 300)
        return `Command sent to ${server.name}. ${out !== 'sent' ? `Output:\n${out}` : ''}`
      } catch (e: any) {
        return `I couldn't send that command: ${String(e?.message || e).slice(0, 160)}`
      }
    }

    case 'backup': {
      try {
        const backup = await ctx.performBackup(server, user, {})
        return `Started a backup of "${server.name}" (${backup.name}). I'll know when it finishes.`
      } catch (e: any) {
        return `I couldn't start a backup: ${String(e?.message || e).slice(0, 160)}`
      }
    }

    default:
      return 'I understood you but the action is out of my current abilities.'
  }
}

function friendlyKey(k: string): string {
  return k.replace(/-/g, ' ')
}

// ---------------------------------------------------------------------------
// Chat entry point
// ---------------------------------------------------------------------------

export async function chat(ctx: AIBroContext, user: any, message: string, providerId?: string): Promise<{ ok: boolean; reply: string; action?: any; provider?: string }> {
  const keyUpdateFn = (providerId: string, msg: string) => {
    const keys = keysFor(user, providerId)
    if (keys.length === 0) throw Object.assign(new Error('NO_KEY'), { kind: 'client', detail: `No ${providerLabel(providerId)} key added. Add one in the AIBro card below.` })
    if (keys.length === 1) return keys[0].key
    return keys[0].key
  }
  const def = providerId ? providerDef(providerId) : AIBRO_PROVIDERS.find((p) => keysFor(user, p.id).length) || AIBRO_PROVIDERS[0]
  if (!def) throw Object.assign(new Error('UNKNOWN_PROVIDER'), { kind: 'client' })
  const apiKey = keyUpdateFn(def.id, '')
  const sys = `${SYSTEM_PROMPT}\n\n${buildUserContext(ctx, user)}`
  const raw = await callModel(def, apiKey, [
    { role: 'system', content: sys },
    { role: 'user', content: message },
  ])
  const action = extractAction(raw)
  if (!action) {
    return { ok: true, reply: `I didn't get a usable response from ${def.label}. Try rephrasing: "list servers", "start my server", "change join mode to offline".`, provider: def.id }
  }
  const reply = await executeAction({ ...ctx, agentFor: ctx.agentFor }, user, action)
  return { ok: true, reply, action, provider: def.id }
}

function providerLabel(id: string): string {
  return providerDef(id)?.label || id
}