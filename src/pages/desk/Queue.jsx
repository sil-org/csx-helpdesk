import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import DeskHeader from '../../components/DeskHeader'
import StatusPill from '../../components/StatusPill'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { hd, profilesByIds, relativeTime, ACTIVE_STATUSES } from '../../lib/helpdesk'

const CHIPS = [
  ['active', 'All active'],
  ['new', 'New'],
  ['open', 'Open'],
  ['waiting', 'Waiting for response'],
  ['paused', 'Paused'],
  ['resolved', 'Resolved'],
  ['closed', 'Closed'],
]

export default function Queue() {
  const { slug } = useParams()
  const { agentDesks, allDesks, isSuperAdmin, loading: accessLoading } = useHelpdesk()
  const [desk, setDesk] = useState(null)
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('active')
  const [error, setError] = useState(null)

  const isDeskAdmin = isSuperAdmin || agentDesks.find((d) => d.slug === slug)?.role === 'admin'

  useEffect(() => {
    if (accessLoading) return
    const d = (isSuperAdmin ? allDesks : agentDesks).find((x) => x.slug === slug)
    setDesk(d ?? null)
  }, [slug, agentDesks, allDesks, isSuperAdmin, accessLoading])

  useEffect(() => {
    if (!desk) return
    let cancelled = false

    async function load() {
      try {
        const { data, error } = await hd.from('tickets')
          .select('id, ticket_number, subject, status, updated_at, sender_email, assignee_profile_id, reporter_verified, requester:requesters(display_name, email)')
          .eq('current_desk_id', desk.id)
          .order('updated_at', { ascending: false })
        if (error) throw error
        const assignees = await profilesByIds(data.map((t) => t.assignee_profile_id))
        if (!cancelled) {
          setRows(data.map((t) => ({ ...t, assigneeName: t.assignee_profile_id ? assignees[t.assignee_profile_id]?.display_name : null })))
        }
      } catch (e) {
        if (!cancelled) { setError(e.message); setRows([]) }
      }
    }
    load()
    return () => { cancelled = true }
  }, [desk])

  if (accessLoading) return <Loading />
  if (!desk) return <NotFound slug={slug} />

  const visible = (rows ?? []).filter((t) => t.status !== 'deleted')
  const deleted = (rows ?? []).filter((t) => t.status === 'deleted')
  const chips = [...CHIPS, ...(isDeskAdmin && deleted.length ? [['deleted', 'Deleted (admin)']] : [])]
  const count = (key) => visible.filter((t) => (key === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === key)).length
  const filtered = filter === 'deleted' ? deleted : visible.filter((t) => (filter === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === filter))

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <DeskHeader desk={desk} />

      <div className="flex flex-wrap gap-6 p-6 items-start">
        <nav className="flex-none w-[220px] flex flex-col gap-1">
          <NavLink href={`/d/${slug}`} on>Queue</NavLink>
          {isDeskAdmin && <NavLink href="/admin">Desk settings</NavLink>}
        </nav>

        <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-display text-[28px] m-0">Queue</h1>
            <div className="text-sm text-gray-500">{desk.name} &middot; reporter shown is the detected requester, not the sender</div>
          </div>

          <div className="flex flex-wrap gap-2">
            {chips.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-full border text-sm font-medium ${
                  filter === key ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-300 text-gray-700 hover:border-brand'
                }`}
              >
                {label}
                <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${filter === key ? 'bg-white/20 text-white' : 'bg-[#E5EEF8] text-gray-700'}`}>
                  {key === 'deleted' ? deleted.length : count(key)}
                </span>
              </button>
            ))}
          </div>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[820px]">
                <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_190px_minmax(0,1.2fr)_90px] gap-4 px-5 py-2.5 bg-gray-50 text-xs font-semibold tracking-wider uppercase text-gray-500">
                  <div>Ticket</div><div>Reporter</div><div>Status</div><div>Assignee</div><div>Updated</div>
                </div>
                {rows === null && <div className="px-5 py-8 text-sm text-gray-400">Loading tickets&hellip;</div>}
                {rows !== null && filtered.length === 0 && <div className="px-5 py-8 text-sm text-gray-400">No tickets here.</div>}
                {filtered.map((t) => (
                  <Link
                    key={t.id}
                    to={`/d/${slug}/t/${t.ticket_number}`}
                    className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)_190px_minmax(0,1.2fr)_90px] gap-4 items-center px-5 py-3.5 border-t border-gray-200 hover:bg-[#F2F7FB]"
                  >
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold text-gray-900 truncate">{t.subject || '(no subject)'}</div>
                      <div className="text-xs text-gray-500 mt-0.5">#{t.ticket_number}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm truncate">{t.requester?.display_name || t.requester?.email || t.sender_email}</div>
                      {!t.reporter_verified && <span className="inline-flex items-center text-xs font-semibold text-[#5c3700] bg-[#FFF1D1] rounded px-1.5 py-0.5">Reporter unverified</span>}
                    </div>
                    <div><StatusPill status={t.status} /></div>
                    <div className="text-sm text-gray-700 truncate">{t.assigneeName || 'Unassigned'}</div>
                    <div className="text-xs text-gray-500">{relativeTime(t.updated_at)}</div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
          {isDeskAdmin && <div className="text-xs text-gray-500">Deleted tickets are hidden from agents and appear under the admin-only Deleted filter.</div>}
        </div>
      </div>
    </div>
  )
}

function NavLink({ href, on, children }) {
  return (
    <Link to={href} className={`px-3 py-2.5 rounded-lg text-sm font-medium ${on ? 'bg-[#E5EEF8] text-brand-dark font-semibold' : 'text-gray-600 hover:bg-[#E5EEF8]'}`}>
      {children}
    </Link>
  )
}

function Loading() {
  return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>
}

function NotFound({ slug }) {
  return (
    <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm px-4 text-center">
      You don't have access to a desk called "{slug}", or it doesn't exist.
      <br />Ask an admin to add you with <code>helpdesk.set_desk_role()</code>.
    </div>
  )
}
