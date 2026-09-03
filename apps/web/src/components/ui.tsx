import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/* ---------- Spinner ---------- */
export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="spin"
      style={{
        width: size, height: size, display: 'inline-block',
        borderRadius: '50%', border: '2px solid var(--line-strong)',
        borderTopColor: 'var(--accent)', animation: 'rt 0.7s linear infinite',
      }}
    />
  )
}

/* ---------- Status pill ---------- */
const STATE_MAP: Record<string, { label: string; cls: string }> = {
  running: { label: 'Running', cls: 'green' },
  offline: { label: 'Offline', cls: 'gray' },
  starting: { label: 'Starting', cls: 'blue' },
  stopping: { label: 'Stopping', cls: 'amber' },
  restarting: { label: 'Restarting', cls: 'amber' },
  killing: { label: 'Killing', cls: 'red' },
  provisioning: { label: 'Provisioning', cls: 'blue' },
  error: { label: 'Error', cls: 'red' },
}
export function StatePill({ state, pulse }: { state: string; pulse?: boolean }) {
  const m = STATE_MAP[state] || { label: state, cls: 'gray' }
  return (
    <span className={`badge ${m.cls}`}>
      <span className={`dot ${pulse && state === 'running' ? 'pulse' : ''}`} />
      {m.label}
    </span>
  )
}

/* ---------- Activity map ---------- */
export function SevBadge({ sev }: { sev: string }) {
  const m: Record<string, [string, string]> = {
    info: ['blue', 'Info'], warn: ['amber', 'Warning'], error: ['red', 'Error'],
    healthy: ['green', 'Healthy'], attention: ['amber', 'Attention'],
  }
  const [cls, label] = m[sev] || ['gray', sev]
  return <span className={`badge ${cls}`}>{label}</span>
}

/* ---------- Icon set (custom, no emoji) ---------- */
const I = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z" />,
  server: <><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></>,
  node: <><rect x="2" y="6" width="20" height="12" rx="3" /><path d="M8 12h8" /></>,
  map: <><circle cx="12" cy="12" r="3" /><path d="M12 2a10 10 0 1 0 10 10" /></>,
  activity: <path d="M4 12h4l3 8 4-16 3 8h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  power: <><path d="M12 3v8" /><path d="M6.3 6.5a8 8 0 1 0 11.4 0" /></>,
  play: <path d="M6 4l14 8-14 8V4z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  restart: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
  file: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4" /></>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />,
  snap: <><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
  chev: <path d="m9 6 6 6-6 6" />,
  chevD: <path d="m6 9 6 6 6-6" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  bell: <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  download: <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="10" y="10" width="4" height="4" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
  down: <><rect x="3" y="8" width="14" height="10" rx="2" /><path d="m3 13 7-4 7 4" /></>,
  chip: <><path d="M6 3v3M18 3v3M6 18v3M18 18v3M3 6h3M3 18h3M18 6h3M18 18h3" /><rect x="7" y="7" width="10" height="10" rx="2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></>,
  shield: <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  box: <><path d="m12 3 8 4v10l-8 4-8-4V7l8-4Z" /><path d="m4 7 8 4 8-4M12 11v10" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m6 20 5-5 3 3 4-4 3 3" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
  refresh: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M21 12a9 9 0 0 0-3 6.7" /></>,
}

export function Icon({ name, size = 16, className }: { name: keyof typeof I; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {I[name]}
    </svg>
  )
}

/* ---------- Modal ---------- */
export function Modal({ open, onClose, title, children, width = 520 }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <span className="bold">{title}</span>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><Icon name="plus" /> </button>
        </div>
        <div className="modal-b">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/* ---------- Empty state ---------- */
export function EmptyState({ icon, title, desc, action }: { icon: keyof typeof I; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="e-ico"><Icon name={icon} size={26} /></div>
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/* ---------- Toast system ---------- */
interface Toast { id: number; kind: 'ok' | 'err' | 'info'; msg: string }
let toasts: Toast[] = []
const listeners = new Set<() => void>()
let nid = 0
function push(kind: Toast['kind'], msg: string) {
  const t = { id: ++nid, kind, msg }
  toasts = [...toasts, t]
  listeners.forEach((l) => l())
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); listeners.forEach((l) => l()) }, 4000)
}
export const toast = {
  ok: (m: string) => push('ok', m),
  err: (m: string) => push('err', m),
  info: (m: string) => push('info', m),
}

export function ToastHost() {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
      ))}
    </div>
  )
}
