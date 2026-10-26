// Run with: npm run test:inbound
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { normalizeHeaders, processEmail, ResendClient, verifyWebhook } from './resend.ts'
import type { ReceivedEmail } from './resend.ts'

// ── Fixtures: shaped like the real group-delivered mail from the Resend test ──

const GROUP_LIST = JSON.stringify({
  id: { name: 'helpdesk.sil.org' },
  post: { url: 'https://groups.google.com/a/sil.org/group/helpdesk/post', mail: 'helpdesk@sil.org' },
})

function groupMail(over: Partial<ReceivedEmail> & { headers?: Record<string, string> } = {}): ReceivedEmail {
  const { headers, ...rest } = over
  return {
    id: 'em-1',
    from: 'kate.maher.brenner@gmail.com',
    to: ['ingester@narabsaou.resend.app'], // the group rewrites To to our receiving address
    cc: [],
    subject: 'test 2',
    message_id: '<CAP1Lxyoc@mail.gmail.com>',
    text: 'now with attachys\n\nKate (Maher) Brenner\n\nTo unsubscribe from this group and stop receiving emails from it, send an email to helpdesk+unsubscribe@sil.org.\n',
    html: '<div>now with attachys</div>',
    received_for: ['ingester@narabsaou.resend.app', 'helpdesk@sil.org'],
    attachments: [],
    headers: {
      from: '"Kate Brenner" <kate.maher.brenner@gmail.com>',
      to: 'helpdesk@sil.org',
      'x-original-sender': 'kate.maher.brenner@gmail.com',
      'x-original-authentication-results': 'mx.google.com; dkim=pass; spf=pass; dmarc=pass',
      precedence: 'list',
      'mailing-list': 'list helpdesk@sil.org; contact helpdesk+owners@sil.org',
      list: GROUP_LIST,
      received: '["from a by b","from c by d"]',
      ...headers,
    },
    ...rest,
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

function makeDeps(email: ReceivedEmail, opts: { rpcResult?: unknown; rpcError?: string; attachmentBytes?: Uint8Array } = {}) {
  const calls = {
    rpc: [] as unknown[],
    logs: [] as Record<string, unknown>[],
    attachments: [] as Record<string, unknown>[],
    uploads: [] as string[],
  }
  const db = {
    rpc: async (_fn: string, args: unknown) => {
      calls.rpc.push(args)
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } }
      return {
        data: opts.rpcResult ?? { status: 'ingested', ticket_id: 't1', message_id: 'm1', created_ticket: true, reopened: false },
        error: null,
      }
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === 'ingest_log') calls.logs.push(row)
        if (table === 'ticket_attachments') calls.attachments.push(row)
        return { error: null }
      },
    }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          calls.uploads.push(path)
          return { error: null }
        },
      }),
    },
  }
  const resend = {
    getEmail: async () => email,
    getAttachment: async () => opts.attachmentBytes ?? new Uint8Array([1, 2, 3]),
  }
  return { deps: { db, resend, config: { maxAttachmentBytes: 1000 } }, calls }
}

const desks = new Map([['helpdesk@sil.org', 'desk-ghd'], ['btc@sil.org', 'desk-btc']])

// ── normalizeHeaders ─────────────────────────────────────────────────────

test('normalizeHeaders expands the pre-parsed list object and JSON-array headers', () => {
  const h = normalizeHeaders({
    list: GROUP_LIST,
    references: '["<a@x>","<b@y>"]',
    received: '["one","two"]',
    subject: 'Plain: [not json]',
    'x-note': '[not json',
  })
  const get = (n: string) => h.filter((x) => x.name === n).map((x) => x.value)
  assert.deepEqual(get('list-post'), ['<mailto:helpdesk@sil.org>'])
  assert.deepEqual(get('list-id'), ['<helpdesk.sil.org>'])
  assert.deepEqual(get('references'), ['<a@x> <b@y>'])
  assert.deepEqual(get('received'), ['one', 'two'])
  assert.deepEqual(get('subject'), ['Plain: [not json]'])
  assert.deepEqual(get('x-note'), ['[not json'])
})

// ── verifyWebhook (Svix) ─────────────────────────────────────────────────

const secretBytes = Buffer.from('0123456789abcdef0123456789abcdef')
const secret = 'whsec_' + secretBytes.toString('base64')
const sign = (id: string, ts: string, body: string) =>
  'v1,' + createHmac('sha256', secretBytes).update(`${id}.${ts}.${body}`).digest('base64')

test('verifyWebhook accepts a correct signature and rejects tampering, staleness and missing parts', async () => {
  const now = 1_800_000_000_000
  const ts = String(now / 1000)
  const body = '{"type":"email.received"}'
  const good = { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }
  assert.equal(await verifyWebhook(body, good, secret, now), true)
  // key rotation: any one of several signatures may match
  assert.equal(await verifyWebhook(body, { ...good, signature: 'v1,AAAA ' + good.signature }, secret, now), true)
  assert.equal(await verifyWebhook(body + ' ', good, secret, now), false)
  assert.equal(await verifyWebhook(body, { ...good, id: 'msg_2' }, secret, now), false)
  assert.equal(await verifyWebhook(body, good, 'whsec_' + Buffer.from('another-secret-another-secret!!').toString('base64'), now), false)
  assert.equal(await verifyWebhook(body, good, secret, now + 6 * 60 * 1000), false) // older than 5 minutes
  assert.equal(await verifyWebhook(body, { ...good, signature: null }, secret, now), false)
  assert.equal(await verifyWebhook(body, good, '', now), false)
  assert.equal(await verifyWebhook(body, { ...good, signature: good.signature.replace('v1', 'v2') }, secret, now), false)
})

// ── processEmail ─────────────────────────────────────────────────────────

test('group mail: routes by received_for/To, uses the original sender, strips the footer', async () => {
  const { deps, calls } = makeDeps(groupMail())
  const out = await processEmail(deps, 'em-1', desks)
  assert.deepEqual(out, { status: 'ingested', ticket_id: 't1', created: true, reopened: false })
  const p = (calls.rpc[0] as { p: Record<string, unknown> }).p
  assert.equal(p.desk_id, 'desk-ghd')
  assert.equal(p.source_address, 'helpdesk@sil.org')
  assert.equal(p.from_email, 'kate.maher.brenner@gmail.com')
  assert.equal(p.from_name, 'Kate Brenner')
  assert.equal(p.body, 'now with attachys\n\nKate (Maher) Brenner')
  assert.equal(p.gmail_message_id, 'em-1')
  assert.equal(p.rfc_message_id, '<CAP1Lxyoc@mail.gmail.com>')
  assert.equal(p.forwarded, false)
  assert.equal((p.headers as Record<string, unknown>).original_authentication_results, 'mx.google.com; dkim=pass; spf=pass; dmarc=pass')
  assert.equal(calls.logs[0].outcome, 'ingested')
})

test('routes by received_for alone when To has been rewritten and no list headers exist', async () => {
  const email = groupMail({ headers: { to: 'ingester@narabsaou.resend.app', 'mailing-list': '', list: '' } })
  const { deps, calls } = makeDeps(email)
  await processEmail(deps, 'em-1', desks)
  assert.equal((calls.rpc[0] as { p: { desk_id: string } }).p.desk_id, 'desk-ghd')
})

test('a rewritten From ("Pat via Help Desk") still yields the real sender from X-Original-Sender', async () => {
  const email = groupMail({
    from: 'helpdesk@sil.org',
    headers: { from: '"Pat via Help Desk" <helpdesk@sil.org>', 'x-original-sender': 'pat@strict-dmarc.org' },
  })
  const { deps, calls } = makeDeps(email)
  await processEmail(deps, 'em-1', desks)
  const p = (calls.rpc[0] as { p: Record<string, unknown> }).p
  assert.equal(p.from_email, 'pat@strict-dmarc.org')
  assert.equal(p.from_name, null) // the display name belonged to the group's address, not the person
})

test('a reply: threading ids pass through and quoted history is cut', async () => {
  const email = groupMail({
    id: 'em-2',
    subject: 'Re: [Request Received] test 2',
    message_id: '<reply@mail.gmail.com>',
    text: 'and a better test!\n\nKate\n\nOn Mon, Oct 26, 2026 at 8:54 AM SIL Global IT Helpdesk\n<service@youtrack.cloud> wrote:\n\n> old text\n\nTo unsubscribe from this group and stop receiving emails from it, send an email to helpdesk+unsubscribe@sil.org.\n',
    headers: {
      references: '["<CAP1Lxyoc@mail.gmail.com>","<ses-id@eu-west-1.amazonses.com>"]',
      'in-reply-to': '<ses-id@eu-west-1.amazonses.com>',
    },
  })
  const { deps, calls } = makeDeps(email)
  await processEmail(deps, 'em-2', desks)
  const p = (calls.rpc[0] as { p: Record<string, unknown> }).p
  assert.deepEqual(p.references, ['<CAP1Lxyoc@mail.gmail.com>', '<ses-id@eu-west-1.amazonses.com>'])
  assert.equal(p.in_reply_to, '<ses-id@eu-west-1.amazonses.com>')
  assert.equal(p.body, 'and a better test!\n\nKate')
})

test('a forward keeps its quoted content and is flagged', async () => {
  const email = groupMail({
    subject: 'Fwd: cannot log in',
    text: 'see below\n\n---------- Forwarded message ---------\nFrom: Pat <pat@x.org>\nSent: Monday\nTo: me\nSubject: cannot log in\n\nhelp',
    headers: { 'in-reply-to': '<x@y>' },
  })
  const { deps, calls } = makeDeps(email)
  await processEmail(deps, 'em-3', desks)
  const p = (calls.rpc[0] as { p: Record<string, unknown> }).p
  assert.equal(p.forwarded, true)
  assert.match(p.body as string, /cannot log in/)
  assert.match(p.body as string, /Forwarded message/)
})

test('falls back to html when there is no text part', async () => {
  const { deps, calls } = makeDeps(groupMail({ text: null, html: '<p>Hello&nbsp;<b>there</b></p>' }))
  await processEmail(deps, 'em-1', desks)
  assert.equal((calls.rpc[0] as { p: { body: string } }).p.body, 'Hello there')
})

test('unrouted mail is logged, not ingested', async () => {
  const email = groupMail({ received_for: ['ingester@narabsaou.resend.app', 'unknown@sil.org'], headers: { to: 'unknown@sil.org', 'mailing-list': '', list: '' } })
  const { deps, calls } = makeDeps(email)
  assert.deepEqual(await processEmail(deps, 'em-1', desks), { status: 'unrouted' })
  assert.equal(calls.rpc.length, 0)
  assert.equal(calls.logs[0].outcome, 'unrouted')
})

test('mail from one of our own desk addresses is skipped (loop protection)', async () => {
  const email = groupMail({ headers: { 'x-original-sender': 'btc@sil.org' } })
  const { deps, calls } = makeDeps(email)
  const out = await processEmail(deps, 'em-1', desks)
  assert.equal(out.status, 'skipped')
  assert.equal(calls.rpc.length, 0)
})

test('automatic replies are skipped; list mail (Precedence: list) is not', async () => {
  const auto = makeDeps(groupMail({ headers: { 'auto-submitted': 'auto-replied' } }))
  assert.equal((await processEmail(auto.deps, 'em-1', desks)).status, 'skipped')
  assert.equal(auto.calls.rpc.length, 0)
  const ok = makeDeps(groupMail())
  assert.equal((await processEmail(ok.deps, 'em-1', desks)).status, 'ingested')
})

test('a bounce naming a real recipient still becomes a ticket, at lower confidence', async () => {
  const { deps, calls } = makeDeps(groupMail({
    from: 'MAILER-DAEMON@amazonses.com',
    headers: {
      from: 'Mail Delivery System <MAILER-DAEMON@amazonses.com>',
      'content-type': 'multipart/report; report-type=delivery-status',
      'x-original-sender': '',
    },
    text: 'An error occurred while trying to deliver the mail to marc_aarnoudse@sil.org:\n' +
      'Remote host said: 550 5.1.1 unknown user\n\nMAILER-DAEMON@amazonses.com',
  }))
  const result = await processEmail(deps, 'em-1', desks)
  assert.equal(result.status, 'ingested')
  const p = (calls.rpc[0] as { p: Record<string, unknown> }).p
  assert.equal(p.forwarded_sender_email, 'marc_aarnoudse@sil.org')
  assert.equal(p.detected_sender_confidence, 0.4)
})

test('a bounce with no identifiable recipient is skipped as noise', async () => {
  const { deps, calls } = makeDeps(groupMail({
    from: 'MAILER-DAEMON@amazonses.com',
    headers: {
      from: 'Mail Delivery System <MAILER-DAEMON@amazonses.com>',
      'content-type': 'multipart/report; report-type=delivery-status',
      'x-original-sender': '',
    },
    text: 'This confirms your subscription request.\nMAILER-DAEMON@amazonses.com',
  }))
  assert.equal((await processEmail(deps, 'em-1', desks)).status, 'skipped')
  assert.equal(calls.rpc.length, 0)
})

test('a duplicate delivery changes nothing', async () => {
  const { deps, calls } = makeDeps(groupMail(), { rpcResult: { status: 'duplicate', ticket_id: 't1', message_id: 'm1' } })
  assert.deepEqual(await processEmail(deps, 'em-1', desks), { status: 'duplicate' })
  assert.equal(calls.logs.length, 0)
  assert.equal(calls.attachments.length, 0)
})

test('a database failure is logged and thrown so the webhook is retried', async () => {
  const { deps, calls } = makeDeps(groupMail(), { rpcError: 'boom' })
  await assert.rejects(processEmail(deps, 'em-1', desks), /boom/)
  assert.equal(calls.logs[0].outcome, 'error')
})

test('a failure fetching the email from Resend is logged and thrown', async () => {
  const { deps, calls } = makeDeps(groupMail())
  deps.resend.getEmail = async () => {
    throw new Error('Resend GET /emails/receiving/x -> 500')
  }
  await assert.rejects(processEmail(deps, 'em-1', desks), /500/)
  assert.equal(calls.logs[0].outcome, 'error')
})

test('attachments: stored, oversized ones recorded as skipped, failures recorded not lost', async () => {
  const email = groupMail({
    attachments: [
      { id: 'a1', filename: '../shot.png', content_type: 'image/png', size: 10 },
      { id: 'a2', filename: 'huge.zip', content_type: 'application/zip', size: 5000 },
      { id: 'a3', filename: 'bad.pdf', content_type: 'application/pdf', size: 10 },
    ],
  })
  const { deps, calls } = makeDeps(email)
  let n = 0
  deps.resend.getAttachment = async () => {
    if (++n === 2) throw new Error('attachment download -> 404') // a1 is call 1, a3 is call 2 (a2 is skipped by size)
    return new Uint8Array([1, 2, 3])
  }
  await processEmail(deps, 'em-1', desks)
  assert.equal(calls.uploads.length, 1)
  assert.ok(!calls.uploads[0].includes('..'))
  assert.equal(calls.attachments.length, 3)
  assert.equal(calls.attachments[0].storage_path, calls.uploads[0])
  assert.match(calls.attachments[1].skipped_reason as string, /larger than/)
  assert.match(calls.attachments[2].skipped_reason as string, /could not store/)
})

// ── ResendClient ─────────────────────────────────────────────────────────

test('ResendClient sends the bearer key, surfaces HTTP errors, and follows a download_url', async () => {
  const seen: { url: string; auth?: string }[] = []
  const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push({ url, auth: init?.headers?.Authorization })
    if (url.endsWith('/emails/receiving/em-1')) return new Response(JSON.stringify({ id: 'em-1' }), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/attachments/a1')) return new Response(JSON.stringify({ download_url: 'https://cdn.example/f' }), { headers: { 'content-type': 'application/json' } })
    if (url === 'https://cdn.example/f') return new Response(new Uint8Array([9, 8]))
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  const client = new ResendClient('re_key', fetchFn)
  assert.equal((await client.getEmail('em-1')).id, 'em-1')
  assert.equal(seen[0].auth, 'Bearer re_key')
  assert.deepEqual([...(await client.getAttachment('em-1', 'a1'))], [9, 8])
  assert.equal(seen[2].auth, undefined) // the signed download URL gets no API key
  await assert.rejects(client.getEmail('missing'), /404/)
})
