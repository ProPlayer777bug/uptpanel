import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'
import { Icon, Spinner, toast, ConfirmDialog } from '../../components/ui'
import type { Server } from '@uptimehost/types'

interface FEntry { name: string; path: string; isDir: boolean; size?: number }

export function FilesTab({ server }: { server: Server }) {
  const [cwd, setCwd] = useState('/')
  const [files, setFiles] = useState<FEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [openFile, setOpenFile] = useState<FEntry | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (path: string) => {
    setLoading(true); setErr('')
    try {
      const d = await api.get(`/servers/${server.id}/files?path=${encodeURIComponent(path)}`)
      const arr = (d.entries || []).map((f: any) => {
        const abs = path === '/' ? `/${f.name}` : `${path}/${f.name}`
        return { name: f.name, path: abs, isDir: !!f.dir, size: f.size }
      })
      setFiles(arr)
    } catch (e: any) { setErr(e?.message || 'Failed to list files'); setFiles([]) }
    finally { setLoading(false) }
  }, [server.id])

  useEffect(() => { load(cwd) }, [cwd, load])

  const createFile = async () => {
    const name = newName.trim()
    if (!name) return
    const path = cwd === '/' ? `/${name}` : `${cwd}/${name}`
    try {
      await api.post(`/servers/${server.id}/files/write`, { path, content: '' })
      toast.ok(`Created ${name}`)
      setNewName(''); setCreating(false); load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Failed to create file') }
  }

  const crumbs = cwd.split('/').filter(Boolean)

  return (
    <div className="card">
      <div className="card-h" style={{ gap: 6 }}>
        <button className="btn ghost icon sm" onClick={() => setCwd('/')} title="Root"><Icon name="folder" size={14} /></button>
        <button className="btn ghost icon sm" onClick={() => setCwd(parentOf(cwd))} disabled={cwd === '/'} title="Up"><Icon name="chevron" size={14} /></button>
        <div className="flex items-center gap-1 sm mono" style={{ overflow: 'hidden', flex: 1 }}>
          <a onClick={() => setCwd('/')} style={{ cursor: 'pointer' }}>/</a>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-3">/</span>
              <a onClick={() => setCwd('/' + crumbs.slice(0, i + 1).join('/'))} style={{ cursor: 'pointer', color: i === crumbs.length - 1 ? 'var(--text)' : 'var(--text-2)' }}>{c}</a>
            </span>
          ))}
        </div>
        <button className="btn sm ghost" onClick={() => setCreating((v) => !v)}><Icon name="plus" size={13} /> New</button>
        <button className="btn sm" onClick={() => load(cwd)}><Icon name="restart" size={13} /> Refresh</button>
      </div>

      {creating && (
        <div className="flex gap-2 items-center" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
          <input className="input sm mono flex-1" placeholder="file.txt" value={newName} autoFocus onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createFile()} />
          <button className="btn primary sm" onClick={createFile} disabled={!newName.trim()}>Create</button>
          <button className="btn sm ghost" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {openFile && <FileEditor server={server} path={openFile.path} onClose={() => setOpenFile(null)} onSaved={() => load(cwd)} />}

      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {loading ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
        : err ? <div className="empty"><h3>{err}</h3></div>
        : (
          <table className="dtable">
            <tbody>
              {files!.map((f) => (
                <tr key={f.path} onClick={() => f.isDir ? setCwd(f.path) : setOpenFile(f)}>
                  <td style={{ width: 30, paddingLeft: 16 }}><Icon name={f.isDir ? 'folder' : 'file'} size={15} className={f.isDir ? 'accent' : ''} /></td>
                  <td><span className="mono sm">{f.name}</span></td>
                  <td className="xs text-3" style={{ textAlign: 'right', width: 160, paddingRight: 16 }}>{f.isDir ? 'directory' : fmtSize(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !err && (files?.length ?? 0) === 0 && <div className="empty"><h3 className="sm">Empty directory</h3></div>}
      </div>
    </div>
  )
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

function FileEditor({ server, path, onClose, onSaved }: { server: Server; path: string; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.get(`/servers/${server.id}/files/content?path=${encodeURIComponent(path)}`)
      .then((d) => { setContent(d.content ?? ''); setSaveState('saved') })
      .catch((e: any) => toast.err(e?.message || 'Failed to read file'))
      .finally(() => setLoading(false))
  }, [server.id, path])

  useEffect(() => {
    if (saveState === 'dirty') {
      const f = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
      window.addEventListener('beforeunload', f)
      return () => window.removeEventListener('beforeunload', f)
    }
  }, [saveState])

  const save = async () => {
    setSaveState('saving')
    try {
      await api.post(`/servers/${server.id}/files/write`, { path, content })
      setSaveState('saved')
      toast.ok(`Saved ${path}`)
      onSaved()
    } catch (e: any) { setSaveState('error'); toast.err(e?.message || 'Failed to write file') }
  }

  const requestClose = () => {
    if (saveState === 'dirty') setConfirmClose(true)
    else onClose()
  }

  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      <div className="flex items-center gap-2" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <Icon name="file" size={14} />
        <span className="mono sm">{path}</span>
        <span className={`xs ${saveState === 'error' ? '' : 'text-3'}`} style={{ color: saveState === 'error' ? 'var(--danger)' : saveState === 'saving' ? 'var(--warn)' : saveState === 'dirty' ? 'var(--warn)' : undefined }}>
          {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved' : 'Save failed'}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={requestClose}>Close</button>
        <button className="btn sm primary" onClick={save} disabled={saveState === 'saving' || saveState === 'saved'}>{saveState === 'saving' ? 'Saving…' : 'Save'}</button>
      </div>
      {loading ? <div className="center" style={{ padding: 40 }}><Spinner size={20} /></div> : (
        <textarea
          className="input"
          aria-label={`Editor for ${path}`}
          style={{ width: '100%', minHeight: 420, fontFamily: 'var(--font-mono)', fontSize: 12.5, borderRadius: 0, border: 'none', background: 'var(--code-bg)', color: 'var(--text)', lineHeight: 1.7 }}
          spellCheck={false}
          value={content}
          onChange={(e) => { setContent(e.target.value); setSaveState((s) => (s === 'saved' ? 'dirty' : s)) }}
        />
      )}
      <ConfirmDialog
        open={confirmClose}
        title="Discard changes?"
        message={`You have unsaved changes in ${path}. Save before closing?`}
        confirmLabel="Discard"
        danger
        onClose={() => setConfirmClose(false)}
        onConfirm={() => { setConfirmClose(false); onClose() }}
      />
    </div>
  )
}

function parentOf(p: string) { if (p === '/' || !p) return '/'; const parts = p.split('/').filter(Boolean); parts.pop(); return parts.length ? '/' + parts.join('/') : '/' }
function fmtSize(n?: number) { if (n == null) return ''; if (n < 1024) return `${n}B`; if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`; return `${(n / 1048576).toFixed(1)}MB` }
