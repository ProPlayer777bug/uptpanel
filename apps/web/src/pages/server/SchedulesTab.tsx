import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast, Modal } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface Task { id?: string; action: string; payload: string; sequenceId?: number }
interface Run { id: string; status: string; startedAt: number; finishedAt: number | null; output: string }
interface Schedule {
  id: string
  name: string
  cron: string
  isActive: boolean
  tasks: Task[]
  lastRunAt: number | null
  nextRunAt: number | null
  createdAt: number
  runs?: Run[]
}

const ACTIONS = ['command', 'start', 'stop', 'restart', 'backup']

export function SchedulesTab({ server }: { server: Server }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [cron, setCron] = useState('0 */6 * * *')
  const [tasks, setTasks] = useState<Task[]>([{ action: 'command', payload: '' }])
  const [viewId, setViewId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    api.get(`/servers/${server.id}/schedules`).then((d) => setSchedules(d.schedules)).catch((e: any) => toast.err(e?.message)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [server.id])

  const save = async () => {
    setBusy(true)
    try {
      await api.post(`/servers/${server.id}/schedules`, { name, cron, isActive: true, tasks })
      toast.ok('Schedule created')
      setOpen(false)
      setName(''); setCron('0 */6 * * *'); setTasks([{ action: 'command', payload: '' }])
      load()
    } catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const toggle = async (s: Schedule) => {
    await api.post(`/servers/${server.id}/schedules/${s.id}`, { isActive: !s.isActive })
    toast.ok(s.isActive ? 'Schedule paused' : 'Schedule enabled')
    load()
  }
  const runNow = async (s: Schedule) => {
    setBusy(true)
    try { await api.post(`/servers/${server.id}/schedules/${s.id}/run`, {}); toast.info('Schedule run kicked') }
    catch (e: any) { toast.err(e?.message) }
    finally { setBusy(false) }
  }
  const remove = async (s: Schedule) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return
    await api.del(`/servers/${server.id}/schedules/${s.id}`)
    toast.ok('Schedule deleted')
    load()
  }

  const updateTask = (i: number, patch: Partial<Task>) => {
    setTasks((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))
  }

  return (
    <div className="card">
      <div className="card-h">
        <Icon name="activity" size={15} /> Schedules <span className="h-sub">cron-triggered tasks</span>
        <div style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={() => setOpen(true)}><Icon name="plus" size={13} /> New schedule</button>
      </div>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {loading && schedules == null ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
        : !schedules || schedules.length === 0 ? (
          <div className="empty"><h3>No schedules</h3><p>Automate commands, power actions, and backups with cron schedules.</p></div>
        ) : schedules.map((s) => (
          <div key={s.id} className="row-item" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div className="flex items-center gap-2">
                <span className="cell-main">{s.name}</span>
                <span className="badge mono xs">{s.cron}</span>
                <span className={`badge ${s.isActive ? 'green' : 'gray'}`}>{s.isActive ? 'Active' : 'Paused'}</span>
              </div>
              <div className="sm text-3 mt-1">
                {s.tasks.map((t, i) => (
                  <span key={i} className="badge gray xs" style={{ marginRight: 4 }}>{t.action}{t.payload ? `: ${t.payload}` : ''}</span>
                ))}
              </div>
              <div className="xs text-3 mt-1">
                {s.lastRunAt ? `last run ${new Date(s.lastRunAt).toLocaleString()}` : 'never run'} · next {
                  s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'n/a'
                } · <a className="link" onClick={() => setViewId(viewId === s.id ? null : s.id)}>{(s.runs?.length || 0)} runs</a>
              </div>
              {viewId === s.id && (
                <div className="mt-2" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8 }}>
                  {(!s.runs || s.runs.length === 0) ? <span className="xs text-3">No runs yet.</span> : s.runs.map((r) => (
                    <div key={r.id} className="xs mono" style={{ borderBottom: '1px solid var(--line)', padding: '4px 0' }}>
                      <span className={`badge ${r.status === 'success' ? 'green' : r.status === 'running' ? 'blue' : 'red'} xs`}>{r.status}</span>{' '}
                      <span className="text-3">{new Date(r.startedAt).toLocaleString()}</span>
                      {r.output && <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{r.output}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-1">
              <button className="btn sm ghost" onClick={() => runNow(s)} disabled={busy}><Icon name="play" size={13} /> Run</button>
              <button className="btn sm ghost" onClick={() => toggle(s)}><Icon name="restart" size={13} /> {s.isActive ? 'Pause' : 'Enable'}</button>
              <button className="btn sm ghost" onClick={() => remove(s)}><Icon name="trash" size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New schedule" width={560}>
        <div className="form">
          <label>Name <input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly backup" /></label>
          <label>Cron expression <input className="inp mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="* * * * *" /></label>
          <div className="mt-2"><span className="sm text-3">Tasks (run in order)</span></div>
          {tasks.map((t, i) => (
            <div key={i} className="flex gap-2 panel-row mt-1" style={{ alignItems: 'center' }}>
              <select className="inp xs" style={{ width: 110 }} value={t.action} onChange={(e) => updateTask(i, { action: e.target.value, payload: '' })}>
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {t.action === 'command' ? (
                <input className="inp xs" style={{ flex: 1 }} value={t.payload} onChange={(e) => updateTask(i, { payload: e.target.value })} placeholder="command to run" />
              ) : (
                <span className="sm text-3" style={{ flex: 1 }}>{t.action === 'backup' ? 'creates a backup' : `power action: ${t.action}`}</span>
              )}
              <button className="btn sm ghost icon" onClick={() => setTasks((ts) => ts.filter((_, idx) => idx !== i))}><Icon name="trash" size={13} /></button>
            </div>
          ))}
          <button className="btn sm ghost mt-1" onClick={() => setTasks((ts) => [...ts, { action: 'command', payload: '' }])}><Icon name="plus" size={13} /> Add task</button>
        </div>
        <div className="flex gap-2 mt-3" style={{ justifyContent: 'flex-end' }}>
          <button className="btn sm ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn sm primary" onClick={save} disabled={busy || !name || !cron}>Create schedule</button>
        </div>
      </Modal>
    </div>
  )
}
