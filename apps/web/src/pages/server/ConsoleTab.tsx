import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface Line { id: number; kind: 'out' | 'in' | 'sys'; text: string; ts: number }
interface ConsoleMsg { type: 'log' | 'input' | 'status'; line: string }

let seq = 0

export function ConsoleTab({ server }: { server: Server }) {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [attached, setAttached] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/server/${server.id}/console`)
    wsRef.current = ws
    ws.onopen = () => { setAttached(true); add({ kind: 'sys', text: 'console attached' }) }
    ws.onmessage = (ev) => {
      const raw = String(ev.data)
      try {
        const msg = JSON.parse(raw) as ConsoleMsg
        if (msg && msg.line) {
          const kind = msg.type === 'status' ? 'sys' : msg.type === 'input' ? 'in' : 'out'
          add({ kind, text: msg.line.replace(/\u001b\[[0-9;]*m/g, '') })
        }
      } catch {
        add({ kind: 'out', text: raw.replace(/\u001b\[[0-9;]*m/g, '') })
      }
    }
    ws.onclose = (e) => { setAttached(false); add({ kind: 'sys', text: e.code === 4009 ? 'node unreachable' : 'console detached' }) }
    return () => { alive.current = false; try { ws.close() } catch {} }
  }, [server.id])

  const add = (l: { kind: 'out' | 'in' | 'sys'; text: string }) => {
    if (!alive.current) return
    setLines((prev) => [...prev.slice(-500), { ...l, id: ++seq, ts: Date.now() }])
  }

  useEffect(() => { const b = boxRef.current; if (b) b.scrollTop = b.scrollHeight }, [lines])

  const sendCommand = () => {
    const cmd = input.trim()
    if (!cmd || !wsRef.current) return
    add({ kind: 'in', text: `$ ${cmd}` })
    wsRef.current.send(JSON.stringify({ type: 'command', line: cmd }))
    setInput('')
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: '62vh' }}>
      <div className="card-h">
        <Icon name="terminal" size={15} /> Console
        <span className={`badge ${attached ? 'green' : 'gray'}`}><span className={`dot ${attached ? 'pulse' : ''}`} />{attached ? 'attached' : 'disconnected'}</span>
      </div>
      <div className={`terminal flex-1 ${attached ? 'term-out' : ''}`} ref={boxRef} style={{ borderRadius: 0 }}>
        {lines.map((l) => (
          <div key={l.id} className={`term-line term-${l.kind}`}>
            <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
            <span className="txt">{l.text}</span>
          </div>
        ))}
        <div className="term-line term-out"><span className="txt"><span className="term-cursor" /></span></div>
      </div>
      <div className="card-b thin" style={{ borderTop: '1px solid var(--line)' }}>
        <form onSubmit={(e) => { e.preventDefault(); sendCommand() }} className="flex gap-2">
          <Icon name="terminal" size={16} />
          <input
            className="input mono flex-1"
            placeholder={server.state === 'running' ? 'Type a command and press Enter…' : 'Start the server to send commands'}
            value={input} onChange={(e) => setInput(e.target.value)} disabled={server.state !== 'running'}
          />
          <button className="btn primary sm" disabled={server.state !== 'running' || !input.trim()}><Icon name="play" size={13} /> Send</button>
        </form>
      </div>
    </div>
  )
}
