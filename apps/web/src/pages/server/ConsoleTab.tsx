import { useEffect, useRef, useState, useCallback } from 'react'
import { Icon } from '../../components/ui'
import { api } from '../../api/client'
import { getToken } from '../../api/client'
import type { Server } from '@uptimehost/types'

interface Line { id: number; kind: 'out' | 'in' | 'sys'; text: string; ts: number }
interface ConsoleMsg { type: 'log' | 'input' | 'status' | 'system'; line: string }

let seq = 0

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
  const pendingRef = useRef<Line[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  // `paused` is read through a ref so the `add` callback keeps a stable identity
  // and the console websocket does NOT get torn down/reconnected just because the
  // pause flag changed (which used to drop focus-free reconnects on every toggle).
  const pausedRef = useRef(paused)
  useEffect(() => { pausedRef.current = paused }, [paused])

  const add = useCallback((l: { kind: 'out' | 'in' | 'sys'; text: string }) => {
    if (!alive.current) return
    const line: Line = { ...l, id: ++seq, ts: Date.now() }
    if (pausedRef.current) { pendingRef.current.push(line); return }
    setLines((prev) => [...prev.slice(-500), line])
  }, [])

  // Fetch the server's startup command so the console can render a
  // Pterodactyl-style launch line ("java -Xms... -jar server.jar").
  useEffect(() => {
    api.get(`/servers/${server.id}/startup`).then((d: any) => {
      if (d?.startupCommand) setStartupCmd(d.startupCommand)
    }).catch(() => {})
  }, [server.id])

  // Pterodactyl-style "Server marked as running..." banner emitted once the
  // backend reports the server running (and again after each start).
  const prevState = useRef(server.state)
  useEffect(() => {
    if (server.state === 'running' && prevState.current !== 'running') {
      add({ kind: 'sys', text: 'Server marked as running...' })
      if (startupCmd) add({ kind: 'in', text: `container@${server.node?.name || 'node'}~ ${startupCmd}` })
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
      setLines((prev) => [...prev, ...flush].slice(-500))
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
    ws.onopen = () => { retryRef.current = 0; setAttached(true); add({ kind: 'sys', text: 'Console attached' }) }
    ws.onmessage = (ev) => {
      const raw = String(ev.data)
      let msg: ConsoleMsg | null = null
      try { msg = JSON.parse(raw) as ConsoleMsg } catch { /* raw text */ }
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
    const b = boxRef.current
    if (b && autoScroll) b.scrollTop = b.scrollHeight
  }, [lines, autoScroll])

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

  const running = server.state === 'running'
  const host = server.node?.name || '—'
  const a0 = server.allocations?.[0]
  const address = a0 ? `${a0.alias || a0.ip || host}:${a0.port}` : host

  return (
    <div className="console-grid">
      {/* Terminal window frame (modern dark terminal: traffic lights + title) */}
      <div className={`term-window ${fullscreen ? 'fs' : ''}`}>
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
          <button className="btn sm ghost icon" onClick={() => { setShowSearch((v) => !v); setSearchQ('') }} title="Search / filter"><Icon name="search" size={13} /></button>
          <button className="btn sm ghost icon" onClick={() => setTermSize(-1)} title="Decrease font"><Icon name="x" size={11} /></button>
          <span className="xs text-3 mono" style={{ width: 22, textAlign: 'center' }}>{fontSize}</span>
          <button className="btn sm ghost icon" onClick={() => setTermSize(1)} title="Increase font"><Icon name="plus" size={11} /></button>
          <button className="btn sm ghost icon" onClick={() => setAutoScroll((v) => !v)} title={`Auto-scroll: ${autoScroll ? 'on' : 'off'}`}>
            <Icon name="chevD" size={13} />
          </button>
          <button className="btn sm ghost icon" onClick={() => setPaused((v) => !v)} title={paused ? 'Resume' : 'Pause'}>
            <Icon name={paused ? 'play' : 'stop'} size={13} />
          </button>
          <button className="btn sm ghost icon" onClick={() => setLines([])} title="Clear">
            <Icon name="trash" size={13} />
          </button>
          <button className="btn sm ghost icon" onClick={copyConsole} title="Copy">
            <Icon name="copy" size={13} />
          </button>
          <button className="btn sm ghost icon" onClick={reconnect} title="Reconnect">
            <Icon name="restart" size={13} />
          </button>
          <button className="btn sm ghost icon" onClick={toggleFullscreen} title="Fullscreen">
            <Icon name={fullscreen ? 'collapse' : 'expand'} size={13} />
          </button>
          <button className="btn sm" onClick={downloadConsole}>
            <Icon name="download" size={13} /> Log
          </button>
        </div>

        <div className="terminal" ref={boxRef} style={{ fontSize }}>
          {visibleLines.map((l) => (
            <LineView key={l.id} l={l} />
          ))}
          {searchQ.trim() && visibleLines.length === 0 && (
            <div className="term-line term-info"><span className="txt">No lines match filter.</span></div>
          )}
          <div className="term-line term-out"><span className="txt"><span className="term-cursor" /></span></div>
        </div>

        <div className="term-inputbar">
          <span className="term-prompt mono sm">$</span>
          <input
            className="input mono flex-1"
            placeholder={running ? 'Type a command and press Enter (e.g. list, say hello) · ↑/↓ history' : 'Start the server to send commands'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKey}
            disabled={!running}
          />
          <button className="btn primary sm" onClick={() => sendCommand()} disabled={!running || !input.trim()}>
            Send
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
          <span className="xs text-3">CPU <b className="text-2">{server.cpuPercent}%</b></span>
          <span className="xs text-3">MEM <b className="text-2">{server.memoryLimitMb}MB</b></span>
          <span className="badge gray mono xs">{server.id}</span>
        </div>
      </div>

      {/* Sidebar — stat blocks */}
      <div className="console-sidebar">
        <div style={{ display: 'grid', gap: 12 }}>
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
            value={`${server.cpuPercent}%`}
            sub="limit"
            iconCls="cyan"
          />
          <StatBlock
            icon="down"
            label="Memory"
            value={`${server.memoryLimitMb} MB`}
            sub="limit"
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
            value="—"
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
      <span className="txt" dangerouslySetInnerHTML={{ __html: renderMC(l.text).html }} />
    </div>
  )
}
