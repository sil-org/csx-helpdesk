import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { hd, relativeTime, REPORTER_STATUS_LABEL } from '../lib/helpdesk'
import StatusPill from '../components/StatusPill'
import AppLayout from '../components/AppLayout'
import { getReporterLinks } from '../navLinks'

// Reporter view (spec section 3 / 4): only tickets where the signed-in
// profile is the linked requester. RLS alone isn't enough to scope this: the
// shared tickets_select policy also admits tickets where the signed-in
// profile is desk staff (for the ticket detail page), so an agent would
// otherwise see every ticket on their desk here too. Filter explicitly on
// the requester link instead.
export default function MyTickets() {
  const { profile } = useAuth()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    hd.from('tickets')
      .select('id, ticket_number, subject, status, updated_at, current_desk:desks!tickets_current_desk_id_fkey(name, logo_url, theme_primary), requester:requesters!inner(profile_id)')
      .eq('requester.profile_id', profile.id)
      .order('updated_at', { ascending: false })
      .then(({ data, error }) => { if (error) { setError(error.message); setRows([]) } else { setRows(data ?? []) } })
  }, [profile.id])

  // Reporters can have tickets across several desks; there's no single
  // "owning" desk for this list the way there is on one ticket's own page,
  // so this is a heuristic (spec section 10 only specifies branding for a
  // ticket's own desk) — the most recently updated ticket's desk, or no
  // badge at all if there are no tickets yet to go by.
  const desk = rows?.[0]?.current_desk

  return (
    <AppLayout desk={desk} links={getReporterLinks({ signedIn: true })}>
      <div className="max-w-[880px] w-full mx-auto px-6 py-8 flex flex-col gap-5">
        <div>
          <h1 className="font-display text-[28px] m-0">My tickets</h1>
          <div className="text-sm text-gray-500 mt-1.5">Only requests where you are the reporter appear here.</div>
        </div>

        {/* Look for an answer before waiting on a person. */}
        <form action="/help" method="get" role="search" className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 h-12">
          <label htmlFor="help-search" className="sr-only">Search the help center</label>
          <input id="help-search" name="q" type="search" placeholder="Search the help center for an answer" className="flex-1 min-w-0 bg-transparent outline-none text-[15px]" />
          <button type="submit" className="text-sm font-bold text-brand">Search</button>
        </form>

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
    </AppLayout>
  )
}
