import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { Icon, Spinner, toast } from './ui'
import type { PanelBgConfig } from './PanelBackground'

const MAX_IMAGE = 15 * 1024 * 1024
const MAX_VIDEO = 28 * 1024 * 1024

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('Failed to read file'))
    r.readAsDataURL(file)
  })
}

// Checks media duration (used for live wallpaper: clips must be <= 10s).
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
  const [banner, setBanner] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    api.get('/settings/background').then((d) => {
      const bg = (d.background || null) as PanelBgConfig | null
      setCfg(bg)
      setMode(bg?.enabled ? bg.kind : 'off')
      setUrl(bg?.url || '')
      setDurationSec(bg?.durationSec || 5)
    }).catch((e: any) => toast.err(e?.message))
      .finally(() => setLoaded(true))
  }
  useEffect(() => { load() }, [])

  const pickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBanner('')
    const isVideo = mode === 'live'
    if (!isVideo && !file.type.startsWith('image/')) { setBanner('Please choose an image file (PNG, JPG, GIF, WEBP).'); return }
    if (isVideo && !file.type.startsWith('video/')) { setBanner('Please choose a video file (MP4, WEBM, MOV).'); return }
    if (file.size > (isVideo ? MAX_VIDEO : MAX_IMAGE)) {
      setBanner(`This file is too large (${(file.size / 1048576).toFixed(1)} MB). ${isVideo ? '28' : '15'} MB max.`)
      return
    }
    const dataUrl = await fileToDataUrl(file)
    if (isVideo) {
      try {
        const dur = await readVideoDuration(dataUrl)
        if (!Number.isFinite(dur) || dur <= 0) { setBanner('Could not read the video.'); return }
        if (dur > 10.5) {
          setBanner(`That video is ${dur.toFixed(1)}s long. Live wallpaper clips must be 10 seconds or shorter.`)
          return
        }
      } catch { setBanner('Could not read the video — try a shorter MP4/WEBM file.'); return }
    }
    setUrl(dataUrl)
    setBanner('File loaded — click Save to apply.')
  }

  const save = async () => {
    setLoading(true)
    setBanner('')
    try {
      const enabled = mode !== 'off'
      const res = await api.put('/settings/background', {
        background: { enabled, kind: mode || 'wallpaper', url: url.trim(), durationSec },
      })
      setCfg(res.background as PanelBgConfig)
      toast.ok(enabled ? 'Background applied to the whole panel' : 'Background removed')
      window.dispatchEvent(new Event('uh-bg-changed'))
    } catch (e: any) {
      setBanner(e?.message || 'Failed to save background')
      toast.err(e?.message || 'Failed to save background')
    } finally { setLoading(false) }
  }

  if (!loaded) return <div className="center" style={{ padding: 18 }}><Spinner size={18} /></div>

  const previewUrl = url
  return (
    <div className="card">
      <div className="card-h">
        <Icon name="image" size={15} /> Customize background <span className="h-sub">wallpaper or live wallpaper for the whole panel</span>
        {cfg?.enabled && <span className="badge cyan sm" style={{ marginLeft: 8 }}>active</span>}
        <div style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={save} disabled={loading}><Icon name="check" size={13} /> Save</button>
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
            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>{mode === 'wallpaper' ? 'Image URL' : 'Video URL'}</label>
                <input className="input mono xs" placeholder={mode === 'wallpaper' ? 'https://…/image.png or data:image/…' : 'https://…/clip.mp4 or data:video/…'} value={url} onChange={(e) => { setUrl(e.target.value); setBanner('') }} />
              </div>
              {mode === 'live' && (
                <div className="field">
                  <label>Duration (1–10s)</label>
                  <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
                    <input className="input" type="number" min={1} max={10} value={durationSec} onChange={(e) => setDurationSec(Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 5))))} />
                    <span className="xs">seconds</span>
                  </div>
                  <span className="xs text-3">Live clips are capped at 10 seconds.</span>
                </div>
              )}
            </div>

            <div className="flex mt-2" style={{ gap: 10, alignItems: 'center' }}>
              <button className="btn sm ghost" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={13} /> Upload {mode === 'wallpaper' ? 'image' : 'video'} file
              </button>
              <input ref={fileRef} type="file" accept={mode === 'wallpaper' ? 'image/*' : 'video/*'} style={{ display: 'none' }} onChange={pickFile} />
              <span className="xs text-3">{mode === 'wallpaper' ? 'PNG/JPG/GIF/WEBP, 15 MB max.' : 'MP4/WEBM, 10s max, 28 MB max.'}</span>
            </div>

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