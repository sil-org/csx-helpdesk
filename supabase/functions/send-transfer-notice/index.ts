import { createClient } from 'jsr:@supabase/supabase-js@2'

// Emails the reporter that their ticket moved to a new desk (spec section 9,
// decision 16). Called directly from the agent's browser right after
// helpdesk.transfer_ticket() succeeds — that RPC already re-checked
// can_work_ticket and moved the row, so this just re-reads the now-current
// desk and notifies. A failed send here is a soft failure: the transfer
// already happened and isn't undone, the same way a reply that fails to
// send still keeps its ticket_messages row (see send-reply).

const RESEND_FROM_ADDRESS = (Deno.env.get('HELPDESK_RESEND_FROM') || 'helpdesk@em.sil.org').split('<').pop()!.replace('>', '').trim()

interface SendTransferNoticeRequest {
  ticket_id: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const { ticket_id }: SendTransferNoticeRequest = await req.json()
    if (!ticket_id) return json({ error: 'Missing required field: ticket_id' }, 400)

    // Scoped to the caller's own session — after a transfer this is true for
    // the receiving desk's agents and, read-only, the sending desk's.
    const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      db: { schema: 'helpdesk' },
      global: { headers: { Authorization: authHeader } },
    })
    const { data: visible, error: visErr } = await asCaller.from('tickets').select('id').eq('id', ticket_id).maybeSingle()
    if (visErr) throw visErr
    if (!visible) return json({ error: 'ticket not found, or you cannot see it' }, 404)

    const sendKey = Deno.env.get('HELPDESK_RESEND_SENDING_API_KEY')
    if (!sendKey) return json({ error: 'HELPDESK_RESEND_SENDING_API_KEY is not configured' }, 500)

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    const { data: ticket, error: ticketErr } = await db.from('tickets')
      .select('id, ticket_number, subject, current_desk_id, requester:requesters(email)')
      .eq('id', ticket_id).single()
    if (ticketErr) throw ticketErr

    const to = ticket.requester?.email
    if (!to) return json({ skipped: 'no reporter email on file' })

    const { data: desk, error: deskErr } = await db.from('desks').select('name').eq('id', ticket.current_desk_id).single()
    if (deskErr) throw deskErr

    const { data: addresses, error: addrErr } = await db.from('desk_addresses')
      .select('address, is_default_reply, live_replies').eq('desk_id', ticket.current_desk_id)
    if (addrErr) throw addrErr
    const replyAddress = addresses?.find((a) => a.is_default_reply) ?? addresses?.[0]
    if (!replyAddress) return json({ skipped: 'the new desk has no address to notify from yet' })
    if (!replyAddress.live_replies) {
      return json({ skipped: `live replies aren't turned on yet for ${replyAddress.address} (Admin > Addresses)` })
    }

    const subject = ticket.subject && /^re:/i.test(ticket.subject) ? ticket.subject : `Re: ${ticket.subject || `Ticket #${ticket.ticket_number}`}`
    const text = `Your ticket has been moved to ${desk.name}. They'll take it from here — just reply to this email and it'll reach them.`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${desk.name} <${RESEND_FROM_ADDRESS}>`,
        to: [to],
        reply_to: replyAddress.address,
        subject,
        text,
        html: `<p>${text}</p>`,
      }),
    })
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`)

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
