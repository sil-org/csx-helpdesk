import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import AppLayout from '../../components/AppLayout'
import StatusPill from '../../components/StatusPill'
import { useAuth } from '../../context/AuthContext'
import { useHelpdesk } from '../../context/HelpdeskContext'
import { getLinks } from '../../navLinks'
import { hd, profilesByIds, relativeTime, STATUS_LABEL } from '../../lib/helpdesk'
import { supabase } from '../../lib/supabase'

const ATTACHMENT_BUCKET = 'helpdesk-attachments'
const VISIBLE_RECENT_MESSAGES = 3

export default function Ticket() {
  const { slug, ticketNumber } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const { agentDesks, allDesks, isSuperAdmin, loading: accessLoading } = useHelpdesk()
  const [desk, setDesk] = useState(null)
  const [ticket, setTicket] = useState(undefined) // undefined = loading, null = not found
  const [messages, setMessages] = useState([])
  const [attachments, setAttachments] = useState({})
  const [expandedOld, setExpandedOld] = useState(false)
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
  // Which draft the agent loaded into the compose box (if any), so that when
  // they send we can tell "used it" from "wrote their own".
  const [loadedDraftId, setLoadedDraftId] = useState(null)
  const [mergedIntoNumber, setMergedIntoNumber] = useState(null)
  const [ticketDesk, setTicketDesk] = useState(null)
  const [deskAgentIds, setDeskAgentIds] = useState([])
  const [transferDesks, setTransferDesks] = useState([])
  const [transferTarget, setTransferTarget] = useState('')
  const [transferConfirming, setTransferConfirming] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [forwardOpen, setForwardOpen] = useState(false)
  const [forwardEmail, setForwardEmail] = useState('')
  const [forwardMessage, setForwardMessage] = useState('')
  const [forwarding, setForwarding] = useState(false)

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
      .select('*, requester:requesters(id, display_name, email)')
      .eq('ticket_number', ticketNumber)
      .maybeSingle()
    if (tErr) { setError(tErr.message); setTicket(null); return }
    setTicket(t ?? null)
    if (!t) return

    if (t.merged_into_ticket_id) {
      const { data: survivor } = await hd.from('tickets').select('ticket_number').eq('id', t.merged_into_ticket_id).maybeSingle()
      setMergedIntoNumber(survivor?.ticket_number ?? null)
    } else {
      setMergedIntoNumber(null)
    }

    const [{ data: msgs }, { data: parts }, { data: evts }, { data: fwdLinks }, { data: backLinks }, { data: tDesk }, { data: tAgents }, { data: xferDesks }] = await Promise.all([
      hd.from('ticket_messages').select('*').eq('ticket_id', t.id).order('created_at'),
      hd.from('ticket_participants').select('*').eq('ticket_id', t.id).eq('type', 'cc'),
      hd.from('ticket_events').select('*').eq('ticket_id', t.id).order('created_at', { ascending: false }),
      hd.from('ticket_links').select('linked_ticket_id').eq('ticket_id', t.id),
      hd.from('ticket_links').select('ticket_id').eq('linked_ticket_id', t.id),
      hd.from('desks').select('id, slug, name, accepts_transfers').eq('id', t.current_desk_id).maybeSingle(),
      hd.from('agent_desks').select('profile_id').eq('desk_id', t.current_desk_id),
      hd.from('desks').select('id, slug, name').eq('accepts_transfers', true),
    ])
    setMessages(msgs ?? [])
    setAttachments(await loadAttachments(t.id))
    setParticipants(parts ?? [])
    setEvents(evts ?? [])
    setTicketDesk(tDesk ?? null)
    const agentIds = (tAgents ?? []).map((a) => a.profile_id)
    setDeskAgentIds(agentIds)
    setTransferDesks((xferDesks ?? []).filter((d) => d.id !== t.current_desk_id))

    const linkedIds = [...(fwdLinks ?? []).map((l) => l.linked_ticket_id), ...(backLinks ?? []).map((l) => l.ticket_id)]
    if (linkedIds.length) {
      const { data: linked } = await hd.from('tickets').select('id, ticket_number, subject, status').in('id', linkedIds)
      setLinks(linked ?? [])
    } else {
      setLinks([])
    }

    const ids = [t.assignee_profile_id, ...agentIds, ...(msgs ?? []).map((m) => m.profile_id), ...(evts ?? []).map((e) => e.actor_profile_id)]
    setPeople(await profilesByIds(ids))

    const { data: activeDraft } = await hd.from('ticket_drafts')
      .select('id, body, cited_sources, sender_trust, created_at')
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
    setLoadedDraftId(draft.id)
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
  useEffect(() => { setExpandedOld(false) }, [ticketNumber])

  if (accessLoading || ticket === undefined) return <Loading />
  if (!desk) return <NotFound reason={`You don't have access to a desk called "${slug}".`} />
  if (ticket === null) return <NotFound reason={`Ticket #${ticketNumber} wasn't found, or isn't on this desk.`} />

  const isDeskAdmin = isSuperAdmin || agentDesks.find((d) => d.slug === slug)?.role === 'admin'
  const isNote = mode === 'note'

  async function sendMessage() {
    if (!body.trim()) return
    setSending(true)
    setError(null)
    const { data: inserted, error } = await hd.from('ticket_messages').insert({
      ticket_id: ticket.id,
      direction: 'outbound',
      internal: isNote,
      profile_id: profile.id,
      body,
    }).select('id').single()
    if (error) { setSending(false); setError(error.message); return }

    // Internal notes are never emailed — only a public reply actually sends.
    // The message is already saved either way; a send failure here is a
    // soft failure (shown, not reverted) so an agent doesn't lose the text.
    if (!isNote) {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: inserted.id }),
      })
      const result = await res.json()
      if (!res.ok) setError(`Saved, but not sent: ${result.error}`)
    }

    setSending(false)
    setBody('')
    // A public reply retires whatever draft was active, whether it was used
    // as-is, edited, or ignored entirely — either way it's no longer "the"
    // suggestion for this ticket once something's actually been sent. The
    // database also records how the sent text compares with the draft, which
    // the nightly knowledge-base review learns from. If recording fails, still
    // retire the draft so it is not offered again.
    if (!isNote && draft) {
      const { error: outcomeErr } = await hd.rpc('record_draft_outcome', {
        p_draft_id: draft.id,
        p_message_id: inserted.id,
        p_used: loadedDraftId === draft.id,
      })
      if (outcomeErr) {
        console.error('record_draft_outcome failed:', outcomeErr.message)
        await hd.from('ticket_drafts').update({ superseded_at: new Date().toISOString() }).eq('id', draft.id)
      }
    }
    setLoadedDraftId(null)
    reload()
  }

  async function setAssignee(profileId) {
    const { error } = await hd.from('tickets').update({ assignee_profile_id: profileId || null }).eq('id', ticket.id)
    if (error) setError(error.message); else reload()
  }

  async function setStatus(status) {
    const { error } = await hd.from('tickets').update({ status }).eq('id', ticket.id)
    if (error) { setError(error.message); return }
    if (status === 'resolved' || status === 'closed') navigate('/dashboard'); else reload()
  }

  async function confirmTransfer() {
    if (!transferTarget) return
    setTransferring(true)
    setError(null)
    const { error } = await hd.rpc('transfer_ticket', { p_ticket_id: ticket.id, p_desk_id: transferTarget })
    if (error) { setTransferring(false); setError(error.message); return }

    // The move already happened; a failed notice here doesn't undo it, it
    // just means the reporter wasn't told (surfaced, not retried silently).
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-transfer-notice`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticket.id }),
    })
    const result = await res.json()
    if (!res.ok) setError(`Transferred, but the reporter wasn't notified: ${result.error}`)

    setTransferring(false)
    setTransferConfirming(false)
    setTransferTarget('')
    setToast('Ticket transferred')
    reload()
  }

  async function forwardOutside() {
    if (!forwardEmail.trim()) return
    setForwarding(true)
    setError(null)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-forward-outside`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticket.id, to_email: forwardEmail.trim(), message: forwardMessage }),
    })
    const result = await res.json()
    setForwarding(false)
    if (!res.ok) { setError(result.error); return }
    navigate('/dashboard')
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
    <AppLayout desk={desk} links={getLinks({ desk, isDeskAdmin, isSuperAdmin })}>
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-lg shadow-lg">
          {toast}
        </div>
      )}

      <div className="flex flex-wrap gap-6 p-6 items-start">
        <div className="flex-[999_1_600px] min-w-0 flex flex-col gap-4">
          <Link to={`/d/${slug}`} className="text-sm font-semibold text-brand hover:text-brand-dark self-start">
            &larr; Back to tickets
          </Link>

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
              {mergedIntoNumber ? (
                <Link to={`/d/${slug}/t/${mergedIntoNumber}`} className="font-semibold text-brand hover:text-brand-dark">
                  #{mergedIntoNumber}
                </Link>
              ) : 'another ticket'}
              . Everything here moved there — reply on that ticket instead.
            </div>
          )}

          {messages.length > VISIBLE_RECENT_MESSAGES && (
            <button
              onClick={() => setExpandedOld((e) => !e)}
              className="self-start text-xs font-semibold text-gray-500 hover:text-brand px-1 py-1"
            >
              {expandedOld
                ? 'Hide earlier messages'
                : `Show ${messages.length - VISIBLE_RECENT_MESSAGES} earlier message${messages.length - VISIBLE_RECENT_MESSAGES === 1 ? '' : 's'}`}
            </button>
          )}

          {(expandedOld ? messages : messages.slice(-VISIBLE_RECENT_MESSAGES)).map((m) => (
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
              <MessageBody text={m.body} atts={attachments[m.id]} internal={m.internal} />
            </div>
          ))}

          {!ticket.merged_into_ticket_id && draft && (
            <div className="rounded-xl border border-[#C9B8E8] bg-[#F4EFFB] p-5 flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold tracking-wider uppercase text-[#5B3A9E]">AI draft</span>
                {draft.sender_trust === 'external' && (
                  <span className="ml-2 text-xs font-semibold text-[#A6121F] bg-[#FBE8E9] rounded px-1.5 py-0.5" title="This person is writing from outside SIL, so the draft was kept to public steps. Check who they are before replying.">Outside SIL sender</span>
                )}
                {draft.sender_trust === 'sil_unverified' && (
                  <span className="ml-2 text-xs font-semibold text-[#7A4F00] bg-[#FFF1D1] rounded px-1.5 py-0.5" title="The address says sil.org, but the email did not pass the check that proves it really came from there, so it could be forged. The draft was kept to self-service steps.">Sender not verified</span>
                )}
                <div className="flex gap-2">
                  <button onClick={dismissDraft} className="text-xs font-semibold text-gray-500 hover:text-gray-700">Dismiss</button>
                  <button onClick={useDraft} className="min-h-[32px] px-3 bg-[#5B3A9E] text-white rounded-lg text-xs font-semibold">Use this draft</button>
                </div>
              </div>
              <div className="text-[15px] leading-relaxed whitespace-pre-wrap text-gray-900">{linkifyText(draft.body ?? '', 'draft')}</div>
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
              <select
                value={ticket.status}
                onChange={(e) => setStatus(e.target.value)}
                className="min-h-[36px] w-full text-sm border border-gray-300 rounded-lg px-2"
              >
                {Object.entries(STATUS_LABEL).filter(([k]) => k !== 'deleted').map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
            </div>

            <div>
              <Label>Assignee</Label>
              {deskAgentIds.length <= 1 && (deskAgentIds.length === 0 || ticket.assignee_profile_id === deskAgentIds[0]) ? (
                <div className="text-sm">
                  {ticket.assignee_profile_id ? (people[ticket.assignee_profile_id]?.display_name ?? '…') : 'Unassigned'}
                </div>
              ) : (
                <select
                  value={ticket.assignee_profile_id ?? ''}
                  onChange={(e) => setAssignee(e.target.value)}
                  className="min-h-[36px] w-full text-sm border border-gray-300 rounded-lg px-2"
                >
                  <option value="">Unassigned</option>
                  {deskAgentIds.map((id) => (
                    <option key={id} value={id}>{people[id]?.display_name ?? '…'}</option>
                  ))}
                </select>
              )}
            </div>

            <div>
              <Label>Desk</Label>
              <div className="text-sm mb-2.5">{ticketDesk?.name ?? desk.name}</div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1 min-w-[160px] flex gap-2">
                  {transferDesks.length === 0 ? (
                    <div className="text-xs text-gray-500 py-2.5">No desks accept transfers yet.</div>
                  ) : transferDesks.length === 1 ? (
                    <button
                      onClick={() => { setTransferTarget(transferDesks[0].id); setTransferConfirming(true) }}
                      className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm hover:border-brand"
                    >
                      Transfer to {transferDesks[0].name}
                    </button>
                  ) : (
                    <>
                      <select
                        value={transferTarget}
                        onChange={(e) => setTransferTarget(e.target.value)}
                        className="min-h-[40px] flex-1 text-sm border border-gray-300 rounded-lg px-2"
                      >
                        <option value="">Transfer to…</option>
                        {transferDesks.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => setTransferConfirming(true)}
                        disabled={!transferTarget}
                        className="min-h-[40px] px-3 border border-gray-300 rounded-lg text-sm disabled:opacity-50 hover:border-brand"
                      >
                        Transfer
                      </button>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setForwardOpen((o) => !o)}
                  aria-label={forwardOpen ? 'Close forward panel' : 'Forward outside and close'}
                  title="Forward outside and close"
                  className={`flex-none w-10 h-10 flex items-center justify-center rounded-lg border ${forwardOpen ? 'border-brand text-brand' : 'border-gray-300 text-gray-500 hover:border-brand hover:text-brand'}`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22l-4-9-9-4Z" />
                  </svg>
                </button>
              </div>

              {transferConfirming && (
                <div className="mt-2 border border-amber-300 bg-amber-50 rounded-lg p-3 text-sm flex flex-col gap-2">
                  <div>
                    Transfer to <b>{transferDesks.find((d) => d.id === transferTarget)?.name}</b>? This resets
                    the status to New and clears the assignee.
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={confirmTransfer}
                      disabled={transferring}
                      className="min-h-[36px] px-3 bg-brand text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                    >
                      {transferring ? 'Transferring…' : 'Confirm transfer'}
                    </button>
                    <button
                      onClick={() => { setTransferConfirming(false); setTransferTarget('') }}
                      disabled={transferring}
                      className="min-h-[36px] px-3 text-sm text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {forwardOpen && (
                <div className="mt-2 border border-gray-200 rounded-lg p-3 flex flex-col gap-2">
                  <label htmlFor="forward-email" className="text-xs text-gray-500">Send the thread to</label>
                  <input
                    id="forward-email"
                    value={forwardEmail}
                    onChange={(e) => setForwardEmail(e.target.value)}
                    placeholder="name@example.org"
                    className="min-h-[40px] px-2.5 border border-gray-300 rounded-lg text-sm"
                  />
                  <textarea
                    value={forwardMessage}
                    onChange={(e) => setForwardMessage(e.target.value)}
                    placeholder="Add a message for them (optional)"
                    className="min-h-[72px] p-2.5 border border-gray-300 rounded-lg text-sm resize-y"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={forwardOutside}
                      disabled={forwarding || !forwardEmail.trim()}
                      className="min-h-[40px] px-3 bg-brand text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                    >
                      {forwarding ? 'Forwarding…' : 'Forward & close'}
                    </button>
                    <button
                      onClick={() => setForwardOpen(false)}
                      disabled={forwarding}
                      className="min-h-[40px] px-3 text-sm text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="text-xs text-gray-500 leading-relaxed">Closes the ticket. A reply from them reopens it.</div>
                </div>
              )}
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
    </AppLayout>
  )
}

// Groups a ticket's attachments by message_id, with a signed URL attached to
// each one that still has bytes in storage (none for a skipped or
// since-removed attachment — those render as a note instead of a link).
async function loadAttachments(ticketId) {
  const { data: atts } = await hd.from('ticket_attachments').select('*').eq('ticket_id', ticketId).order('created_at')
  const withUrls = await Promise.all((atts ?? []).map(async (a) => {
    if (!a.storage_path || a.removed_at) return { ...a, signedUrl: null }
    const { data } = await supabase.storage.from(ATTACHMENT_BUCKET).createSignedUrl(a.storage_path, 3600)
    return { ...a, signedUrl: data?.signedUrl ?? null }
  }))
  const byMessage = {}
  for (const a of withUrls) (byMessage[a.message_id] ??= []).push(a)
  return byMessage
}

function formatBytes(n) {
  if (!n) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Email plain-text bodies render links as "label text <https://url>" and
// inline images as "[image: filename]" placeholders. Turn those back into a
// clickable link / an actual <img> so the message reads the way it looked in
// the sender's mail client, instead of as a wall of escaped text.
function MessageBody({ text, atts, internal }) {
  const usedIds = new Set()
  const imageRe = /\[image:\s*([^\]]+)\]/g
  const parts = []
  let lastIndex = 0
  let m
  const body = text ?? ''
  while ((m = imageRe.exec(body))) {
    if (m.index > lastIndex) parts.push({ type: 'text', value: body.slice(lastIndex, m.index) })
    parts.push({ type: 'image', name: m[1].trim() })
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < body.length) parts.push({ type: 'text', value: body.slice(lastIndex) })

  const nodes = parts.map((p, i) => {
    if (p.type === 'text') return <span key={i}>{linkifyText(p.value, `b${i}`)}</span>
    const att = (atts ?? []).find(
      (a) => !usedIds.has(a.id) && a.filename?.trim().toLowerCase() === p.name.toLowerCase()
    )
    if (att?.signedUrl && att.content_type?.startsWith('image/')) {
      usedIds.add(att.id)
      return (
        <a key={i} href={att.signedUrl} target="_blank" rel="noreferrer" title={att.filename} className="block my-1">
          <img
            src={att.signedUrl}
            alt={att.filename}
            className="max-h-72 max-w-full rounded-lg border border-gray-200 object-contain bg-gray-50"
          />
        </a>
      )
    }
    // No matching attachment: a real filename means the image went missing
    // (say so); a bare emoji/icon placeholder is decorative, so drop it.
    if (p.name.includes('.')) {
      return <span key={i} className="text-xs italic text-gray-400">[image: {p.name}]</span>
    }
    return null
  })

  const rest = (atts ?? []).filter((a) => !usedIds.has(a.id))
  return (
    <>
      <div className={`text-[15px] leading-relaxed whitespace-pre-wrap ${internal ? 'text-[#3d2800]' : 'text-gray-900'}`}>
        {nodes}
      </div>
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {rest.map((a) => <Attachment key={a.id} att={a} />)}
        </div>
      )}
    </>
  )
}

// Matches the "label <https://url>" shape mail clients' plain-text parts use
// for links, then catches any remaining bare URLs in what's left.
function linkifyText(text, keyPrefix) {
  const re = /([^\n<>]*?)<((?:https?:\/\/|mailto:)[^<>\s]+)>/g
  const nodes = []
  let lastIndex = 0
  let m
  let idx = 0
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) nodes.push(text.slice(lastIndex, m.index))
    const label = m[1].trim()
    nodes.push(
      <a key={`${keyPrefix}-l${idx++}`} href={m[2]} target="_blank" rel="noreferrer" className="text-brand underline hover:text-brand-dark">
        {label || m[2]}
      </a>
    )
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))

  return nodes.flatMap((n, i) => (typeof n === 'string' ? linkifyBareUrls(n, `${keyPrefix}-${i}`) : n))
}

function linkifyBareUrls(text, keyPrefix) {
  const re = /\bhttps?:\/\/[^\s<>]+/g
  const nodes = []
  let lastIndex = 0
  let m
  let idx = 0
  while ((m = re.exec(text))) {
    let url = m[0]
    const trailMatch = url.match(/[.,;:!?)\]'"]+$/)
    const trail = trailMatch ? trailMatch[0] : ''
    if (trail) url = url.slice(0, -trail.length)
    if (m.index > lastIndex) nodes.push(text.slice(lastIndex, m.index))
    nodes.push(
      <a key={`${keyPrefix}-u${idx++}`} href={url} target="_blank" rel="noreferrer" className="text-brand underline hover:text-brand-dark">
        {url}
      </a>
    )
    if (trail) nodes.push(trail)
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes.length ? nodes : [text]
}

function Attachment({ att }) {
  const size = formatBytes(att.size_bytes)
  if (att.removed_at) {
    return <div className="text-xs italic text-gray-400 border border-gray-200 rounded-lg px-2.5 py-1.5">{att.filename} (removed)</div>
  }
  if (!att.storage_path) {
    return (
      <div className="text-xs italic text-gray-400 border border-gray-200 rounded-lg px-2.5 py-1.5">
        {att.filename} &mdash; not saved{att.skipped_reason ? ` (${att.skipped_reason})` : ''}
      </div>
    )
  }
  if (att.content_type?.startsWith('image/')) {
    return (
      <a href={att.signedUrl} target="_blank" rel="noreferrer" title={att.filename}>
        <img
          src={att.signedUrl}
          alt={att.filename}
          className="max-h-48 max-w-[220px] rounded-lg border border-gray-200 object-contain bg-gray-50"
        />
      </a>
    )
  }
  return (
    <a
      href={att.signedUrl}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-xs font-medium text-brand border border-gray-200 rounded-lg px-2.5 py-1.5 hover:border-brand"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L10.13 17.14a2 2 0 0 1-2.83-2.83l8.49-8.49" />
      </svg>
      {att.filename}{size ? ` (${size})` : ''}
    </a>
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
