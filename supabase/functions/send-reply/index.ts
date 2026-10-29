import { createClient } from 'jsr:@supabase/supabase-js@2'
import { formatFrom } from '../_shared/sender.ts'
import { textToHtml } from './textToHtml.ts'

// Actually sends a ticket reply by email (spec section 6 "Sending"). Called
// directly from the agent's browser right after the reply is inserted into
// ticket_messages (that insert already passed ticket_messages_insert's own
// can_work_ticket check — this function re-checks it under the caller's own
// JWT before doing anything privileged, rather than trusting a bare message_id).
//
// Deployed with JWT verification ON (unlike the cron-triggered functions):
// this is called by a signed-in agent's own session, not a trusted backend.
//
// live_replies gate (desk_addresses): per the parallel-run design, a desk
// address stays in shadow mode (read and draft, no replies) until someone
// deliberately turns this on for it in Admin. Sending refuses to fire
// without it, on purpose — never silently falls back to "send anyway."

const RESEND_FROM = Deno.env.get('HELPDESK_RESEND_FROM')

interface SendReplyRequest {
  message_id: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const { message_id }: SendReplyRequest = await req.json()
    if (!message_id) return json({ error: 'Missing required field: message_id' }, 400)

    // Scoped to the caller's own session — RLS decides what they can see.
    // A real-but-unauthorized message_id simply won't be found.
    const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      db: { schema: 'helpdesk' },
      global: { headers: { Authorization: authHeader } },
    })
    const { data: msg, error: msgErr } = await asCaller.from('ticket_messages')
      .select('id, ticket_id, body, direction, internal').eq('id', message_id).maybeSingle()
    if (msgErr) throw msgErr
    if (!msg) return json({ error: 'message not found, or you cannot work this ticket' }, 404)
    if (msg.direction !== 'outbound' || msg.internal) return json({ error: 'only a public outbound reply can be sent' }, 400)

    const sendKey = Deno.env.get('HELPDESK_RESEND_SENDING_API_KEY')
    if (!sendKey) return json({ error: 'HELPDESK_RESEND_SENDING_API_KEY is not configured' }, 500)

    // Service role from here on: updating ticket_messages with the sent
    // email's id isn't in authenticated's column grants (every other path
    // to it is an ingestion/system write), and we need every CC/desk field
    // regardless of the narrower columns RLS exposes to a desk agent.
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    const { data: ticket, error: ticketErr } = await db.from('tickets')
      .select('id, ticket_number, subject, source_address, current_desk_id, requester:requesters(email)')
      .eq('id', msg.ticket_id).single()
    if (ticketErr) throw ticketErr

    const { data: desk, error: deskErr } = await db.from('desks').select('name').eq('id', ticket.current_desk_id).single()
    if (deskErr) throw deskErr

    const { data: addresses, error: addrErr } = await db.from('desk_addresses')
      .select('address, is_default_reply, live_replies').eq('desk_id', ticket.current_desk_id)
    if (addrErr) throw addrErr
    const replyAddress = addresses?.find((a) => a.address === ticket.source_address)
      ?? addresses?.find((a) => a.is_default_reply)
      ?? addresses?.[0]
    if (!replyAddress) return json({ error: 'this desk has no address to reply from yet' }, 412)
    if (!replyAddress.live_replies) {
      return json({ error: `Live replies aren't turned on yet for ${replyAddress.address} (Admin > Addresses).` }, 412)
    }

    const { data: ccs } = await db.from('ticket_participants').select('email').eq('ticket_id', ticket.id).eq('type', 'cc')
    const { data: lastInbound } = await db.from('ticket_messages')
      .select('rfc_message_id').eq('ticket_id', ticket.id).eq('direction', 'inbound')
      .not('rfc_message_id', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle()

    const ourMessageId = `<ticket-${ticket.id}-${msg.id}@em.sil.org>`
    const subject = ticket.subject && /^re:/i.test(ticket.subject) ? ticket.subject : `Re: ${ticket.subject || `Ticket #${ticket.ticket_number}`}`
    const headers: Record<string, string> = { 'Message-ID': ourMessageId }
    if (lastInbound?.rfc_message_id) {
      headers['In-Reply-To'] = lastInbound.rfc_message_id
      headers['References'] = lastInbound.rfc_message_id
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: formatFrom(desk.name, RESEND_FROM),
        to: [ticket.requester?.email ?? ticket.source_address].filter(Boolean),
        cc: (ccs ?? []).map((c) => c.email),
        reply_to: replyAddress.address,
        subject,
        text: msg.body,
        html: textToHtml(msg.body),
        headers,
      }),
    })
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`)
    const sent = await res.json()

    const { error: updateErr } = await db.from('ticket_messages')
      .update({ external_message_id: sent.id, rfc_message_id: ourMessageId })
      .eq('id', msg.id)
    if (updateErr) throw updateErr

    return json({ sent: true })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}
