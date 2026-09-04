import { setTimeout as delay } from 'node:timers/promises'

// Mojang Minecraft version manifest — the source of truth for the latest
// release/snapshot and each version's required Java runtime. The panel polls
// this so defaults always track the newest release without operator action.

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest.json'
const REFRESH_MS = 6 * 60 * 60 * 1000 // 6h, matches Mojang's cadence
const FETCH_TIMEOUT_MS = 15000

export interface MCManifestVersion {
  id: string
  type: 'release' | 'snapshot' | string
  url: string
}

export interface MCVersionInfo {
  id: string
  type: string
  /** Java major version required to run this Minecraft version (null = unknown). */
  java: number | null
  /** Signed server.jar download URL from Mojang. */
  serverJar: string | null
  /** True when this is the latest *release* (stable) version. */
  latestRelease: boolean
  /** True when this is the latest *snapshot* build. */
  latestSnapshot: boolean
}

export interface MCDefaults {
  /** Latest stable release, e.g. "26.2". */
  release: MCVersionInfo | null
  /** Latest snapshot build (may equal release when none is live). */
  snapshot: MCVersionInfo | null
  /** Java major version required by the latest release. */
  defaultJava: number
  /** When the manifest was last successfully fetched. */
  fetchedAt: number
  /** Timestamp of the newest *release* entry in the manifest. */
  releaseChangedAt: number | null
}

const state: {
  ok: boolean
  infoByVersion: Map<string, MCVersionInfo>
  release: MCVersionInfo | null
  snapshot: MCVersionInfo | null
  fetchedAt: number
  lastErr: string | null
} = {
  ok: false,
  infoByVersion: new Map(),
  release: null,
  snapshot: null,
  fetchedAt: 0,
  lastErr: null,
}

async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

// resolveJavaVersion fetches the per-version manifest to learn the required
// Java runtime and the server.jar download URL.
async function resolveVersion(v: MCManifestVersion, latestRelease: string, latestSnapshot: string): Promise<MCVersionInfo> {
  let java: number | null = null
  let serverJar: string | null = null
  try {
    const meta = await fetchJson(v.url)
    java = Number(meta?.javaVersion?.majorVersion) || null
    serverJar = meta?.downloads?.server?.url || null
  } catch {
    // Java requirement unknown — caller falls back to a sensible default.
  }
  return {
    id: v.id,
    type: v.type,
    java,
    serverJar,
    latestRelease: v.id === latestRelease,
    latestSnapshot: v.id === latestSnapshot,
  }
}

export async function refreshMCManifest(): Promise<MCDefaults> {
  try {
    const manifest = await fetchJson(MANIFEST_URL)
    const latestRelease: string = manifest?.latest?.release
    const latestSnapshot: string = manifest?.latest?.snapshot
    const versions: MCManifestVersion[] = Array.isArray(manifest?.versions) ? manifest.versions : []

    const infoByVersion = new Map<string, MCVersionInfo>()
    // Resolve the latest release (+ snapshot when different) so the panel can
    // advertise the newest default and its Java requirement.
    const targets = versions.filter((v) => v.id === latestRelease || v.id === latestSnapshot)
    const resolved = await Promise.all(targets.map((v) => resolveVersion(v, latestRelease, latestSnapshot)))
    for (const r of resolved) infoByVersion.set(r.id, r)

    state.ok = true
    state.lastErr = null
    state.fetchedAt = Date.now()
    state.release = infoByVersion.get(latestRelease) || null
    state.snapshot = infoByVersion.get(latestSnapshot) || null
    state.infoByVersion = infoByVersion
    return currentDefaults()
  } catch (e: any) {
    state.lastErr = String(e?.message || e)
    return currentDefaults()
  }
}

export function currentDefaults(): MCDefaults {
  const defaultJava = state.release?.java ?? state.snapshot?.java ?? 21
  return {
    release: state.release,
    snapshot: state.snapshot,
    defaultJava,
    fetchedAt: state.fetchedAt,
    releaseChangedAt: state.release?.id ? state.fetchedAt : null,
  }
}

export function mcState() {
  return { ...state, infoByVersion: Object.fromEntries(state.infoByVersion) }
}

export async function startMCVersionWatcher(): Promise<void> {
  await refreshMCManifest()
  // Poll forever so defaults auto-advance when Mojang ships a new release.
  // Errors are swallowed; the next tick retries.
  for (;;) {
    await delay(REFRESH_MS)
    await refreshMCManifest()
  }
}

// javaImage determines the Pterodactyl-style yolks docker image for a required
// Java major version. Falls back to the newest available when unknown.
export function javaImage(java: number | null | undefined): string {
  switch (java) {
    case 25: return 'ghcr.io/pterodactyl/yolks:java_25'
    case 21: return 'ghcr.io/pterodactyl/yolks:java_21'
    case 17: return 'ghcr.io/pterodactyl/yolks:java_17'
    case 16: return 'ghcr.io/pterodactyl/yolks:java_16'
    case 11: return 'ghcr.io/pterodactyl/yolks:java_11'
    case 8: return 'ghcr.io/pterodactyl/yolks:java_8'
    default: return 'ghcr.io/pterodactyl/yolks:java_21'
  }
}
