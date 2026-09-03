import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client'
import type { Server, Node, Location, Blueprint } from '@uptimehost/types'

export function usePoll<T>(fetcher: () => Promise<T>, deps: unknown[] = [], interval = 8000) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const cb = useRef(fetcher)
  cb.current = fetcher
  const depsKey = JSON.stringify(deps)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const d = await cb.current()
        if (!alive) return
        setData(d); setError(null)
      } catch (e: any) {
        if (!alive) return
        setError(e?.message || 'Error')
      } finally {
        if (alive) setLoading(false)
      }
    }
    run()
    // A non-positive interval means "fetch once", never poll. A bare
    // setInterval(fn, 0) would hammer the API and blow past rate limits.
    if (interval > 0) {
      const t = setInterval(run, interval)
      return () => { alive = false; clearInterval(t) }
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, interval])

  return { data, loading, error, refetch: useCallback(() => { setLoading(true); cb.current() }, []) }
}

export function useServers() {
  const { data, ...rest } = usePoll<{ servers: Server[]; summary: any }>(async () => api.get('/servers'))
  return { servers: data?.servers ?? [], summary: data?.summary ?? null, ...rest }
}

export function useNodes() {
  const { data, ...rest } = usePoll<{ nodes: Node[]; locations: Location[] }>(async () => api.get('/nodes'))
  return { nodes: data?.nodes ?? [], locations: data?.locations ?? [], ...rest }
}

export function useLocations() {
  const { data, ...rest } = usePoll<{ locations: Location[] }>(async () => api.get('/locations'))
  return { locations: data?.locations ?? [], ...rest }
}

export function useBlueprints() {
  const { data, ...rest } = usePoll<{ blueprints: Blueprint[] }>(async () => api.get('/blueprints'))
  return { blueprints: data?.blueprints ?? [], ...rest }
}

export function useServer(id: string | undefined) {
  return usePoll<{ server: Server }>(
    async () => api.get(`/servers/${id}`),
    [id],
    id ? 6000 : 0,
  )
}

export async function powerAction(id: string, action: 'start' | 'stop' | 'restart' | 'kill') {
  return api.post(`/servers/${id}/power`, { action })
}
