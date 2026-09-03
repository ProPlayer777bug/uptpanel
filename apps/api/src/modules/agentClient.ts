// Panel → Node Agent HTTP client (like Pterodactyl Panel → Wings).
// The agent runs on each node and manages Docker; the panel calls it over HTTP.
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
    private baseUrl: string,
    private token: string,
  ) {}

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err: any = new Error(`agent ${res.status}: ${text.slice(0, 200)}`)
      err.agentStatus = res.status
      throw err
    }
    return res.json() as Promise<T>
  }

  // ---- Health / system ----
  ping() {
    return this.req('GET', '/api/system')
  }
  list() {
    return this.req<{ containers: any[] }>('GET', '/api/containers')
  }

  // ---- Container lifecycle ----
  createContainer(payload: unknown) {
    return this.req('POST', '/api/containers', payload)
  }
  power(containerId: string, action: string) {
    return this.req('POST', `/api/containers/${containerId}/power`, { action })
  }
  remove(containerId: string) {
    return this.req('DELETE', `/api/containers/${containerId}`)
  }
  stats(containerId: string) {
    return this.req('GET', `/api/containers/${containerId}/stats`)
  }
  command(containerId: string, cmd: string) {
    return this.req('POST', `/api/containers/${containerId}/command`, { command: cmd })
  }

  // ---- Files ----
  listFiles(containerId: string, path: string) {
    return this.req('GET', `/api/containers/${containerId}/files?path=${encodeURIComponent(path)}`)
  }
  readFile(containerId: string, path: string) {
    return this.req('GET', `/api/containers/${containerId}/files/content?path=${encodeURIComponent(path)}`)
  }
  writeFile(containerId: string, path: string, content: string) {
    return this.req('POST', `/api/containers/${containerId}/files/write`, { path, content })
  }
  containerLogs(containerId: string, tail?: number) {
    return this.req('GET', `/api/containers/${containerId}/logs?tail=${tail || 200}`)
  }

  // ---- Backups (real ZIP archives on the node) ----
  createBackup(containerId: string, name: string, uuid: string) {
    return this.req('POST', `/api/containers/${containerId}/backups`, { name, uuid })
  }
  restoreBackup(containerId: string, name: string) {
    return this.req('POST', `/api/containers/${containerId}/backups/restore`, { name })
  }
  deleteBackup(containerId: string, name: string) {
    return this.req('DELETE', `/api/containers/${containerId}/backups?name=${encodeURIComponent(name)}`)
  }
  // Returns a raw fetch Response so the panel can stream bytes through.
  downloadBackup(containerId: string, name: string): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/containers/${containerId}/backups?name=${encodeURIComponent(name)}`
    return fetch(url, { headers: { authorization: `Bearer ${this.token}` } })
  }

  // ---- Reinstall / destroy data ----
  reinstall(containerId: string) {
    return this.req('POST', `/api/containers/${containerId}/reinstall`)
  }

  // Checks whether a container currently exists on the node.
  async exists(containerId: string): Promise<boolean> {
    const { containers } = await this.list()
    return containers.some((c: any) => c.serverId === containerId || c.name === `uh_${containerId}`)
  }
}

export function agentFor(node: any): AgentClient | null {
  if (!node || !node.agentUrl || !node.agentToken) return null
  return new AgentClient(node.agentUrl, node.agentToken)
}

// Normalize incoming agent error ids for the UI.
export function agentErrorId(err: any): string {
  return `UH-AGENT-${nanoid(4).toUpperCase()}`
}
