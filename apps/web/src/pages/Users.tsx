import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { useApp } from '../state/auth'
import { Shell } from '../components/Shell'
import { Button, Icon, Modal, ConfirmDialog, toast, Menu, StatePill, Spinner, EmptyState } from '../components/ui'

const ROLES = ['viewer', 'developer', 'operator', 'admin', 'owner']

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-col gap-1" style={{ minWidth: 0 }}>
      <label>{label}</label>
      {children}
    </div>
  )
}

function fmtDate(ts?: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function Users() {
  const { user: me } = useApp()
  const isOwner = me?.role === 'owner'
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<any | null>(null)
  const [deleting, setDeleting] = useState<any | null>(null)
  const [detail, setDetail] = useState<any | null>(null)

  const load = async () => {
    try {
      const r = await api.get('/users')
      setUsers(r.users)
    } catch (e: any) {
      toast.err(e?.message || 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return users
    return users.filter((u) => u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t) || (u.role || '').toLowerCase().includes(t))
  }, [users, q])

  const handleCreate = async (body: any) => {
    try {
      await api.post('/users', body)
      toast.ok(`Created ${body.name}`)
      setCreateOpen(false)
      load()
    } catch (e: any) {
      throw e
    }
  }
  const handleEdit = async (body: any) => {
    try {
      await api.patch(`/users/${editing.id}`, body)
      toast.ok('User updated')
      setEditing(null)
      setDetail((d: any) => (d && d.id === editing.id ? { ...d, ...(body.name ? { name: body.name } : {}), ...(body.role ? { role: body.role } : {}), ...(body.email ? { email: body.email } : {}) } : d))
      load()
    } catch (e: any) {
      throw e
    }
  }
  const handleDelete = async () => {
    try {
      await api.del(`/users/${deleting.id}`)
      toast.ok(`Deleted ${deleting.name}`)
      setDeleting(null)
      if (detail && detail.id === deleting.id) setDetail(null)
      load()
    } catch (e: any) {
      toast.err(e?.message || 'Delete failed')
    }
  }

  return (
    <Shell>
      <div className="page">
        <div className="page-h">
          <h1>Users</h1>
          <span className="sub">{users.length} accounts</span>
          <div style={{ flex: 1 }} />
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreateOpen(true)}>New user</Button>
        </div>

        <div className="server-toolbar">
          <div className="search-box" style={{ maxWidth: 320 }}>
            <Icon name="search" size={14} />
            <input placeholder="Search name, email, role…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ flex: 1 }} />
        </div>

        {loading ? (
          <div className="center" style={{ padding: 60 }}><Spinner size={26} /></div>
        ) : filtered.length === 0 ? (
          <div className="card"><EmptyState icon="user" title="No users" desc="Create your first account to let someone sign in." action={<Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>New user</Button>} /></div>
        ) : (
          <div className="card anim-in" style={{ overflowX: 'auto' }}>
            <table className="dtable">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Admin</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} onClick={() => setDetail(u)} className={detail?.id === u.id ? 'sel' : ''}>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="avatar" style={{ width: 28, height: 28, fontSize: 12, background: `hsl(${u.avatarHue||0} 65% 45%)`, color: '#fff' }}>{u.name?.[0] || '?'}</span>
                        <div>
                          <div className="cell-main">{u.name}{u.id === me?.id && <span className="xs text-3" style={{ marginLeft: 6 }}>(you)</span>}</div>
                          <div className="cell-sub mono xs">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className={`badge ${u.role === 'owner' || u.role === 'admin' ? 'cyan' : 'gray'} xs`}>{u.role}</span></td>
                    <td>{u.role === 'owner' || u.role === 'admin' ? <span className="badge green xs"><Icon name="check" size={10} /> Enabled</span> : <span className="badge gray xs">—</span>}</td>
                    <td><span className="xs text-3">{fmtDate(u.createdAt)}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Menu trigger={<span className="nav-icon-btn"><Icon name="dots" size={16} /></span>} align="right" items={[
                        { label: 'View servers', icon: 'server', onClick: () => setDetail(u) },
                        { label: 'Edit', icon: 'gear', onClick: () => setEditing(u) },
                        ...(isOwner ? [{ label: u.role === 'owner' || u.role === 'admin' ? 'Disable admin' : 'Enable admin', icon: 'shield', onClick: () => setEditing({ ...u, onlyRole: true }) }] : []),
                        { label: 'Delete', icon: 'trash', danger: true, onClick: () => setDeleting(u) },
                      ]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {createOpen && <CreateUserModal isOwner={isOwner} onClose={() => setCreateOpen(false)} onSave={handleCreate} />}
      {editing && <EditUserModal isOwner={isOwner} user={editing} onClose={() => setEditing(null)} onSave={handleEdit} />}
      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          onClose={() => setDeleting(null)}
          onConfirm={handleDelete}
          title="Delete user"
          message={`Delete ${deleting.name} (${deleting.email})? This revokes all their sessions and server access. This cannot be undone.`}
          confirmLabel="Delete user"
          danger
        />
      )}
      {detail && <UserDetail isOwner={isOwner} user={detail} onClose={() => setDetail(null)} onEdit={(u) => { setDetail(null); setEditing(u) }} onChanged={load} />}
    </Shell>
  )
}

function CreateUserModal({ isOwner, onClose, onSave }: { isOwner: boolean; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('viewer')
  const [busy, setBusy] = useState(false)

  const allowedRoles = isOwner ? ROLES : ROLES.filter((r) => r !== 'admin' && r !== 'owner')

  const submit = async () => {
    setBusy(true)
    try { await onSave({ name, email, password, role }); onClose() }
    catch (e: any) { toast.err(e?.message || 'Create failed') }
    finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title="Create user">
      <div className="flex-col gap-3" style={{ minWidth: 0 }}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jamie Doe" /></Field>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></Field>
        <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min 6 characters" /></Field>
        <Field label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            {allowedRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        {!isOwner && <div className="xs text-3">Only the owner can create admin or owner accounts.</div>}
        <div className="flex justify-end gap-2" style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || !email.trim() || password.length < 6} onClick={submit}>Create user</Button>
        </div>
      </div>
    </Modal>
  )
}

function EditUserModal({ isOwner, user, onClose, onSave }: { isOwner: boolean; user: any; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const { user: me } = useApp()
  const isSelf = user.id === me?.id
  const [name, setName] = useState(user.name || '')
  const [email, setEmail] = useState(user.email || '')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState(user.role || 'viewer')
  const [busy, setBusy] = useState(false)
  const isApiRole = user.role === 'owner' || user.role === 'admin'
  const allowedRoles = isOwner ? ROLES : ROLES.filter((r) => r !== 'admin' && r !== 'owner')

  const submit = async () => {
    setBusy(true)
    const body: any = {}
    if (name && name !== user.name) body.name = name
    if (email && email !== user.email) body.email = email
    if (password) body.password = password
    // If the row edit was opened via "Enable/Disable admin", only toggle role.
    if (user.onlyRole) body.role = isApiRole ? 'viewer' : 'admin'
    else if (role !== user.role) body.role = role
    try { await onSave(body); onClose() }
    catch (e: any) { toast.err(e?.message || 'Save failed') }
    finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title={`Edit ${user.name}`}>
      <div className="flex-col gap-3" style={{ minWidth: 0 }}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password {isSelf ? '' : '(leave blank to keep)'}"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isSelf ? 'New password' : 'Only set to change'} autoComplete="new-password" /></Field>
        <Field label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)} disabled={user.onlyRole}>
            {allowedRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <div className="flex justify-end gap-2" style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={submit}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

function UserDetail({ isOwner, user, onClose, onEdit, onChanged }: { isOwner: boolean; user: any; onClose: () => void; onEdit: (u: any) => void; onChanged: () => void }) {
  const [servers, setServers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api.get(`/users/${user.id}/servers`).then((r) => { if (alive) setServers(r.servers) }).catch(() => {}).finally(() => alive && setLoading(false))
    return () => { alive = false }
  }, [user.id])

  const toggleAdmin = async () => {
    const isApi = user.role === 'owner' || user.role === 'admin'
    try {
      await api.patch(`/users/${user.id}`, { role: isApi ? 'viewer' : 'admin' })
      toast.ok(isApi ? 'Admin disabled' : 'Admin enabled')
      onChanged()
    } catch (e: any) { toast.err(e?.message || 'Failed') }
  }

  return (
    <Modal open onClose={onClose} title={user.name} width={640}>
      <div className="flex-col gap-4" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-3">
          <span className="avatar" style={{ width: 44, height: 44, fontSize: 18, background: `hsl(${user.avatarHue||0} 65% 45%)`, color: '#fff' }}>{user.name?.[0] || '?'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cell-main">{user.name}</div>
            <div className="cell-sub mono sm">{user.email}</div>
            <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
              <span className={`badge ${user.role === 'owner' || user.role === 'admin' ? 'cyan' : 'gray'} xs`}>{user.role}</span>
            </div>
          </div>
          {isOwner && (
            <Button variant={user.role === 'owner' || user.role === 'admin' ? 'subtle' : 'primary'} size="sm" icon="shield" onClick={toggleAdmin}>
              {user.role === 'owner' || user.role === 'admin' ? 'Disable admin' : 'Enable admin'}
            </Button>
          )}
          <Button variant="ghost" size="sm" icon="gear" onClick={() => onEdit(user)}>Edit</Button>
        </div>

        <div>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <span className="sub bold">Servers ({servers.length})</span>
          </div>
          {loading ? <Spinner size={20} /> : servers.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}><div className="e-ico"><Icon name="server" size={22} /></div><h3>No servers</h3><p>This user has no servers they can access yet. Grant access via a server's Access tab.</p></div>
          ) : (
            <div className="flex-col gap-2">
              {servers.map((s) => (
                <div key={s.id} className="card" style={{ padding: 12 }}>
                  <div className="flex items-center gap-2">
                    <Icon name="server" size={15} />
                    <span className="cell-main">{s.name}</span>
                    <div style={{ flex: 1 }} />
                    <StatePill state={s.state} pulse />
                    <span className="xs text-3 mono">{s.memoryLimitMb}MB</span>
                  </div>
                  <div className="cell-sub mono xs">{s.id}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
