import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import DeskHeader from '../../components/DeskHeader'
import StatusPill from '../../components/StatusPill'
import { useAuth } from '../../context/AuthContext'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { hd, profilesByIds, relativeTime, STATUS_LABEL } from '../../lib/helpdesk'

export default function Ticket() {
  const { slug, ticketNumber } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { agentDesks, allDesks, isSuperAdmin, loading: accessLoading } = useHelpdesk()
  const [desk, setDesk] = useState(null)
  const [ticket, setTicket] = useState(undefined) // undefined = loading, null = not found
  const [messages, setMessages] = useState([])
  const [participants, setParticipants] = useState([])
  const [events, setEvents] = useState([])
  const [people, setPeople] = useState({})
  const [mode, setMode] = useState('reply')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [ccInput, setCcInput] = useState('')
  const [links, setLinks] = useState([])
  const [linkInput, setLinkInput] = useState('')
  const [reassignOpen, setReassignOpen] = useState(false)
  const [reassignEmail, setReassignEmail] = useState('')
  const [reassignName, setReassignName] = useState('')
  const [toast, setToast] = useState(null)
  const [draft, setDraft] = useState(null)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (accessLoading) return
    setDesk((isSuperAdmin ? allDesks : agentDesks).find((x) => x.slug === slug) ?? null)
  }, [slug, agentDesks, allDesks, isSuperAdmin, accessLoading])

  async function reload() {
    const { data: t, error: tErr } = await hd.from('tickets')
      .select('*, requester:requesters(id, display_name, email), merged_into:tickets!tickets_merged_into_ticket_id_fkey(ticket_number)')
      .eq('ticket_number', ticketNumber)
      .maybeSingle()
    if (tErr) { setError(tErr.message); setTicket(null); return }
    setTicket(t ?? null)
    if (!t) return

    const [{ data: msgs }, { data: parts }, { data: evts }, { data: fwdLinks }, { data: backLinks }] = await Promise.all([
      hd.from('ticket_messages').select('*').eq('ticket_id', t.id).order('created_at'),
      hd.from('ticket_participants').select('*').eq('ticket_id', t.id).eq('type', 'cc'),
      hd.from('ticket_events').select('*').eq('ticket_id', t.id).order('created_at', { ascending: false }),
      hd.from('ticket_links').select('linked_ticket_id').eq('ticket_id', t.id),
      hd.from('ticket_links').select('ticket_id').eq('linked_ticket_id', t.id),
    ])
    setMessages(msgs ?? [])
    setParticipants(parts ?? [])
    setEvents(evts ?? [])

    const linkedIds = [...(fwdLinks ?? []).map((l) => l.linked_ticket_id), ...(backLinks ?? []).map((l) => l.ticket_id)]
    if (linkedIds.length) {
      const { data: linked } = await hd.from('tickets').select('id, ticket_number, subject, status').in('id', linkedIds)
      setLinks(linked ?? [])
    } else {
      setLinks([])
    }

    const ids = [t.assignee_profile_id, ...(msgs ?? []).map((m) => m.profile_id), ...(evts ?? []).map((e) => e.actor_profile_id)]
    setPeople(await profilesByIds(ids))

    const { data: activeDraft } = await hd.from('ticket_drafts')
      .select('id, body, cited_sources, created_at')
      .eq('ticket_id', t.id)
      .is('superseded_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setDraft(activeDraft ?? null)
  }

  function useDraft() {
    setMode('reply')
    setBody(draft.body)
  }

  async function dismissDraft() {
    const { error } = await hd.from('ticket_drafts').update({ superseded_at: new Date().toISOString() }).eq('id', draft.id)
    if (error) setError(error.message); else setDraft(null)
  }

  async function addLink() {
    const num = parseInt(linkInput.trim(), 10)
    if (!num) return
    setError(null)
    const { data: other, error: findErr } = await hd.from('tickets').select('id').eq('ticket_number', num).maybeSingle()
    if (findErr) { setError(findErr.message); return }
    if (!other) { setError(`No ticket #${num} found.`); return }
    const { error } = await hd.from('ticket_links').insert({ ticket_id: ticket.id, linked_ticket_id: other.id })
    if (error) setError(error.message); else { setLinkInput(''); reload() }
  }

  async function removeLink(linkedId) {
    setError(null)
    await Promise.all([
      hd.from('ticket_links').delete().eq('ticket_id', ticket.id).eq('linked_ticket_id', linkedId),
      hd.from('ticket_links').delete().eq('ticket_id', linkedId).eq('linked_ticket_id', ticket.id),
    ])
    reload()
  }

  async function reassignReporter(email, name) {
    setError(null)
    const { error } = await hd.rpc('reassign_reporter', { p_ticket_id: ticket.id, p_email: email, p_display_name: name || null })
    if (error) setError(error.message)
    else { setReassignOpen(false); setReassignEmail(''); setReassignName(''); setToast('Reporter confirmed'); reload() }
  }

  useEffect(() => { reload() }, [ticketNumber]) // eslint-disable-line react-hooks/exhaustive-deps

  if (accessLoading || ticket === undefined) return <Loading />
  if (!desk) return <NotFound reason={`You don't have access to a desk called "${slug}".`} />
  if (ticket === null) return <NotFound reason={`Ticket #${ticketNumber} wasn't found, or isn't on this desk.`} />

  const isNote = mode === 'note'

  async function sendMessage() {
    if (!body.trim()) return
    setSending(true)
    setError(null)
    const { error } = await hd.from('ticket_messages').insert({
      ticket_id: ticket.id,
      direction: 'outbound',
      internal: isNote,
      profile_id: profile.id,
      body,
    })
    setSending(false)
    if (error) { setError(error.message); return }
    setBody('')
    // A public reply retires whatever draft was active, whether it was used
    // as-is, edited, or ignored entirely — either way it's no longer "the"
    // suggestion for this ticket once something's actually been sent.
    if (!isNote && draft) {
      await hd.from('ticket_drafts').update({ superseded_at: new Date().toISOString() }).eq('id', draft.id)
    }
    reload()
  }

  async function assignToMe() {
    const { error } = await hd.from('tickets').update({ assignee_profile_id: profile.id }).eq('id', ticket.id)
    if (error) setError(error.message); else reload()
  }

  async function setStatus(status) {
    const { error } = await hd.from('tickets').update({ status }).eq('id', ticket.id)
    if (error) { setError(error.message); return }
    if (status === 'resolved' || status === 'closed') navigate('/dashboard'); else reload()
  }

  async function addCc() {
    const email = ccInput.trim().toLowerCase()
    if (!email) return
    const { error } = await hd.from('ticket_participants').insert({ ticket_id: ticket.id, email, type: 'cc' })
    if (error) setError(error.message); else { setCcInput(''); reload() }
  }

  async function removeCc(email) {
    const { error } = await hd.from('ticket_participants').delete().eq('ticket_id', ticket.id).eq('email', email)
    if (error) setError(error.message); else reload()
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <DeskHeader desk={desk} backTo={`/d/${slug}`} />
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex flex-wrap gap-6 p-6 items-start">
        <div className="flex-[999_1_600px] min-w-0 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-gray-500">#{ticket.ticket_number}</span>
              <StatusPill status={ticket.status} />
            </div>
            <h1 className="font-display text-[28px] m-0">{ticket.subject || '(no subject)'}</h1>
          </div>

          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}

          {ticket.merged_into_ticket_id && (
            <div className="bg-gray-100 border border-gray-300 rounded-xl p-4 text-sm text-gray-700">
              Merged into{' '}
              <Link to={`/d/${slug}/t/${ticket.merged_into?.ticket_number}`} className="font-semibold text-brand hover:text-brand-dark">
                #{ticket.merged_into?.ticket_number}
              </Link>
              . Everything here moved there — reply on that ticket instead.
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-xl border p-5 flex flex-col gap-2.5 ${m.internal ? 'bg-[#FFF8E8] border-[#FFE2A4]' : 'bg-white border-gray-200'}`}
            >
              <div className="flex flex-wrap justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  {m.internal && <span className="text-xs font-semibold tracking-wider uppercase bg-[#7a4a00] text-white px-2 py-0.5 rounded">Internal note</span>}
                  <span className="text-sm font-bold">
                    {m.direction === 'inbound'
                      ? (ticket.requester?.display_name || m.author_email || ticket.sender_email)
                      : (people[m.profile_id]?.display_name || 'An agent')}
                  </span>
                </div>
                <div className="text-xs text-gray-500">{new Date(m.created_at).toLocaleString()}</div>
              </div>
              <div className={`text-[15px] leading-relaxed whitespace-pre-wrap ${m.internal ? 'text-[#3d2800]' : 'text-gray-900'}`}>{m.body}</div>
            </div>
          ))}

          {!ticket.merged_into_ticket_id && draft && (
            <div className="rounded-xl border border-[#C9B8E8] bg-[#F4EFFB] p-5 flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold tracking-wider uppercase text-[#5B3A9E]">AI draft</span>
                <div className="flex gap-2">
                  <button onClick={dismissDraft} className="text-xs font-semibold text-gray-500 hover:text-gray-700">Dismiss</button>
                  <button onClick={useDraft} className="min-h-[32px] px-3 bg-[#5B3A9E] text-white rounded-lg text-xs font-semibold">Use this draft</button>
                </div>
              </div>
              <div className="text-[15px] leading-relaxed whitespace-pre-wrap text-gray-900">{draft.body}</div>
              {draft.cited_sources?.kb_section && (
                <div className="text-xs text-[#5B3A9E]">Drew on knowledge-base section: {draft.cited_sources.kb_section}</div>
              )}
            </div>
          )}

          {!ticket.merged_into_ticket_id && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex gap-2 border-b border-gray-200 px-2">
                <button
                  onClick={() => setMode('reply')}
                  className={`min-h-[44px] px-5 border-b-[3px] text-sm font-semibold ${mode === 'reply' ? 'border-brand text-gray-900' : 'border-transparent text-gray-500'}`}
                >
                  Reply to reporter
                </button>
                <button
                  onClick={() => setMode('note')}
                  className={`min-h-[44px] px-5 border-b-[3px] text-sm font-semibold ${mode === 'note' ? 'border-[#7a4a00] text-[#5c3700]' : 'border-transparent text-gray-500'}`}
                >
                  Internal note
                </button>
              </div>
              <div className="p-4 flex flex-col gap-3" style={{ background: isNote ? '#FFF8E8' : '#fff' }}>
                <div className="text-sm font-bold" style={{ color: isNote ? '#5c3700' : '#034D8A' }}>
                  {isNote ? 'Internal note. Only agents on this desk will see this.' : 'Public reply. The reporter and CCs will receive this by email.'}
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={isNote ? 'Write a note for your team...' : 'Write your reply to the reporter...'}
                  className="min-h-[120px] p-3 border border-gray-300 rounded-lg text-[15px] resize-y"
                />
                <div className="flex flex-wrap items-center gap-3 justify-between">
                  <div className="text-xs" style={{ color: isNote ? '#5c3700' : '#034D8A' }}>
                    {isNote ? 'Not emailed to anyone.' : `Sends from the ${desk.name} address.`}
                  </div>
                  <button
                    onClick={sendMessage}
                    disabled={sending || !body.trim()}
                    className={`min-h-[44px] px-4 rounded-lg font-semibold text-sm disabled:opacity-50 ${isNote ? 'bg-[#7a4a00] text-white' : 'bg-brand text-white hover:bg-brand-dark'}`}
                  >
                    {sending ? 'Sending…' : isNote ? 'Add internal note' : 'Send reply'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 min-w-[280px] max-w-[380px] flex flex-col gap-4">
          <Card>
            <div className="flex items-start justify-between gap-2">
              <div>
                <Label>Reporter</Label>
                <div className="text-base font-bold">{ticket.requester?.display_name || '(unknown)'}</div>
                <div className="text-xs text-gray-500">{ticket.requester?.email || ticket.sender_email}</div>
              </div>
              {ticket.reporter_verified && (
                <button
                  onClick={() => setReassignOpen((o) => !o)}
                  aria-label={reassignOpen ? 'Cancel reassigning reporter' : 'Reassign reporter'}
                  title="Reassign reporter"
                  className={`flex-none w-8 h-8 flex items-center justify-center rounded-lg border ${reassignOpen ? 'border-brand text-brand' : 'border-gray-300 text-gray-500 hover:border-brand hover:text-brand'}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              )}
            </div>
            {!ticket.reporter_verified && (
              <div className="bg-[#FFF1D1] rounded-lg px-3 py-2.5 text-xs leading-relaxed text-[#5c3700]">
                <b>Reporter unverified.</b> {ticket.detected_sender_email
                  ? <>Best guess from the forwarded text: <b>{ticket.detected_sender_name || ticket.detected_sender_email}</b> ({ticket.detected_sender_email}). Confirm it below, or enter someone else.</>
                  : 'No candidate could be parsed from the forward. Enter the real reporter\'s email below.'}
              </div>
            )}
            {(reassignOpen || !ticket.reporter_verified) && (
              <div className="border-t border-gray-200 pt-3 flex flex-col gap-2">
                {ticket.detected_sender_email && (
                  <button
                    onClick={() => reassignReporter(ticket.detected_sender_email, ticket.detected_sender_name)}
                    className="cand flex items-center gap-3 w-full min-h-[44px] px-3 border border-gray-300 rounded-lg bg-white text-left text-sm hover:border-brand"
                  >
                    <span className="flex-1 min-w-0">
                      <b className="block">{ticket.detected_sender_name || ticket.detected_sender_email}</b>
                      <span className="text-xs text-gray-500">Best guess from the forwarded text &middot; {ticket.detected_sender_email}</span>
                    </span>
                  </button>
                )}
                <label htmlFor="reassign-email" className="text-xs text-gray-500">Or enter an email</label>
                <input
                  id="reassign-email"
                  value={reassignEmail}
                  onChange={(e) => setReassignEmail(e.target.value)}
                  placeholder="name@example.org"
                  className="min-h-[40px] px-2.5 border border-gray-300 rounded-lg text-sm"
                />
                <input
                  value={reassignName}
                  onChange={(e) => setReassignName(e.target.value)}
                  placeholder="Display name (optional)"
                  className="min-h-[40px] px-2.5 border border-gray-300 rounded-lg text-sm"
                />
                <button
                  onClick={() => reassignReporter(reassignEmail, reassignName)}
                  disabled={!reassignEmail.trim()}
                  className="min-h-[40px] px-3 bg-brand text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  Confirm reporter
                </button>
              </div>
            )}
          </Card>

          <Card>
            <div>
              <Label>Status</Label>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={ticket.status} />
                <select
                  value={ticket.status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="min-h-[36px] text-sm border border-gray-300 rounded px-2"
                >
                  {Object.entries(STATUS_LABEL).filter(([k]) => k !== 'deleted').map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label>Assignee</Label>
              <div className="text-sm">
                {ticket.assignee_profile_id ? (people[ticket.assignee_profile_id]?.display_name ?? '…') : 'Unassigned'}
                {ticket.assignee_profile_id !== profile.id && (
                  <button onClick={assignToMe} className="ml-2 font-semibold text-brand">Assign to me</button>
                )}
              </div>
            </div>
            <div>
              <Label>Desk</Label>
              <div className="text-sm mb-2.5">{desk.name}</div>
              <div className="flex flex-wrap gap-2">
                <button disabled className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm text-gray-400 cursor-not-allowed" title="Transfers land in build-order step 6 (not built yet)">
                  Transfer to desk
                </button>
                <button disabled className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm text-gray-400 cursor-not-allowed" title="External forwarding lands in build-order step 6 (not built yet)">
                  Forward outside &amp; close
                </button>
              </div>
            </div>
          </Card>

          <Card>
            <Label>CC (email only)</Label>
            {participants.map((p) => (
              <div key={p.email} className="flex items-center justify-between text-sm gap-2">
                <span>{p.email}</span>
                <button onClick={() => removeCc(p.email)} className="text-xs text-gray-500 hover:text-red-700">Remove</button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                value={ccInput}
                onChange={(e) => setCcInput(e.target.value)}
                placeholder="email@example.org"
                className="min-h-[40px] flex-1 px-2.5 border border-gray-300 rounded-lg text-sm"
              />
              <button onClick={addCc} className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm">Add</button>
            </div>
            <div className="text-xs text-gray-500 leading-relaxed">CCs receive public replies by email. They don't see internal notes and can't open the ticket in the app.</div>
          </Card>

          <Card>
            <Label>Related tickets</Label>
            {links.map((l) => (
              <div key={l.id} className="flex items-center justify-between text-sm gap-2">
                <a href={`/d/${slug}/t/${l.ticket_number}`} className="text-brand hover:text-brand-dark truncate">
                  #{l.ticket_number} {l.subject}
                </a>
                <button onClick={() => removeLink(l.id)} className="text-xs text-gray-500 hover:text-red-700 flex-none">Unlink</button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                placeholder="Ticket #"
                className="min-h-[40px] w-24 px-2.5 border border-gray-300 rounded-lg text-sm"
              />
              <button onClick={addLink} className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm">Link</button>
            </div>
            <div className="text-xs text-gray-500 leading-relaxed">
              For tickets that are related but shouldn't be merged — email threading can only connect replies to a
              message this desk already received, so a conversation that started elsewhere won't auto-link.
            </div>
          </Card>

          <Card>
            <Label>History</Label>
            <div className="text-xs text-gray-600 leading-relaxed flex flex-col gap-1">
              {events.map((e) => (
                <div key={e.id}>
                  {new Date(e.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                  {people[e.actor_profile_id]?.display_name || 'System'} &mdash; {describeEvent(e)}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function describeEvent(e) {
  switch (e.event_type) {
    case 'created': return 'ticket created'
    case 'status_changed': return `status: ${e.from_value} → ${e.to_value}`
    case 'assigned': return 'assignee changed'
    case 'transferred': return 'transferred desks'
    case 'reporter_changed': return 'reporter changed'
    case 'reopened': return e.note || 'reopened'
    case 'forwarded_outside': return 'forwarded outside'
    default: return e.event_type
  }
}

function Card({ children }) {
  return <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3">{children}</div>
}

function Label({ children }) {
  return <div className="text-xs font-semibold tracking-wider uppercase text-gray-500">{children}</div>
}

function Loading() {
  return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>
}

function NotFound({ reason }) {
  return <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm px-4 text-center">{reason}</div>
}
