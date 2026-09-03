import { useState } from 'react'
import { useLocations, useNodes } from '../api/hooks'
import { api } from '../api/client'
import { useApp } from '../state/auth'
import { Icon, Modal, Spinner, toast } from '../components/ui'

export function Locations() {
  const { locations, loading, refetch } = useLocations()
  const { nodes } = useNodes()
  const { refresh } = useApp()
  const [create, setCreate] = useState(false)

  const del = async (id: string, name: string) => {
    if (!confirm(`Delete location "${name}"?`)) return
    try { await api.del(`/locations/${id}`); toast.ok('Location deleted'); refetch() }
    catch (e: any) {
      if (e?.data?.code === 'LOCATION_HAS_NODES') toast.err(`Location still has ${e.data.nodes} node(s)`)
      else toast.err(e?.message || 'Failed to delete')
    }
  }

  return (
    <div className="page">
      <div className="page-h">
        <h1>Locations</h1>
        <span className="sub">{locations.length} total</span>
        <div style={{ flex: 1 }} />
        <button className="btn primary sm" onClick={() => setCreate(true)}><Icon name="plus" size={14} /> Add location</button>
      </div>

      {loading ? (
        <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
      ) : locations.length === 0 ? (
        <div className="card"><div className="empty"><Icon name="map" size={24} className="accent" /><h3>No locations</h3><p>Locations group nodes by region. Create one to organise your infrastructure.</p><div className="mt-3"><button className="btn primary sm" onClick={() => setCreate(true)}><Icon name="plus" size={14} /> Add location</button></div></div></div>
      ) : (
        <div className="card anim-in">
          <table className="dtable">
            <thead><tr><th>Location</th><th>Code</th><th>Description</th><th>Nodes</th><th></th></tr></thead>
            <tbody>
              {locations.map((l) => {
                const count = nodes.filter((n) => n.locationId === l.id).length
                return (
                  <tr key={l.id}>
                    <td><div className="cell-main">{l.name}</div><div className="cell-sub mono xs">{l.id}</div></td>
                    <td><span className="badge gray mono">{l.shortCode}</span></td>
                    <td className="text-2">{l.description || '—'}</td>
                    <td><span className="badge cyan">{count}</span></td>
                    <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => del(l.id, l.name)}><Icon name="trash" size={13} /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {create && <CreateLocation onClose={() => { setCreate(false); refetch(); refresh() }} />}
    </div>
  )
}

function CreateLocation({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async () => {
    if (!name.trim()) { toast.err('Enter a name'); return }
    setBusy(true)
    try { await api.post('/locations', { name: name.trim(), shortCode: code.trim() || undefined, description: desc || undefined }); toast.ok('Location created'); onClose() }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title="Add location" width={460}>
      <div className="grid gap-3">
        <div className="field"><label>Name</label><input className="input" placeholder="Frankfurt" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Short code</label><input className="input mono" placeholder="FRA" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></div>
        <div className="field"><label>Description</label><textarea className="input" placeholder="Optional" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={add} disabled={busy}>{busy ? <Spinner size={16} /> : 'Create'}</button>
      </div>
    </Modal>
  )
}
