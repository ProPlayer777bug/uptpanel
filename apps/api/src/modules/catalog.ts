import { setTimeout as delay } from 'node:timers/promises'

// UptimeHost marketplace catalog: Minecraft versions (Vanilla + Paper + Purpur
// + Folia) and plugins from SpigotMC + Modrinth. The catalog is refreshed in
// the background every HOUR so the panel always lists up-to-date versions.

/** Supported server software platforms shown on the version page. */
export const MC_PLATFORMS = ['vanilla', 'paper', 'purpur', 'folia'] as const
export type McPlatform = (typeof MC_PLATFORMS)[number]

export interface CatalogVersion {
  /** Unique id, e.g. `paper@1.21.4` (platform prefixed so platform+version is unique). */
  id: string
  /** The raw version string (e.g. `1.21.4`). */
  name: string
  /** The platform / server software this version belongs to. */
  type: McPlatform
  java: number | null
  url: string | null
  release: boolean
}

export interface PluginInfo {
  id: string
  name: string
  description: string
  source: 'spigot' | 'modrinth'
  author: string | null
  downloads: number
  icon: string | null
  url: string | null
  latestVersion: string | null
  /** Direct download URL for the plugin jar (or mod jar). */
  downloadUrl: string | null
  /** Which loader/type; 'plugin' for Bukkit/Paper or 'mod' for modloaders. */
  kind: 'plugin' | 'mod'
}

export interface CatalogSnapshot {
  fetchedAt: number
  versions: CatalogVersion[]
  plugins: PluginInfo[]
}

const REFRESH_MS = 60 * 60 * 1000 // 1 hour
const FETCH_TIMEOUT_MS = 15000

const state: {
  fetchedAt: number
  ok: boolean
  lastErr: string | null
  versions: CatalogVersion[]
  plugins: PluginInfo[]
} = {
  fetchedAt: 0,
  ok: false,
  lastErr: null,
  versions: [],
  plugins: [],
}

async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'uptimehost-panel/0.2' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

// Return the latest STABLE build download URL for a version on a fill project,
// or null. Falls back to the newest build if no STABLE channel exists.
async function fillBuildDownload(project: string, version: string): Promise<string | null> {
  try {
    const builds: any = await fetchJson(`https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds`)
    const array: any[] = Array.isArray(builds) ? builds : []
    // Prefer the newest STABLE build.
    const stable = [...array].reverse().find((b: any) => b?.channel === 'STABLE') || array[0]
    const url = stable?.downloads?.['server:default']?.url
    if (url) return url
    const last = array[array.length - 1]
    if (last?.downloads?.['server:default']?.url) return last.downloads['server:default'].url
  } catch { /* ignore */ }
  return null
}

async function fetchVanillaVersions(): Promise<CatalogVersion[]> {
  try {
    const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json')
    const latestRelease = manifest?.latest?.release
    const list: any[] = Array.isArray(manifest?.versions) ? manifest.versions : []
    // Take the latest ~40 releases and recent snapshots, newest first.
    const releases = list.filter((v: any) => v.type === 'release').slice(0, 40)
    const snapshots = list.filter((v: any) => v.type === 'snapshot').slice(0, 5)
    const chosen = [...snapshots, ...releases]
    const out: CatalogVersion[] = []
    for (const v of chosen) {
      let java: number | null = null
      let jar: string | null = null
      if (v.type === 'release' || v.id === latestRelease) {
        try {
          const meta = await fetchJson(v.url)
          java = meta?.javaVersion?.majorVersion != null ? Number(meta.javaVersion.majorVersion) : null
          jar = meta?.downloads?.server?.url || null
        } catch { /* ignore */ }
      }
      out.push({ id: `vanilla@${v.id}`, name: v.id, type: 'vanilla', java, url: jar, release: v.type === 'release' })
    }
    return out
  } catch (e: any) {
    state.lastErr = 'vanilla: ' + String(e?.message || e)
    return []
  }
}

// Compare two Minecraft version strings numerically, descending (newest first).
// Handles pre-release suffixes by treating them as older than the plain release.
function mcVersionCompare(a: string, b: string): number {
  const partsA = a.split('-')[0].split('.').map((n) => Number(n) || 0)
  const partsB = b.split('-')[0].split('.').map((n) => Number(n) || 0)
  const len = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < len; i++) {
    const x = partsA[i] || 0
    const y = partsB[i] || 0
    if (x !== y) return y - x
  }
  // Equal numeric version → a plain release is newer than a pre/snapshot build.
  const pre = /-(rc|pre|snapshot)/i
  const pa = pre.test(a) ? 1 : 0
  const pb = pre.test(b) ? 1 : 0
  if (pa !== pb) return pa - pb
  return 0
}

// Generic fetcher for PaperMC "fill" project platforms (paper, folia, ...).
async function fetchFillVersions(project: McPlatform): Promise<CatalogVersion[]> {
  try {
    const data: any = await fetchJson(`https://fill.papermc.io/v3/projects/${project}`)
    const groups: Record<string, string[]> = data?.versions || {}
    // Flatten version groups (group key -> concrete version ids), then sort by
    // real Minecraft version (not API insertion order, which is reordered by
    // integer-like object keys) and take the most recent ~24, newest first.
    const all: string[] = []
    for (const v of Object.values(groups)) {
      if (Array.isArray(v)) all.push(...v)
    }
    const unique = Array.from(new Set(all))
    const top = unique.sort(mcVersionCompare).slice(0, 24)
    const out: CatalogVersion[] = []
    for (const v of top) {
      const url = await fillBuildDownload(project, v)
      out.push({ id: `${project}@${v}`, name: v, type: project, java: 21, url, release: !/-(rc|pre|snapshot)/i.test(v) })
    }
    return out
  } catch (e: any) {
    state.lastErr = `${project}: ` + String(e?.message || e)
    return []
  }
}

// Fetch Purpur versions + latest build download URLs from PurpurMC.
async function fetchPurpurVersions(): Promise<CatalogVersion[]> {
  try {
    const data: any = await fetchJson('https://api.purpurmc.org/v2/purpur')
    const list: string[] = Array.isArray(data?.versions) ? data.versions : []
    // Purpur returns oldest-first; sort numerically (newest first) and keep
    // the latest ~24.
    const top = [...list].sort(mcVersionCompare).slice(0, 24)
    const out: CatalogVersion[] = []
    for (const v of top) {
      let url: string | null = null
      try {
        const b: any = await fetchJson(`https://api.purpurmc.org/v2/purpur/${v}`)
        const latest = b?.builds?.latest
        if (latest) url = `https://api.purpurmc.org/v2/purpur/${v}/${latest}/download`
      } catch { /* ignore */ }
      out.push({ id: `purpur@${v}`, name: v, type: 'purpur', java: 21, url, release: true })
    }
    return out
  } catch (e: any) {
    state.lastErr = 'purpur: ' + String(e?.message || e)
    return []
  }
}

// Strip any path separators / dots that aren't safe for a filename.
function safeFileName(name: string): string {
  return (name || 'plugin')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.+$/, '')
    .slice(0, 80) || 'plugin'
}

async function fetchSpigotPlugins(limit = 40): Promise<PluginInfo[]> {
  const out: PluginInfo[] = []
  try {
    // spiget search for the newest plugins sorted by downloads.
    let list: any[] = []
    try {
      list = await fetchJson('https://api.spiget.org/v2/resources?size=40&sort=-downloads&fields=id,name,tag,downloads,file,external_url,icon,testedVersions,author')
    } catch {
      list = await fetchJson('https://api.spiget.org/v2/resources?size=40&sort=-downloads')
    }
    if (!Array.isArray(list)) return out
    for (const r of list) {
      const id = r?.id
      if (!id) continue
      const name = r?.name || 'Unnamed'
      const latestVersion = r?.file?.type === '.jar' ? null : null
      out.push({
        id: 'spigot-' + id,
        name,
        description: r?.tag || '',
        source: 'spigot',
        author: r?.author?.name || null,
        downloads: Number(r?.downloads || r?.downloadCount || 0),
        icon: r?.icon?.data ? `data:image/png;base64,${r.icon.data}` : null,
        url: `https://www.spigotmc.org/resources/${id}/`,
        latestVersion,
        downloadUrl: `https://api.spiget.org/v2/resources/${id}/download`,
        kind: 'plugin',
      })
    }
  } catch (e: any) {
    state.lastErr = 'spigot: ' + String(e?.message || e)
  }
  return out
}

async function fetchModrinthPlugins(limit = 40): Promise<PluginInfo[]> {
  const out: PluginInfo[] = []
  try {
    // Bukkit (Paper) plugins on Modrinth, sorted by downloads.
    const params = new URLSearchParams({
      facets: JSON.stringify([['project_type:mod', 'project_type:plugin']]),
      index: 'downloads',
      limit: String(limit),
    })
    const resp: any = await fetchJson(`https://api.modrinth.com/v2/search?${params.toString()}`)
    const hits: any[] = Array.isArray(resp) ? resp : resp?.hits || []
    for (const r of hits.slice(0, limit)) {
      const slug = r?.slug
      // Only include Paper/Bukkit & Fabric/Forge plugin/mod jars.
      const loaders: string[] = r?.loaders || []
      const isPlugin = loaders.includes('paper') || loaders.includes('bukkit') || loaders.includes('spigot')
      const isMod = loaders.includes('fabric') || loaders.includes('forge') || loaders.includes('neoforge')
      let info: any = null
      if (slug) {
        try { info = await fetchJson(`https://api.modrinth.com/v2/project/${slug}`) } catch { /* ignore */ }
      }
      const dlUrl = slug
        ? `https://cdn.modrinth.com/data/${(r as any).project_id}/${(info?.latest_files?.[0]?.files?.[0]?.url) || ''}`.replace(/\/$/, '')
        : null
      out.push({
        id: 'modrinth-' + (r?.project_id || slug),
        name: r?.title || slug,
        description: r?.description || '',
        source: 'modrinth',
        author: (info?.team || r?.author) ? null : null,
        downloads: Number(r?.downloads || 0),
        icon: r?.icon_url || null,
        url: `https://modrinth.com/${(r as any).project_type || 'plugin'}/${slug}`,
        latestVersion: info?.version_type || null,
        downloadUrl: null, // resolved at install time from latest file
        kind: isMod ? 'mod' : 'plugin',
      })
    }
  } catch (e: any) {
    state.lastErr = 'modrinth: ' + String(e?.message || e)
  }
  return out
}

export async function refreshCatalog(): Promise<CatalogSnapshot> {
  const [vanilla, paper, purpur, folia, spigot, modrinth] = await Promise.all([
    fetchVanillaVersions(),
    fetchFillVersions('paper'),
    fetchPurpurVersions(),
    fetchFillVersions('folia'),
    fetchSpigotPlugins(),
    fetchModrinthPlugins(),
  ])
  state.versions = [...vanilla, ...paper, ...purpur, ...folia]
  state.plugins = [...spigot, ...modrinth]
  state.fetchedAt = Date.now()
  state.ok = true
  if (!state.lastErr) state.lastErr = null
  return snapshot()
}

export function snapshot(): CatalogSnapshot {
  return { fetchedAt: state.fetchedAt, versions: state.versions, plugins: state.plugins }
}

export function catalogState() {
  return { ...state }
}

// Resolve the actual download URL + java version for a requested version id.
// The version id is `platform@version` (e.g. `paper@1.21.4`), which lets us
// pick the right source per server software regardless of blueprint.
export async function resolveVersionDownload(versionId: string, blueprintId: string): Promise<{ url: string | null; java: number | null; name: string; platform: string | null } | null> {
  const v = state.versions.find((x) => x.id === versionId)
  if (v?.url) return { url: v.url, java: v.java, name: v.name, platform: v.type }
  // Parse `platform@version` for live resolution outside the cache.
  const at = versionId.lastIndexOf('@')
  const platform = at > 0 ? versionId.slice(0, at) : null
  const ver = at > 0 ? versionId.slice(at + 1) : versionId
  if (platform === 'vanilla') {
    try {
      const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json')
      const entry = (manifest?.versions || []).find((x: any) => x.id === ver)
      if (entry?.url) {
        const meta = await fetchJson(entry.url)
        return { url: meta?.downloads?.server?.url || null, java: meta?.javaVersion?.majorVersion ? Number(meta.javaVersion.majorVersion) : null, name: ver, platform: 'vanilla' }
      }
    } catch { /* ignore */ }
    return null
  }
  if (platform === 'paper' || platform === 'folia') {
    const url = await fillBuildDownload(platform, ver)
    if (url) return { url, java: 21, name: ver, platform }
  }
  if (platform === 'purpur') {
    try {
      const b: any = await fetchJson(`https://api.purpurmc.org/v2/purpur/${ver}`)
      const latest = b?.builds?.latest
      if (latest) return { url: `https://api.purpurmc.org/v2/purpur/${ver}/${latest}/download`, java: 21, name: ver, platform: 'purpur' }
    } catch { /* ignore */ }
  }
  return null
}

// Resolve the download URL + jar filename for a plugin id.
export async function resolvePluginDownload(pluginId: string): Promise<{ url: string; fileName: string; name: string } | null> {
  const p = state.plugins.find((x) => x.id === pluginId)
  if (!p) return null
  const clean = safeFileName(p.name)
  if (p.source === 'spigot' && p.downloadUrl) {
    return { url: p.downloadUrl, fileName: `${clean}.jar`, name: p.name }
  }
  if (p.source === 'modrinth') {
    // Resolve the latest version file via the Modrinth API.
    const projectId = pluginId.replace(/^modrinth-/, '')
    try {
      const ver: any = await fetchJson(`https://api.modrinth.com/v2/project/${projectId}/version`)
      if (Array.isArray(ver) && ver.length > 0) {
        const file = ver[0]?.files?.[0]
        if (file?.url) {
          const ext = p.kind === 'mod' ? '.jar' : '.jar'
          return { url: file.url, fileName: `${clean}${ext}`, name: p.name }
        }
      }
    } catch { /* ignore */ }
  }
  return null
}

export async function startCatalogWatcher(): Promise<void> {
  await refreshCatalog()
  for (;;) {
    await delay(REFRESH_MS)
    await refreshCatalog()
  }
}
