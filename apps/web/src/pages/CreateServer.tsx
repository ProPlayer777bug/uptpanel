import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBlueprints, useNodes, usePoll } from '../api/hooks'
import { api } from '../api/client'
import { Icon, Modal, Spinner, toast } from '../components/ui'
import { useApp } from '../state/auth'
import type { Blueprint, Node } from '@uptimehost/types'

type Step = 'name' | 'node' | 'memory' | 'disk' | 'cpu' | 'users'

const STEPS: { key: Step; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'node', label: 'Node' },
  { key: 'memory', label: 'Memory' },
  { key: 'disk', label: 'Disk' },
  { key: 'cpu', label: 'CPU' },
  { key: 'users', label: 'Users' },
]

const STEP_MOBILE_WIDTH = 280

export function CreateServer({ onClose }: { onClose: () => void }) {
  const { nodes } = useNodes()
  const { blueprints } = useBlueprints()
  const { refresh } = useApp()
  const navigate = useNavigate()
  const { data: mc } = usePoll<any>(async () => api.get('/mc/versions'), [], 600000)
  const { data: usersData, loading: usersLoading } = usePoll<{ users: any[] }>(async () => api.get('/users'), [], 60000)

  const online = useMemo(() => nodes.filter((n) => n.status === 'online'), [nodes])
  const [bpId, setBpId] = useState('')
  const [node, setNode] = useState<Node | null>(null)
  const [name, setName] = useState('')
  const [mem, setMem] = useState('')
  const [disk, setDisk] = useState('')
  const [cpuCores, setCpuCores] = useState('')
  const [step, setStep] = useState<Step>('name')
  const [busy, setBusy] = useState(false)
  const [userQuery, setUserQuery] = useState('')
  const [selectedUsers, setSelectedUsers] = useState<string[]>([])
  const [userRoles, setUserRoles] = useState<Record<string, string>>({})

  const users = usersData?.users ?? []

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) => u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q),
    )
  }, [users, userQuery])

  useEffect(() => {
    if (blueprints.length && !bpId) setBpId(blueprints[0].id)
    if (!node && online.length) setNode(online[0])
  }, [blueprints, online, node, bpId])

  const bp: Blueprint | undefined = blueprints.find((b) => b.id === bpId)
  const cpuPercent = Math.max(1, Math.round((Number(cpuCores) || 1) * 100))

  const canNext =
    step === 'name' ? name.trim().length > 0 :
    step === 'node' ? !!node && !!bpId :
    step === 'memory' ? (Number(mem) > 0 && (node?.overcommit || Number(mem) <= (node?.remainingMemoryMb ?? Number.MAX_SAFE_INTEGER))) :
    step === 'disk' ? (Number(disk) > 0 && Number(disk) <= (node?.remainingDiskGb ?? Number.MAX_SAFE_INTEGER)) :
    true

  const prev = () => {
    const i = STEPS.findIndex((s) => s.key === step)
    if (i > 0) setStep(STEPS[i - 1].key)
  }

  const next = () => {
    const i = STEPS.findIndex((s) => s.key === step)
    if (i < STEPS.length - 1) setStep(STEPS[i + 1].key)
    else create()
  }

  const create = async () => {
    if (!node || !bpId) return
    setBusy(true)
    try {
      const res = await api.post('/servers', {
        name: name || undefined,
        blueprintId: bpId,
        nodeId: node.id,
        memoryMb: Number(mem),
        cpuPercent,
        storageGb: Number(disk),
      })
      const serverId = res.server.id
      for (const email of selectedUsers) {
        await api.post(`/servers/${serverId}/access`, { email, role: userRoles[email] || 'viewer' })
      }
      toast.ok(selectedUsers.length ? `Server created — added ${selectedUsers.length} user${selectedUsers.length === 1 ? '' : 's'}` : 'Server created — provisioning')
      refresh()
      onClose()
      navigate(`/servers/${serverId}`)
    } catch (e: any) {
      toast.err(e?.message || 'Failed to create server')
    } finally {
      setBusy(false)
    }
  }

  const stepIdx = STEPS.findIndex((s) => s.key === step)

  return (
    <Modal open onClose={onClose} title="Create a server">
      <div className="wizard-steps mb-3">
        {STEPS.map((s, i) => (
          <div key={s.key} className={`wizard-step ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'active' : ''}`}>
            <span className="wizard-dot">{i < stepIdx ? '✓' : i + 1}</span>
            <span className="wizard-label">{s.label}</span>
          </div>
        ))}
      </div>

      {step === 'name' && (
        <div className="grid gap-3">
          <div className="field">
            <label>Display name</label>
            <input
              className="input"
              autoFocus
              placeholder="Give your server a name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && canNext) next() }}
            />
            <span className="xs text-3">This is the name your players will see. You can change it later in the server settings.</span>
          </div>
          {bp && (
            <div className="card subtle p-2">
              <div className="xs text-3">Template</div>
              <div className="cell-main">{bp.name}</div>
              <div className="cell-sub mono xs">{bp.image} · {bp.ports.length} port{bp.ports.length === 1 ? '' : 's'}</div>
            </div>
          )}
        </div>
      )}

      {step === 'node' && (
        <div className="grid gap-3">
          <div className="field">
            <label>Blueprint</label>
            <select className="select" value={bpId} onChange={(e) => setBpId(e.target.value)}>
              {blueprints.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.category}</option>)}
            </select>
            {bp && (
              <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
                <span className="badge gray mono">{bp.image}</span>
                <span className="badge blue">{bp.ports.length} port{bp.ports.length === 1 ? '' : 's'}</span>
                <span className="badge amber">Startup: {bp.startup}</span>
                {bp.mcCatalog && mc?.versions?.release && (
                  <span className="badge cyan" title="New servers deploy the latest release automatically.">
                    <Icon name="box" size={12} /> MC {mc.versions.release.id} · Java {mc.versions.defaultJava}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="field">
            <label>Node</label>
            {online.length === 0 ? (
              <span className="xs text-3">No online nodes available. Add a node to provision.</span>
            ) : (
              <div className="grid gap-2">
                {online.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`select-row ${node?.id === n.id ? 'selected' : ''}`}
                    onClick={() => setNode(n)}
                  >
                    <div style={{ flex: 1 }}>
                      <div className="cell-main">{n.name}</div>
                      <div className="cell-sub mono xs">{n.scheme}://{n.host}:{n.port}</div>
                    </div>
                    <div className="xs text-3" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <div>{n.remainingMemoryMb} MB free</div>
                      <div>{n.remainingDiskGb} GB free</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 'memory' && (
        <AllocField
          label="RAM allocation"
          unit="MB"
          value={mem}
          setValue={(v) => setMem(v)}
          remaining={node?.remainingMemoryMb ?? 0}
          overcommit={node?.overcommit}
          maxBuf={bp ? Math.min(node?.remainingMemoryMb ?? Number.MAX_SAFE_INTEGER, bp.recommendedMemoryMb) : node?.remainingMemoryMb ?? 0}
          placeholder={bp ? String(bp.recommendedMemoryMb) : '512'}
          help={`${node?.name ?? 'node'} has ${node?.remainingMemoryMb ?? 0} MB remaining after existing servers.`}
        />
      )}

      {step === 'disk' && (
        <AllocField
          label="Disk allocation"
          unit="GB"
          value={disk}
          setValue={(v) => setDisk(v)}
          remaining={node?.remainingDiskGb ?? 0}
          maxBuf={bp ? Math.min(node?.remainingDiskGb ?? Number.MAX_SAFE_INTEGER, bp.recommendedStorageGb) : node?.remainingDiskGb ?? 0}
          placeholder={bp ? String(bp.recommendedStorageGb) : '5'}
          help={`${node?.name ?? 'node'} has ${node?.remainingDiskGb ?? 0} GB remaining after existing servers.`}
        />
      )}

      {step === 'cpu' && (
        <>
          <div className="field">
            <label>CPU cores</label>
            <input
              className="input"
              type="number"
              min={1}
              step={1}
              placeholder={bp ? String(Math.max(1, Math.round(bp.recommendedCpu / 100))) : '1'}
              value={cpuCores}
              onChange={(e) => setCpuCores(e.target.value)}
            />
            <span className="xs text-3">1 core = 100% · 2 cores = 200%, etc. This server will be limited to {cpuPercent}%.</span>
          </div>
          <div className="card subtle p-2">
            <div className="xs text-3">Summary</div>
            <div className="cell-main">{name || (bp ? `${bp.name} Server` : 'Server')}</div>
            <div className="cell-sub mono xs">
              {node?.name} · {Number(mem) || 0} MB · {Number(disk) || 0} GB · {cpuCores ? `${cpuCores} core${Number(cpuCores) === 1 ? '' : 's'}` : '1 core'} ({cpuPercent}%)
            </div>
          </div>
        </>
      )}

      {step === 'users' && (
        <div className="grid gap-3">
          <div className="field">
            <label>Grant access to users</label>
            <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
              <input
                className="input flex-1"
                placeholder="Search by name or email…"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
              />
              <Icon name="search" size={16} className="text-3" />
            </div>
            <span className="xs text-3">Search existing users and add them to this server. You can invite new users later from the Access tab.</span>
          </div>

          {selectedUsers.length > 0 && (
            <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
              {selectedUsers.map((email) => {
                const u = users.find((x) => x.email === email)
                return (
                  <span key={email} className="badge blue" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {u?.name || email}
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
                      onClick={() => setSelectedUsers((s) => s.filter((e) => e !== email))}
                      title="Remove"
                    >×</button>
                  </span>
                )
              })}
            </div>
          )}

          <div style={{ maxHeight: 260, overflow: 'auto', borderRadius: 8, border: '1px solid var(--line)' }}>
            {usersLoading ? (
              <div className="center" style={{ padding: 24 }}><Spinner size={20} /></div>
            ) : filteredUsers.length === 0 ? (
              <div className="center xs text-3" style={{ padding: 24 }}>No users found. Create users from the Users page.</div>
            ) : (
              filteredUsers.map((u) => {
                const checked = selectedUsers.includes(u.email)
                return (
                  <div
                    key={u.email}
                    className="select-row"
                    onClick={() =>
                      setSelectedUsers((s) => (checked ? s.filter((e) => e !== u.email) : [...s, u.email]))
                    }
                  >
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <input type="checkbox" checked={checked} readOnly />
                      <div>
                        <div className="cell-main">{u.name}</div>
                        <div className="cell-sub xs">{u.email} · {u.role}</div>
                      </div>
                    </div>
                    {checked && (
                      <select
                        className="select sm"
                        style={{ width: 120 }}
                        value={userRoles[u.email] || 'viewer'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setUserRoles((r) => ({ ...r, [u.email]: e.target.value }))}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="developer">Developer</option>
                        <option value="operator">Operator</option>
                        <option value="admin">Admin</option>
                      </select>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      <div className="actions" style={{ marginTop: 20 }}>
        <button className="btn" onClick={() => (step === 'name' ? onClose() : prev())}>Back</button>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={next} disabled={busy || !canNext}>
          {busy ? <Spinner size={16} /> : (stepIdx === STEPS.length - 1 ? <><Icon name="plus" size={15} /> Create</> : 'Continue')}
        </button>
      </div>
    </Modal>
  )
}

function AllocField(props: {
  label: string
  unit: string
  value: string
  setValue: (v: string) => void
  remaining: number
  overcommit?: boolean
  maxBuf: number
  placeholder: string
  help: string
}) {
  const { label, unit, value, setValue, remaining, overcommit, maxBuf, placeholder, help } = props
  const num = Number(value) || 0
  const over = overcommit && num > remaining
  return (
    <div className="grid gap-3">
      <div className="field">
        <label>{label}</label>
        <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
          <input className="input flex-1" type="number" min={1} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
          <span className="xs">{unit}</span>
        </div>
        <span className="xs text-3">{help}</span>
        {over && <div className="xs" style={{ color: 'var(--danger)' }}>Exceeds remaining (overcommit is enabled on this node).</div>}
      </div>
      <div className="field">
        <label>Remaining on node</label>
        <div className="flex gap-2 items-center">
          <div className="bar flex-1"><div style={{ width: `${Math.min(100, (num / Math.max(1, remaining)) * 100)}%`, background: over ? 'var(--danger)' : 'var(--accent)' }} /></div>
          <span className="xs">{Math.min(num, remaining)} / {remaining} {unit}</span>
        </div>
      </div>
    </div>
  )
}

export function useCreateOpen() {
  const [open, setOpen] = useState(false)
  const el = useMemo(() => open && <CreateServer onClose={() => setOpen(false)} />, [open])
  return { open, setOpen, el }
}
