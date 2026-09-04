import { useMemo, useState } from 'react'
import { useBlueprints } from '../api/hooks'
import { Shell } from '../components/Shell'
import { Icon } from '../components/ui'
import type { Blueprint } from '@uptimehost/types'

const CATEGORIES = ['All', 'Games', 'Applications', 'Databases', 'Proxies', 'Development']

export function Templates() {
  const { blueprints, loading } = useBlueprints()
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    let list = blueprints
    if (cat !== 'All') list = list.filter((b) => b.category.toLowerCase() === cat.toLowerCase())
    if (q.trim()) list = list.filter((b) => (b.name + ' ' + (b.image || '')).toLowerCase().includes(q.trim().toLowerCase()))
    return list
  }, [blueprints, cat, q])

  return (
    <Shell>
      <div className="page">
        <div className="anim-in">
          <div className="flex items-center gap-3 mb-4" style={{ flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600 }}>Templates</h1>
              <div className="sm text-3">Blueprint catalog for provisioning servers</div>
            </div>
            <div style={{ flex: 1 }} />
            <div className="search-box" style={{ width: 260 }}>
              <Icon name="search" size={14} />
              <input placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>

          <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
            {CATEGORIES.map((c) => (
              <button key={c} className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{c}</button>
            ))}
          </div>

          {loading && blueprints.length === 0 ? (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="card" style={{ height: 180 }} />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="card"><div className="empty"><h3>No templates</h3><p>No blueprints match your filter.</p></div></div>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
              {filtered.map((b) => <BlueprintCard key={b.id} bp={b} />)}
            </div>
          )}
        </div>
      </div>
    </Shell>
  )
}

function BlueprintCard({ bp }: { bp: Blueprint }) {
  return (
    <div className="card tpl-card">
      <div className="flex items-center gap-3">
        <span className="tpl-logo"><Icon name={bp.mcCatalog ? 'box' : 'layers'} size={18} /></span>
        <div>
          <div className="cell-main">{bp.name}</div>
          <span className="badge gray xs">{bp.category}</span>
        </div>
      </div>
      <div className="xs text-3 mono mt-2" style={{ wordBreak: 'break-all' }}>{bp.image}</div>
      <div className="flex gap-2 mt-3" style={{ flexWrap: 'wrap' }}>
        <span className="badge blue xs"><Icon name="cpu" size={11} /> {bp.recommendedCpu >= 100 ? `${bp.recommendedCpu / 100} cores` : `${bp.recommendedCpu}%`}</span>
        <span className="badge amber xs"><Icon name="chip" size={11} /> {bp.recommendedMemoryMb} MB</span>
        <span className="badge cyan xs"><Icon name="box" size={11} /> {bp.recommendedStorageGb} GB</span>
        <span className="badge gray xs">{bp.ports.length} port{bp.ports.length === 1 ? '' : 's'}</span>
      </div>
      <div className="xs text-3 mt-2" style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Startup: {bp.startup}</div>
    </div>
  )
}