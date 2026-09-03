import { useState } from 'react'
import { powerAction } from '../../api/hooks'
import { useApp } from '../../state/auth'
import { Icon, Modal, toast } from '../../components/ui'
import type { Server } from '@uptimehost/types'

export function PowerControls({ server, compact }: { server: Server; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const { refresh } = useApp()
  const state = server.state

  const run = async (action: 'start' | 'stop' | 'restart' | 'kill', fromConfirm = false) => {
    if (action === 'kill' && !fromConfirm) { setConfirm(true); return }
    if (fromConfirm) setConfirm(false)
    setBusy(true)
    try {
      await powerAction(server.id, action)
      toast.ok(`${server.name}: ${action} triggered`)
      refresh()
      setTimeout(refresh, 1400)
    } catch (e: any) {
      toast.err(e?.message || `Failed to ${action}`)
    } finally {
      setBusy(false)
    }
  }

  if (compact) {
    return (
      <div className="flex gap-1" style={{ opacity: busy ? 0.6 : 1 }}>
        {state === 'offline' ? (
          <button className="btn sm subtle" disabled={busy} onClick={() => run('start')} title="Start"><Icon name="play" size={13} /> Start</button>
        ) : state === 'running' ? (
          <>
            <button className="btn sm ghost icon" disabled={busy} onClick={() => run('restart')} title="Restart"><Icon name="restart" size={13} /></button>
            <button className="btn sm ghost icon" disabled={busy} onClick={() => run('stop')} title="Stop"><Icon name="stop" size={13} /></button>
            <button className="btn sm ghost icon" disabled={busy} onClick={() => run('kill')} title="Kill"><Icon name="power" size={13} /></button>
          </>
        ) : <span className="xs text-3 nowrap">{state}</span>}
        {confirm && <KillConfirm server={server} onClose={() => setConfirm(false)} onConfirm={() => run('kill', true)} busy={busy} compact />}
      </div>
    )
  }

  return (
    <div className="flex gap-2" style={{ opacity: busy ? 0.6 : 1 }}>
      <button className="btn primary" disabled={busy || state === 'running'} onClick={() => run('start')}><Icon name="play" size={14} /> Start</button>
      <button className="btn" disabled={busy || state === 'offline'} onClick={() => run('restart')}><Icon name="restart" size={14} /> Restart</button>
      <button className="btn" disabled={busy || state === 'offline'} onClick={() => run('stop')}><Icon name="stop" size={14} /> Stop</button>
      <button className="btn danger" disabled={busy || state === 'offline'} onClick={() => run('kill')}><Icon name="power" size={14} /> Kill</button>
      {confirm && <KillConfirm server={server} onClose={() => setConfirm(false)} onConfirm={() => run('kill', true)} busy={busy} />}
    </div>
  )
}

function KillConfirm({ server, onClose, onConfirm, busy, compact }: { server: Server; onClose: () => void; onConfirm: () => void; busy: boolean; compact?: boolean }) {
  return (
    <Modal open onClose={onClose} title="Kill server?" width={420}>
      <p className="sm text-2">
        Forcefully kill <b>{server.name}</b>? This immediately terminates the process without a graceful shutdown and
        may cause data loss or corruption. Prefer <b>Stop</b> when possible.
      </p>
      <div className="actions" style={compact ? { position: 'relative' } : undefined}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" onClick={onConfirm} disabled={busy}>{busy ? 'Killing…' : 'Kill server'}</button>
      </div>
    </Modal>
  )
}
