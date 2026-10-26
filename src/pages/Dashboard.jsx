import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useHelpdesk } from '../context/HelpdeskContext'
import { signOut } from '../lib/auth'
import { hd } from '../lib/helpdesk'

// Landing page after sign-in: routes to the most useful place for this
// profile rather than showing a generic dashboard.
export default function Dashboard() {
  const { profile } = useAuth()
  const { agentDesks, isSuperAdmin, loading, error, refresh } = useHelpdesk()
  const [hasOwnTickets, setHasOwnTickets] = useState(null)
  const [refreshed, setRefreshed] = useState(false)

  // This is the one page whose whole job is a routing decision based on
  // current access, so it can't rely on however stale HelpdeskContext's
  // cached state happens to be (it only refetches once per sign-in,
  // not per visit) — force a fresh fetch every time this page is reached.
  useEffect(() => {
    refresh().finally(() => setRefreshed(true))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!refreshed || loading || agentDesks.length || isSuperAdmin) return
    hd.from('tickets').select('id').limit(1).then(({ data, error }) => {
      if (error) console.error('Dashboard own-tickets check failed:', error)
      setHasOwnTickets((data ?? []).length > 0)
    })
  }, [refreshed, loading, agentDesks, isSuperAdmin])

  if (loading || !refreshed) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-4 max-w-md mx-auto mt-20">
        Couldn't load your helpdesk access: {error}
      </div>
    )
  }
  if (agentDesks.length) return <Navigate to={`/d/${agentDesks[0].slug}`} replace />
  if (isSuperAdmin) return <Navigate to="/admin" replace />
  if (hasOwnTickets) return <Navigate to="/my-tickets" replace />
  if (hasOwnTickets === false) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-gray-500 text-sm max-w-sm">
          Signed in as {profile?.display_name} ({profile?.primary_email}), but you aren't on any desk yet and
          don't have any tickets. Ask an admin to add you, or email a help desk address to open one.
        </p>
        <button onClick={signOut} className="text-sm font-medium text-gray-500 hover:text-gray-700">Sign out</button>
      </div>
    )
  }
  return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>
}
