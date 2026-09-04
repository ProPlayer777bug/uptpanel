import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../theme/useTheme'

// Public, unauthenticated Privacy Policy page. Rendered outside the auth gate
// (see App.tsx) so Google OAuth verification and any visitor can open
// https://panel.uptimehost.in/privacy without logging in.
//
// Uses the same design tokens / dark+light theme as the rest of UptimeHost.
// SEO title/description/canonical are injected on this route only (the SPA
// shell keeps a generic title for other routes).

const SITE = 'https://panel.uptimehost.in'
const CONTACT = 'gpro41980@gmail.com'

type Section = { id: string; n: string; title: string }

const SECTIONS: Section[] = [
  { id: 'intro', n: '1', title: 'Introduction' },
  { id: 'information-we-collect', n: '2', title: 'Information We Collect' },
  { id: 'account-information', n: '3', title: 'Account Information' },
  { id: 'google-oauth', n: '4', title: 'Google OAuth / Sign-In' },
  { id: 'hosting-server', n: '5', title: 'Hosting and Server Information' },
  { id: 'payment', n: '6', title: 'Payment Information' },
  { id: 'how-we-use', n: '7', title: 'How We Use Information' },
  { id: 'cookies', n: '8', title: 'Cookies and Similar Technologies' },
  { id: 'third-party', n: '9', title: 'Third-Party Services' },
  { id: 'data-security', n: '10', title: 'Data Security' },
  { id: 'data-retention', n: '11', title: 'Data Retention' },
  { id: 'data-sharing', n: '12', title: 'Data Sharing and Disclosure' },
  { id: 'user-rights', n: '13', title: 'User Rights' },
  { id: 'account-deletion', n: '14', title: 'Account Deletion' },
  { id: 'children', n: '15', title: "Children's Privacy" },
  { id: 'changes', n: '16', title: 'Changes to This Policy' },
  { id: 'contact', n: '17', title: 'Contact Information' },
]

export function PrivacyPolicy() {
  const { mode, applyMode } = useTheme()

  // SEO for this route (client-injected; Google's crawler executes JS).
  useEffect(() => {
    const prevTitle = document.title
    document.title = 'UptimeHost Privacy Policy'

    let meta: HTMLMetaElement | null = null
    let canonical: HTMLLinkElement | null = null
    let existingDesc = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (!existingDesc) {
      meta = document.createElement('meta')
      meta.name = 'description'
      document.head.appendChild(meta)
    } else {
      meta = existingDesc
    }
    const prevDesc = meta.content
    meta.content =
      'UptimeHost Privacy Policy explaining how we collect, use, protect, and manage user information and Google OAuth authentication data.'

    canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    const prevHref = canonical?.getAttribute('href') || null
    if (!canonical) {
      canonical = document.createElement('link')
      canonical.rel = 'canonical'
      document.head.appendChild(canonical)
    }
    canonical.setAttribute('href', `${SITE}/privacy`)

    return () => {
      document.title = prevTitle
      meta!.content = prevDesc
      // Restore previous canonical if there was one, otherwise remove the link.
      if (prevHref) canonical!.setAttribute('href', prevHref)
      else canonical?.remove()
    }
  }, [])

  const nav = (
    <header className="pub-nav">
      <div className="pub-nav-inner">
        <div className="sidebar-brand" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark" style={{ width: 30, height: 30, fontSize: 14 }}>U</div>
          <div className="brand-word">Uptime<span>Host</span></div>
        </div>
        <div className="pub-nav-links">
          <button
            className="btn ghost sm icon-only"
            onClick={() => applyMode(mode === 'dark' ? 'light' : 'dark')}
            title="Toggle theme"
            aria-label="Toggle theme"
            style={{ width: 34, height: 34, display: 'grid', placeItems: 'center' }}
          >
            {mode === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
            )}
          </button>
          <Link className="btn primary sm" to="/">Open Panel</Link>
        </div>
      </div>
    </header>
  )

  return (
    <div className="pub-page">
      {nav}

      <main className="pub-main">
        <section className="pub-hero anim-in">
          <span className="pub-eyebrow">Privacy Policy</span>
          <h1>UptimeHost <span className="pub-accent">Privacy Policy</span></h1>
          <p className="pub-lede">
            How we collect, use, protect, and manage your information when you use the UptimeHost panel
            and services.
          </p>
          <span className="pub-updated">Last Updated: September 4, 2026</span>
        </section>

        <div className="pub-layout">
          {/* Sticky table of contents (desktop) */}
          <nav className="pub-toc" aria-label="Table of contents">
            <div className="pub-toc-inner">
              <div className="pub-toc-title">On this page</div>
              <ol className="pub-toc-list">
                {SECTIONS.map((s) => (
                  <li key={s.id}><a href={`#${s.id}`}><span className="pub-toc-n">{s.n}.</span>{s.title}</a></li>
                ))}
              </ol>
            </div>
          </nav>

          {/* Content */}
          <article className="pub-content anim-in">
            <Section id="intro" n="1" title="Introduction" first>
              <p>
                UptimeHost ("we", "us", or "our") provides a hosting control panel and related services through
                the website located at <a href={SITE}>{SITE}</a> (the "Service"). This Privacy Policy explains what
                information we collect through the Service, how we use it, and the choices you have about it.
              </p>
              <p>
                By accessing or using the Service, you agree to the collection and use of information as described
                in this policy. This policy applies to the Service we operate directly; separate providers we
                rely on (for example, to send email or message verification codes) process data under their own
                privacy policies, as explained below.
              </p>
            </Section>

            <Section id="information-we-collect" n="2" title="Information We Collect">
              <p>
                The information we collect depends on how you use the Service. We collect information that you
                provide directly, information we receive automatically as you use the Service, and, when you
                choose to sign in through a provider, limited information shared with us by that provider.
              </p>
              <h3>What we may collect</h3>
              <ul>
                <li>Account details you provide when you register or sign in (see <a href="#account-information">Account Information</a>).</li>
                <li>If you use Google Sign-In or another supported identity method, the limited profile information shared with us for authentication (see <a href="#google-oauth">Google OAuth / Sign-In</a>).</li>
                <li>Hosting and server configuration you create, such as nodes, servers, allocations, and related settings (see <a href="#hosting-server">Hosting and Server Information</a>).</li>
                <li>Payment details you provide if you purchase a paid plan (see <a href="#payment">Payment Information</a>).</li>
                <li>Basic technical data such as your IP address, browser type, device, and log data collected automatically when you use the Service.</li>
              </ul>
            </Section>

            <Section id="account-information" n="3" title="Account Information">
              <p>
                When you create an account on UptimeHost, we may collect information needed to establish and
                manage your account, such as:
              </p>
              <ul>
                <li>A display name / username.</li>
                <li>An email address (and/or phone number) used for login and verification.</li>
                <li>A password, if you sign up with a password, which we store in a hashed (non-plaintext) form.</li>
                <li>Account role and permissions settings, and a record of when you sign in.</li>
              </ul>
              <p>
                We use this information to create and secure your account, authenticate you, grant you access to
                the servers you are permitted to manage, and contact you about your account when necessary.
              </p>
            </Section>

            <Section id="google-oauth" n="4" title="Google OAuth / Google Sign-In">
              <p>
                UptimeHost may offer you the option to sign in or register using your Google account via Google
                OAuth / Google Sign-In. This section explains how that works.
              </p>
              <ul>
                <li>
                  <strong>Authentication.</strong> When you choose to sign in with Google, Google redirects you to a
                  Google authorization page. If you consent, Google shares with us the basic account information
                  that is required for authentication and that Google provides — typically your name, email
                  address, and basic profile information.
                </li>
                <li>
                  <strong>How we use it.</strong> This information is used to create and/or authenticate your
                  UptimeHost account and to associate that identity with your account on our Service. We do not
                  use this information for any purpose beyond operating and securing your account.
                </li>
                <li>
                  <strong>No selling.</strong> We do not sell Google user data.
                </li>
                <li>
                  <strong>No advertising use.</strong> We do not use Google user data for advertising or ad
                  targeting purposes.
                </li>
                <li>
                  <strong>Minimal scope.</strong> We request only the information necessary to provide the
                  sign-in functionality, and we do not request access to your Google data beyond what is needed
                  for authentication.
                </li>
                <li>
                  <strong>Revoking access.</strong> You can revoke UptimeHost's access to your Google account at
                  any time through your Google Account settings (under "Security" &gt; "Third-party apps with
                  account access"). Google also lists the access UptimeHost has and lets you remove it.
                </li>
                <li>
                  <strong>Google's policy.</strong> Google's processing of your data is governed by Google's own
                  privacy policy, which you can review at Google. This Privacy Policy describes how we handle any
                  limited information Google shares with us.
                </li>
              </ul>
            </Section>

            <Section id="hosting-server" n="5" title="Hosting and Server Information">
              <p>
                UptimeHost is a hosting control panel. As part of providing the Service, you may create and manage
                game servers, nodes, allocations, and other hosting resources. We store the configuration and
                operational data you provide so that we can run and manage those resources for you. This may
                include:
              </p>
              <ul>
                <li>Server names, identifiers, blueprints, startup commands, and environment configuration.</li>
                <li>Network allocations and node details.</li>
                <li>Console logs and performance metrics generated as your servers run.</li>
                <li>Backups, snapshots, schedules, and similar data you create.</li>
              </ul>
              <p>
                This data is used to operate the Service you have requested. Console output, server logs, and
                configuration are visible to you and, where applicable, to those you grant access to. If you
                connect an external identity provider for authentication, we do not use your server data for any
                unrelated purpose.
              </p>
            </Section>

            <Section id="payment" n="6" title="Payment Information">
              <p>
                If you purchase a paid subscription or service through UptimeHost, we may collect payment details
                (such as billing contact information) to process your order. We do not store or process full card
                numbers directly on our servers; payments are handled by our payment processors.
              </p>
              <p>
                The specific payment providers we use will process your payment data under their own privacy
                policies, and we only receive the limited information needed to confirm that a payment was
                completed and to maintain your billing records (for example, the amount paid and the last four
                digits of a card, when provided by the processor).
              </p>
            </Section>

            <Section id="how-we-use" n="7" title="How We Use Information">
              <p>We use the information we collect for the following purposes:</p>
              <ul>
                <li>To create, authenticate, and manage your UptimeHost account.</li>
                <li>To provide, operate, maintain, and secure the Service and the hosting resources you manage.</li>
                <li>To communicate with you about your account, the Service, and important updates.</li>
                <li>To send verification codes (via email and/or SMS) needed to secure your login.</li>
                <li>To prevent fraud, abuse, and unauthorized access, and to protect the security of the Service.</li>
                <li>To improve, debug, and analyze the performance and reliability of the Service.</li>
                <li>To comply with applicable legal obligations.</li>
              </ul>
              <p>
                We do not sell your personal information, and we do not use Google user data for advertising.
              </p>
            </Section>

            <Section id="cookies" n="8" title="Cookies and Similar Technologies">
              <p>
                UptimeHost uses cookies and similar local storage technologies to keep you signed in and to
                remember your preferences (for example, your chosen display theme). These are necessary for the
                Service to function correctly.
              </p>
              <ul>
                <li><strong>Authentication:</strong> we use a token stored in your browser to keep you signed in across visits.</li>
                <li><strong>Preferences:</strong> we store lightweight settings such as your theme choice in local browser storage.</li>
              </ul>
              <p>
                Third-party services we may use (such as analytics or payment providers) are governed by their own
                cookie and privacy policies. You can generally manage or clear cookies through your browser
                settings, though some features of the Service require them.
              </p>
            </Section>

            <Section id="third-party" n="9" title="Third-Party Services">
              <p>
                UptimeHost relies on a small number of third-party services to operate. When you use these, your
                data is processed both by us and by the relevant provider under that provider's privacy policy.
              </p>
              <ul>
                <li><strong>Google (Google OAuth / Sign-In)</strong> — for optional sign-in; see the <a href="#google-oauth">Google OAuth</a> section.</li>
                <li><strong>Email / SMS providers</strong> — to deliver verification codes to your email or phone.</li>
                <li><strong>Payment processors</strong> — to process payments you make.</li>
                <li><strong>Cloud/CDN and infrastructure providers</strong> — to host and serve the Service.</li>
              </ul>
              <p>
                We encourage you to review the privacy policies of any third-party service you choose to use. We
                are not responsible for these third parties' data practices.
              </p>
            </Section>

            <Section id="data-security" n="10" title="Data Security">
              <p>
                We take reasonable and appropriate technical and organizational measures to protect your
                information, such as encrypting traffic in transit (HTTPS), hashing passwords rather than storing
                them in plaintext, and restricting access to personal data to those who need it to operate the
                Service.
              </p>
              <p>
                No method of transmission over the Internet or method of electronic storage is 100% secure. While
                we work to protect your information, we cannot guarantee its absolute security, and you are
                responsible for keeping your login credentials confidential.
              </p>
            </Section>

            <Section id="data-retention" n="11" title="Data Retention">
              <p>
                We retain personal information only for as long as necessary to provide the Service, satisfy the
                purposes described in this policy, comply with our legal obligations, resolve disputes, and
                enforce our agreements.
              </p>
              <p>
                Your account information is retained while your account is active. If you delete your account (see
                <a href="#account-deletion">Account Deletion</a>), we will delete or anonymize your personal data as
                described below. Log and operational data may be retained for shorter periods for security and
                troubleshooting, subject to applicable law.
              </p>
            </Section>

            <Section id="data-sharing" n="12" title="Data Sharing and Disclosure">
              <p>
                We do not sell your personal information. We may share information only in the following
                circumstances:
              </p>
              <ul>
                <li>
                  <strong>Service providers:</strong> with the vendors who help us operate the Service (such as
                  email/SMS delivery and payment processors), only as needed to perform their functions on our
                  behalf and under confidentiality obligations.
                </li>
                <li>
                  <strong>People you authorize:</strong> with those you grant access to, so they can view or manage
                  the servers and resources you allow them to access.
                </li>
                <li>
                  <strong>Legal requirements:</strong> when required by law, regulation, legal process, or
                  governmental request, or when we believe in good faith that disclosure is necessary to protect
                  our rights, your safety, or the safety of others, or to investigate fraud or abuse.
                </li>
                <li>
                  <strong>Business transfers:</strong> in connection with a merger, acquisition, sale of assets,
                  or similar transaction, in which case we will take reasonable steps to ensure your information
                  continues to be handled in a manner consistent with this policy.
                </li>
              </ul>
            </Section>

            <Section id="user-rights" n="13" title="User Rights">
              <p>
                Depending on your jurisdiction, you may have rights regarding the personal information we hold
                about you, including the right to:
              </p>
              <ul>
                <li>Access and review the personal information we hold about you.</li>
                <li>Correct or update inaccurate information.</li>
                <li>Request deletion of your personal information.</li>
                <li>Object to or restrict certain processing.</li>
                <li>Withdraw consent where processing is based on consent (such as Google Sign-In).</li>
                <li>Lodge a complaint with a relevant data protection authority.</li>
              </ul>
              <p>
                To exercise any of these rights, contact us using the details in the <a href="#contact">Contact
                Information</a> section. We will respond to reasonable requests within applicable timeframes.
              </p>
            </Section>

            <Section id="account-deletion" n="14" title="Account Deletion">
              <p>
                You may request deletion of your UptimeHost account at any time by contacting us at
                <a href={`mailto:${CONTACT}`}> {CONTACT}</a>. When you delete your account, we will remove or
                anonymize your personal data (including account information and Google identity association) and
                revoke your access, subject to any information we are legally required to retain or that relates
                to an ongoing legal dispute or payment obligation.
              </p>
              <p>
                Please note that deleting your account will not necessarily remove server and hosting content you
                have created, which may remain governed by the relevant agreements until it is separately removed.
              </p>
            </Section>

            <Section id="children" n="15" title="Children's Privacy">
              <p>
                The Service is not directed to children under the age of 13, and we do not knowingly collect
                personal information from children under 13. If you believe a child has provided us with personal
                information, please contact us using the details below so we can take appropriate action.
              </p>
            </Section>

            <Section id="changes" n="16" title="Changes to This Privacy Policy">
              <p>
                We may update this Privacy Policy from time to time to reflect changes in our practices, the
                Service, or applicable law. When we make material changes, we will update the "Last Updated" date
                at the top of this page and take reasonable steps to notify you where appropriate.
              </p>
              <p>
                We encourage you to review this page periodically to stay informed about how we protect your
                information. Your continued use of the Service after changes take effect constitutes acceptance of
                the updated policy where such acceptance is permitted by law.
              </p>
            </Section>

            <Section id="contact" n="17" title="Contact Information" last>
              <p>
                If you have any questions, concerns, or requests about this Privacy Policy or your personal
                information, please contact us at:
              </p>
              <div className="pub-contact">
                <div><span className="pub-contact-label">Service</span> UptimeHost</div>
                <div><span className="pub-contact-label">Website</span> <a href={SITE}>{SITE}</a></div>
                <div><span className="pub-contact-label">Email</span> <a href={`mailto:${CONTACT}`}>{CONTACT}</a></div>
              </div>
            </Section>
          </article>
        </div>
      </main>

      <footer className="pub-footer">
        <div className="pub-footer-inner">
          <div className="pub-footer-brand">
            <div className="brand-mark" style={{ width: 26, height: 26, fontSize: 12 }}>U</div>
            <div className="brand-word" style={{ fontSize: 14 }}>Uptime<span>Host</span></div>
          </div>
          <span className="pub-footer-copy">© {new Date().getFullYear()} UptimeHost. All rights reserved.</span>
          <nav className="pub-footer-links" aria-label="Footer">
            <Link to="/privacy">Privacy Policy</Link>
            <a href={SITE}>Website</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}

function Section({
  id, n, title, children, first, last,
}: {
  id: string; n: string; title: string; children: ReactNode; first?: boolean; last?: boolean
}) {
  return (
    <section id={id} className={`pub-section ${first ? 'first' : ''} ${last ? 'last' : ''}`} aria-labelledby={`h-${id}`}>
      <div className="pub-h">
        <span className="pub-n">{n}</span>
        <h2 id={`h-${id}`}>{title}</h2>
      </div>
      <div className="pub-body">{children}</div>
    </section>
  )
}
