// Panel → Node Agent HTTP client (like Pterodactyl Panel → Wings).
// The agent runs on each node and manages Docker; the panel calls it over HTTP.
//
// Every request is authenticated with a short-lived, replay-protected HMAC
// signature (Pterodactyl-style). The signature binds the HTTP method, the
// request path (incl. query), a unique request id, the signing timestamp, the
// target node id and the sha256 of the raw body, all keyed by the node's
// shared secret (agent token). The agent independently verifies the same
// canonical string, so a captured request cannot be replayed elsewhere.
import { nanoid } from 'nanoid'
import { createHmac, createHash, randomUUID } from 'node:crypto'

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

function bodyHash(raw: string | undefined | null): string {
  return createHash('sha256').update(raw || '').digest('hex')
}

function canonical(method: string, path: string, requestID: string, timestampSec: string, nodeID: string, rawBody: string): string {
  return `${method}\n${path}\n${requestID}\n${timestampSec}\n${nodeID}\n${bodyHash(rawBody)}`
}

export class AgentClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private nodeId: string,
  ) {}

  private signature(method: string, path: string, rawBody: string) {
    const xRequestId = randomUUID()
    const xTimestamp = String(Math.floor(Date.now() / 1000))
    const xSignature = createHmac('sha256', this.token)
      .update(canonical(method, path, xRequestId, xTimestamp, this.nodeId, rawBody))
      .digest('hex')
    return { xRequestId, xTimestamp, xSignature }
  }

  private signedHeaders(method: string, path: string, rawBody: string): Record<string, string> {
    const s = this.signature(method, path, rawBody)
    return {
      'x-node-id': this.nodeId,
      'x-request-id': s.xRequestId,
      'x-timestamp': s.xTimestamp,
      'x-signature': s.xSignature,
    }
  }

  private async req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    const rawBody = body != null ? JSON.stringify(body) : ''
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.signedHeaders(method, path, rawBody),
    }
    const res = await this.fetchTls(url, {
      method,
      headers,
      body: rawBody || undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err: any = new Error(`agent ${res.status}: ${text.slice(0, 200)}`)
      err.agentStatus = res.status
      throw err
    }
    return res.json() as Promise<T>
  }

  // fetchTls wraps the global fetch, optionally relaxing TLS certificate
  // verification for local/dev nodes whose agent runs a self-signed cert.
  // This is an explicit opt-in escape hatch (UH_AGENT_INSECURE=1) and MUST
  // NOT be enabled in production.
  private async fetchTls(url: string, init: RequestInit): Promise<Response> {
    if (process.env.UH_AGENT_INSECURE === '1') {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }
    return fetch(url, init)
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
  downloadFile(containerId: string, path: string, url: string) {
    return this.req('POST', `/api/containers/${containerId}/files/download`, { path, url })
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
    const path = `/api/containers/${containerId}/backups?name=${encodeURIComponent(name)}`
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`
    return this.fetchTls(url, {
      method: 'GET',
      headers: this.signedHeaders('GET', path, ''),
    })
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
  if (!node || !node.agentUrl || !node.agentToken || !node.id) return null
  return new AgentClient(node.agentUrl, node.agentToken, node.id)
}

// Normalize incoming agent error ids for the UI.
export function agentErrorId(err: any): string {
  return `UH-AGENT-${nanoid(4).toUpperCase()}`
}
