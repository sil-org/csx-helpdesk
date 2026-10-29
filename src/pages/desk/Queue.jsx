import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import AppLayout from '../../components/AppLayout'
import StatusPill from '../../components/StatusPill'
import { useAuth } from '../../context/AuthContext'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { getLinks } from '../../navLinks'
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
  const { profile } = useAuth()
  const { agentDesks, allDesks, isSuperAdmin, loading: accessLoading } = useHelpdesk()
  const [desk, setDesk] = useState(null)
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('active')
  const [searchText, setSearchText] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState('all') // 'all' | 'mine' | 'unassigned' | <profile_id>
  const [deskAgents, setDeskAgents] = useState([]) // [{id, display_name}]
  const [savedSearches, setSavedSearches] = useState([])
  const [savingSearch, setSavingSearch] = useState(false)
  const [newSearchName, setNewSearchName] = useState('')
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

  async function loadFilterData() {
    if (!desk) return
    const [{ data: agentRows }, { data: searches }] = await Promise.all([
      hd.from('agent_desks').select('profile_id').eq('desk_id', desk.id),
      hd.from('saved_searches').select('id, name, query').eq('desk_id', desk.id).order('created_at'),
    ])
    const ids = (agentRows ?? []).map((a) => a.profile_id)
    const names = await profilesByIds(ids)
    setDeskAgents(ids.map((id) => ({ id, display_name: names[id]?.display_name ?? '…' })))
    setSavedSearches(searches ?? [])
  }

  useEffect(() => { load(); loadFilterData() }, [desk]) // eslint-disable-line react-hooks/exhaustive-deps

  if (accessLoading) return <Loading />
  if (!desk) return <NotFound slug={slug} />

  const visible = (rows ?? []).filter((t) => t.status !== 'deleted')
  const deleted = (rows ?? []).filter((t) => t.status === 'deleted')
  const chips = [...CHIPS, ...(isDeskAdmin && deleted.length ? [['deleted', 'Deleted (admin)']] : [])]
  const count = (key) => visible.filter((t) => (key === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === key)).length
  const byStatus = filter === 'deleted' ? deleted : visible.filter((t) => (filter === 'active' ? ACTIVE_STATUSES.includes(t.status) : t.status === filter))
  const byAssignee = byStatus.filter((t) => {
    if (assigneeFilter === 'all') return true
    if (assigneeFilter === 'mine') return t.assignee_profile_id === profile.id
    if (assigneeFilter === 'unassigned') return !t.assignee_profile_id
    return t.assignee_profile_id === assigneeFilter
  })
  const q = searchText.trim().toLowerCase()
  const filtered = !q ? byAssignee : byAssignee.filter((t) =>
    (t.subject || '').toLowerCase().includes(q)
    || String(t.ticket_number).includes(q)
    || (t.requester?.display_name || '').toLowerCase().includes(q)
    || (t.requester?.email || '').toLowerCase().includes(q)
    || (t.sender_email || '').toLowerCase().includes(q)
  )
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

  function applySearch(query) {
    setFilter(query.status ?? 'active')
    setSearchText(query.text ?? '')
    setAssigneeFilter(query.assignee ?? 'all')
    clearSelection()
  }

  async function saveCurrentSearch() {
    const name = newSearchName.trim()
    if (!name) return
    setError(null)
    const { error } = await hd.from('saved_searches').insert({
      profile_id: profile.id,
      desk_id: desk.id,
      name,
      query: { text: searchText, status: filter, assignee: assigneeFilter },
    })
    if (error) { setError(error.message); return }
    setNewSearchName('')
    setSavingSearch(false)
    loadFilterData()
  }

  async function deleteSavedSearch(id) {
    const { error } = await hd.from('saved_searches').delete().eq('id', id)
    if (error) setError(error.message); else loadFilterData()
  }

  return (
    <AppLayout desk={desk} links={getLinks({ desk, isDeskAdmin, isSuperAdmin })}>
      <div className="p-6 max-w-[1400px] flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-display text-[28px] m-0">Tickets</h1>
            <div className="text-sm text-gray-500">{desk.name} &middot; reporter shown is the detected requester, not the sender</div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {chips.map(([key, label]) => (
              <button
                key={key}
                onClick={() => { setFilter(key); clearSelection() }}
                className={`inline-flex items-center gap-1.5 min-h-[30px] px-2.5 rounded-full border text-xs font-medium ${
                  filter === key ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-300 text-gray-700 hover:border-brand'
                }`}
              >
                {label}
                <span className={`text-[11px] font-semibold px-1.5 rounded-full leading-[18px] ${filter === key ? 'bg-white/20 text-white' : 'bg-[#E5EEF8] text-gray-700'}`}>
                  {key === 'deleted' ? deleted.length : count(key)}
                </span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search subject, reporter, or ticket #&hellip;"
              className="min-h-[34px] flex-1 min-w-[220px] px-3 border border-gray-300 rounded-lg text-sm"
            />
            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="min-h-[34px] text-sm border border-gray-300 rounded-lg px-2"
            >
              <option value="all">Anyone</option>
              <option value="mine">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
              {deskAgents.filter((a) => a.id !== profile.id).map((a) => (
                <option key={a.id} value={a.id}>{a.display_name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {savedSearches.map((s) => (
              <div key={s.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full border border-gray-300 bg-white text-xs">
                <button onClick={() => applySearch(s.query)} className="font-medium text-gray-700 hover:text-brand">{s.name}</button>
                <button
                  onClick={() => deleteSavedSearch(s.id)}
                  aria-label={`Delete saved search ${s.name}`}
                  title="Delete saved search"
                  className="text-gray-400 hover:text-red-600 px-1 leading-none"
                >
                  &times;
                </button>
              </div>
            ))}
            {savingSearch ? (
              <div className="inline-flex items-center gap-1.5">
                <input
                  value={newSearchName}
                  onChange={(e) => setNewSearchName(e.target.value)}
                  placeholder="Name this search"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentSearch(); if (e.key === 'Escape') setSavingSearch(false) }}
                  className="min-h-[28px] px-2 border border-gray-300 rounded-lg text-xs w-36"
                />
                <button onClick={saveCurrentSearch} disabled={!newSearchName.trim()} className="text-xs font-semibold text-brand disabled:opacity-50">Save</button>
                <button onClick={() => { setSavingSearch(false); setNewSearchName('') }} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setSavingSearch(true)} className="text-xs font-semibold text-brand hover:text-brand-dark">+ Save this search</button>
            )}
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
          {isDeskAdmin && <div className="text-xs text-gray-500">Deleted tickets are hidden from agents and appear under the admin-only Deleted filter. A deleted ticket is recoverable for a while before it's permanently purged.</div>}
      </div>
    </AppLayout>
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
