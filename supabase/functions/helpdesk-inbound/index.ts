import { createClient } from 'jsr:@supabase/supabase-js@2'
import { ensureBucket, loadAddressMap, processEmail, ResendClient, verifyWebhook } from './resend.ts'
import type { Db } from './resend.ts'
import { formatFrom } from '../_shared/sender.ts'
import { buildNewTicketEmail } from './notify.ts'

// Receives Resend's `email.received` webhook and turns the email into a
// ticket (docs/HELPDESK_SPEC.md section 6). People write to their usual
// @sil.org desk addresses; each desk's Google Group (or an alias with a
// routing rule) also delivers a copy to a Resend receiving address, which
// calls this function. The logic lives in resend.ts; this file is only the
// HTTP entry point.
//
// The deploy uses --no-verify-jwt, so authentication is ours:
//   - Resend's calls are checked against HELPDESK_RESEND_WEBHOOK_SECRET (Svix
//     signature). Without it the function refuses to run.
//   - Re-processing one stored email by hand (e.g. after adding a missing
//     desk address) needs header x-helpdesk-secret = HELPDESK_REPROCESS_SECRET
//     and body {"email_id": "..."}. If that secret isn't set, the path is off.
//
// Failures return 500 so Resend retries; duplicates are harmless because
// ingest_inbound dedupes on the Resend email id.
//
// Not done here (later phases): reporter detection beyond a "forwarded"
// flag, acknowledgement emails, sending replies, attachment virus scanning.

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const raw = await req.text()
  const reprocessHeader = req.headers.get('x-helpdesk-secret')

  let emailId: string | undefined
  if (reprocessHeader !== null) {
    const secret = Deno.env.get('HELPDESK_REPROCESS_SECRET')
    if (!secret || !(await sameSecret(reprocessHeader, secret))) return json({ error: 'unauthorized' }, 401)
    try {
      emailId = JSON.parse(raw).email_id
    } catch { /* handled below */ }
    if (!emailId) return json({ error: 'body must be {"email_id": "..."}' }, 400)
  } else {
    const webhookSecret = Deno.env.get('HELPDESK_RESEND_WEBHOOK_SECRET')
    if (!webhookSecret) return json({ error: 'HELPDESK_RESEND_WEBHOOK_SECRET is not configured' }, 500)
    const ok = await verifyWebhook(raw, {
      id: req.headers.get('svix-id'),
      timestamp: req.headers.get('svix-timestamp'),
      signature: req.headers.get('svix-signature'),
    }, webhookSecret)
    if (!ok) return json({ error: 'bad signature' }, 401)

    let event: { type?: string; data?: { email_id?: string } }
    try {
      event = JSON.parse(raw)
    } catch {
      return json({ error: 'invalid JSON' }, 400)
    }
    if (event.type !== 'email.received') return json({ ignored: event.type ?? 'unknown' })
    emailId = event.data?.email_id
    if (!emailId) return json({ error: 'event has no data.email_id' }, 400)
  }

  const apiKey = Deno.env.get('HELPDESK_RESEND_API_KEY')
  if (!apiKey) return json({ error: 'HELPDESK_RESEND_API_KEY is not configured' }, 500)

  try {
    const db: Db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })
    await ensureBucket(db)
    const outcome = await processEmail(
      {
        db,
        resend: new ResendClient(apiKey),
        config: { maxAttachmentBytes: Number(Deno.env.get('HELPDESK_MAX_ATTACHMENT_BYTES') ?? 10 * 1024 * 1024) },
      },
      emailId,
      await loadAddressMap(db)
    )
    if (outcome.status === 'ingested') {
      triggerDraft(outcome.ticket_id)
      if (outcome.created) background(notifyNewTicket(db, outcome.ticket_id))
      else triggerAssigneeNotice(outcome.ticket_id, outcome.message_id)
    }
    return json(outcome)
  } catch (err) {
    console.error('helpdesk-inbound failed:', (err as Error).message)
    return json({ error: (err as Error).message }, 500)
  }
})

// Fire-and-forget: a new ticket, or a new non-internal requester reply,
// kicks off generate-draft in the background without awaiting it, so a slow
// or down Claude API can never affect this webhook's response to Resend
// (which retries the whole thing on timeout) or ingestion reliability.
// A failed draft call just means no draft — a soft failure, not a broken ticket.
function triggerDraft(ticketId: string) {
  const call = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-draft`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket_id: ticketId }),
  }).catch((err) => console.error('generate-draft trigger failed:', err.message))

  background(call)
}

// A requester reply on an existing ticket emails its assigned agent (a no-op
// when unassigned). Same fire-and-forget shape as triggerDraft.
function triggerAssigneeNotice(ticketId: string, messageId: string) {
  const call = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notify-assignee`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ticket_id: ticketId, message_id: messageId }),
  }).catch((err) => console.error('notify-assignee trigger failed:', err.message))

  background(call)
}

// EdgeRuntime is a Supabase Edge Functions global (not in standard Deno
// lib types) that keeps background work alive after the response is sent.
function background(p: Promise<unknown>) {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
  if (runtime) runtime.waitUntil(p)
}

// Emails every agent and admin on the ticket's desk when a brand-new ticket
// is created, plus any extra addresses in HELPDESK_NEW_TICKET_NOTIFY
// (comma-separated, optional). Never throws: a failed alert must not affect
// ingestion or make Resend retry.
async function notifyNewTicket(db: Db, ticketId: string) {
  try {
    const sendKey = Deno.env.get('HELPDESK_RESEND_SENDING_API_KEY')
    const appUrl = Deno.env.get('HELPDESK_APP_URL')
    if (!sendKey || !appUrl) {
      console.error('new-ticket notify skipped: HELPDESK_RESEND_SENDING_API_KEY / HELPDESK_APP_URL not set')
      return
    }
    const { data: t, error } = await db.from('tickets')
      .select('ticket_number, subject, sender_email, current_desk_id, desks:desks!current_desk_id(name, slug)')
      .eq('id', ticketId).maybeSingle()
    if (error || !t) throw new Error(error?.message ?? 'ticket not found')
    const desk = (t as { desks: { name: string; slug: string } }).desks

    const { data: members, error: mErr } = await db.from('agent_desks').select('profile_id').eq('desk_id', t.current_desk_id)
    if (mErr) throw mErr
    const ids = (members ?? []).map((m: { profile_id: string }) => m.profile_id)
    const emails: string[] = []
    if (ids.length) {
      // profiles lives in public, not the helpdesk schema this client targets.
      const pub = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
        auth: { persistSession: false },
      })
      const { data: profiles, error: pErr } = await pub.from('profiles').select('primary_email').in('id', ids)
      if (pErr) throw pErr
      for (const p of profiles ?? []) if (p.primary_email) emails.push(p.primary_email)
    }
    for (const a of (Deno.env.get('HELPDESK_NEW_TICKET_NOTIFY') ?? '').split(',')) if (a.trim()) emails.push(a.trim())
    const to = [...new Set(emails.map((e) => e.toLowerCase()))]
    if (!to.length) return

    const { subject, text } = buildNewTicketEmail({
      ticketNumber: t.ticket_number,
      subject: t.subject,
      senderEmail: t.sender_email,
      deskName: desk.name,
      link: `${appUrl.replace(/\/$/, '')}/d/${desk.slug}/t/${t.ticket_number}`,
    })
    // One message per recipient so agents don't see each other's addresses
    // and one bad address can't block the rest.
    const from = formatFrom(desk.name, Deno.env.get('HELPDESK_RESEND_FROM'))
    await Promise.all(to.map(async (addr) => {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: addr, subject, text }),
      })
      if (!res.ok) console.error(`new-ticket notify to ${addr} failed: ${res.status} ${await res.text()}`)
    }))
  } catch (err) {
    console.error('new-ticket notify failed:', (err as Error).message)
  }
}

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
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
