// Panel → Wings daemon HTTP client (Pterodactyl-style connection model).
// The daemon runs on each node and manages the server's container(s); the
// panel calls it over HTTP/WS using the Wings REST paths:
//
//	/api/system                          health
//	/api/servers/:id                     (DELETE) remove container
//	/api/servers/:id/power               {action} start|stop|restart|kill
//	/api/servers/:id/commands            {commands:[...]} or {command}
//	/api/servers/:id/logs?tail=N         fetch recent logs
//	/api/servers/:id/stats               live resource stats
//	/api/servers/:id/files/...           file operations
//	/api/servers/:id/backups/...         backup archive operations
//	/api/servers/:id/reinstall           wipe data dir
//	/api/servers/:id/ws                  Wings JSON console protocol
//
// Every request authenticates with the node's daemon token in the
// Authorization: Bearer header, exactly like Wings' RequireAuthorization
// middleware expects.
import { nanoid } from 'nanoid'

export interface AgentInfo {
  id: string
  version: string
  online: boolean
  dockerHealthy: boolean
  memoryTotalMb: number
  memoryUsedMb: number
  diskTotalGb: number
  diskUsedGb: number
  cpuPercent: number
  containers: number
  reachedAt: number
}

export class AgentClient {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    private nodeId: string,
  ) {}

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const rawBody = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    }
    const res = await this.fetchTls(url, {
      method,
      headers,
      body: rawBody || undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err: any = new Error(`wings ${res.status}: ${text.slice(0, 200)}`)
      err.agentStatus = res.status
      throw err
    }
    return res.json() as Promise<T>
  }

  // fetchTls wraps the global fetch, optionally relaxing TLS certificate
  // verification for local/dev nodes whose daemon runs a self-signed cert.
  // This is an explicit opt-in escape hatch (UH_AGENT_INSECURE=1) and MUST
  // NOT be enabled in production.
  async fetchTls(url: string, init: RequestInit): Promise<Response> {
    if (process.env.UH_AGENT_INSECURE === '1') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }
    return fetch(url, init)
  }

  // ---- Health / system ----
  ping() {
    return this.req('GET', '/api/system')
  }

  // ---- Server lifecycle (Wings-style) ----
  list() {
    // Wings GET /api/servers returns the full server list; our daemon exposes
    // /api/containers for enumeration, keep both working.
    return this.req<{ containers: any[] }>('GET', '/api/containers')
  }
  createContainer(payload: unknown) {
    return this.req('POST', '/api/servers', payload)
  }
  power(serverId: string, action: string) {
    return this.req('POST', `/api/servers/${serverId}/power`, { action, wait_seconds: 30 })
  }
  remove(serverId: string) {
    return this.req('DELETE', `/api/servers/${serverId}`)
  }
  stats(serverId: string) {
    return this.req('GET', `/api/servers/${serverId}/stats`)
  }
  command(serverId: string, cmd: string) {
    return this.req('POST', `/api/servers/${serverId}/commands`, { commands: [cmd] })
  }

  // ---- Files ----
  listFiles(serverId: string, path: string) {
    return this.req('GET', `/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`)
  }
  readFile(serverId: string, path: string) {
    return this.req('GET', `/api/servers/${serverId}/files/content?path=${encodeURIComponent(path)}`)
  }
  writeFile(serverId: string, path: string, content: string) {
    return this.req('POST', `/api/servers/${serverId}/files/write`, { path, content })
  }
  downloadFile(serverId: string, path: string, url: string) {
    return this.req('POST', `/api/servers/${serverId}/files/download`, { path, url })
  }
  deleteFile(serverId: string, path: string) {
    return this.req('POST', `/api/servers/${serverId}/files/delete`, { path })
  }
  renameFile(serverId: string, from: string, to: string) {
    return this.req('POST', `/api/servers/${serverId}/files/rename`, { from, to })
  }
  makeDir(serverId: string, path: string) {
    return this.req('POST', `/api/servers/${serverId}/files/mkdir`, { path })
  }
  archive(serverId: string, path: string) {
    return this.req<{ ok: boolean; file: string; bytes: number }>('POST', `/api/servers/${serverId}/files/archive`, { path })
  }
  extractArchive(serverId: string, path: string) {
    return this.req('POST', `/api/servers/${serverId}/files/archive/extract`, { path })
  }
  openFirewall(serverId: string, port: number) {
    return this.req('POST', `/api/servers/${serverId}/firewall/open`, { port })
  }
  closeFirewall(serverId: string, port: number) {
    return this.req('POST', `/api/servers/${serverId}/firewall/close`, { port })
  }
  // Get a file's bytes for browser download.
  downloadFileBytes(serverId: string, path: string): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/servers/${serverId}/files/download?path=${encodeURIComponent(path)}`
    return this.fetchTls(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
    })
  }
  containerLogs(serverId: string, tail?: number) {
    return this.req('GET', `/api/servers/${serverId}/logs?tail=${tail || 200}`)
  }

  // ---- Backups (real ZIP archives on the node) ----
  createBackup(serverId: string, name: string, uuid: string) {
    return this.req('POST', `/api/servers/${serverId}/backups`, { name, uuid })
  }
  restoreBackup(serverId: string, name: string) {
    return this.req('POST', `/api/servers/${serverId}/backups/restore`, { name })
  }
  deleteBackup(serverId: string, name: string) {
    return this.req('DELETE', `/api/servers/${serverId}/backups?name=${encodeURIComponent(name)}`)
  }
  // Returns a raw fetch Response so the panel can stream bytes through.
  downloadBackup(serverId: string, name: string): Promise<Response> {
    const path = `/api/servers/${serverId}/backups?name=${encodeURIComponent(name)}`
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    return this.fetchTls(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}` },
    })
  }

  // ---- Reinstall / destroy data ----
  reinstall(serverId: string) {
    return this.req('POST', `/api/servers/${serverId}/reinstall`)
  }

  // Checks whether a container currently exists on the node.
  async exists(serverId: string): Promise<boolean> {
    const { containers } = await this.list()
    return containers.some((c: any) => c.serverId === serverId || c.name === `uh_${serverId}`)
  }
}

export function agentFor(node: any): AgentClient | null {
  if (!node || !node.agentUrl || !node.agentToken || !node.id) return null
  return new AgentClient(node.agentUrl, node.agentToken, node.id)
}

// Normalize incoming agent error ids for the UI.
export function agentErrorId(err: any): string {
  return `UH-AGENT-${nanoid(4).toUpperCase()}`
}
