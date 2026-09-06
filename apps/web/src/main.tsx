import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppProvider } from './state/auth'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/themes.css'

// Apply the saved color palette to <html> before first paint so the chosen
// Minecraft theme is active immediately (the picker lives in Account settings).
document.documentElement.dataset.palette = localStorage.getItem('uh_palette2') || 'sakura'

// Recover from stale hashed-chunk failures after a redeploy: a browser can hold
// an old index.html that references asset hashes a newer build deleted, which
// surfaces as dynamic-import fetch errors. Reload so the (no-cache) index.html
// resolves the current chunks. Listeners stay armed for the whole session; the
// timestamp throttles at one auto-reload per 30s so a genuinely broken chunk
// can't loop forever.
const isChunkFail = (e: unknown) => {
  const msg = String((e && (e as any).message) || (e && (e as any).name) || e || '')
  return /Failed to fetch dynamically imported module|ChunkLoadError|Importing a module script failed|Unexpected token|error loading dynamically imported module/i.test(msg)
}
const STAMP_KEY = 'uh_chunk_reload_at'
const onChunkFail = () => {
  const last = Number(sessionStorage.getItem(STAMP_KEY) || 0)
  const now = Date.now()
  if (now - last < 30000) return
  sessionStorage.setItem(STAMP_KEY, String(now))
  window.location.reload()
}
window.addEventListener('error', (e: ErrorEvent) => { if (isChunkFail(e.error || e.message)) onChunkFail() })
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => { if (isChunkFail(e.reason)) onChunkFail() })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
)
