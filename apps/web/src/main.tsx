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
// surfaces as dynamic-import fetch errors. Reload once so the (no-cache)
// index.html resolves the current chunks. The session flag prevents a loop if
// an error is real.
if (!sessionStorage.getItem('uh_chunk_check')) {
  sessionStorage.setItem('uh_chunk_check', '1')
  const isChunkFail = (e: unknown) => {
    const msg = String((e && (e as any).message) || (e && (e as any).name) || e || '')
    return /Failed to fetch dynamically imported module|ChunkLoadError|Importing a module script failed|Unexpected token|error loading dynamically imported module/i.test(msg)
  }
  const recover = () => {
    window.removeEventListener('error', onErr)
    window.removeEventListener('unhandledrejection', onRej)
    window.location.reload()
  }
  const onErr = (e: ErrorEvent) => { if (isChunkFail(e.error || e.message)) recover() }
  const onRej = (e: PromiseRejectionEvent) => { if (isChunkFail(e.reason)) recover() }
  window.addEventListener('error', onErr)
  window.addEventListener('unhandledrejection', onRej)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
)
