import { useCallback, useEffect, useRef, useState } from 'react'
import { api, downloadBlob, uploadForm } from '../../api/client'
import { Icon, Spinner, toast, ConfirmDialog, Menu } from '../../components/ui'
import { useApp } from '../../state/auth'
import { VersionManager, PluginManager, isMcServer } from './VersionPluginModals'
import type { Server } from '@uptimehost/types'

interface FEntry { name: string; path: string; isDir: boolean; size?: number }

const FM_THEMES = [
  { id: 'gold', name: 'Gold', accent: '#fdc92f' },
  { id: 'midnight', name: 'Midnight', accent: '#58a6ff' },
  { id: 'amethyst', name: 'Amethyst', accent: '#a78bfa' },
  { id: 'emerald', name: 'Emerald', accent: '#34d399' },
  { id: 'ocean', name: 'Ocean', accent: '#22d3ee' },
  { id: 'crimson', name: 'Crimson', accent: '#f87171' },
  { id: 'rose', name: 'Rose', accent: '#f472b6' },
  { id: 'slate', name: 'Slate', accent: '#94a3b8' },
  { id: 'mint', name: 'Mint', accent: '#86efac' },
  { id: 'neon', name: 'Neon', accent: '#e879f9' },
]

export function FilesTab({ server }: { server: Server }) {
  const { refresh } = useApp()
  const [cwd, setCwd] = useState('/')
  const [files, setFiles] = useState<FEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [openFile, setOpenFile] = useState<FEntry | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renameTarget, setRenameTarget] = useState<FEntry | null>(null)
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null)
  const [fmTheme, setFmTheme] = useState(() => localStorage.getItem('uh_fm_theme') || '')
  const [themeOpen, setThemeOpen] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [javaOpen, setJavaOpen] = useState(false)
  const [javaBusy, setJavaBusy] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  const JAVA_VERSIONS = [8, 11, 16, 17, 21, 25]

  const changeJava = async (v: number) => {
    if (v === server.javaVersion) { setJavaOpen(false); return }
    setJavaBusy(true)
    try {
      await api.post(`/servers/${server.id}/java`, { version: v })
      toast.ok(`Java ${v} applied — server stopped, ready to start`)
      refresh()
    } catch (e: any) { toast.err(e?.message || 'Failed to change Java') }
    finally { setJavaBusy(false); setJavaOpen(false) }
  }

  useEffect(() => {
    if (!themeOpen && !javaOpen) return
    const onDoc = () => { setThemeOpen(false); setJavaOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setThemeOpen(false); setJavaOpen(false) } }
    document.addEventListener('click', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey) }
  }, [themeOpen, javaOpen])

  const pickFmTheme = (id: string) => {
    setFmTheme(id)
    if (id) localStorage.setItem('uh_fm_theme', id)
    else localStorage.removeItem('uh_fm_theme')
    setThemeOpen(false)
  }

  const load = useCallback(async (path: string) => {
    setLoading(true); setErr('')
    try {
      const d = await api.get(`/servers/${server.id}/files?path=${encodeURIComponent(path)}`)
      const arr = (d.entries || []).map((f: any) => {
        const abs = path === '/' ? `/${f.name}` : `${path}/${f.name}`
        return { name: f.name, path: abs, isDir: !!f.dir, size: f.size }
      })
      setFiles(arr)
      setSelected(new Set())
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

  const createFolder = async () => {
    const name = newName.trim()
    if (!name) return
    const path = cwd === '/' ? `/${name}` : `${cwd}/${name}`
    try {
      await api.post(`/servers/${server.id}/files/mkdir`, { path })
      toast.ok(`Created ${name}`)
      setNewName(''); setCreating(false); load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Failed to create folder') }
  }

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    setBusy(true)
    try {
      const form = new FormData()
      for (const f of Array.from(list)) form.append(f.name, f, f.name)
      const res = await uploadForm(`/servers/${server.id}/files/upload?path=${encodeURIComponent(cwd)}`, form)
      toast.ok(`Uploaded ${(res?.files?.length ?? list.length)} file(s)`)
      load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Upload failed') }
    finally { setBusy(false); if (uploadRef.current) uploadRef.current.value = '' }
  }

  const download = async (f: FEntry) => {
    if (f.isDir) { toast.err('Cannot download a directory'); return }
    try {
      await downloadBlob(`/servers/${server.id}/files/download?path=${encodeURIComponent(f.path)}`, f.name)
    } catch (e: any) { toast.err(e?.message || 'Download failed') }
  }

  const archive = async (f: FEntry) => {
    setBusy(true)
    try {
      const res = await api.post(`/servers/${server.id}/files/archive`, { path: f.path })
      toast.ok(`Zipped to ${res?.file ?? f.name + '.zip'}`)
      load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Archive failed') }
    finally { setBusy(false) }
  }

  const extract = async (f: FEntry) => {
    setBusy(true)
    try {
      await api.post(`/servers/${server.id}/files/archive/extract`, { path: f.path })
      toast.ok('Extracted')
      load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Extract failed') }
    finally { setBusy(false) }
  }

  const doDelete = async () => {
    if (!deleteTargets || deleteTargets.length === 0) return
    setBusy(true)
    const targets = [...deleteTargets]
    setDeleteTargets(null)
    try {
      for (const p of targets) {
        await api.post(`/servers/${server.id}/files/delete`, { path: p })
      }
      toast.ok(`Deleted ${targets.length} item(s)`)
      load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Delete failed') }
    finally { setBusy(false) }
  }

  const rename = async (to: string) => {
    if (!renameTarget) return
    const name = to.trim()
    if (!name || name === renameTarget.name) { setRenameTarget(null); return }
    const parent = renameTarget.path.slice(0, renameTarget.path.lastIndexOf('/'))
    const newPath = parent === '' ? `/${name}` : `${parent}/${name}`
    try {
      await api.post(`/servers/${server.id}/files/rename`, { from: renameTarget.path, to: newPath })
      toast.ok('Renamed')
      setRenameTarget(null)
      load(cwd)
    } catch (e: any) { toast.err(e?.message || 'Rename failed') }
  }

  const crumbs = cwd.split('/').filter(Boolean)
  const selCount = selected.size
  const allSelected = (files?.length ?? 0) > 0 && files!.every((f) => selected.has(f.path))

  const toggleAll = () => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set((files ?? []).map((f) => f.path)))
  }

  return (
    <div className={`card fm${fmTheme ? ` fm-t-${fmTheme}` : ''}`}>
      <div className="card-h fm-toolbar" style={{ gap: 6 }}>
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
        <input
          ref={uploadRef} type="file" multiple style={{ display: 'none' }}
          onChange={(e) => upload(e.target.files)}
        />
        <button className="btn sm ghost" disabled={busy} onClick={() => uploadRef.current?.click()}><Icon name="upload" size={13} /> Upload</button>
        <button className="btn sm ghost" onClick={() => { setCreating((v) => !v); setNewName('') }}><Icon name="folder" size={13} /> New</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => load(cwd)}><Icon name="restart" size={13} /> Refresh</button>
        {isMcServer(server) && (server.permissions?.files === true || server.permissions?.admin === true) && (
          <>
            <button className="btn sm ghost" onClick={() => setShowPlugins(true)}><Icon name="box" size={13} /> Plugins</button>
            <button className="btn sm ghost" onClick={() => setShowVersions(true)}><Icon name="activity" size={13} /> Version</button>
            <div style={{ position: 'relative' }} onClick={(e) => { e.stopPropagation(); setJavaOpen((v) => !v) }}>
              <button className={`btn sm ghost${javaBusy ? '' : ''}`} title="Java runtime this server boots with">
                {javaBusy ? <Spinner size={13} /> : <Icon name="chip" size={13} />} Java {server.javaVersion || '?'}
              </button>
              {javaOpen && (
                <div className="fm-theme-menu" role="menu" style={{ width: 160 }} onClick={(e) => e.stopPropagation()}>
                  {JAVA_VERSIONS.map((v) => (
                    <button key={v} className={`fm-theme-item${server.javaVersion === v ? ' active' : ''}`} onClick={() => changeJava(v)}>
                      <span>Java {v}</span>
                      {server.javaVersion === v && <Icon name="check" size={13} />}
                    </button>
                  ))}
                  <div className="xs text-3" style={{ padding: '6px 10px' }}>Restarts the server with the chosen JVM (stops a running server).</div>
                </div>
              )}
            </div>
          </>
        )}
        <button
          className={`btn sm ${selCount > 0 ? '' : 'ghost'}`}
          title={selCount > 0 ? `${selCount} selected — click to clear or use Delete below` : 'Mass select files'}
          onClick={() => selCount > 0 ? setSelected(new Set()) : toggleAll()}
        >
          <Icon name="check" size={13} /> {allSelected ? 'Deselect all' : selCount > 0 ? `${selCount} selected` : 'Select all'}
        </button>
        <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
          <button className={`btn sm ghost${fmTheme ? '' : ''}`} title="File manager theme" onClick={() => setThemeOpen((v) => !v)}>
            <Icon name="palette" size={13} /> {fmTheme ? FM_THEMES.find((t) => t.id === fmTheme)?.name ?? 'Theme' : 'Theme'}
          </button>
          {themeOpen && (
            <div className="fm-theme-menu" role="menu">
              {FM_THEMES.map((t) => (
                <button key={t.id} className={`fm-theme-item${fmTheme === t.id ? ' active' : ''}`} onClick={() => pickFmTheme(t.id)}>
                  <span className="fm-theme-dot" style={{ background: t.accent }} />
                  <span>{t.name}</span>
                  {fmTheme === t.id && <Icon name="check" size={13} />}
                </button>
              ))}
              <button className="fm-theme-item" onClick={() => pickFmTheme('')}>
                <span className="fm-theme-dot" style={{ background: 'repeating-conic-gradient(#8a8f98 0% 25%, #3a3f4a 0% 50%) 50% / 10px 10px' }} />
                <span>Default</span>
                {!fmTheme && <Icon name="check" size={13} />}
              </button>
            </div>
          )}
        </div>
      </div>

      {creating && (
        <div className="flex gap-2 items-center panel-row fm-create" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
          <input className="input sm mono flex-1" placeholder="name" value={newName} autoFocus onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createFile()} />
          <button className="btn primary sm" disabled={!newName.trim()} onClick={createFile}>Create file</button>
          <button className="btn sm ghost" disabled={!newName.trim()} onClick={createFolder}>Create folder</button>
          <button className="btn sm ghost" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {selCount > 0 && (
        <div className="flex gap-2 items-center fm-selbar" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-2)' }}>
          <span className="sm text-2">{selCount} selected</span>
          <div style={{ flex: 1 }} />
          <button className="btn sm ghost" disabled={busy} onClick={() => setDeleteTargets([...selected])}><Icon name="trash" size={13} /> Delete</button>
          <button className="btn sm ghost" disabled={busy || selCount !== 1} onClick={() => { const s = [...selected]; const f = files?.find((x) => x.path === s[0]); if (f) archive(f) }}><Icon name="download" size={13} /> Zip</button>
          <button className="btn sm ghost" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {openFile && <FileEditor server={server} path={openFile.path} onClose={() => setOpenFile(null)} onSaved={() => load(cwd)} />}
      {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} onConfirm={rename} />}

      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {loading ? <div className="center" style={{ padding: 50 }}><Spinner size={22} /></div>
        : err ? <div className="empty"><h3>{err}</h3></div>
        : (
          <table className="dtable">
            <tbody>
              {files!.map((f) => (
                <tr key={f.path} onClick={() => f.isDir ? setCwd(f.path) : setOpenFile(f)} style={{ cursor: 'pointer' }}>
                  <td style={{ width: 34, paddingLeft: 16 }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggleSelect(f.path)} />
                  </td>
                  <td style={{ width: 30 }}><Icon name={f.isDir ? 'folder' : 'file'} size={15} className={f.isDir ? 'accent' : ''} /></td>
                  <td><span className="mono sm">{f.name}</span></td>
                  <td className="xs text-3" style={{ textAlign: 'right', width: 120, paddingRight: 8 }}>{f.isDir ? 'directory' : fmtSize(f.size)}</td>
                  <td style={{ width: 40, paddingRight: 12 }} onClick={(e) => e.stopPropagation()}>
                    <Menu
                      align="right"
                      trigger={<button className="btn ghost icon sm"><Icon name="dots" size={14} /></button>}
                      items={[
                        ...(f.isDir ? [] : [{ label: 'Download', icon: 'download' as const, onClick: () => download(f) }]),
                        ...(f.name.toLowerCase().endsWith('.zip') ? [{ label: 'Extract', icon: 'box' as const, onClick: () => extract(f) }] : []),
                        { label: 'Zip', icon: 'download' as const, onClick: () => archive(f) },
                        { label: 'Rename', icon: 'copy' as const, onClick: () => setRenameTarget(f) },
                        { label: 'Delete', icon: 'trash' as const, danger: true, onClick: () => setDeleteTargets([f.path]) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !err && (files?.length ?? 0) === 0 && <div className="empty"><h3 className="sm">Empty directory</h3></div>}
      </div>

      <ConfirmDialog
        open={!!deleteTargets}
        title="Delete item(s)"
        message={`Delete ${deleteTargets?.length ?? 0} selected item(s)? This cannot be undone.`}
        confirmLabel={`Delete ${deleteTargets?.length ?? 0}`}
        danger
        busy={busy}
        onClose={() => setDeleteTargets(null)}
        onConfirm={doDelete}
      />

      <VersionManager server={server} open={showVersions} onClose={() => setShowVersions(false)} />
      <PluginManager server={server} open={showPlugins} onClose={() => setShowPlugins(false)} />
    </div>
  )
}

function RenameDialog({ target, onClose, onConfirm }: { target: FEntry; onClose: () => void; onConfirm: (to: string) => void }) {
  const [value, setValue] = useState(target.name)
  return (
    <div className="flex gap-2 panel-row items-center" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
      <Icon name="copy" size={14} />
      <input className="input sm mono flex-1" value={value} autoFocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(value); if (e.key === 'Escape') onClose() }} />
      <button className="btn primary sm" onClick={() => onConfirm(value)}>Rename</button>
      <button className="btn sm ghost" onClick={onClose}>Cancel</button>
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
      <div className="flex panel-row items-center gap-2" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
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
