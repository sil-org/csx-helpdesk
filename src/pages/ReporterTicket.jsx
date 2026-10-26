import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { hd, REPORTER_STATUS_LABEL } from '../lib/helpdesk'
import StatusPill from '../components/StatusPill'

// Read-only — RLS (ticket_messages_select) already excludes internal notes
// for a reporter, and is_ticket_reporter excludes Deleted tickets entirely.
// Reporters reply by email, not through the app (there's no insert policy
// granting them ticket_messages insert), so there's no compose box here.
export default function ReporterTicket() {
  const { ticketNumber } = useParams()
  const [ticket, setTicket] = useState(undefined)
  const [messages, setMessages] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    hd.from('tickets')
      .select('id, ticket_number, subject, status, current_desk:desks!tickets_current_desk_id_fkey(name)')
      .eq('ticket_number', ticketNumber)
      .maybeSingle()
      .then(async ({ data: t, error }) => {
        if (error) setError(error.message)
        setTicket(t ?? null)
        if (t) {
          const { data, error: mErr } = await hd.from('ticket_messages').select('*').eq('ticket_id', t.id).order('created_at')
          if (mErr) setError(mErr.message)
          setMessages(data ?? [])
        }
      })
  }, [ticketNumber])

  if (ticket === undefined) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading&hellip;</div>
  if (ticket === null) return <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">Ticket not found.</div>

  return (
    <div className="min-h-screen" style={{ background: '#F9F5F9' }}>
      <div className="px-6 py-3 bg-white border-b" style={{ borderColor: '#E9D7E8' }}>
        <Link to="/my-tickets" className="text-sm font-semibold" style={{ color: '#6B2169' }}>&larr; My tickets</Link>
      </div>
      <div className="max-w-[760px] w-full mx-auto px-6 py-8 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-gray-500">#{ticket.ticket_number}</span>
          <StatusPill status={ticket.status} label={REPORTER_STATUS_LABEL[ticket.status]} />
        </div>
        <h1 className="font-display text-[26px] m-0">{ticket.subject || '(no subject)'}</h1>
        <div className="text-sm text-gray-500 -mt-2">{ticket.current_desk?.name}</div>

        {messages.map((m) => (
          <div key={m.id} className="bg-white border rounded-xl p-5 flex flex-col gap-2" style={{ borderColor: '#E9D7E8' }}>
            <div className="flex justify-between gap-2 text-xs text-gray-500">
              <span className="text-sm font-bold text-gray-900">{m.direction === 'inbound' ? 'You' : 'Help desk'}</span>
              {new Date(m.created_at).toLocaleString()}
            </div>
            <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{m.body}</div>
          </div>
        ))}

        <div className="text-xs text-gray-500">To reply, just email the help desk address directly — your reply threads onto this ticket automatically.</div>
      </div>
    </div>
  )
}
