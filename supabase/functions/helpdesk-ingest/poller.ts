import type { GmailMessage } from './gmail.ts'
import {
  autoReplyReason,
  candidateAddresses,
  extractBody,
  getHeader,
  listAttachments,
  looksForwarded,
  parseAddress,
  parseReferences,
  routeDesk,
  safeFilename,
  stripGroupFooter,
  truncateBody,
} from './parse.ts'

// The polling logic behind helpdesk-ingest, with its dependencies (database,
// Gmail, limits) passed in so it can be tested without Deno, Supabase or
// the network. index.ts wires in the real ones.

export const PROCESSED_LABEL = 'HelpdeskProcessed'
export const UNROUTED_LABEL = 'HelpdeskUnrouted'
export const FAILED_LABEL = 'HelpdeskFailed'
export const ATTACHMENT_BUCKET = 'helpdesk-attachments'
const MAX_ATTACHMENTS_PER_MESSAGE = 20
const MAX_ATTEMPTS = 3

// deno-lint-ignore no-explicit-any
export type Db = any
export type Outcome = 'ingested' | 'skipped' | 'unrouted'

export interface MailboxRow {
  mailbox: string
  desk_id: string | null
  auth_type: 'service_account' | 'oauth'
  secret_prefix: string | null
  isolation_label: string | null
}

// The slice of the Gmail client the poller uses (gmail.ts implements it).
export interface GmailApi {
  listMessageIds(query: string, max: number): Promise<string[]>
  getMessage(id: string): Promise<GmailMessage>
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>
  ensureLabel(name: string): Promise<string>
  findLabel(name: string): Promise<string | null>
  modifyLabels(messageId: string, add: string[], remove: string[]): Promise<void>
}

export interface Config {
  maxPerRun: number
  maxAttachmentBytes: number
}

export interface Deps {
  db: Db
  makeGmail: (mb: MailboxRow) => Promise<GmailApi>
  config: Config
}

interface Ctx {
  db: Db
  gmail: GmailApi
  mb: MailboxRow
  addressToDesk: Map<string, string>
  labels: { processed: string; unrouted: string; failed: string; isolation: string | null }
  retryUnrouted: boolean
  config: Config
}

export async function pollMailbox(
  deps: Deps,
  mb: MailboxRow,
  addressToDesk: Map<string, string>,
  retryUnrouted: boolean
) {
  const { db, config } = deps
  const { data: run } = await db.from('ingest_runs').insert({ mailbox: mb.mailbox }).select('id').single()
  const stats = { processed: 0, ingested: 0, skipped: 0, unrouted: 0, errors: 0 }
  let fatal: string | null = null

  try {
    const gmail = await deps.makeGmail(mb)
    const isolationId = mb.isolation_label ? await gmail.findLabel(mb.isolation_label) : null
    if (mb.isolation_label && !isolationId) {
      throw new Error(`isolation label "${mb.isolation_label}" not found in ${mb.mailbox}; create it and its filter first`)
    }
    const ctx: Ctx = {
      db, gmail, mb, addressToDesk, retryUnrouted, config,
      labels: {
        processed: await gmail.ensureLabel(PROCESSED_LABEL),
        unrouted: await gmail.ensureLabel(UNROUTED_LABEL),
        failed: await gmail.ensureLabel(FAILED_LABEL),
        isolation: isolationId,
      },
    }

    const ids = await gmail.listMessageIds(buildQuery(mb.isolation_label, retryUnrouted), config.maxPerRun)
    for (const id of ids) {
      stats.processed++
      try {
        stats[await processMessage(ctx, id)]++
      } catch (err) {
        stats.errors++
        await recordFailure(ctx, id, err as Error)
      }
    }
  } catch (err) {
    fatal = (err as Error).message
  }

  await db.from('ingest_runs').update({ finished_at: new Date().toISOString(), ...stats, error: fatal }).eq('id', run?.id)
  return { mailbox: mb.mailbox, ...stats, error: fatal }
}

// A dedicated mailbox is read from its inbox. A mailbox that also holds real
// mail is read only through its isolation label (Gmail's own filter decides
// what the poller can ever see).
function buildQuery(isolationLabel: string | null, retryUnrouted: boolean): string {
  const parts = [isolationLabel ? `label:"${isolationLabel}"` : 'in:inbox']
  parts.push(retryUnrouted ? `label:${UNROUTED_LABEL}` : `-label:${UNROUTED_LABEL}`)
  parts.push(`-label:${PROCESSED_LABEL}`, `-label:${FAILED_LABEL}`)
  if (!retryUnrouted) parts.push('newer_than:14d')
  return parts.join(' ')
}

async function processMessage(ctx: Ctx, id: string): Promise<Outcome> {
  const { db, gmail, mb, labels } = ctx
  const msg = await gmail.getMessage(id)
  const headers = msg.payload.headers
  const from = parseAddress(getHeader(headers, 'From'))
  const subject = getHeader(headers, 'Subject')

  // Done with this message: mark it processed and take it out of the inbox
  // (or, for isolated mailboxes, off the isolation label; never touch INBOX).
  const finish = () =>
    gmail.modifyLabels(
      id,
      [labels.processed],
      labels.isolation ? [labels.isolation, labels.unrouted] : ['INBOX', labels.unrouted]
    )

  // Mail loop protection: never turn our own mail, or automatic replies, into tickets.
  if (from.email === mb.mailbox || ctx.addressToDesk.has(from.email)) {
    await logOutcome(ctx, msg, 'skipped', 'sent from one of our own addresses', from.email, subject)
    await finish()
    return 'skipped'
  }
  const auto = autoReplyReason(headers, from.email, subject)
  if (auto) {
    await logOutcome(ctx, msg, 'skipped', auto, from.email, subject)
    await finish()
    return 'skipped'
  }

  const route = routeDesk(candidateAddresses(headers), ctx.addressToDesk, mb.desk_id)
  if (!route) {
    if (!ctx.retryUnrouted) {
      await logOutcome(ctx, msg, 'unrouted', 'no recipient or group header matched a desk address', from.email, subject)
      await gmail.modifyLabels(id, [labels.unrouted], [])
    }
    return 'unrouted'
  }

  const body = truncateBody(stripGroupFooter(extractBody(msg.payload)))
  const references = parseReferences(getHeader(headers, 'References'))
  const { data, error } = await db.rpc('ingest_inbound', {
    p: {
      mailbox: mb.mailbox,
      desk_id: route.deskId,
      source_address: route.sourceAddress,
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      rfc_message_id: parseReferences(getHeader(headers, 'Message-ID'))[0] ?? null,
      in_reply_to: parseReferences(getHeader(headers, 'In-Reply-To'))[0] ?? null,
      references,
      from_email: from.email,
      from_name: from.name === from.email ? null : from.name,
      subject,
      body,
      forwarded: looksForwarded(subject, body),
      headers: {
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        cc: getHeader(headers, 'Cc'),
        date: getHeader(headers, 'Date'),
        subject,
        message_id: getHeader(headers, 'Message-ID'),
        list_id: getHeader(headers, 'List-Id'),
        delivered_to: getHeader(headers, 'Delivered-To'),
      },
    },
  })
  if (error) throw new Error(`ingest_inbound failed: ${error.message}`)

  if (data.status === 'ingested') {
    await storeAttachments(ctx, msg, data.ticket_id, data.message_id)
  }
  await finish()
  return data.status === 'ingested' ? 'ingested' : 'skipped'
}

async function storeAttachments(ctx: Ctx, msg: GmailMessage, ticketId: string, messageId: string) {
  const all = listAttachments(msg.payload)
  const refs = all.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
  for (const [i, a] of refs.entries()) {
    const row: Record<string, unknown> = {
      ticket_id: ticketId,
      message_id: messageId,
      filename: a.filename,
      content_type: a.mimeType,
      size_bytes: a.size,
    }
    try {
      if (a.size > ctx.config.maxAttachmentBytes) {
        row.skipped_reason = `larger than ${Math.round(ctx.config.maxAttachmentBytes / 1024 / 1024)} MB`
      } else {
        const bytes = await ctx.gmail.getAttachment(msg.id, a.attachmentId)
        if (bytes.length > ctx.config.maxAttachmentBytes) {
          row.skipped_reason = `larger than ${Math.round(ctx.config.maxAttachmentBytes / 1024 / 1024)} MB`
        } else {
          const path = `${ticketId}/${messageId}/${i}-${safeFilename(a.filename)}`
          const { error } = await ctx.db.storage.from(ATTACHMENT_BUCKET).upload(path, bytes, {
            contentType: a.mimeType,
            upsert: false,
          })
          if (error) throw new Error(error.message)
          row.storage_path = path
          row.size_bytes = bytes.length
        }
      }
    } catch (err) {
      row.skipped_reason = `upload failed: ${(err as Error).message}`
    }
    await ctx.db.from('ticket_attachments').insert(row)
  }
  if (all.length > refs.length) {
    await ctx.db.from('ticket_attachments').insert({
      ticket_id: ticketId,
      message_id: messageId,
      filename: `(${all.length - refs.length} more attachments not stored)`,
      skipped_reason: `more than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    })
  }
}

async function logOutcome(
  ctx: Ctx,
  msg: GmailMessage,
  outcome: 'skipped' | 'unrouted',
  reason: string,
  fromEmail: string,
  subject: string
) {
  const { error } = await ctx.db.from('ingest_log').insert({
    mailbox: ctx.mb.mailbox,
    gmail_message_id: msg.id,
    outcome,
    reason,
    from_email: fromEmail,
    subject: subject.slice(0, 300),
    snippet: (msg.snippet ?? '').slice(0, 500),
    headers: {
      to: getHeader(msg.payload.headers, 'To'),
      cc: getHeader(msg.payload.headers, 'Cc'),
      delivered_to: getHeader(msg.payload.headers, 'Delivered-To'),
      list_id: getHeader(msg.payload.headers, 'List-Id'),
      auto_submitted: getHeader(msg.payload.headers, 'Auto-Submitted'),
    },
  })
  if (error) console.error('ingest_log insert failed:', error.message)
}

// A message that keeps failing is parked (HelpdeskFailed) after MAX_ATTEMPTS
// so it can't block or repeat forever; it stays visible in ingest_log.
async function recordFailure(ctx: Ctx, id: string, err: Error) {
  const { data: prev } = await ctx.db
    .from('ingest_log')
    .select('attempts')
    .eq('mailbox', ctx.mb.mailbox)
    .eq('gmail_message_id', id)
    .eq('outcome', 'error')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const attempts = (prev?.attempts ?? 0) + 1
  await ctx.db.from('ingest_log').insert({
    mailbox: ctx.mb.mailbox,
    gmail_message_id: id,
    outcome: 'error',
    reason: err.message.slice(0, 1000),
    attempts,
  })
  if (attempts >= MAX_ATTEMPTS) {
    try {
      await ctx.gmail.modifyLabels(id, [ctx.labels.failed], [])
    } catch (labelErr) {
      console.error('could not park failed message:', (labelErr as Error).message)
    }
  }
}

let bucketReady = false
export async function ensureBucket(db: Db) {
  if (bucketReady) return
  const { error } = await db.storage.createBucket(ATTACHMENT_BUCKET, { public: false })
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(`storage bucket: ${error.message}`)
  bucketReady = true
}

