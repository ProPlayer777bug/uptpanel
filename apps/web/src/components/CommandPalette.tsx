import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Icon } from './ui'
import { api } from '../api/client'
import type { Server } from '@uptimehost/types'

interface Item { key: string; group: string; label: string; sub?: string; icon: any; goto?: string; }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const [servers, setServers] = useState<Server[]>([])
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 20); api.get('/servers').then((d) => setServers(d.servers || [])).catch(() => {}) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    out.push({ key: 'nav-home', group: 'Navigate', label: 'Dashboard', icon: Icon({ name: 'home', size: 15 }), goto: '/' })
    out.push({ key: 'nav-servers', group: 'Navigate', label: 'Servers', icon: Icon({ name: 'server', size: 15 }), goto: '/servers' })
    out.push({ key: 'nav-nodes', group: 'Navigate', label: 'Nodes', icon: Icon({ name: 'node', size: 15 }), goto: '/nodes' })
    out.push({ key: 'nav-locations', group: 'Navigate', label: 'Locations', icon: Icon({ name: 'map', size: 15 }), goto: '/locations' })
    out.push({ key: 'nav-activity', group: 'Navigate', label: 'Activity', icon: Icon({ name: 'activity', size: 15 }), goto: '/activity' })
    out.push({ key: 'nav-account', group: 'Navigate', label: 'Account', icon: Icon({ name: 'gear', size: 15 }), goto: '/account' })
    servers.forEach((s) => out.push({
      key: `srv-${s.id}`, group: 'Servers', label: s.name,
      sub: `[${(s.state || '').toUpperCase()}]`, icon: Icon({ name: 'server', size: 15 }), goto: `/servers/${s.id}`,
    }))
    return out
  }, [servers])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return items
    return items.filter((i) => i.label.toLowerCase().includes(t) || i.group.toLowerCase().includes(t))
  }, [items, q])

  useEffect(() => { setIdx(0) }, [q])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && filtered[idx]) { e.preventDefault(); go(filtered[idx]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, idx])

  const go = (it: Item) => { onClose(); if (it.goto) navigate(it.goto) }

  if (!open) return null
  let lastGroup = ''
  return createPortal(
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={17} />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search servers, pages…" />
          <span className="kbd">ESC</span>
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matches for “{q}”</div>}
          {filtered.map((it, i) => {
            const groupHead = it.group !== lastGroup
            lastGroup = it.group
            return (
              <div key={it.key}>
                {groupHead && <div className="palette-group">{it.group}</div>}
                <div className={`palette-item ${i === idx ? 'active' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => go(it)}>
                  <span className="pi-ico">{it.icon}</span>
                  {it.label}
                  {it.sub && <span className="pi-sub">{it.sub}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
