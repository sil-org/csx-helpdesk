import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import DeskHeader from '../../components/DeskHeader'
import StatusPill from '../../components/StatusPill'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { hd, profilesByIds, relativeTime, STATUS_LABEL, ACTIVE_STATUSES } from '../../lib/helpdesk'

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
  const [selected, setSelected] = useState(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [merging, setMerging] = useState(false)
  const [survivorId, setSurvivorId] = useState(null)

  const isDeskAdmin = isSuperAdmin || agentDesks.find((d) => d.slug === slug)?.role === 'admin'

  useEffect(() => {
    if (accessLoading) return
    const d = (isSuperAdmin ? allDesks : agentDesks).find((x) => x.slug === slug)
    setDesk(d ?? null)
  }, [slug, agentDesks, allDesks, isSuperAdmin, accessLoading])

  async function load() {
    if (!desk) return
    try {
      const { data, error } = await hd.from('tickets')
        .select('id, ticket_number, subject, status, updated_at, sender_email, assignee_profile_id, reporter_verified, requester:requesters(display_name, email)')
        .eq('current_desk_id', desk.id)
        .order('updated_at', { ascending: false })
      if (error) throw error
      const assignees = await profilesByIds(data.map((t) => t.assignee_profile_id))
      setRows(data.map((t) => ({ ...t, assigneeName: t.assignee_profile_id ? assignees[t.assignee_profile_id]?.display_name : null })))
    } catch (e) {
      setError(e.message); setRows([])
    }
  }

  useEffect(() => { load() }, [desk]) // eslint-disable-line react-hooks/exhaustive-deps

  if (accessLoading) return <Loading />
  if (!desk) return <NotFound slug={slug} />

  const visible = (rows ?? []).filter((t) => t.status !== 'deleted')
  const deleted = (rows ?? []).filter((t) => t.status === 'deleted')
  const chips = [...CHIPS, ...(isDeskAdmin && deleted.length ? [['deleted', 'Deleted (admin)']] : [])]
  const count = (key) => visible.filter((t) => (key === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === key)).length
  const filtered = filter === 'deleted' ? deleted : visible.filter((t) => (filter === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === filter))
  const selectedRows = filtered.filter((t) => selected.has(t.id))

  function toggle(id) {
    setSelected((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((s) => (s.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.id))))
  }

  function clearSelection() {
    setSelected(new Set())
    setMerging(false)
    setSurvivorId(null)
  }

  async function bulkSetStatus(status) {
    setBulkBusy(true)
    setError(null)
    const { error } = await hd.from('tickets').update({ status }).in('id', [...selected])
    setBulkBusy(false)
    if (error) setError(error.message); else { clearSelection(); load() }
  }

  async function bulkDelete() {
    if (!window.confirm(`Delete ${selected.size} ticket(s)? They can be recovered for a while before they're permanently purged.`)) return
    await bulkSetStatus('deleted')
  }

  async function confirmMerge() {
    if (!survivorId) return
    setBulkBusy(true)
    setError(null)
    const { error } = await hd.rpc('merge_tickets', { p_ticket_ids: [...selected], p_survivor_id: survivorId })
    setBulkBusy(false)
    if (error) setError(error.message); else { clearSelection(); load() }
  }

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
                onClick={() => { setFilter(key); clearSelection() }}
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

          {selected.size > 0 && (
            <div className="bg-gray-900 text-white rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold">{selected.size} selected</span>
              <button onClick={clearSelection} className="text-xs text-gray-300 hover:text-white">Clear</button>
              <div className="flex-1" />
              <select
                disabled={bulkBusy}
                defaultValue=""
                onChange={(e) => { if (e.target.value) bulkSetStatus(e.target.value) }}
                className="min-h-[36px] text-sm rounded-lg px-2 text-gray-900"
              >
                <option value="" disabled>Set status to&hellip;</option>
                {Object.entries(STATUS_LABEL).filter(([k]) => k !== 'deleted').map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <button
                onClick={bulkDelete}
                disabled={bulkBusy}
                className="min-h-[36px] px-3 border border-red-400 text-red-300 hover:bg-red-500 hover:text-white rounded-lg text-sm font-semibold"
              >
                Delete
              </button>
              <button
                onClick={() => setMerging((m) => !m)}
                disabled={bulkBusy || selected.size < 2}
                className="min-h-[36px] px-3 bg-white text-gray-900 rounded-lg text-sm font-semibold disabled:opacity-50"
                title={selected.size < 2 ? 'Select at least two tickets to merge' : ''}
              >
                {merging ? 'Cancel merge' : 'Merge'}
              </button>
            </div>
          )}

          {merging && (
            <div className="bg-white border border-gray-300 rounded-xl p-4 flex flex-col gap-2.5">
              <div className="text-sm font-semibold">Which ticket survives? Every message, attachment, and CC from the others moves onto it; the rest are closed.</div>
              {selectedRows.map((t) => (
                <label key={t.id} className="flex items-center gap-3 text-sm">
                  <input type="radio" name="survivor" checked={survivorId === t.id} onChange={() => setSurvivorId(t.id)} />
                  #{t.ticket_number} {t.subject || '(no subject)'}
                </label>
              ))}
              <button
                onClick={confirmMerge}
                disabled={bulkBusy || !survivorId}
                className="self-start min-h-[40px] px-4 bg-brand text-white rounded-lg text-sm font-semibold disabled:opacity-50"
              >
                {bulkBusy ? 'Merging…' : 'Confirm merge'}
              </button>
            </div>
          )}

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[860px]">
                <div className="grid grid-cols-[32px_minmax(0,3fr)_minmax(0,2fr)_190px_minmax(0,1.2fr)_90px] gap-4 px-5 py-2.5 bg-gray-50 text-xs font-semibold tracking-wider uppercase text-gray-500 items-center">
                  <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleAll} className="w-4 h-4" />
                  <div>Ticket</div><div>Reporter</div><div>Status</div><div>Assignee</div><div>Updated</div>
                </div>
                {rows === null && <div className="px-5 py-8 text-sm text-gray-400">Loading tickets&hellip;</div>}
                {rows !== null && filtered.length === 0 && <div className="px-5 py-8 text-sm text-gray-400">No tickets here.</div>}
                {filtered.map((t) => (
                  <Link
                    key={t.id}
                    to={`/d/${slug}/t/${t.ticket_number}`}
                    className="grid grid-cols-[32px_minmax(0,3fr)_minmax(0,2fr)_190px_minmax(0,1.2fr)_90px] gap-4 items-center px-5 py-3.5 border-t border-gray-200 hover:bg-[#F2F7FB]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.preventDefault(); toggle(t.id) }}
                      className="w-4 h-4"
                    />
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
          {isDeskAdmin && <div className="text-xs text-gray-500">Deleted tickets are hidden from agents and appear under the admin-only Deleted filter. A deleted ticket is recoverable for a while before it's permanently purged.</div>}
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
