import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildAssigneeEmail } from './message.ts'

// Emails a ticket's assigned agent when the requester updates it — an emailed
// reply (called by helpdesk-inbound with the service-role key) or a comment
// in the app (called from the reporter's browser with their own session).
// Nothing is sent for an unassigned ticket.
//
// Deployed --no-verify-jwt like the other functions, so authorization is done
// here: either the service-role key, or a caller whose own RLS-scoped session
// can see that exact inbound message on that ticket. Each message notifies at
// most once (assignee_notified_at is claimed atomically), so repeat or forged
// calls can't spam the agent.

const RESEND_FROM = Deno.env.get('HELPDESK_RESEND_FROM') || 'helpdesk@em.sil.org'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)
    const sendKey = Deno.env.get('HELPDESK_RESEND_SENDING_API_KEY')
    const appUrl = Deno.env.get('HELPDESK_APP_URL')
    if (!sendKey || !appUrl) return json({ error: 'HELPDESK_RESEND_SENDING_API_KEY / HELPDESK_APP_URL not configured' }, 500)

    const { ticket_id, message_id } = await req.json()
    if (!ticket_id || !message_id) return json({ error: 'Missing required fields: ticket_id, message_id' }, 400)

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const isService = await sameSecret(authHeader, `Bearer ${serviceKey}`)
    if (!isService) {
      const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        db: { schema: 'helpdesk' },
        global: { headers: { Authorization: authHeader } },
      })
      const { data: seen, error: seenErr } = await asCaller.from('ticket_messages')
        .select('id').eq('id', message_id).eq('ticket_id', ticket_id).maybeSingle()
      if (seenErr) throw seenErr
      if (!seen) return json({ error: 'message not found' }, 404)
    }

    const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })
    const { data: msg, error: msgErr } = await db.from('ticket_messages')
      .select('id, body, direction, internal, assignee_notified_at').eq('id', message_id).eq('ticket_id', ticket_id).maybeSingle()
    if (msgErr) throw msgErr
    if (!msg) return json({ error: 'message not found' }, 404)
    if (msg.direction !== 'inbound' || msg.internal) return json({ skipped: 'not a requester message' })

    const { data: t, error: tErr } = await db.from('tickets')
      .select('ticket_number, subject, status, assignee_profile_id, sender_email, requester:requesters(email), desks:desks!current_desk_id(name, slug)')
      .eq('id', ticket_id).maybeSingle()
    if (tErr) throw tErr
    if (!t || t.status === 'deleted') return json({ skipped: 'ticket not active' })
    if (!t.assignee_profile_id) return json({ skipped: 'unassigned' })

    // Claim before sending: a duplicate call finds nothing to claim.
    const { data: claimed, error: claimErr } = await db.from('ticket_messages')
      .update({ assignee_notified_at: new Date().toISOString() })
      .eq('id', message_id).is('assignee_notified_at', null).select('id')
    if (claimErr) throw claimErr
    if (!claimed?.length) return json({ skipped: 'already notified' })

    const pub = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false } })
    const { data: assignee, error: pErr } = await pub.from('profiles')
      .select('primary_email').eq('id', t.assignee_profile_id).maybeSingle()
    if (pErr) throw pErr
    if (!assignee?.primary_email) return json({ skipped: 'assignee has no email' })

    const desk = (t as unknown as { desks: { name: string; slug: string } }).desks
    const requester = (t as unknown as { requester: { email: string } | null }).requester
    const { subject, text } = buildAssigneeEmail({
      ticketNumber: t.ticket_number,
      subject: t.subject,
      requesterEmail: requester?.email ?? t.sender_email,
      deskName: desk.name,
      body: msg.body,
      via: isService ? 'email' : 'app',
      link: `${appUrl.replace(/\/$/, '')}/d/${desk.slug}/t/${t.ticket_number}`,
    })
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: assignee.primary_email, subject, text }),
    })
    if (!res.ok) {
      // Release the claim so a retry can try again.
      await db.from('ticket_messages').update({ assignee_notified_at: null }).eq('id', message_id)
      throw new Error(`Resend send failed: ${res.status} ${await res.text()}`)
    }
    return json({ notified: true })
  } catch (err) {
    console.error('notify-assignee failed:', (err as Error).message)
    return json({ error: (err as Error).message }, 500)
  }
})

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ])
  const x = new Uint8Array(ha)
  const y = new Uint8Array(hb)
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
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
