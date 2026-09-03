import { useApp } from '../state/auth'
import { useTheme } from '../theme/useTheme'
import { Icon } from '../components/ui'

export function Account() {
  const { user } = useApp()
  const { mode, applyMode } = useTheme()
  const u = user || { name: '', email: '', role: '', avatarHue: 0, createdAt: 0, id: '' }

  const roleColor: Record<string, string> = { owner: 'amber', admin: 'red', operator: 'blue', developer: 'cyan', viewer: 'gray' }

  return (
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
          </div>
        </div>
      </div>
    </div>
  )
}
