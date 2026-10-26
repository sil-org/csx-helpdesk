import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { signOut } from '../lib/auth'
import { useAuth } from '../context/AuthContext'
import { hd, relativeTime, REPORTER_STATUS_LABEL } from '../lib/helpdesk'
import StatusPill from '../components/StatusPill'

// Reporter view (spec section 3 / 4): only tickets where the signed-in
// profile is the linked requester. RLS (is_ticket_reporter) already excludes
// Deleted tickets and internal content — this page shows only what's returned.
export default function MyTickets() {
  const { profile } = useAuth()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    hd.from('tickets')
      .select('id, ticket_number, subject, status, updated_at, current_desk:desks!tickets_current_desk_id_fkey(name, logo_url, theme_primary)')
      .order('updated_at', { ascending: false })
      .then(({ data, error }) => { if (error) { setError(error.message); setRows([]) } else { setRows(data ?? []) } })
  }, [])

  // Reporters can have tickets across several desks; there's no single
  // "owning" desk for this list the way there is on one ticket's own page,
  // so this is a heuristic (spec section 10 only specifies branding for a
  // ticket's own desk) — the most recently updated ticket's desk, falling
  // back to the default SIL theme if there are no tickets yet to go by.
  const color = rows?.[0]?.current_desk?.theme_primary || '#005CB9'
  const logoUrl = rows?.[0]?.current_desk?.logo_url

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <div className="flex flex-wrap items-center gap-4 px-6 py-3 bg-white border-b border-gray-200">
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-8 w-auto" />
          ) : (
            <div className="w-9 h-9 rounded-full text-white flex items-center justify-center font-bold text-sm" style={{ background: color }}>
              {(profile?.display_name || '?')[0]}
            </div>
          )}
          <div className="text-[17px] font-bold">My tickets</div>
        </div>
        <div className="flex-1" />
        <div className="text-sm text-gray-500">{profile?.display_name}</div>
        <button onClick={signOut} className="text-sm font-medium text-gray-500 hover:text-gray-700">Sign out</button>
      </div>

      <div className="max-w-[880px] w-full mx-auto px-6 py-8 flex flex-col gap-5">
        <div>
          <h1 className="font-display text-[28px] m-0">My tickets</h1>
          <div className="text-sm text-gray-500 mt-1.5">Only requests where you are the reporter appear here.</div>
        </div>

        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}
        {rows === null && <div className="text-sm text-gray-400">Loading&hellip;</div>}
        {rows !== null && rows.length === 0 && (
          <div className="text-sm text-gray-500">You don't have any tickets yet. Email your help desk to open one.</div>
        )}
        {(rows ?? []).map((t) => (
          <Link
            key={t.id}
            to={`/my-tickets/${t.ticket_number}`}
            className="block bg-white border border-gray-200 rounded-xl px-5 py-4 hover:border-gray-400"
          >
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="text-base font-bold">{t.subject || '(no subject)'}</div>
              <StatusPill status={t.status} label={REPORTER_STATUS_LABEL[t.status]} />
            </div>
            <div className="text-xs text-gray-500 mt-1.5">#{t.ticket_number} &middot; {t.current_desk?.name} &middot; updated {relativeTime(t.updated_at)}</div>
          </Link>
        ))}
      </div>
    </div>
  )
}
