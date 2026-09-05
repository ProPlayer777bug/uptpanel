import { useEffect, useRef } from 'react'
import { useApp } from '../state/auth'
import { useTheme } from '../theme/useTheme'
import { usePalette, PALETTES } from '../theme/themes'
import { Icon } from '../components/ui'
import { ApiKeys } from '../components/ApiKeys'
import { AIBro } from '../components/AIBro'
import { Shell } from '../components/Shell'

export function Account({ focus }: { focus?: string }) {
  const { user } = useApp()
  const { mode, applyMode } = useTheme()
  const { palette, setPalette } = usePalette()
  const u = user || { name: '', email: '', role: '', avatarHue: 0, createdAt: 0, id: '' }
  const apiKeysRef = useRef<HTMLDivElement>(null)

  // When arriving at /account/api-keys, scroll the Application API keys card
  // into view so the nav item visibly "opens" the right section.
  useEffect(() => {
    if (focus === 'api-keys' && apiKeysRef.current) {
      apiKeysRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focus])

  const roleColor: Record<string, string> = { owner: 'amber', admin: 'red', operator: 'blue', developer: 'cyan', viewer: 'gray' }

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 900 }}>
        <div className="page-h"><h1>Account</h1><span className="sub">profile & preferences</span></div>

        <div className="grid cols-2">
          <div className="card">
            <div className="card-h"><Icon name="lock" size={15} /> Profile</div>
            <div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span className="avatar" style={{ width: 52, height: 52, fontSize: 20, background: `hsl(${u.avatarHue} 70% 55%)` }}>{(u.name?.[0] || '?').toUpperCase()}</span>
              <div>
                <div className="bold lg">{u.name}</div>
                <div className="text-2 sm">{u.email}</div>
                <div className="mt-1"><span className={`badge ${roleColor[u.role] || 'gray'}`}>{u.role}</span></div>
              </div>
            </div>
            <div className="card-b thin">
              <div className="info-row"><span className="k">Member since</span><span>{new Date(u.createdAt || Date.now()).toLocaleDateString()}</span></div>
              <div className="info-row"><span className="k">User ID</span><span className="mono xs">{u.id}</span></div>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><Icon name="gear" size={15} /> Preferences</div>
            <div className="card-b">
              <div className="field">
                <label>Theme</label>
                <div className="flex gap-2">
                  {(['dark', 'light', 'system'] as const).map((m) => (
                    <button key={m} className={`btn ${mode === m ? 'subtle' : 'ghost'}`} onClick={() => applyMode(m)}>{m}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Color theme</label>
                <div className="theme-grid">
                  {PALETTES.map((p) => (
                    <button
                      key={p.id}
                      className={`theme-swatch ${palette === p.id ? 'active' : ''}`}
                      title={p.name}
                      onClick={() => setPalette(p.id)}
                    >
                      <span className="sw-dot" style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.accent})` }} />
                      <span className="sw-name">{p.name}</span>
                      {palette === p.id && <span className="sw-check">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Application API — account-level keys to manage servers programmatically */}
        <div className="card" ref={apiKeysRef} style={{ marginTop: 0 }} id="application-api">
          <div className="card-h"><Icon name="key" size={15} /> Application API keys</div>
          <div className="card-b">
            <p className="sub" style={{ marginBottom: 12 }}>
              Account keys let your programs (e.g. a Discord bot) call the panel API to manage the servers you can access.
              Each server also has its own key — see a server's <b>API</b> tab for a key scoped to just that server.
            </p>
            <ApiKeys kind="account" />
          </div>
        </div>

        {/* AIBro — AI assistants with the user's own provider API keys */}
        <AIBro />
      </div>
    </Shell>
  )
}
