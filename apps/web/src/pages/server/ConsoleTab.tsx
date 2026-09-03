import { useEffect, useRef, useState, useCallback } from 'react'
import { Icon } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface Line { id: number; kind: 'out' | 'in' | 'sys'; text: string; ts: number }
interface ConsoleMsg { type: 'log' | 'input' | 'status' | 'system'; line: string }

let seq = 0

// Render Minecraft's legacy §-codes (and a few ANSI codes) into inline HTML so
// the live console looks like a real game-server terminal.
const MC: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA', '4': '#AA0000',
  '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA', '8': '#555555', '9': '#5555FF',
  a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
}
function renderMC(text: string): { html: string; plain: string } {
  let html = ''
  let plain = ''
  let color = 'inherit'
  const parts = text.split(/(§.)|(\u001b\[[0-9;]*m)/g)
  for (const p of parts) {
    if (!p) continue
    if (p.startsWith('§')) {
      const c = MC[p[1].toLowerCase()]
      if (p[1].toLowerCase() === 'l') { html += '<b>'; plain += ''; continue }
      if (p[1].toLowerCase() === 'r') { html += '</b>'; color = 'inherit'; continue }
      color = c ? MC[c] || 'inherit' : color
      if (c) { html += `<span style="color:${color}">`; continue }
      continue
    }
    if (p.startsWith('\u001b[')) { html += '</span>'; plain += ''; continue }
    html += escapeHtml(p)
    plain += p
  }
  return { html, plain }
}
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function ConsoleTab({ server }: { server: Server }) {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [attached, setAttached] = useState(false)
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const pendingRef = useRef<Line[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const lastMsgRef = useRef<ConsoleMsg | null>(null)

  const add = useCallback((l: { kind: 'out' | 'in' | 'sys'; text: string }) => {
    if (!alive.current) return
    const line: Line = { ...l, id: ++seq, ts: Date.now() }
    if (paused) { pendingRef.current.push(line); return }
    setLines((prev) => [...prev.slice(-500), line])
  }, [paused])

  // When paused we queue incoming output and flush it on resume so nothing is lost.
  useEffect(() => {
    if (!paused && pendingRef.current.length) {
      const flush = pendingRef.current
      pendingRef.current = []
      setLines((prev) => [...prev, ...flush].slice(-500))
    }
  }, [paused])

  const connect = useCallback(() => {
    alive.current = true
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/server/${server.id}/console`)
    wsRef.current = ws
    ws.onopen = () => { setAttached(true); add({ kind: 'sys', text: 'console attached' }) }
    ws.onmessage = (ev) => {
      const raw = String(ev.data)
      let msg: ConsoleMsg | null = null
      try { msg = JSON.parse(raw) as ConsoleMsg } catch { /* raw text */ }
      if (msg && msg.line) {
        lastMsgRef.current = msg
        const clean = msg.line.replace(/\u001b\[[0-9;]*m/g, '')
        const kind = msg.type === 'status' || msg.type === 'system' ? 'sys' : msg.type === 'input' ? 'in' : 'out'
        add({ kind, text: clean })
      } else {
        add({ kind: 'out', text: raw.replace(/\u001b\[[0-9;]*m/g, '') })
      }
    }
    ws.onclose = (e) => { setAttached(false); add({ kind: 'sys', text: e.code === 4009 ? 'node unreachable — retrying' : 'console detached' }) }
    ws.onerror = () => { setAttached(false) }
    return ws
  }, [server.id, add])

  useEffect(() => {
    const ws = connect()
    return () => { alive.current = false; try { ws.close() } catch {} }
  }, [connect])

  const reconnect = () => {
    try { wsRef.current?.close() } catch {}
    setLines([])
    alive.current = true
    connect()
  }

  useEffect(() => {
    const b = boxRef.current
    if (b && autoScroll) b.scrollTop = b.scrollHeight
  }, [lines, autoScroll])

  const sendCommand = () => {
    const cmd = input.trim()
    if (!cmd || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    add({ kind: 'in', text: `$ ${cmd}` })
    wsRef.current.send(JSON.stringify({ type: 'command', line: cmd }))
    setInput('')
  }

  const copyConsole = async () => {
    const text = lines.map((l) => l.text).join('\n')
    try { await navigator.clipboard.writeText(text); alert('Console copied') } catch { /* ignore */ }
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

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '68vh' }}>
      <div className="card-h">
        <Icon name="terminal" size={15} /> Console
        <span className={`badge ${attached ? 'green' : 'gray'}`}>
          <span className={`dot ${attached ? 'pulse' : ''}`} />{attached ? (running ? 'live' : 'attached (offline)') : 'disconnected'}
        </span>
        <span className={`badge ${paused ? 'amber' : 'gray'}`}><span className="dot" /> {paused ? 'paused' : 'streaming'}</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost icon" onClick={() => setAutoScroll((v) => !v)} title={`Auto-scroll: ${autoScroll ? 'on' : 'off'}`}>
          <Icon name="power" size={13} />
        </button>
        <button className="btn sm ghost icon" onClick={() => setPaused((v) => !v)} title={paused ? 'Resume output' : 'Pause output'}>
          <Icon name={paused ? 'play' : 'stop'} size={13} />
        </button>
        <button className="btn sm ghost icon" onClick={() => setLines([])} title="Clear console"><Icon name="trash" size={13} /></button>
        <button className="btn sm ghost icon" onClick={copyConsole} title="Copy console"><Icon name="download" size={13} /></button>
        <button className="btn sm ghost icon" onClick={reconnect} title="Reconnect"><Icon name="restart" size={13} /></button>
        <button className="btn sm" onClick={downloadConsole}><Icon name="download" size={13} /> Log</button>
      </div>

      <div className={`terminal flex-1 ${attached && running ? 'term-out' : ''}`} ref={boxRef} style={{ borderRadius: 0 }}>
        {lines.map((l) => (
          <LineView key={l.id} l={l} />
        ))}
        <div className="term-line term-out"><span className="txt"><span className="term-cursor" /></span></div>
      </div>

      <div className="card-b thin" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="flex gap-2">
          <Icon name="terminal" size={16} />
          <input
            className="input mono flex-1"
            placeholder={running ? 'Type a Minecraft command and press Enter…' : 'Start the server to send commands'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') sendCommand() }}
            disabled={!running}
          />
          <button className="btn primary sm" onClick={sendCommand} disabled={!running || !input.trim()}>Send</button>
        </div>
      </div>
    </div>
  )
}

function LineView({ l }: { l: Line }) {
  if (l.kind === 'sys') {
    return (
      <div className="term-line term-info">
        <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
        <span className="txt">▸ {l.text}</span>
      </div>
    )
  }
  const cls = l.kind === 'in' ? 'term-command' : 'term-out'
  return (
    <div className={`term-line ${cls}`}>
      <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
      <span className="txt" dangerouslySetInnerHTML={{ __html: renderMC(l.text).html }} />
    </div>
  )
}
