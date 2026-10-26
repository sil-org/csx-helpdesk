import { createClient } from 'jsr:@supabase/supabase-js@2'
import { ensureBucket, loadAddressMap, processEmail, ResendClient, verifyWebhook } from './resend.ts'
import type { Db } from './resend.ts'

// Receives Resend's `email.received` webhook and turns the email into a
// ticket (docs/HELPDESK_SPEC.md section 6). People write to their usual
// @sil.org desk addresses; each desk's Google Group (or an alias with a
// routing rule) also delivers a copy to a Resend receiving address, which
// calls this function. The logic lives in resend.ts; this file is only the
// HTTP entry point.
//
// The deploy uses --no-verify-jwt, so authentication is ours:
//   - Resend's calls are checked against RESEND_WEBHOOK_SECRET (Svix
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
    const webhookSecret = Deno.env.get('RESEND_WEBHOOK_SECRET')
    if (!webhookSecret) return json({ error: 'RESEND_WEBHOOK_SECRET is not configured' }, 500)
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

  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) return json({ error: 'RESEND_API_KEY is not configured' }, 500)

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
    return json(outcome)
  } catch (err) {
    console.error('helpdesk-inbound failed:', (err as Error).message)
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
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
