// Tests for the polling glue (labels, routing, loop protection, attachments,
// retries) using an in-memory fake database and fake Gmail. The SQL side
// (ingest_inbound, RLS) is covered by supabase/tests/helpdesk_rls.test.sql;
// the real Gmail API and PostgREST are not exercised here.
//
// node --experimental-strip-types --test supabase/functions/helpdesk-ingest/poller.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { pollMailbox, PROCESSED_LABEL, UNROUTED_LABEL, FAILED_LABEL } from './poller.ts'
import type { Deps, GmailApi, MailboxRow } from './poller.ts'
import type { GmailMessage } from './gmail.ts'

const b64 = (s: string) => Buffer.from(s).toString('base64url')

// ── fakes ────────────────────────────────────────────────────────────────

class Query {
  db: FakeDb
  table: string
  mode = 'select'
  payload: any
  filters: [string, any][] = []
  isSingle = false
  constructor(db: FakeDb, table: string) {
    this.db = db
    this.table = table
  }
  insert(p: any) { this.mode = 'insert'; this.payload = p; return this }
  update(p: any) { this.mode = 'update'; this.payload = p; return this }
  select(_c?: string) { return this }
  eq(c: string, v: any) { this.filters.push([c, v]); return this }
  order(_c?: string, _o?: any) { return this }
  limit(_n: number) { return this }
  single() { this.isSingle = true; return this }
  maybeSingle() { this.isSingle = true; return this }
  then(res: any, rej: any) { return Promise.resolve(this.exec()).then(res, rej) }
  exec() {
    const db = this.db
    if (this.table === 'ingest_runs' && this.mode === 'insert') {
      const row = { id: `run${db.runs.length + 1}`, ...this.payload }
      db.runs.push(row)
      return { data: { id: row.id }, error: null }
    }
    if (this.table === 'ingest_runs' && this.mode === 'update') {
      const id = this.filters.find(([c]) => c === 'id')?.[1]
      Object.assign(db.runs.find((r) => r.id === id), this.payload)
      return { data: null, error: null }
    }
    if (this.table === 'ingest_log' && this.mode === 'insert') {
      db.logs.push({ ...this.payload })
      return { data: null, error: null }
    }
    if (this.table === 'ingest_log' && this.mode === 'select') {
      const rows = db.logs.filter((r) => this.filters.every(([c, v]) => r[c] === v))
      return { data: rows.length ? rows[rows.length - 1] : null, error: null }
    }
    if (this.table === 'ticket_attachments' && this.mode === 'insert') {
      db.attachments.push({ ...this.payload })
      return { data: null, error: null }
    }
    throw new Error(`FakeDb: unsupported ${this.mode} on ${this.table}`)
  }
}

class FakeDb {
  runs: any[] = []
  logs: any[] = []
  attachments: any[] = []
  rpcCalls: any[] = []
  uploads: string[] = []
  failUploads = false
  nextIngest: any = null // override rpc result
  n = 0
  from(table: string) { return new Query(this, table) }
  rpc(name: string, args: any) {
    this.rpcCalls.push({ name, args })
    const data = this.nextIngest ?? { status: 'ingested', ticket_id: `t${++this.n}`, message_id: `m${this.n}` }
    return Promise.resolve({ data, error: null })
  }
  storage = {
    from: (_bucket: string) => ({
      upload: async (path: string, _bytes: Uint8Array, _o: any) => {
        if (this.failUploads) return { error: { message: 'bucket on fire' } }
        this.uploads.push(path)
        return { error: null }
      },
    }),
  }
}

class FakeGmail implements GmailApi {
  labels = new Map<string, string>([['INBOX', 'INBOX']])
  msgs = new Map<string, { m: GmailMessage; labels: Set<string> }>()
  attachments = new Map<string, Uint8Array>()
  failGet = new Set<string>()
  fetched: string[] = []

  add(m: GmailMessage, labelNames: string[] = ['INBOX']) {
    this.msgs.set(m.id, { m, labels: new Set(labelNames.map((n) => this.idFor(n))) })
  }
  idFor(name: string) {
    if (!this.labels.has(name)) this.labels.set(name, `L_${name}`)
    return this.labels.get(name)!
  }
  has(id: string, name: string) { return this.msgs.get(id)!.labels.has(this.labels.get(name) ?? '__none__') }

  async ensureLabel(name: string) { return this.idFor(name) }
  async findLabel(name: string) { return this.labels.get(name) ?? null }
  async listMessageIds(q: string, max: number) {
    const terms = [...q.matchAll(/(-?)(in|label|newer_than):("[^"]+"|\S+)/g)]
    const out: string[] = []
    for (const [id, { labels }] of this.msgs) {
      const ok = terms.every(([, neg, key, raw]) => {
        const val = raw.replace(/^"|"$/g, '')
        if (key === 'newer_than') return true
        const labelId = key === 'in' ? this.labels.get(val.toUpperCase()) : this.labels.get(val)
        const has = labelId !== undefined && labels.has(labelId)
        return neg ? !has : has
      })
      if (ok) out.push(id)
    }
    return out.slice(0, max)
  }
  async getMessage(id: string) {
    this.fetched.push(id)
    if (this.failGet.has(id)) throw new Error('Gmail API error 500')
    return this.msgs.get(id)!.m
  }
  async getAttachment(_mid: string, aid: string) { return this.attachments.get(aid) ?? new Uint8Array(3) }
  async modifyLabels(id: string, add: string[], remove: string[]) {
    const s = this.msgs.get(id)!.labels
    add.forEach((l) => s.add(l))
    remove.forEach((l) => s.delete(l))
  }
}

function mk(id: string, o: {
  from?: string; to?: string; subject?: string; body?: string; thread?: string
  headers?: Record<string, string>; parts?: any[]
}): GmailMessage {
  const headers = Object.entries({
    From: o.from ?? 'Pat <pat@example.org>',
    To: o.to ?? 'dallas-help@sil.org',
    Subject: o.subject ?? 'Printer broken',
    'Message-ID': `<${id}@x>`,
    ...(o.headers ?? {}),
  }).map(([name, value]) => ({ name, value }))
  const text = { mimeType: 'text/plain', body: { data: b64(o.body ?? 'It is on fire') } }
  return {
    id,
    threadId: o.thread ?? `th-${id}`,
    snippet: (o.body ?? 'It is on fire').slice(0, 50),
    payload: o.parts
      ? { mimeType: 'multipart/mixed', headers, parts: [text, ...o.parts] }
      : { ...text, headers },
  } as GmailMessage
}

const SA: MailboxRow = { mailbox: 'helpdesk-ingest@sil.org', desk_id: null, auth_type: 'service_account', secret_prefix: null, isolation_label: null }
const ADDRESSES = new Map([['dallas-help@sil.org', 'desk-dallas'], ['git-help@sil.org', 'desk-git']])

function setup(config = { maxPerRun: 25, maxAttachmentBytes: 10 * 1024 * 1024 }) {
  const db = new FakeDb()
  const gmail = new FakeGmail()
  const deps: Deps = { db, makeGmail: async () => gmail, config }
  const poll = (mb = SA, addrs = ADDRESSES, retry = false) => pollMailbox(deps, mb, addrs, retry)
  return { db, gmail, deps, poll }
}

// ── tests ────────────────────────────────────────────────────────────────

test('a normal email becomes a ticket via ingest_inbound and is archived and marked processed', async () => {
  const { db, gmail, poll } = setup()
  gmail.add(mk('g1', { from: '"Pat Smith" <Pat@Example.org>', body: 'It is on fire' }))
  const r = await poll()
  assert.deepEqual([r.processed, r.ingested, r.skipped, r.unrouted, r.errors, r.error], [1, 1, 0, 0, 0, null])
  const p = db.rpcCalls[0].args.p
  assert.equal(db.rpcCalls[0].name, 'ingest_inbound')
  assert.equal(p.desk_id, 'desk-dallas')
  assert.equal(p.source_address, 'dallas-help@sil.org')
  assert.equal(p.from_email, 'pat@example.org')
  assert.equal(p.from_name, 'Pat Smith')
  assert.equal(p.subject, 'Printer broken')
  assert.equal(p.body, 'It is on fire')
  assert.equal(p.gmail_message_id, 'g1')
  assert.equal(p.rfc_message_id, '<g1@x>')
  assert.equal(p.forwarded, false)
  assert.ok(gmail.has('g1', PROCESSED_LABEL))
  assert.ok(!gmail.has('g1', 'INBOX'))
  // run bookkeeping
  assert.equal(db.runs.length, 1)
  assert.ok(db.runs[0].finished_at)
  assert.equal(db.runs[0].ingested, 1)
  // second poll finds nothing: processed mail is excluded
  const r2 = await poll()
  assert.equal(r2.processed, 0)
  assert.equal(db.rpcCalls.length, 1)
})

test('mail delivered through a group routes by the group header, is flagged forwarded, and loses the group footer', async () => {
  const { db, gmail, poll } = setup()
  gmail.add(mk('g2', {
    to: 'Some Other <other@example.org>',
    subject: 'Fwd: login problem',
    body: 'see below\n---------- Forwarded message ---------\nFrom: Maria <maria@sil.org>\n\nI cannot log in\n\n--\nYou received this message because you are subscribed to the Google Groups "Global IT" group.\nTo unsubscribe from this group, send an email to git-help+unsubscribe@sil.org.',
    headers: { 'Delivered-To': 'helpdesk-ingest@sil.org', 'List-Post': '<mailto:git-help@sil.org>', 'References': '<a@x> <b@x>', 'In-Reply-To': '<b@x>' },
  }))
  await poll()
  const p = db.rpcCalls[0].args.p
  assert.equal(p.desk_id, 'desk-git')
  assert.equal(p.source_address, 'git-help@sil.org')
  assert.equal(p.forwarded, true)
  assert.ok(!p.body.includes('You received this message'))
  assert.ok(p.body.includes('I cannot log in'))
  assert.deepEqual(p.references, ['<a@x>', '<b@x>'])
  assert.equal(p.in_reply_to, '<b@x>')
})

test('automatic replies and mail from our own addresses are skipped, logged, and never become tickets', async () => {
  const { db, gmail, poll } = setup()
  gmail.add(mk('auto', { headers: { 'Auto-Submitted': 'auto-replied' }, subject: 'Automatic reply: help' }))
  gmail.add(mk('own', { from: 'Dallas Help <dallas-help@sil.org>' }))
  gmail.add(mk('self', { from: 'helpdesk-ingest@sil.org' }))
  const r = await poll()
  assert.equal(r.skipped, 3)
  assert.equal(db.rpcCalls.length, 0)
  assert.deepEqual(db.logs.map((l) => [l.gmail_message_id, l.outcome]).sort(), [['auto', 'skipped'], ['own', 'skipped'], ['self', 'skipped']])
  assert.match(db.logs.find((l) => l.gmail_message_id === 'auto').reason, /Auto-Submitted/)
  for (const id of ['auto', 'own', 'self']) assert.ok(gmail.has(id, PROCESSED_LABEL))
})

test('mail matching no desk is parked once as unrouted, then routed on retry after the address is added', async () => {
  const { db, gmail, poll } = setup()
  gmail.add(mk('u1', { to: 'africa-help@sil.org' }))
  const r1 = await poll()
  assert.equal(r1.unrouted, 1)
  assert.equal(db.rpcCalls.length, 0)
  assert.equal(db.logs.filter((l) => l.outcome === 'unrouted').length, 1)
  assert.ok(gmail.has('u1', UNROUTED_LABEL))
  assert.ok(gmail.has('u1', 'INBOX'), 'unrouted mail stays in the inbox')

  const r2 = await poll() // normal polls ignore it: no duplicate log rows
  assert.equal(r2.processed, 0)
  assert.equal(db.logs.filter((l) => l.outcome === 'unrouted').length, 1)

  // still unrouted on retry: nothing changes
  const r3 = await poll(SA, ADDRESSES, true)
  assert.equal(r3.unrouted, 1)
  assert.equal(db.logs.filter((l) => l.outcome === 'unrouted').length, 1)

  // the super admin adds the address, then retries
  const more = new Map(ADDRESSES).set('africa-help@sil.org', 'desk-africa')
  const r4 = await poll(SA, more, true)
  assert.equal(r4.ingested, 1)
  assert.equal(db.rpcCalls[0].args.p.desk_id, 'desk-africa')
  assert.ok(gmail.has('u1', PROCESSED_LABEL))
  assert.ok(!gmail.has('u1', UNROUTED_LABEL))
  assert.ok(!gmail.has('u1', 'INBOX'))
})

test('attachments are stored, oversize ones are recorded as skipped, upload failures do not lose the ticket', async () => {
  const { db, gmail, poll } = setup({ maxPerRun: 25, maxAttachmentBytes: 1000 })
  gmail.add(mk('a1', { parts: [
    { mimeType: 'application/pdf', filename: 'small.pdf', body: { attachmentId: 'at1', size: 10 } },
    { mimeType: 'video/mp4', filename: 'huge.mp4', body: { attachmentId: 'at2', size: 5_000_000 } },
  ] }))
  await poll()
  assert.deepEqual(db.uploads, ['t1/m1/0-small.pdf'])
  const small = db.attachments.find((a) => a.filename === 'small.pdf')
  const huge = db.attachments.find((a) => a.filename === 'huge.mp4')
  assert.equal(small.storage_path, 't1/m1/0-small.pdf')
  assert.equal(huge.storage_path, undefined)
  assert.match(huge.skipped_reason, /larger than/)

  db.failUploads = true
  gmail.add(mk('a2', { parts: [{ mimeType: 'image/png', filename: 'x.png', body: { attachmentId: 'at3', size: 10 } }] }))
  const r = await poll()
  assert.equal(r.ingested, 1)
  assert.equal(r.errors, 0)
  assert.match(db.attachments.find((a) => a.filename === 'x.png').skipped_reason, /upload failed: bucket on fire/)
  assert.ok(gmail.has('a2', PROCESSED_LABEL))
})

test('a duplicate from ingest_inbound does no attachment work but is still marked processed', async () => {
  const { db, gmail, poll } = setup()
  db.nextIngest = { status: 'duplicate', ticket_id: 't9', message_id: 'm9' }
  gmail.add(mk('d1', { parts: [{ mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'at1', size: 10 } }] }))
  const r = await poll()
  assert.deepEqual([r.ingested, r.skipped], [0, 1])
  assert.equal(db.uploads.length, 0)
  assert.ok(gmail.has('d1', PROCESSED_LABEL))
})

test('a message that keeps failing is parked after three attempts without blocking the others', async () => {
  const { db, gmail, poll } = setup()
  gmail.add(mk('bad', {}))
  gmail.failGet.add('bad')
  gmail.add(mk('good', {}))

  const r1 = await poll()
  assert.deepEqual([r1.processed, r1.ingested, r1.errors], [2, 1, 1])
  const r2 = await poll()
  assert.deepEqual([r2.processed, r2.errors], [1, 1])
  assert.ok(!gmail.has('bad', FAILED_LABEL))
  const r3 = await poll()
  assert.equal(r3.errors, 1)
  assert.deepEqual(db.logs.filter((l) => l.outcome === 'error').map((l) => l.attempts), [1, 2, 3])
  assert.ok(gmail.has('bad', FAILED_LABEL), 'parked after the third failure')
  const r4 = await poll()
  assert.equal(r4.processed, 0)
})

test('an isolated mailbox only ever sees labelled mail, falls back to its desk, and leaves the inbox alone', async () => {
  const { db, gmail, poll } = setup()
  const pilot: MailboxRow = { mailbox: 'info@btconference.org', desk_id: 'desk-pilot', auth_type: 'oauth', secret_prefix: 'HELPDESK_BTC', isolation_label: 'HelpdeskPilot' }
  gmail.add(mk('p1', { to: 'helpdesk-test@btconference.org' }), ['INBOX', 'HelpdeskPilot'])
  gmail.add(mk('real', { to: 'info@btconference.org', subject: 'Conference registration' }), ['INBOX'])
  const r = await poll(pilot)
  assert.equal(r.ingested, 1)
  assert.equal(db.rpcCalls[0].args.p.desk_id, 'desk-pilot')
  assert.equal(db.rpcCalls[0].args.p.source_address, null)
  assert.ok(gmail.has('p1', PROCESSED_LABEL))
  assert.ok(!gmail.has('p1', 'HelpdeskPilot'), 'isolation label removed')
  assert.ok(gmail.has('p1', 'INBOX'), 'inbox untouched on an isolated mailbox')
  assert.ok(!gmail.fetched.includes('real'), 'unlabelled mail is never even fetched')
  assert.ok(!gmail.has('real', PROCESSED_LABEL))
})

test('a missing isolation label, or a failing token, is recorded on the run and does not throw', async () => {
  const { db, gmail, deps } = setup()
  const bad: MailboxRow = { ...SA, isolation_label: 'NoSuchLabel' }
  const r = await pollMailbox(deps, bad, ADDRESSES, false)
  assert.match(r.error!, /isolation label "NoSuchLabel" not found/)
  assert.equal(r.processed, 0)
  assert.match(db.runs[0].error, /not found/)
  assert.ok(db.runs[0].finished_at)

  const broken: Deps = { ...deps, makeGmail: async () => { throw new Error('Google token request failed (401)') } }
  const r2 = await pollMailbox(broken, SA, ADDRESSES, false)
  assert.match(r2.error!, /token request failed/)
  assert.equal(gmail.fetched.length, 0)
})

test('maxPerRun caps how many messages one poll handles', async () => {
  const { gmail, poll, db } = setup({ maxPerRun: 2, maxAttachmentBytes: 1000 })
  for (let i = 0; i < 5; i++) gmail.add(mk(`c${i}`, {}))
  assert.equal((await poll()).processed, 2)
  assert.equal((await poll()).processed, 2)
  assert.equal((await poll()).processed, 1)
  assert.equal(db.rpcCalls.length, 5)
})
