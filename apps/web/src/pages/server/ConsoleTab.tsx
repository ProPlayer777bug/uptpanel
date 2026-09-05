import { useEffect, useRef, useState, useCallback } from 'react'
import { Icon, toast } from '../../components/ui'
import { api } from '../../api/client'
import { getToken } from '../../api/client'
import { powerAction } from '../../api/hooks'
import { useApp } from '../../state/auth'
import { publicAddress } from '../../utils/mask'
import { maskHost } from '../../utils/mask'
import type { Server } from '@uptimehost/types'

interface Line { id: number; kind: 'out' | 'in' | 'sys'; text: string; ts: number }

// 20 console-only text color + font presets. Colors map to the CSS custom
// property --term-fg, fonts to --term-font (stacked so they fall back to the
// browser's default monospace when the named face isn't installed).
const CONSOLE_THEMES: { id: string; name: string; color: string; font: string }[] = [
  { id: 'gold', name: 'Gold', color: '#ffd23f', font: `'JetBrains Mono','Fira Code',ui-monospace,'SF Mono',Menlo,monospace` },
  { id: 'ember', name: 'Ember', color: '#ffb454', font: `'Fira Code','JetBrains Mono',ui-monospace,'Cascadia Code',monospace` },
  { id: 'green', name: 'Green', color: '#4cff88', font: `'JetBrains Mono','Fira Code',ui-monospace,'SF Mono',Menlo,monospace` },
  { id: 'ice', name: 'Ice Blue', color: '#8fd8ff', font: `'SF Mono',Menlo,Monaco,Consolas,monospace` },
  { id: 'candy', name: 'Candy Pink', color: '#ff8ae2', font: `Consolas,'Courier New',Courier,monospace` },
  { id: 'lime', name: 'Lime', color: '#ccff33', font: `'Ubuntu Mono','DejaVu Sans Mono',Consolas,monospace` },
  { id: 'paper', name: 'Paper White', color: '#eef2f7', font: `'JetBrains Mono','Fira Code',ui-monospace,'SF Mono',Menlo,monospace` },
  { id: 'lavender', name: 'Lavender', color: '#c9a9ff', font: `'Roboto Mono','Droid Sans Mono','DejaVu Sans Mono',monospace` },
  { id: 'neon', name: 'Cyber Neon', color: '#00ffd5', font: `ui-monospace,'Cascadia Code','JetBrains Mono',Menlo,monospace` },
  { id: 'matrix', name: 'Matrix', color: '#00e05a', font: `Consolas,'Courier New',Courier,monospace` },
  { id: 'embers', name: 'Ember Orange', color: '#ff8c42', font: `'Ubuntu Mono','DejaVu Sans Mono',Consolas,monospace` },
  { id: 'crimson', name: 'Crimson', color: '#ff6b6b', font: `'JetBrains Mono','Fira Code',ui-monospace,'SF Mono',Menlo,monospace` },
  { id: 'teal', name: 'Teal', color: '#2dd4bf', font: `'Fira Code','JetBrains Mono',ui-monospace,'Cascadia Code',monospace` },
  { id: 'silver', name: 'Silver', color: '#cfd6e3', font: `'DejaVu Sans Mono','Bitstream Vera Sans Mono',Consolas,monospace` },
  { id: 'violet', name: 'Purple Haze', color: '#b388ff', font: `'Inconsolata','Droid Sans Mono','DejaVu Sans Mono',monospace` },
  { id: 'ocean', name: 'Ocean', color: '#4dd0e1', font: `'SF Mono',Menlo,Monaco,Consolas,monospace` },
  { id: 'retro', name: 'Retro', color: '#ffd866', font: `'Courier New',Courier,monospace` },
  { id: 'cream', name: 'Soft Cream', color: '#f3e8c9', font: `'SF Mono',Menlo,Monaco,Consolas,monospace` },
  { id: 'solar', name: 'Solarized', color: '#d19a2f', font: `'Ubuntu Mono','DejaVu Sans Mono',Consolas,monospace` },
  { id: 'nord', name: 'Nord', color: '#88c0d0', font: `ui-monospace,'Cascadia Code','JetBrains Mono',Menlo,monospace` },
]
interface ConsoleMsg { type: 'log' | 'input' | 'status' | 'system' | 'eula-required' | 'eula-accepted'; line?: string }

let seq = 0

const MAX_LINES = 1000

const MC: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA', '4': '#AA0000',
  '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA', '8': '#555555', '9': '#5555FF',
  a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
}
function renderMC(text: string): { html: string; plain: string } {
  let html = ''
  let plain = ''
  let color = 'inherit'
  let open = false
  const parts = text.split(/(§.)|(\u001b\[[0-9;]*m)/g)
  for (const p of parts) {
    if (!p) continue
    if (p.startsWith('§')) {
      const k = p[1].toLowerCase()
      if (k === 'l') { html += '<b>'; continue }
      if (k === 'r') {
        if (open) { html += '</span>'; open = false }
        html += '</b>'
        color = 'inherit'
        continue
      }
      const c = MC[k]
      if (c) {
        if (open) { html += '</span>'; open = false }
        html += `<span style="color:${c}">`
        open = true
      }
      continue
    }
    if (p.startsWith('\u001b[')) {
      if (open) { html += '</span>'; open = false }
      continue
    }
    html += escapeHtml(p)
    plain += p
  }
  if (open) html += '</span>'
  return { html, plain }
}
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Rendered output is cached per line id so frequent re-renders of the console
// (which happens on every batch flush) never re-split/re-escape old lines.
const _htmlCache = new Map<number, string>()
function cachedHtml(id: number, text: string): string {
  let h = _htmlCache.get(id)
  if (h === undefined) { h = renderMC(text).html; _htmlCache.set(id, h) }
  return h
}

function fmtUptime(startedAt: number | null | undefined): string {
  if (!startedAt) return '—'
  const ms = Math.max(0, Date.now() - startedAt)
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function ConsoleTab({ server }: { server: Server }) {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [attached, setAttached] = useState(false)
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [startupCmd, setStartupCmd] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('uh_term_size') || 13))
  const [searchQ, setSearchQ] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [liveStats, setLiveStats] = useState<{ cpuPercent?: number; memoryUsedMb?: number; pids?: number }>({})
  const [eulaPending, setEulaPending] = useState(false)
  const [powerBusy, setPowerBusy] = useState(false)
  const [showKillConfirm, setShowKillConfirm] = useState(false)
  const [termTheme, setTermTheme] = useState(() => localStorage.getItem('uh_console_theme') || 'gold')
  const [themeOpen, setThemeOpen] = useState(false)
  const { refresh } = useApp()
  const pendingRef = useRef<Line[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const pausedRef = useRef(paused)
  useEffect(() => { pausedRef.current = paused }, [paused])

  useEffect(() => {
    if (!themeOpen) return
    const onDoc = () => setThemeOpen(false)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setThemeOpen(false) }
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey) }
  }, [themeOpen])

  const pickTermTheme = (id: string) => {
    setTermTheme(id)
    localStorage.setItem('uh_console_theme', id)
    setThemeOpen(false)
  }

  // Console height resizer with lock/unlock. When unlocked a drag handle at
  // the bottom lets the user set a custom height (persisted). Locked keeps
  // whatever height was set (or the CSS default) and hides the handle.
  const [hLocked, setHLocked] = useState(() => localStorage.getItem('uh_console_lock') !== '0')
  const [customH, setCustomH] = useState<number | null>(() => {
    const n = Number(localStorage.getItem('uh_console_h') || 0)
    return n > 240 ? n : null
  })
  const winRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null)

  const toggleHeightLock = () => {
    setHLocked((v) => {
      const next = !v
      localStorage.setItem('uh_console_lock', next ? '1' : '0')
      return next
    })
  }

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    resizeRef.current = { startY: e.clientY, startH: winRef.current?.offsetHeight || 360 }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
    const move = (ev: MouseEvent) => {
      const r = resizeRef.current
      if (!r) return
      const h = Math.max(240, Math.min(window.innerHeight - 120, r.startH + (ev.clientY - r.startY)))
      setCustomH(h)
      localStorage.setItem('uh_console_h', String(h))
    }
    const up = () => {
      resizeRef.current = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const runPowerAction = async (action: 'start' | 'stop' | 'restart' | 'kill', fromConfirm = false) => {
    if (action === 'kill' && !fromConfirm) { setShowKillConfirm(true); return }
    if (fromConfirm) setShowKillConfirm(false)
    setPowerBusy(true)
    try {
      await powerAction(server.id, action)
      toast.ok(`${server.name}: ${action} triggered`)
      refresh()
      setTimeout(refresh, 1400)
    } catch (e: any) {
      toast.err(e?.message || `Failed to ${action}`)
    } finally {
      setPowerBusy(false)
    }
  }

  // Live lines are batched (flushed a few times/sec) so a rapid console burst
  // doesn't trigger a React re-render per line, and scrollback only evicts the
  // oldest lines once the cap is reached — nothing is dropped mid-stream.
  const queueRef = useRef<Line[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const linesRef = useRef<Line[]>([])

  const flushBatch = useCallback(() => {
    flushTimerRef.current = null
    if (!queueRef.current.length) return
    const batch = queueRef.current
    queueRef.current = []
    setLines((prev) => {
      const next = [...prev, ...batch]
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
    })
  }, [])

  const add = useCallback((l: { kind: 'out' | 'in' | 'sys'; text: string }) => {
    if (!alive.current) return
    const line: Line = { ...l, id: ++seq, ts: Date.now() }
    if (pausedRef.current) { pendingRef.current.push(line); return }
    queueRef.current.push(line)
    if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flushBatch, 120)
  }, [flushBatch])

  // Preload persisted console history so an open/refreshed console starts with
  // the recent scrollback instead of a blank feed (deduped against live lines).
  const loadHistory = useCallback(async () => {
    try {
      const d: any = await api.get(`/servers/${server.id}/terminal`)
      const hist = (d?.lines || []).map((l: any) => ({ kind: 'out' as const, text: String(l.text || ''), ts: Number(l.ts) || Date.now() }))
      if (!hist.length) return
      const seen = new Set<string>()
      const key = (l: { ts: number; text: string }) => `${l.ts}|${l.text}`
      for (const l of linesRef.current) seen.add(key(l))
      for (const l of queueRef.current) seen.add(key(l))
      const fresh = hist.filter((h: any) => !seen.has(`${h.ts}|${h.text}`)) as Line[]
      if (!fresh.length) return
      setLines((prev) => {
        const merged = [...prev]
        for (const h of fresh) {
          if (merged.some((m) => m.ts === h.ts && m.text === h.text)) continue
          merged.push(h)
        }
        return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged
      })
    } catch { /* history is best-effort */ }
  }, [server.id])

  useEffect(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    flushBatch()
  }, [paused, flushBatch])

  useEffect(() => {
    setLines((prev) => (prev.length > MAX_LINES ? prev.slice(-MAX_LINES) : prev))
    loadHistory()
  }, [loadHistory])

  useEffect(() => () => { if (flushTimerRef.current) clearTimeout(flushTimerRef.current) }, [])

  // Forget old console output: every 10 minutes the scrollback is pruned to
  // only the newest 20 messages so stale logs don't accumulate forever.
  useEffect(() => {
    const t = setInterval(() => {
      setLines((prev) => (prev.length > 20 ? prev.slice(-20) : prev))
    }, 10 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => { linesRef.current = lines }, [lines])

  // Fetch the server's startup command so the console can render a
  // Pterodactyl-style launch line ("java -Xms... -jar server.jar").
  useEffect(() => {
    api.get(`/servers/${server.id}/startup`).then((d: any) => {
      if (d?.startupCommand) setStartupCmd(d.startupCommand)
    }).catch(() => {})
  }, [server.id])

  useEffect(() => {
    const poll = () => api.get(`/servers/${server.id}/stats`).then((d: any) => { if (d?.stats) setLiveStats(d.stats) }).catch(() => {})
    poll()
    const t = setInterval(poll, 100)
    return () => clearInterval(t)
  }, [server.id])

  // Pterodactyl-style "Server marked as running..." banner emitted once the
  // backend reports the server running (and again after each start).
  const prevState = useRef(server.state)
  useEffect(() => {
    if (server.state === 'running' && prevState.current !== 'running') {
      add({ kind: 'sys', text: 'Server marked as running...' })
      if (startupCmd) add({ kind: 'in', text: `container@${server.role === 'admin' ? (server.node?.name || 'node') : 'instance'}~ ${startupCmd}` })
    }
    if (server.state === 'offline' && prevState.current !== 'offline') {
      add({ kind: 'sys', text: 'Server marked as offline.' })
    }
    prevState.current = server.state
  }, [server.state, startupCmd, add, server.node?.name])

  useEffect(() => {
    if (!paused && pendingRef.current.length) {
      const flush = pendingRef.current
      pendingRef.current = []
      setLines((prev) => [...prev, ...flush].length > MAX_LINES ? [...prev, ...flush].slice(-MAX_LINES) : [...prev, ...flush])
    }
  }, [paused])

  // Persist the console connection 24/7: on any close/error (server restart,
  // WS drop, node blip) auto-reconnect instead of staying "detached".
  const retryRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleReconnect = useCallback(() => {
    alive.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    // Exponential backoff: 1s, 2s, 4s, ... capped at 15s, reset once connected.
    const wait = Math.min(15000, 1000 * Math.pow(2, retryRef.current))
    retryRef.current = Math.min(retryRef.current + 1, 5)
    timerRef.current = setTimeout(() => connect(), wait)
  }, [])
  const connect = useCallback(() => {
    alive.current = true
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/server/${server.id}/console?token=${getToken()}`)
    wsRef.current = ws
    ws.onopen = () => { retryRef.current = 0; setAttached(true); setEulaPending(false); add({ kind: 'sys', text: 'Console attached' }) }
    ws.onmessage = (ev) => {
      const raw = String(ev.data)
      let msg: ConsoleMsg | null = null
      try { msg = JSON.parse(raw) as ConsoleMsg } catch { /* raw text */ }
      if (msg?.type === 'eula-required') { setEulaPending(true); return }
      if (msg?.type === 'eula-accepted') { setEulaPending(false); return }
      if (msg && msg.line) {
        const clean = msg.line.replace(/\u001b\[[0-9;]*m/g, '')
        const kind = msg.type === 'status' || msg.type === 'system' ? 'sys' : msg.type === 'input' ? 'in' : 'out'
        add({ kind, text: clean })
      } else {
        add({ kind: 'out', text: raw.replace(/\u001b\[[0-9;]*m/g, '') })
      }
    }
    ws.onclose = (e) => {
      setAttached(false)
      add({ kind: 'sys', text: e.code === 4009 ? 'Node unreachable — reconnecting' : 'Console detached — reconnecting' })
      // Only auto-retry while this component is mounted; still allow on-close
      // closes (e.g. manual reconnect) to trigger a fresh socket immediately.
      scheduleReconnect()
    }
    ws.onerror = () => { setAttached(false) }
    return ws
  }, [server.id, add, scheduleReconnect])

  useEffect(() => {
    const ws = connect()
    return () => { alive.current = false; if (timerRef.current) clearTimeout(timerRef.current); try { ws.close() } catch {} }
  }, [connect])

  const reconnect = () => {
    try { wsRef.current?.close() } catch {}
    retryRef.current = 0
    scheduleReconnect()
  }

  useEffect(() => {
    // Only follow the feed when auto-scroll is on AND the user is already at
    // the bottom. If they scrolled up to read earlier lines, stay put and show
    // the "↓ New logs" jump instead of yanking them back down.
    const b = boxRef.current
    if (b && autoScroll && atBottomRef.current) b.scrollTop = b.scrollHeight
  }, [lines, autoScroll])

  const onTermScroll = () => {
    const b = boxRef.current
    if (!b) return
    const near = b.scrollHeight - b.scrollTop - b.clientHeight < 60
    atBottomRef.current = near
    setShowJump(!near)
  }

  const jumpToBottom = () => {
    const b = boxRef.current
    if (b) b.scrollTop = b.scrollHeight
    atBottomRef.current = true
    setShowJump(false)
  }

  const sendCommand = (cmd?: string) => {
    const trimmed = (cmd ?? input).trim()
    if (!trimmed) return
    const ws = wsRef.current
    if (!ws) { add({ kind: 'sys', text: 'Console not connected — cannot send.' }); return }
    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED (numeric for
    // browsers that do not expose the WebSocket.* class constants).
    if (ws.readyState === 1) {
      add({ kind: 'in', text: `> ${trimmed}` })
      ws.send(JSON.stringify({ type: 'command', line: trimmed }))
      setHistory((prev) => [trimmed, ...prev].slice(0, 50))
      setHistIdx(-1)
      setInput('')
      return
    }
    if (ws.readyState === 0) {
      // Socket still establishing (common on slower mobile links). Wait for it
      // to open rather than silently dropping the command.
      add({ kind: 'sys', text: 'Connecting… sending command once attached' })
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'command', line: trimmed }))
        add({ kind: 'in', text: `> ${trimmed}` })
      }, { once: true })
      setHistory((prev) => [trimmed, ...prev].slice(0, 50))
      setHistIdx(-1)
      setInput('')
      return
    }
    add({ kind: 'sys', text: 'Console disconnected — cannot send.' })
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { sendCommand(); return }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistIdx((i) => {
        const next = i + 1
        if (next >= history.length) return i
        setInput(history[next])
        return next
      })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistIdx((i) => {
        const next = i - 1
        if (next < 0) { setInput(''); return -1 }
        setInput(history[next])
        return next
      })
    }
  }

  const setTermSize = (d: number) => {
    setFontSize((v) => {
      const n = Math.min(22, Math.max(10, v + d))
      localStorage.setItem('uh_term_size', String(n))
      return n
    })
  }

  const toggleFullscreen = () => {
    setFullscreen((f) => {
      const box = boxRef.current?.closest('.term-window') as HTMLElement | null
      if (!f) box?.requestFullscreen?.().catch(() => {})
      else document.exitFullscreen?.()
      return !f
    })
  }

  const visibleLines = searchQ.trim()
    ? lines.filter((l) => l.text.toLowerCase().includes(searchQ.trim().toLowerCase()))
    : lines

  const copyConsole = async () => {
    const text = lines.map((l) => l.text).join('\n')
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
  }
  const downloadConsole = () => {
    const text = lines.map((l) => new Date(l.ts).toLocaleTimeString() + ' | ' + l.text).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `${server.name}-console.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const running = server.state === 'running' || server.state === 'started' || server.state === 'restarting'
  const host = server.node?.host && server.role !== 'admin' ? maskHost(server.node?.host) : server.node?.host || server.node?.name || '—'
  const a0 = server.allocations?.[0]
  const address = a0 ? publicAddress(a0, server.node) || `${a0.alias || a0.ip || host}:${a0.port}` : host

  return (
    <div className="console-grid">
      {/* Terminal window frame (modern dark terminal: traffic lights + title) */}
      <div ref={winRef} className={`term-window ${fullscreen ? 'fs' : ''} ct-${termTheme}`} style={customH ? { height: customH, minHeight: customH, maxHeight: customH } : undefined}>
        <div className="term-titlebar">
          <div className="term-dots">
            <span className="td red" />
            <span className="td yellow" />
            <span className="td green" />
          </div>
          <div className="term-title mono">
            <Icon name="terminal" size={13} />
            <span className="xs">{server.name} — console</span>
          </div>
          <div style={{ flex: 1 }} />
          {showSearch && (
            <input ref={searchRef} className="input sm mono" value={searchQ}
              placeholder="Filter…" style={{ width: 150 }} autoFocus
              onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setShowSearch(false)} />
          )}
          <button className="btn ghost icon" onClick={() => { setShowSearch((v) => !v); setSearchQ('') }} title="Search / filter"><Icon name="search" size={16} /></button>
          <button className="btn ghost icon" onClick={() => setTermSize(-1)} title="Decrease font"><Icon name="x" size={13} /></button>
          <span className="xs text-3 mono" style={{ width: 26, textAlign: 'center' }}>{fontSize}</span>
          <button className="btn ghost icon" onClick={() => setTermSize(1)} title="Increase font"><Icon name="plus" size={13} /></button>
          <button className="btn ghost icon" onClick={toggleHeightLock} title={hLocked ? 'Unlock console height (drag to resize)' : 'Lock console height (fixed)'}>
            <Icon name={hLocked ? 'unlock' : 'lock'} size={15} />
          </button>
          <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            <button className="btn ghost icon" title="Console theme (text color + font)" onClick={() => setThemeOpen((v) => !v)}>
              <Icon name="palette" size={16} />
            </button>
            {themeOpen && (
              <div className="ct-theme-menu" role="menu">
                {CONSOLE_THEMES.map((t) => (
                  <button key={t.id} className={`ct-theme-item${termTheme === t.id ? ' active' : ''}`} onClick={() => pickTermTheme(t.id)}>
                    <span className="ct-theme-dot" style={{ background: t.color }} />
                    <span className="ct-theme-sample" style={{ color: t.color, fontFamily: t.font }}>{t.name}</span>
                    {termTheme === t.id && <Icon name="check" size={13} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="terminal" ref={boxRef} style={{ fontSize }} onScroll={onTermScroll}>
          {visibleLines.map((l) => (
            <LineView key={l.id} l={l} />
          ))}
          {searchQ.trim() && visibleLines.length === 0 && (
            <div className="term-line term-info"><span className="txt">No lines match filter.</span></div>
          )}
          <div className="term-line term-out"><span className="txt"><span className="term-cursor" /></span></div>
          {!searchQ.trim() && showJump && (
            <button className="term-jump" onClick={jumpToBottom}>↓ New logs</button>
          )}
        </div>

        <div className="term-inputbar" style={eulaPending ? { borderColor: 'var(--warning, #e5a50a)', boxShadow: '0 0 0 1px rgba(229,165,10,.35)' } : undefined}>
          <span className="term-prompt mono sm">{eulaPending ? '!' : '$'}</span>
          <input
            className="input mono flex-1"
            placeholder={eulaPending ? 'Type true to accept the Minecraft EULA and start the server' : (running ? 'Type a command and press Enter (e.g. list, say hello) · ↑/↓ history' : 'Start the server to send commands')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKey}
            disabled={!running && !eulaPending}
          />
          <button className="btn primary sm" onClick={() => sendCommand()} disabled={(!running && !eulaPending) || !input.trim()}>
            {eulaPending ? 'Accept EULA' : 'Send'}
          </button>
        </div>

        <div className="term-statusbar mono">
          <span className={`badge ${attached ? 'green' : 'gray'}`} style={{ padding: '1px 8px' }}>
            <span className={`dot ${attached ? 'pulse' : ''}`} />
            {attached ? (running ? 'Live' : 'Attached') : 'Disconnected'}
          </span>
          <span className="xs text-3"><Icon name="node" size={11} /> {host}</span>
          <span style={{ flex: 1 }} />
          <span className="xs text-3">uptime <b className="text-2">{running ? fmtUptime(server.startedAt) : 'offline'}</b></span>
          <span className="xs text-3">CPU <b className="text-2">{liveStats.cpuPercent != null ? `${(Math.round((liveStats.cpuPercent || 0) * 100) / 100).toFixed(2)}%` : '—'}</b> <span className="text-3">/ {server.cpuPercent}%</span></span>
          <span className="xs text-3">MEM <b className="text-2">{liveStats.memoryUsedMb != null ? `${Math.round(liveStats.memoryUsedMb)}MB` : '—'}</b> <span className="text-3">/ {server.memoryLimitMb}MB</span></span>
          <span className="badge gray mono xs">{server.id}</span>
        </div>
        {!hLocked && <div className="term-resizer" onMouseDown={onResizeStart} title="Drag to resize console height" />}
      </div>

      {/* Sidebar — buttons + stat blocks */}
      <div className="console-sidebar">
        <div style={{ display: 'grid', gap: 12 }}>
          {/* Server Power Controls */}
          <div className="sidebar-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            <button className="btn sm" disabled={powerBusy || running} onClick={() => runPowerAction('start')} title="Start"><Icon name="play" size={14} /> Start</button>
            <button className="btn sm" disabled={powerBusy || !running} onClick={() => runPowerAction('restart')} title="Restart"><Icon name="restart" size={14} /> Restart</button>
            <button className="btn sm" disabled={powerBusy || !running} onClick={() => runPowerAction('stop')} title="Stop"><Icon name="stop" size={14} /> Stop</button>
            <button className="btn sm danger" disabled={powerBusy || !running} onClick={() => runPowerAction('kill')} title="Kill"><Icon name="power" size={14} /> Kill</button>
            {showKillConfirm && (
              <div className="card subtle p-2" style={{ width: '100%', textAlign: 'center' }}>
                <div className="xs text-3 mb-2">Force kill <b>{server.name}</b>? Data loss possible.</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn sm danger" onClick={() => runPowerAction('kill', true)} disabled={powerBusy}>{powerBusy ? 'Killing…' : 'Kill server'}</button>
                  <button className="btn sm" onClick={() => setShowKillConfirm(false)} disabled={powerBusy}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* Console Actions */}
          <div className="sidebar-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            <button className="btn sm" onClick={reconnect} title="Reconnect"><Icon name="restart" size={14} /> Reconnect</button>
            <button className="btn sm" onClick={() => setLines([])} title="Clear"><Icon name="trash" size={14} /> Clear</button>
            <button className="btn sm" onClick={copyConsole} title="Copy"><Icon name="copy" size={14} /> Copy</button>
            <button className="btn sm" onClick={downloadConsole}><Icon name="download" size={14} /> Log</button>
            <button className="btn sm ghost" onClick={() => setPaused((v) => !v)} title={paused ? 'Resume' : 'Pause'}><Icon name={paused ? 'play' : 'stop'} size={14} /> {paused ? 'Resume' : 'Pause'}</button>
            <button className="btn sm ghost" onClick={() => setAutoScroll((v) => !v)} title={`Auto-scroll: ${autoScroll ? 'on' : 'off'}`}><Icon name="chevD" size={14} /> Scroll</button>
            <button className="btn sm ghost" onClick={toggleFullscreen} title="Fullscreen"><Icon name={fullscreen ? 'collapse' : 'expand'} size={14} /> FS</button>
          </div>

          <StatBlock
            icon="globe"
            label="Address"
            value={address}
            iconCls="cyan"
          />
          <StatBlock
            icon="clock"
            label="Uptime"
            value={running ? fmtUptime(server.startedAt) : 'Offline'}
            iconCls={running ? 'green' : 'amber'}
          />
          <StatBlock
            icon="cpu"
            label="CPU"
            value={liveStats.cpuPercent != null ? `${(Math.round((liveStats.cpuPercent || 0) * 100) / 100).toFixed(2)}%` : '—'}
            sub={`/ ${server.cpuPercent}% limit`}
            iconCls="cyan"
          />
          <StatBlock
            icon="down"
            label="Memory"
            value={liveStats.memoryUsedMb != null ? `${Math.round(liveStats.memoryUsedMb)} MB` : '—'}
            sub={`/ ${server.memoryLimitMb} MB limit`}
            iconCls="amber"
          />
          <StatBlock
            icon="box"
            label="Disk"
            value={`${server.storageGb} GB`}
            sub="limit"
            iconCls="blue"
          />
          <StatBlock
            icon="layers"
            label="Processes"
            value={liveStats.pids != null ? `${liveStats.pids}` : '—'}
            sub="container pids"
            iconCls="green"
          />
        </div>
      </div>

      {/* Charts row at bottom */}
      <div className="console-charts">
        <div className="chart-block">
          <div className="chart-block-header">
            <h3>CPU Usage</h3>
            <span className="sm text-3 mono">—</span>
          </div>
          <div className="chart-block-body center">
            <span className="text-3 sm">No data</span>
          </div>
        </div>
        <div className="chart-block">
          <div className="chart-block-header">
            <h3>Memory Usage</h3>
            <span className="sm text-3 mono">—</span>
          </div>
          <div className="chart-block-body center">
            <span className="text-3 sm">No data</span>
          </div>
        </div>
        <div className="chart-block">
          <div className="chart-block-header">
            <h3>Network I/O</h3>
            <span className="sm text-3 mono">—</span>
          </div>
          <div className="chart-block-body center">
            <span className="text-3 sm">No data</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatBlock({ icon, label, value, sub, iconCls }: { icon: any; label: string; value: string; sub?: string; iconCls: string }) {
  return (
    <div className="stat-block">
      <div className={`sb-icon ${iconCls}`}>
        <Icon name={icon} size={18} />
      </div>
      <div className="sb-text">
        <div className="sb-label">{label}</div>
        <div className="sb-value" style={{ fontSize: 15 }}>{value}</div>
        {sub && <div className="sb-sub">{sub}</div>}
      </div>
    </div>
  )
}

function LineView({ l }: { l: Line }) {
  if (l.kind === 'sys') {
    return (
      <div className="term-line term-info">
        <span className="txt">▸ {l.text}</span>
      </div>
    )
  }
  const cls = l.kind === 'in' ? 'term-command' : 'term-out'
  return (
    <div className={`term-line ${cls}`}>
      <span className="txt" dangerouslySetInnerHTML={{ __html: cachedHtml(l.id, l.text) }} />
    </div>
  )
}
