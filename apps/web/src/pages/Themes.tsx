import { useTheme } from '../theme/useTheme'
import { usePalette, PALETTES, type Palette } from '../theme/themes'
import { Shell } from '../components/Shell'

function ThemeCard({ p, active, onClick }: { p: Palette; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`theme-card ${active ? 'active' : ''}`}
      onClick={onClick}
      style={{ '--tc': p.primary, '--tc2': p.secondary, '--tc3': p.accent, '--tbg': p.background, '--ts': p.surface, '--tcard': p.card } as React.CSSProperties}
    >
      <div className="tc-preview">
        <div className="tc-bar" style={{ background: `linear-gradient(135deg, ${p.primary}, ${p.accent})` }} />
        <div className="tc-body" style={{ background: p.background }}>
          <div className="tc-surface" style={{ background: p.surface }}>
            <div className="tc-card" style={{ background: p.card }}>
              <div className="tc-text" style={{ color: p.text, background: p.primary, borderRadius: 4, padding: '3px 8px', fontSize: 10, fontWeight: 700 }}>Server</div>
              <div className="tc-text-muted" style={{ color: p.muted, fontSize: 9 }}>uptimehost.in:25565</div>
            </div>
            <div className="tc-card tc-card2" style={{ background: p.card }}>
              <div className="tc-dot" style={{ background: p.success }} />
              <div className="tc-text-sm" style={{ color: p.muted, fontSize: 9 }}>Running</div>
              <div className="tc-dot" style={{ background: p.danger }} />
            </div>
          </div>
        </div>
      </div>
      <div className="tc-name" style={{ color: active ? p.accent : undefined }}>{p.name}</div>
      {active && <div className="tc-active-dot" style={{ background: p.accent }} />}
    </button>
  )
}

export function Themes() {
  const { mode, applyMode } = useTheme()
  const { palette, setPalette } = usePalette()
  const current = PALETTES.find((p) => p.id === palette) || PALETTES[0]

  return (
    <Shell>
      <div className="page" style={{ maxWidth: 1040 }}>
        <div className="page-h">
          <h1>Themes</h1>
          <span className="sub">customize the panel look &amp; feel</span>
        </div>

        <div className="grid cols-2">
          {/* Mode card */}
          <div className="card">
            <div className="card-h">Display mode</div>
            <div className="card-b">
              <p className="sm text-2" style={{ marginBottom: 12 }}>Choose between dark and light mode, or follow your system preference.</p>
              <div className="flex gap-2">
                {(['dark', 'light', 'system'] as const).map((m) => (
                  <button key={m} className={`btn ${mode === m ? 'primary' : 'ghost'}`} onClick={() => applyMode(m)}>
                    {m === 'dark' ? '🌙' : m === 'light' ? '☀️' : '💻'} {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Current theme info */}
          <div className="card">
            <div className="card-h">Current theme</div>
            <div className="card-b" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="tc-dot-lg" style={{ width: 42, height: 42, borderRadius: 'var(--r-lg)', background: `linear-gradient(135deg, ${current.primary}, ${current.accent})`, boxShadow: `0 4px 14px ${current.primary}40` }} />
              <div>
                <div className="bold lg">{current.name}</div>
                <div className="sm text-2">
                  <span style={{ color: current.primary }}>●</span> Primary
                  {' '}
                  <span style={{ color: current.accent }}>●</span> Accent
                  {' '}
                  <span style={{ color: current.success }}>●</span> Success
                  {' '}
                  <span style={{ color: current.danger }}>●</span> Danger
                </div>
                <div className="xs text-3 mono" style={{ marginTop: 4 }}>{current.primary} / {current.background}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Theme grid */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-h">Color themes</div>
          <div className="card-b">
            <p className="sm text-2" style={{ marginBottom: 14 }}>Pick a color theme for the panel. All 20 themes are dark-mode palettes that recolor the entire UI instantly.</p>
            <div className="themes-grid">
              {PALETTES.map((p) => (
                <ThemeCard key={p.id} p={p} active={palette === p.id} onClick={() => setPalette(p.id)} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  )
}

export default Themes
