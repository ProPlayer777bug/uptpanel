import { useEffect, useRef, useState } from 'react'
import { api, uploadRaw } from '../api/client'
import { Icon, Spinner, toast } from './ui'
import type { PanelBgConfig } from './PanelBackground'

const MAX_IMAGE = 15 * 1024 * 1024
const MAX_VIDEO = 300 * 1024 * 1024

// Checks media duration (used for live wallpaper: clips must be <= 60s).
function readVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 10)
    v.onerror = () => reject(new Error('Could not read video'))
    v.src = url
  })
}

export function CustomizeBackground() {
  const [cfg, setCfg] = useState<PanelBgConfig | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'off' | 'wallpaper' | 'live'>(cfg?.enabled ? cfg.kind : 'off')
  const [url, setUrl] = useState('')
  const [durationSec, setDurationSec] = useState(5)
  const [screen, setScreen] = useState<'pc' | 'mobile' | 'both'>('both')
  const [banner, setBanner] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [objUrl, setObjUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    api.get('/settings/background').then((d) => {
      const bg = (d.background || null) as PanelBgConfig | null
      setCfg(bg)
      setMode(bg?.enabled ? bg.kind : 'off')
      setUrl(bg?.url || '')
      setDurationSec(bg?.durationSec || 5)
      setScreen((bg?.screen as 'pc' | 'mobile' | 'both') || 'both')
    }).catch((e: any) => toast.err(e?.message))
      .finally(() => setLoaded(true))
  }
  useEffect(() => { load() }, [])

  const dropFile = () => {
    setPendingFile(null)
    if (objUrl) { URL.revokeObjectURL(objUrl); setObjUrl('') }
  }

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBanner('')
    const isVideo = mode === 'live'
    if (!isVideo && !file.type.startsWith('image/')) { setBanner('Please choose an image file (PNG, JPG, GIF, WEBP).'); return }
    if (isVideo && !file.type.startsWith('video/')) { setBanner('Please choose a video file (MP4, WEBM, MOV).'); return }
    if (file.size > (isVideo ? MAX_VIDEO : MAX_IMAGE)) {
      setBanner(`This file is too large (${(file.size / 1048576).toFixed(1)} MB). ${isVideo ? '300' : '15'} MB max.`)
      return
    }
    const preview = URL.createObjectURL(file)
    if (isVideo) {
      try {
        const dur = await readVideoDuration(preview)
        if (!Number.isFinite(dur) || dur <= 0) { URL.revokeObjectURL(preview); setBanner('Could not read the video.'); return }
        if (dur > 60.5) {
          URL.revokeObjectURL(preview)
          setBanner(`That video is ${dur.toFixed(1)}s long. Live wallpaper clips must be 60 seconds or shorter.`)
          return
        }
      } catch { URL.revokeObjectURL(preview); setBanner('Could not read the video — try a shorter MP4/WEBM file.'); return }
    }
    if (pendingFile) dropFile()
    setPendingFile(file)
    setObjUrl(preview)
    setBanner('File ready — click Save to upload & apply.')
  }

  const save = async () => {
    setLoading(true)
    setBanner('')
    setProgress(0)
    try {
      const enabled = mode !== 'off'
      let finalUrl = url.trim()
      // Upload the picked file for real (raw bytes — never base64, so a 300MB
      // clip can't OOM the browser), then persist the returned media URL.
      if (enabled && pendingFile) {
        const up = await uploadRaw('/settings/background/upload', pendingFile, setProgress)
        finalUrl = up.url || finalUrl
        setUrl(finalUrl)
        dropFile()
      }
      const res = await api.put('/settings/background', {
        background: { enabled, kind: mode || 'wallpaper', url: finalUrl, durationSec, screen },
      })
      setCfg(res.background as PanelBgConfig)
      toast.ok(enabled ? 'Background applied to the whole panel' : 'Background removed')
      window.dispatchEvent(new Event('uh-bg-changed'))
    } catch (e: any) {
      setBanner(e?.message || 'Failed to save background')
      toast.err(e?.message || 'Failed to save background')
    } finally { setLoading(false) }
  }

  const restore = async () => {
    setLoading(true)
    setBanner('')
    try {
      await api.put('/settings/background', { background: { enabled: false, kind: 'wallpaper', url: '', durationSec: 5, screen: 'both' } })
      setCfg(null)
      setMode('off')
      setUrl('')
      setDurationSec(5)
      setScreen('both')
      dropFile()
      toast.ok('Restored the default panel background')
      window.dispatchEvent(new Event('uh-bg-changed'))
    } catch (e: any) {
      setBanner(e?.message || 'Failed to restore default background')
      toast.err(e?.message || 'Failed to restore default background')
    } finally { setLoading(false) }
  }

  if (!loaded) return <div className="center" style={{ padding: 18 }}><Spinner size={18} /></div>

  const previewUrl = objUrl || (cfg?.url ? url : '')
  return (
    <div className="card">
      <div className="card-h">
        <Icon name="image" size={15} /> Customize background <span className="h-sub">wallpaper or live wallpaper for the whole panel</span>
        {cfg?.enabled && <span className="badge cyan sm" style={{ marginLeft: 8 }}>active</span>}
        <div style={{ flex: 1 }} />
        {cfg?.enabled && (
          <button className="btn sm ghost" onClick={restore} disabled={loading} title="Remove the custom background and use the normal panel theme">
            <Icon name="restart" size={13} /> Restore default
          </button>
        )}
        <button className="btn sm primary" onClick={save} disabled={loading}>
          <Icon name="check" size={13} />
          {loading && pendingFile && progress < 100 ? `Uploading… ${progress}%` : pendingFile ? 'Upload & save' : 'Save'}
        </button>
      </div>
      <div className="card-b">
        <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
          <button className={`btn ${mode === 'off' ? 'subtle' : 'ghost'}`} onClick={() => { setMode('off'); setBanner('') }}>None</button>
          <button className={`btn ${mode === 'wallpaper' ? 'subtle' : 'ghost'}`} onClick={() => { setMode('wallpaper'); setBanner('') }}>Wallpaper</button>
          <button className={`btn ${mode === 'live' ? 'subtle' : 'ghost'}`} onClick={() => { setMode('live'); setBanner('') }}>Live wallpaper</button>
        </div>

        {mode === 'off' && (
          <p className="sub xs">The panel uses its normal theme background.</p>
        )}

        {(mode === 'wallpaper' || mode === 'live') && (
          <>
            <div className="grid panel-2" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>{mode === 'wallpaper' ? 'Image URL' : 'Video URL'}</label>
                <input className="input mono xs" placeholder={mode === 'wallpaper' ? 'https://…/image.png or data:image/…' : 'https://…/clip.mp4 or data:video/…'} value={url} onChange={(e) => { setUrl(e.target.value); setBanner('') }} />
              </div>
              {mode === 'live' && (
                <div className="field">
                  <label>Duration (1–60s)</label>
                  <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
                    <input className="input" type="number" min={1} max={60} value={durationSec} onChange={(e) => setDurationSec(Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 5))))} />
                    <span className="xs">seconds</span>
                  </div>
                  <span className="xs text-3">Live clips are capped at 60 seconds.</span>
                </div>
              )}
            </div>

            <div className="flex gap-1 mt-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="xs text-3" style={{ marginRight: 4 }}>Apply to:</span>
              <button className={`btn ${screen === 'both' ? 'subtle' : 'ghost'}`} onClick={() => setScreen('both')}>PC &amp; mobile</button>
              <button className={`btn ${screen === 'pc' ? 'subtle' : 'ghost'}`} onClick={() => setScreen('pc')}>PC only</button>
              <button className={`btn ${screen === 'mobile' ? 'subtle' : 'ghost'}`} onClick={() => setScreen('mobile')}>Mobile only</button>
              <span className="xs text-3">Which devices see this background.</span>
            </div>

            <div className="flex mt-2" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn sm ghost" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={13} /> {pendingFile ? 'Choose another file' : `Upload ${mode === 'wallpaper' ? 'image' : 'video'} file`}
              </button>
              <input ref={fileRef} type="file" accept={mode === 'wallpaper' ? 'image/*' : 'video/*'} style={{ display: 'none' }} onChange={pickFile} />
              {pendingFile ? (
                <span className="xs text-2 nowrap flex" style={{ gap: 6, alignItems: 'center' }}>
                  <Icon name="file" size={12} /> {pendingFile.name} ({(pendingFile.size / 1048576).toFixed(1)} MB)
                  <button className="btn sm ghost icon" onClick={dropFile} title="Remove selected file"><Icon name="x" size={12} /></button>
                </span>
              ) : (
                <span className="xs text-3">{mode === 'wallpaper' ? 'PNG/JPG/GIF/WEBP, 15 MB max.' : 'MP4/WEBM, 60s max, 300 MB max.'}</span>
              )}
            </div>

            {loading && progress > 0 && progress < 100 && (
              <div className="mt-2">
                <div className="bar" style={{ width: 240, maxWidth: '100%' }}><div className="bar-fill accent" style={{ width: `${progress}%` }} /></div>
                <span className="xs text-3 mt-1">Uploading… {progress}%</span>
              </div>
            )}

            {banner && <div className="xs mt-2" style={{ color: 'var(--danger)' }}>{banner}</div>}

            {previewUrl && (
              <div className="mt-3" style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', height: 180, position: 'relative' }}>
                {mode === 'live' ? (
                  <video src={previewUrl} muted autoPlay loop playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', background: `var(--bg) center/cover no-repeat url(${previewUrl})` }} />
                )}
                <div className="xs" style={{ position: 'absolute', bottom: 6, left: 8, background: 'rgba(0,0,0,.55)', padding: '2px 8px', borderRadius: 6 }}>preview</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}