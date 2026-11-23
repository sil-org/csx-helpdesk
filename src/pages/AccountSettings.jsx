import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useHelpdesk } from '../context/HelpdeskContext'
import { getLinkedAccounts } from '../lib/auth'
import AppLayout from '../components/AppLayout'
import { getLinks, getReporterLinks } from '../navLinks'

// Previously also let a staff member link a second Google account (e.g. a
// personal Gmail) as backup sign-in access. That flow doesn't translate to
// SSO-only sign-in — there's only one identity provider, so there's no
// second account to sign back in with — so the "add a backup account" UI
// below is disabled. The underlying link-token mechanism (createLinkToken,
// resolve_profile_sso's case 2 in schema_helpdesk.sql) still exists and
// still works; it just has no UI entry point right now.
export default function AccountSettings() {
  const { profile } = useAuth()
  const { agentDesks, isSuperAdmin } = useHelpdesk()
  const [linkedAccounts, setLinkedAccounts] = useState(null)
  const [error, setError] = useState(null)

  // Not a desk-specific page, so (like Admin) pass the agent's first desk
  // just so "Tickets" still goes somewhere sensible — whichever nav fits
  // this profile, so an agent or a reporter both keep a way back from here.
  const isAgent = isSuperAdmin || agentDesks.length > 0
  const links = isAgent
    ? getLinks({ desk: agentDesks[0], isDeskAdmin: isSuperAdmin || agentDesks.some((d) => d.role === 'admin'), isSuperAdmin })
    : getReporterLinks({ signedIn: true })

  useEffect(() => {
    if (!profile) return
    getLinkedAccounts(profile.id).then(setLinkedAccounts).catch((e) => setError(e.message))
  }, [profile])

  return (
    <AppLayout desk={isAgent ? agentDesks[0] : undefined} links={links}>
      <div className="p-8">
        <div className="max-w-2xl mx-auto bg-white rounded-2xl shadow-lg p-10">
          <h1 className="font-display text-2xl font-bold text-brand mb-2">Account</h1>
          <p className="text-gray-500 mb-8">{profile?.display_name} — {profile?.primary_email}</p>

          <section className="mb-8">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Linked sign-in accounts</h2>
            {linkedAccounts === null ? (
              <p className="text-sm text-gray-400">Loading…</p>
            ) : (
              <ul className="space-y-1">
                {linkedAccounts.map((a) => (
                  <li key={a.supabase_user_id} className="text-sm text-gray-700">
                    {a.email}{' '}
                    <span className="text-gray-400">
                      — linked {new Date(a.linked_at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Backup sign-in account</h2>
            <p className="text-sm text-gray-500">
              Not available with SSO sign-in — there's a single sign-in identity, so there's no second
              account to link as backup.
            </p>

            {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
          </section>
        </div>
      </div>
    </AppLayout>
  )
}
