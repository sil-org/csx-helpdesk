import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { createLinkToken, getLinkedAccounts, signOut } from '../lib/auth'

// Lets a staff member link a second Google account (e.g. a personal Gmail)
// to their profile, so they can still sign in if they ever lose access to
// their SIL email. Must be done proactively, while they still have access —
// see supabase/schema.sql resolve_profile() for why linking works regardless
// of the second account's domain.
export default function AccountSettings() {
  const { profile } = useAuth()
  const [linkedAccounts, setLinkedAccounts] = useState(null)
  const [linkCodeActive, setLinkCodeActive] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!profile) return
    getLinkedAccounts(profile.id).then(setLinkedAccounts).catch((e) => setError(e.message))
  }, [profile])

  async function handleGenerateLink() {
    setError(null)
    try {
      const token = await createLinkToken()
      localStorage.setItem('pendingLinkToken', token)
      setLinkCodeActive(true)
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
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
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Add a backup sign-in account</h2>
          <p className="text-sm text-gray-500 mb-4">
            Link a personal Google account so you can still sign in if you ever lose access to your
            SIL email — for example if you leave SIL or your account is disabled. Do this now, while
            you still have access. It can't be set up after the fact.
          </p>

          {!linkCodeActive ? (
            <button
              onClick={handleGenerateLink}
              className="px-4 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
            >
              Generate a link code
            </button>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
              <p className="mb-3 font-medium">Now sign out and sign back in with the account you want to link.</p>
              <ol className="list-decimal list-inside space-y-1 mb-4">
                <li>Stay on this device and browser — the link code lives here, not on your account</li>
                <li>Sign out below</li>
                <li>Sign in with the personal Google account, from the Home screen</li>
                <li>It links automatically — the code expires in 15 minutes</li>
              </ol>
              <button
                onClick={signOut}
                className="px-4 py-2 rounded bg-amber-600 text-white text-sm hover:bg-amber-700"
              >
                Sign out now
              </button>
            </div>
          )}

          {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
        </section>
      </div>
    </div>
  )
}
