// API client with token auth and typed responses.
const TOKEN_KEY = 'uh_token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

async function request<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((opts.headers as Record<string, string>) || {}),
  }
  const token = getToken()
  if (token) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`/api${path}`, { ...opts, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err: any = new Error(data.error || `HTTP ${res.status}`)
    err.data = data
    err.status = res.status
    throw err
  }
  return data as T
}

export const api = {
  get: (p: string) => request(p),
  post: (p: string, body?: any) => request(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: (p: string, body?: any) => request(p, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: (p: string, body?: any) => request(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: (p: string) => request(p, { method: 'DELETE' }),
}

// Fetch a binary blob (e.g. a backup zip) and trigger a browser download.
export async function downloadBlob(path: string, filename: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Upload files (multipart FormData) to a File Manager endpoint. Unlike the
// JSON helpers, the browser sets the correct multipart content-type/boundary.
export async function uploadForm(path: string, form: FormData): Promise<any> {
  const token = getToken()
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const err: any = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json().catch(() => ({}))
}

export interface Err extends Error {
  data?: { code?: string; error?: string }
  status?: number
}
