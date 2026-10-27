import { createClient } from 'jsr:@supabase/supabase-js@2'

// Forwards a ticket's public thread to an address outside the desk, then
// closes it (spec section 9: "forward outside"). Called directly from the
// agent's browser. Unlike a reply (already saved to ticket_messages before
// it's sent — a failed send there is a soft failure), there's no earlier
// write here to strand, so this sends the email first and only then calls
// helpdesk.forward_ticket_outside() to close the ticket and record who it
// went to — a ticket is never marked "forwarded" unless it actually was.
// Internal notes are never included (same rule as generate-draft's thread).

const RESEND_FROM_ADDRESS = (Deno.env.get('HELPDESK_RESEND_FROM') || 'helpdesk@em.sil.org').split('<').pop()!.replace('>', '').trim()

interface SendForwardOutsideRequest {
  ticket_id: string
  to_email: string
  message?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const { ticket_id, to_email, message }: SendForwardOutsideRequest = await req.json()
    if (!ticket_id || !to_email) return json({ error: 'Missing required fields: ticket_id, to_email' }, 400)

    // Scoped to the caller's own session for every read below; the actual
    // authorization and state change happens in the RPC call at the end,
    // under this same session, so it can't go further than the caller could.
    const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      db: { schema: 'helpdesk' },
      global: { headers: { Authorization: authHeader } },
    })

    const sendKey = Deno.env.get('HELPDESK_RESEND_SENDING_API_KEY')
    if (!sendKey) return json({ error: 'HELPDESK_RESEND_SENDING_API_KEY is not configured' }, 500)

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    const { data: ticket, error: ticketErr } = await db.from('tickets')
      .select('id, ticket_number, subject, current_desk_id, requester:requesters(display_name, email)')
      .eq('id', ticket_id).maybeSingle()
    if (ticketErr) throw ticketErr
    if (!ticket) return json({ error: 'ticket not found' }, 404)

    const { data: desk, error: deskErr } = await db.from('desks').select('name').eq('id', ticket.current_desk_id).single()
    if (deskErr) throw deskErr

    const { data: addresses, error: addrErr } = await db.from('desk_addresses')
      .select('address, is_default_reply, live_replies').eq('desk_id', ticket.current_desk_id)
    if (addrErr) throw addrErr
    const fromAddress = addresses?.find((a) => a.is_default_reply) ?? addresses?.[0]
    if (!fromAddress) return json({ error: 'this desk has no address to forward from yet' }, 412)
    if (!fromAddress.live_replies) {
      return json({ error: `Live replies aren't turned on yet for ${fromAddress.address} (Admin > Addresses).` }, 412)
    }

    const { data: msgs, error: msgsErr } = await db.from('ticket_messages')
      .select('direction, body, author_email, profile_id, created_at')
      .eq('ticket_id', ticket_id).eq('internal', false).order('created_at')
    if (msgsErr) throw msgsErr

    const profileIds = [...new Set((msgs ?? []).map((m) => m.profile_id).filter(Boolean))]
    const nameById = new Map<string, string>()
    if (profileIds.length) {
      const pub = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
        auth: { persistSession: false },
      })
      const { data: profiles } = await pub.from('profiles').select('id, display_name').in('id', profileIds)
      for (const p of profiles ?? []) nameById.set(p.id, p.display_name)
    }

    const threadText = (msgs ?? []).map((m) => {
      const who = m.direction === 'inbound'
        ? (ticket.requester?.display_name || m.author_email || 'Reporter')
        : (nameById.get(m.profile_id) || 'Agent')
      return `${who} — ${new Date(m.created_at).toLocaleString()}\n${m.body}`
    }).join('\n\n---\n\n')

    const intro = (message || '').trim()
    const bodyText = [
      intro,
      `Forwarded from ${desk.name} — ticket #${ticket.ticket_number} (${ticket.requester?.email || 'unknown reporter'}):`,
      threadText,
    ].filter(Boolean).join('\n\n')

    const subject = ticket.subject && /^fwd:/i.test(ticket.subject) ? ticket.subject : `Fwd: ${ticket.subject || `Ticket #${ticket.ticket_number}`}`

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${desk.name} <${RESEND_FROM_ADDRESS}>`,
        to: [to_email],
        reply_to: fromAddress.address,
        subject,
        text: bodyText,
        html: textToHtml(bodyText),
      }),
    })
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`)

    const { error: rpcErr } = await asCaller.rpc('forward_ticket_outside', { p_ticket_id: ticket_id, p_to_email: to_email })
    if (rpcErr) throw rpcErr

    return json({ sent: true })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const paragraphs = escaped.split(/\n{2,}/).map((p) => p.split('\n').join('<br>'))
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n')
}

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
