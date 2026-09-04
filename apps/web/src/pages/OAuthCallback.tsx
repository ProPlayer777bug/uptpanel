import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Spinner } from '../components/ui'

// Tiny standalone page reached by the popup after the OAuth provider redirects
// back to the API callback (GET /api/auth/oauth/:provider). The API exchanges
// the code server-side and bounces us here with ?token=... (or ?error=...).
// We deliver the token to the opener window (the Login page), then close.
export function OAuthCallback() {
  const { provider } = useParams()
  const [params] = useSearchParams()
  const token = params.get('token')
  const error = params.get('error')
  const name = params.get('name') || ''
  const email = params.get('email') || ''
  const role = params.get('role') || 'viewer'
  const avatarHue = params.get('avatarHue') || ''

  useEffect(() => {
    const msg = error
      ? { uhOauth: true, error }
      : token
        ? { uhOauth: true, token, user: { name, email, role, avatarHue: avatarHue ? Number(avatarHue) : undefined } }
        : { uhOauth: true, error: 'missing authorization response' }
    if (window.opener) {
      window.opener.postMessage(msg, window.location.origin)
      window.close()
    } else if (msg.token) {
      localStorage.setItem('uh_token', msg.token)
      window.location.href = '/'
    } else {
      window.location.href = '/login'
    }
  }, [token, error, name, email, role, avatarHue])

  void provider
  return (
    <div className="login-wrap">
      <div className="login" style={{ width: 340, textAlign: 'center', padding: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}><Spinner size={24} /></div>
        <p className="sm text-3">Completing sign-in…</p>
      </div>
    </div>
  )
}
