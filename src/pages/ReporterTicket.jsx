import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { hd, relativeTime, REPORTER_STATUS_LABEL } from '../lib/helpdesk'
import StatusPill from '../components/StatusPill'
import AppLayout from '../components/AppLayout'
import { getReporterLinks } from '../navLinks'

const REPORTER_LINKS = getReporterLinks({ signedIn: true })

// One-line explanation shown under the status pill. Paused is "On hold" with
// no date (spec section 4).
const STATUS_HINT = {
  new: 'We have your request. Someone on the help desk will pick it up soon.',
  open: 'The help desk is working on this.',
  waiting: 'The help desk is waiting for your reply.',
  paused: 'This request is on hold for now.',
  resolved: 'This was marked resolved. If it isn\'t fixed, add a comment and it will reopen.',
  closed: 'This request is closed. Add a comment to reopen it.',
}

// RLS (ticket_messages_select) already excludes internal notes for a
// reporter, and is_ticket_reporter excludes Deleted tickets entirely.
// Comments go through helpdesk.add_reporter_comment (not a table insert), the
// same effect as emailing a reply: an inbound message, and a reopen if needed.
export default function ReporterTicket() {
  const { ticketNumber } = useParams()
  const [ticket, setTicket] = useState(undefined)
  const [messages, setMessages] = useState([])
  const [error, setError] = useState(null)
  const [comment, setComment] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef(null)

  const load = useCallback(async () => {
    const { data: t, error: tErr } = await hd.from('tickets')
      .select('id, ticket_number, subject, status, current_desk:desks!tickets_current_desk_id_fkey(name, logo_url, theme_primary)')
      .eq('ticket_number', ticketNumber)
      .maybeSingle()
    if (tErr) setError(tErr.message)
    setTicket(t ?? null)
    if (t) {
      const { data, error: mErr } = await hd.from('ticket_messages').select('*').eq('ticket_id', t.id).order('created_at')
      if (mErr) setError(mErr.message)
      setMessages(data ?? [])
    }
  }, [ticketNumber])

  useEffect(() => { load() }, [load])

  async function send(e) {
    e.preventDefault()
    const body = comment.trim()
    if (!body || sending) return
    setSending(true)
    setError(null)
    const { data: messageId, error: rpcErr } = await hd.rpc('add_reporter_comment', { p_ticket_id: ticket.id, p_body: body })
    if (rpcErr) {
      setError(rpcErr.message)
    } else {
      setComment('')
      // Same follow-ups as an emailed reply: a fresh AI draft, and a notice
      // to the assigned agent. Fire-and-forget — a failure here never loses
      // the comment (it's already saved).
      supabase.auth.getSession().then(({ data: { session } }) => {
        const post = (fn, payload) => fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        post('request-draft', { ticket_id: ticket.id }).catch(() => {})
        post('notify-assignee', { ticket_id: ticket.id, message_id: messageId }).catch(() => {})
      }).catch(() => {})
      await load()
      endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    setSending(false)
  }

  if (ticket === undefined) {
    return (
      <AppLayout links={REPORTER_LINKS}>
        <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>
      </AppLayout>
    )
  }
  if (ticket === null) {
    return (
      <AppLayout links={REPORTER_LINKS}>
        <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">Ticket not found.</div>
      </AppLayout>
    )
  }

  // Default SIL Blue unless this desk overrides it (spec section 10: the
  // SIL theme is the default, per-desk colors are the exception).
  const color = ticket.current_desk?.theme_primary || '#005CB9'
  const deskName = ticket.current_desk?.name || 'Help desk'

  return (
    <AppLayout desk={ticket.current_desk} links={REPORTER_LINKS}>
      <Link to="/my-tickets" className="inline-block mt-4 ml-6 text-sm font-semibold" style={{ color }}>&larr; My tickets</Link>

      <div className="max-w-[760px] w-full mx-auto px-6 py-8 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-gray-500">#{ticket.ticket_number}</span>
            <StatusPill status={ticket.status} label={REPORTER_STATUS_LABEL[ticket.status]} />
          </div>
          <h1 className="font-display text-[26px] m-0">{ticket.subject || '(no subject)'}</h1>
          <div className="text-sm text-gray-500">{deskName} &middot; {STATUS_HINT[ticket.status]}</div>
        </div>

        <div className="flex flex-col gap-3">
          {messages.map((m) => {
            const mine = m.direction === 'inbound'
            return (
              <div key={m.id} className={`flex flex-col gap-1 max-w-[85%] ${mine ? 'self-end items-end' : 'self-start items-start'}`}>
                <div className="text-xs text-gray-500">
                  <span className="font-semibold text-gray-700">{mine ? 'You' : deskName}</span>
                  {' '}&middot;{' '}
                  <span title={new Date(m.created_at).toLocaleString()}>{relativeTime(m.created_at)}</span>
                </div>
                <div
                  className={`rounded-2xl px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-words ${mine ? 'text-white' : 'bg-white border border-gray-200 text-gray-900'}`}
                  style={mine ? { background: color } : undefined}
                >
                  {m.body}
                </div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>

        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>}

        <form onSubmit={send} className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3">
          <label htmlFor="comment" className="text-sm font-semibold text-gray-700">Add a comment</label>
          <textarea
            id="comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e) }}
            rows={4}
            maxLength={10000}
            placeholder="Write your reply to the help desk&hellip;"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-[15px] leading-relaxed focus:outline-none focus:border-gray-500"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-500">
              {['resolved', 'closed'].includes(ticket.status) ? 'Commenting will reopen this request.' : 'You can also reply by email.'}
            </div>
            <button
              type="submit"
              disabled={!comment.trim() || sending}
              className="min-h-[36px] px-4 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: color }}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  )
}
