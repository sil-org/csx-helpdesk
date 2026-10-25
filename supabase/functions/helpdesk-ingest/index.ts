import { createClient } from 'jsr:@supabase/supabase-js@2'
import { Gmail, getAccessToken } from './gmail.ts'
import { ensureBucket, pollMailbox } from './poller.ts'
import type { Db, MailboxRow } from './poller.ts'

// Polls every enabled mailbox in helpdesk.desk_mailboxes and turns inbound
// mail into tickets (docs/HELPDESK_SPEC.md section 6). Meant to be called
// once a minute by pg_cron (see supabase/schedule_helpdesk_ingest.sql).
// The logic lives in poller.ts; this file is only the HTTP entry point.
//
// POST, with header x-helpdesk-secret: $HELPDESK_CRON_SECRET. The deploy
// workflow uses --no-verify-jwt, so this secret is the only thing stopping
// anyone on the internet from triggering a poll; the function refuses to run
// if it isn't configured.
//
// Optional JSON body:
//   { "mailbox": "x@sil.org" }        only poll that mailbox
//   { "retry_unrouted": true }        re-route messages parked as unrouted
//                                     (after adding the missing desk address)
//
// Not done here (later phases): reporter detection beyond a "forwarded"
// flag, acknowledgement emails, sending replies, attachment virus scanning.

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const secret = Deno.env.get('HELPDESK_CRON_SECRET')
  if (!secret) return json({ error: 'HELPDESK_CRON_SECRET is not configured' }, 500)
  if (!(await sameSecret(req.headers.get('x-helpdesk-secret') ?? '', secret))) {
    return json({ error: 'unauthorized' }, 401)
  }

  let opts: { mailbox?: string; retry_unrouted?: boolean } = {}
  try {
    opts = await req.json()
  } catch { /* no body is fine */ }

  try {
    const db: Db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    let mbQuery = db.from('desk_mailboxes').select('*').eq('enabled', true)
    if (opts.mailbox) mbQuery = mbQuery.eq('mailbox', opts.mailbox.toLowerCase())
    const { data: mailboxes, error: mbError } = await mbQuery
    if (mbError) throw mbError

    const { data: addresses, error: addrError } = await db.from('desk_addresses').select('address, desk_id')
    if (addrError) throw addrError
    const addressToDesk = new Map<string, string>(
      addresses.map((a: { address: string; desk_id: string }) => [a.address, a.desk_id])
    )

    await ensureBucket(db)

    const deps = {
      db,
      makeGmail: async (mb: MailboxRow) => new Gmail(await getAccessToken(mb, (n) => Deno.env.get(n))),
      config: {
        maxPerRun: Number(Deno.env.get('HELPDESK_MAX_PER_RUN') ?? 25),
        maxAttachmentBytes: Number(Deno.env.get('HELPDESK_MAX_ATTACHMENT_BYTES') ?? 10 * 1024 * 1024),
      },
    }

    const results = []
    for (const mb of mailboxes as MailboxRow[]) {
      results.push(await pollMailbox(deps, mb, addressToDesk, !!opts.retry_unrouted))
    }
    return json({ mailboxes: results })
  } catch (err) {
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
