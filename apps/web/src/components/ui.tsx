import { Component, useEffect, useState, type ReactNode, type ButtonHTMLAttributes } from 'react'
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
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />,
  palette: <><path d="M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 0-4h-1.5a1.5 1.5 0 0 1 0-3H15a3 3 0 0 0 0-6h-.3a1 1 0 0 1 0-2H15a7 7 0 0 0-3-.6Z" /><circle cx="7.5" cy="10" r="1.4" /><circle cx="10" cy="6.5" r="1.4" /><circle cx="14" cy="6.3" r="1.4" /></>,
  database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" /><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></>,
  webhook: <><circle cx="6" cy="6" r="3" /><circle cx="18" cy="10" r="3" /><circle cx="9" cy="18" r="3" /><path d="M12 8 9 15" /></>,
  key: <><circle cx="7.5" cy="15.5" r="3.5" /><path d="M10.2 12.8 21 2M15 7l3 3M17 5l3 3" /></>,
  shieldCheck: <><path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
  warning: <><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.8 2.2c-.8.5-1.3 1-1.3 1.8v.5M12 17h.01" /></>,
  collapse: <><path d="m8 11 4-4 4 4M8 17l4-4 4 4" /></>,
  expand: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h6V3M21 15h-6v6" /></>,
  dots: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
  star: <path d="M12 3 5 12h5l-1 9 3-7 7-7h-5l3-4Z" />,
  upload: <><path d="M12 16V4m0 0 4 4m-4-4-4 4" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  request: <><path d="M2 12h5l2-3 4 6 2-3h7" /><path d="M2 8h20" /><path d="M2 16h20" /></>,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />,
  alert: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>,
  check: <path d="m5 13 4 4 10-10" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  phone: <path d="M5 3h4l2 5-2.5 1.5a13 13 0 0 0 6 6L17 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z" />,
  google: <><path fill="#4285F4" stroke="none" d="M22 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.6a4.5 4.5 0 0 1-2 3v2.5h3.2c1.9-1.7 3.2-4.3 3.2-7.4Z" /><path fill="#34A853" stroke="none" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" stroke="none" d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9l3.3-2.5Z" /><path fill="#EA4335" stroke="none" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6Z" /></>,
  github: <><path fill="currentColor" stroke="none" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.9-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .4 1 .2 1.9.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" /></>,
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

/* ============================================================
   Design-system primitives (P2)
   Reusable building blocks added here so new pages and the shell
   share one implementation instead of bespoke markup.
   ============================================================ */

type IconName = keyof typeof I

/* ---------- Button ---------- */
export function Button({
  variant = 'default', size = 'md', icon, loading = false,
  children, className = '', ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'subtle' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'xs'
  icon?: IconName
  loading?: boolean
}) {
  const cls = ['btn', variant, size, loading ? 'disabled' : '', className].join(' ').trim()
  return (
    <button className={cls} disabled={loading} {...rest}>
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  )
}

/* ---------- Tooltip (CSS-only, aria-labelled) ---------- */
export function Tooltip({ tip, children, side = 'top' }: { tip: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <span className={`tooltip-wrap ${side}`} tabIndex={0} aria-label={tip} data-tip={tip}>
      {children}
    </span>
  )
}

/* ---------- Skeleton ---------- */
export function Skeleton({ w = '100%', h = 14, r = 4, className = '' }: { w?: number | string; h?: number; r?: number; className?: string }) {
  return <span className={`skeleton ${className}`} style={{ width: w, height: h, borderRadius: r }} />
}

/* ---------- ErrorState ---------- */
export function ErrorState({ title = 'Something went wrong', detail, code, reason, hint, onRetry }: {
  title?: string; detail?: string; code?: string; reason?: string; hint?: string; onRetry?: () => void
}) {
  return (
    <div className="error-state">
      <div className="e-ico err"><Icon name="warning" size={26} /></div>
      <h3>{title}</h3>
      {reason && <p className="err-reason">{reason}</p>}
      {hint && <p className="err-hint">{hint}</p>}
      {code && <code className="err-code">{code}</code>}
      <div className="mt-3 flex items-center gap-2">
        {onRetry && <Button variant="subtle" icon="restart" onClick={onRetry}>Retry</Button>}
        {detail && <Button variant="ghost" onClick={() => alert(detail)}>View details</Button>}
      </div>
    </div>
  )
}

/* ---------- Progress (determinate / indeterminate) ---------- */
export function Progress({ value, tone = 'accent', indeterminate = false, className = '' }: {
  value?: number; tone?: 'accent' | 'success' | 'danger' | 'warning'; indeterminate?: boolean; className?: string
}) {
  return (
    <div className={`bar ${indeterminate ? 'bar-indet' : ''} ${className}`} role="progressbar" aria-valuenow={indeterminate ? undefined : value}>
      <div className={`bar-fill ${tone}`} style={indeterminate ? {} : { width: `${Math.max(0, Math.min(100, value || 0))}%` }} />
    </div>
  )
}

/* ---------- Switch ---------- */
export function Switch({ checked, onChange, label, disabled = false }: {
  checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean
}) {
  return (
    <label className={`switch ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      {label && <span className="switch-label">{label}</span>}
    </label>
  )
}

/* ---------- Menu / Dropdown ---------- */
export function Menu({ trigger, items, align = 'right' }: {
  trigger: ReactNode
  items: { label: string; icon?: IconName; danger?: boolean; onClick: () => void; hint?: string }[]
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDoc = () => setOpen(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', onDoc)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('click', onDoc) }
  }, [open])
  return (
    <div className="menu" onClick={(e) => e.stopPropagation()}>
      <span onClick={() => setOpen((o) => !o)}>{trigger}</span>
      {open && (
        <div className={`menu-drop ${align}`} role="menu">
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`}
              onClick={() => { setOpen(false); it.onClick() }}>
              {it.icon && <Icon name={it.icon} size={14} />}
              <span>{it.label}</span>
              {it.hint && <em className="menu-hint">{it.hint}</em>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- Breadcrumbs ---------- */
export function Breadcrumbs({ items }: { items: { label: string; to?: string; onClick?: () => void }[] }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <span key={i} className="crumb" aria-current={i === items.length - 1 ? 'page' : undefined}>
          {c.to ? <a href={c.to}>{c.label}</a> : c.onClick ? <a onClick={c.onClick}>{c.label}</a> : <span>{c.label}</span>}
          {i < items.length - 1 && <span className="crumb-sep">/</span>}
        </span>
      ))}
    </nav>
  )
}

/* ---------- ConfirmDialog ---------- */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger = false, requireType = false, busy = false }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: ReactNode
  confirmLabel?: string; danger?: boolean; requireType?: boolean; busy?: boolean
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => { if (!open) setTyped('') }, [open])
  const disabled = busy || (requireType && typed !== title)
  const confirmBtn = (
    <Button variant={danger ? 'danger' : 'primary'} icon={danger ? 'trash' : 'check'} loading={busy} disabled={disabled} onClick={onConfirm}>
      {confirmLabel}
    </Button>
  )
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="confirm-body">{message}</div>
      {requireType && (
        <div className="field mt-3">
          <label className="form-label">Type <code className="mono">{title}</code> to confirm</label>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={title} />
        </div>
      )}
      <div className="actions flex items-center justify-between mt-4">
        <div />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {confirmBtn}
        </div>
      </div>
    </Modal>
  )
}

/* ---------- Tabs ---------- */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: string; icon?: IconName; admin?: boolean }[]
  value: T; onChange: (t: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === value}
          className={`tab ${t.id === value ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon && <span className="ico"><Icon name={t.icon} size={14} /></span>}
          {t.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Error Boundary ---------- */
interface EBState { error: Error | null }
export class ErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="center" style={{ padding: 60, flexDirection: 'column', gap: 12 }}>
          <div className="brand-mark" style={{ width: 38, height: 38, fontSize: 17 }}>U</div>
          <p style={{ color: 'var(--text-2)', fontSize: 14 }}>Something went wrong.</p>
          <p className="sm text-3" style={{ maxWidth: 400, textAlign: 'center' }}>{this.state.error.message}</p>
          <button className="btn primary sm" onClick={() => { this.setState({ error: null }); window.location.reload() }}>Reload page</button>
        </div>
      )
    }
    return this.props.children
  }
}
