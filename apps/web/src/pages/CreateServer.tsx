import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBlueprints, useNodes } from '../api/hooks'
import { api } from '../api/client'
import { Icon, Modal, Spinner, toast } from '../components/ui'
import { useApp } from '../state/auth'
import type { Blueprint, Node } from '@uptimehost/types'

type Step = 'node' | 'memory' | 'disk' | 'cpu'

const STEPS: { key: Step; label: string }[] = [
  { key: 'node', label: 'Node' },
  { key: 'memory', label: 'Memory' },
  { key: 'disk', label: 'Disk' },
  { key: 'cpu', label: 'CPU' },
]

export function CreateServer({ onClose }: { onClose: () => void }) {
  const { nodes } = useNodes()
  const { blueprints } = useBlueprints()
  const { refresh } = useApp()
  const navigate = useNavigate()

  const online = useMemo(() => nodes.filter((n) => n.status === 'online'), [nodes])
  const [bpId, setBpId] = useState('')
  const [node, setNode] = useState<Node | null>(null)
  const [name, setName] = useState('')
  const [mem, setMem] = useState('')
  const [disk, setDisk] = useState('')
  const [cpuCores, setCpuCores] = useState('')
  const [step, setStep] = useState<Step>('node')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (blueprints.length && !bpId) setBpId(blueprints[0].id)
    if (!node && online.length) setNode(online[0])
  }, [blueprints, online, node, bpId])

  const bp: Blueprint | undefined = blueprints.find((b) => b.id === bpId)
  const cpuPercent = Math.max(1, Math.round((Number(cpuCores) || 1) * 100))

  const canNext =
    step === 'node' ? !!node && !!bpId :
    step === 'memory' ? (Number(mem) > 0 && (node?.overcommit || Number(mem) <= (node?.remainingMemoryMb ?? Number.MAX_SAFE_INTEGER))) :
    step === 'disk' ? (Number(disk) > 0 && Number(disk) <= (node?.remainingDiskGb ?? Number.MAX_SAFE_INTEGER)) :
    true

  const next = () => {
    const i = STEPS.findIndex((s) => s.key === step)
    if (i < STEPS.length - 1) setStep(STEPS[i + 1].key)
    else create()
  }

  const prev = () => {
    const i = STEPS.findIndex((s) => s.key === step)
    if (i > 0) setStep(STEPS[i - 1].key)
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
      toast.ok('Server created — provisioning')
      refresh()
      onClose()
      navigate(`/servers/${res.server.id}`)
    } catch (e: any) {
      toast.err(e?.message || 'Failed to create server')
    } finally {
      setBusy(false)
    }
  }

  const stepIdx = STEPS.findIndex((s) => s.key === step)

  return (
    <Modal open onClose={onClose} title="Create a server" width={620}>
      <div className="wizard-steps mb-3">
        {STEPS.map((s, i) => (
          <div key={s.key} className={`wizard-step ${i < stepIdx ? 'done' : ''} ${i === stepIdx ? 'active' : ''}`}>
            <span className="wizard-dot">{i < stepIdx ? '✓' : i + 1}</span>
            <span className="wizard-label">{s.label}</span>
          </div>
        ))}
      </div>

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

          <div className="field">
            <label>Display name</label>
            <input className="input" placeholder={bp ? `${bp.name} Server` : 'Server name'} value={name} onChange={(e) => setName(e.target.value)} />
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

      <div className="actions" style={{ marginTop: 20 }}>
        <button className="btn" onClick={() => (step === 'node' ? onClose() : prev())}>Back</button>
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
