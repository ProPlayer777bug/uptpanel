import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { Icon, Spinner, toast } from './ui'

interface AIBroKeyView { id: string; label: string; masked: string; createdAt: number }
interface AIBroProviderView { id: string; label: string; maxKeys: number; keyCount: number }
interface ChatMsg { from: 'user' | 'aibro'; text: string; provider?: string }
interface AIBroServerView { id: string; name: string; state: string; selected: boolean }

export function AIBro() {
  const [providers, setProviders] = useState<AIBroProviderView[]>([])
  const [keyGroups, setKeyGroups] = useState<{ provider: string; keys: AIBroKeyView[] }[]>([])
  const [loading, setLoading] = useState(true)

  // Server scope
  const [servers, setServers] = useState<AIBroServerView[]>([])
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const [selLoaded, setSelLoaded] = useState(false)

  // Add-mode fields
  const [addFor, setAddFor] = useState<string>('')
  const [addLabel, setAddLabel] = useState('')
  const [addKey, setAddKey] = useState('')
  const [adding, setAdding] = useState(false)

  // Chat
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [sending, setSending] = useState(false)
  const [chatProvider, setChatProvider] = useState<string>('')
  const endRef = useRef<HTMLDivElement>(null)

  const load = () => {
    api.get('/aibro').then((d) => {
      setProviders(d.providers || [])
      setKeyGroups(d.keys || [])
      if (d.selectedServers && d.selectedServers.length) setSelectedServers(d.selectedServers)
      setChatProvider((cur) => cur && d.providers.some((p: AIBroProviderView) => p.id === cur) ? cur : (d.providers.find((p: AIBroProviderView) => p.keyCount > 0)?.id || ''))
    }).catch((e: any) => toast.err(e?.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const loadServers = () => {
    api.get('/aibro/servers').then((d) => {
      setServers(d.servers || [])
      setSelectedServers(d.selectedServers || [])
    }).catch((e: any) => toast.err(e?.message))
      .finally(() => setSelLoaded(true))
  }
  useEffect(() => { loadServers() }, [])

  const saveServers = async () => {
    try {
      const res = await api.put('/aibro/servers', { serverIds: selectedServers })
      setSelectedServers(res.selectedServers || [])
      toast.ok(selectedServers.length ? `AIBro scoped to ${selectedServers.length} server${selectedServers.length === 1 ? '' : 's'}` : 'AIBro can now manage all your servers')
    } catch (e: any) { toast.err(e?.message) }
  }

  const toggleServer = (id: string) => {
    setSelectedServers((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [chat])

  const addKeySubmit = async () => {
    if (!addFor || !addKey.trim()) return
    setAdding(true)
    try {
      const res = await api.post('/aibro/keys', { provider: addFor, label: addLabel, key: addKey })
      toast.ok(`Saved ${(res.key as AIBroKeyView).label}`)
      setAddLabel('')
      setAddKey('')
      load()
    } catch (e: any) { toast.err(e?.message || 'Failed to save key') }
    finally { setAdding(false) }
  }

  const delKey = async (id: string) => {
    try {
      await api.del(`/aibro/keys/${id}`)
      toast.ok('Key removed')
      load()
    } catch (e: any) { toast.err(e?.message) }
  }

  const send = async () => {
    const msg = chatInput.trim()
    if (!msg || sending) return
    setChat((c) => [...c, { from: 'user', text: msg }])
    setChatInput('')
    setSending(true)
    try {
      const res = await api.post('/aibro/chat', { message: msg, provider: chatProvider || undefined })
      setChat((c) => [...c, { from: 'aibro', text: res.reply || '…', provider: res.provider }])
    } catch (e: any) {
      setChat((c) => [...c, { from: 'aibro', text: `⚠ ${e?.message || 'AIBro failed'}` }])
    } finally { setSending(false) }
  }

  const activeProvider = providers.find((p) => p.id === chatProvider)
  const canChat = (activeProvider?.keyCount ?? 0) > 0 && !loading

  return (
    <div className="card">
      <div className="card-h">
        <Icon name="star" size={15} /> AIBro <span className="h-sub">AI assistants that manage your servers with plain English</span>
      </div>
      <div className="card-b">
        <p className="sub" style={{ marginBottom: 12 }}>
          AIBro understands requests like <i>"start my server"</i>, <i>"change join mode to offline"</i> or <i>"make a backup"</i>.
          Add your own API keys (max 4 per provider) — they're stored only on your account, never transmitted. It uses them to reach
          these providers: <b>Gemini, Claude, ChatGPT, OpenRouter, Groq</b>.
        </p>

        <div className="sm text-3 mb-2">Your provider keys</div>
        {loading ? (
          <div className="center" style={{ padding: 18 }}><Spinner size={18} /></div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
            {providers.map((p) => {
              const group = keyGroups.find((g) => g.provider === p.id)
              const keys = group?.keys || []
              return (
                <div key={p.id} className="card subtle p-2">
                  <div className="flex" style={{ alignItems: 'center', gap: 8 }}>
                    <span className="badge cyan sm">{p.label}</span>
                    <span className="xs text-3">{keys.length}/{p.maxKeys}</span>
                    <div style={{ flex: 1 }} />
                    {keys.length > 0 && chatProvider !== p.id && (
                      <button className="btn sm ghost" title="Use for chat" onClick={() => setChatProvider(p.id)}><Icon name="star" size={12} /></button>
                    )}
                  </div>
                  <div className="mt-1 grid gap-1">
                    {keys.length === 0 && <div className="xs text-3">No keys yet.</div>}
                    {keys.map((k) => (
                      <div key={k.id} className="flex" style={{ alignItems: 'center', gap: 6 }}>
                        <span className="mono xs flex-1" title={k.label}>{k.masked}</span>
                        <span className="xs text-3" style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.label}</span>
                        <button className="btn sm ghost icon" onClick={() => delKey(k.id)}><Icon name="trash" size={12} /></button>
                      </div>
                    ))}
                  </div>
                  {addFor === p.id ? (
                    <div className="grid gap-1 mt-2">
                      <input className="inp xs" placeholder="Label (optional)" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} />
                      <input className="inp xs mono" placeholder={`${p.label} API key`} type="password" value={addKey} onChange={(e) => setAddKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addKeySubmit() }} />
                      <div className="flex gap-1">
                        <button className="btn sm primary" disabled={adding || keys.length >= p.maxKeys} onClick={addKeySubmit}>{adding ? <Spinner size={12} /> : 'Save'}</button>
                        <button className="btn sm ghost" onClick={() => { setAddFor(''); setAddKey(''); setAddLabel('') }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn sm ghost mt-2" disabled={keys.length >= p.maxKeys} onClick={() => { setAddFor(p.id); setAddKey(''); setAddLabel('') }}>
                      <Icon name="plus" size={12} /> {keys.length >= p.maxKeys ? 'Limit reached' : 'Add key'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="sm text-3 mb-2 mt-4">Selected servers</div>
        <p className="xs text-3" style={{ marginBottom: 10 }}>
          AIBro can manage all servers you have access to, or only the ones you pick below. When a selection is active, unselected servers are off-limits to it. Empties mean "all my servers".
        </p>
        {!selLoaded ? (
          <div className="center" style={{ padding: 12 }}><Spinner size={18} /></div>
        ) : servers.length === 0 ? (
          <div className="xs text-3 card subtle p-2">You don't have access to any servers yet. Create one from the dashboard and AIBro can manage it.</div>
        ) : (
          <div>
            <div className="grid gap-1" style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}>
              {servers.map((s) => {
                const checked = selectedServers.includes(s.id)
                return (
                  <label key={s.id} className="select-row flex" style={{ cursor: 'pointer', alignItems: 'center', gap: 10 }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleServer(s.id)} />
                    <div style={{ flex: 1 }}>
                      <span className="cell-main">{s.name}</span>
                    </div>
                    <span className={`badge ${s.state === 'running' ? 'green' : 'gray'} sm`}>{s.state}</span>
                  </label>
                )
              })}
            </div>
            <div className="flex mt-2" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn sm primary" onClick={saveServers}>Save server scope</button>
              <button className="btn sm ghost" onClick={() => setSelectedServers(servers.map((s) => s.id))}>Select all</button>
              <button className="btn sm ghost" onClick={() => setSelectedServers([])}>All servers</button>
            </div>
            <div className="xs text-3 mt-1">Selection: {selectedServers.length === 0 ? 'all accessible servers' : `${selectedServers.length} server${selectedServers.length === 1 ? '' : 's'}`}</div>
          </div>
        )}

        <div className="sm text-3 mb-2 mt-4">Chat with AIBro</div>
        {!canChat ? (
          <div className="xs text-3 card subtle p-2">
            Add at least one provider API key above to enable AIBro. Tip: Gemini's free tier works fine for this.
          </div>
        ) : (
          <div className="card subtle" style={{ border: '1px solid var(--line)' }}>
            <div style={{ maxHeight: 280, overflowY: 'auto', padding: 12 }} className="grid gap-2">
              {chat.length === 0 && (
                <div className="xs text-3" style={{ padding: '6px 2px' }}>
                  Try: <i>"list my servers"</i> · <i>"start my server"</i> · <i>"change join mode to offline on Test Server"</i> · <i>"make a backup"</i>
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: m.from === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div className={`term-line mono xs ${m.from === 'user' ? 'text-2' : ''}`} style={{ maxWidth: '85%', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line)', background: m.from === 'user' ? 'var(--bg2)' : 'var(--bg)' }}>
                    {m.provider && <div className="xs text-3" style={{ opacity: 0.7 }}>{m.provider}</div>}
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            <div className="flex p-2" style={{ gap: 8, borderTop: '1px solid var(--line)', alignItems: 'center' }}>
              <select className="select sm" value={chatProvider} onChange={(e) => setChatProvider(e.target.value)} style={{ maxWidth: 140 }}>
                {providers.filter((p) => p.keyCount > 0).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <input
                className="input flex-1"
                placeholder="Tell AIBro what to do…"
                value={chatInput}
                disabled={sending}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send() }}
              />
              <button className="btn primary" disabled={sending || !chatInput.trim()} onClick={send}>
                {sending ? <Spinner size={15} /> : <Icon name="play" size={15} />}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}