import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client'
import type { Server, Node, Location, Blueprint } from '@uptimehost/types'

export function usePoll<T>(fetcher: () => Promise<T>, deps: unknown[] = [], interval = 100, enabled = true) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const cb = useRef(fetcher)
  cb.current = fetcher
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const depsKey = JSON.stringify(deps)

  useEffect(() => {
    let alive = true
    // When disabled (e.g. a non-admin shouldn't poll admin-only endpoints),
    // don't fire the request at all — avoids needless 403s in the console.
    if (!enabledRef.current) { setLoading(false); return () => { alive = false } }
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
    if (interval > 0 && enabledRef.current) {
      const t = setInterval(run, interval)
      return () => { alive = false; clearInterval(t) }
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, interval, enabled])

  return {
    data, loading, error,
    // refetch re-runs the fetcher and writes its result straight back into state
    // (immediately, without waiting for the next poll tick). Used by manual
    // "Refresh" buttons and onSaved/onDone handlers across the app.
    refetch: useCallback(async () => {
      if (!enabledRef.current) return
      setLoading(true)
      try {
        const d = await cb.current()
        setData(d); setError(null)
      } catch (e: any) {
        setError(e?.message || 'Error')
      } finally {
        setLoading(false)
      }
    }, []),
  }
}

export function useServers() {
  const { data, ...rest } = usePoll<{ servers: Server[]; summary: any }>(async () => api.get('/servers'))
  return { servers: data?.servers ?? [], summary: data?.summary ?? null, ...rest }
}

export function useNodes(enabled = true) {
  const { data, ...rest } = usePoll<{ nodes: Node[]; locations: Location[] }>(async () => api.get('/nodes'), [], 100, enabled)
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
    id ? 100 : 0,
  )
}

export function useActivity(limit = 20) {
  return usePoll<{ activity: any[] }>(async () => api.get(`/activity?limit=${limit}`), [limit], 100)
}

export async function powerAction(id: string, action: 'start' | 'stop' | 'restart' | 'kill') {
  return api.post(`/servers/${id}/power`, { action })
}
