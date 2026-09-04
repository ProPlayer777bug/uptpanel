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
document.documentElement.dataset.palette = localStorage.getItem('uh_palette') || 'ender-purple'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
)
