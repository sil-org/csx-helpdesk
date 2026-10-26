import {
  autoReplyReason,
  BOUNCE_REASONS,
  candidateAddresses,
  getHeader,
  htmlToText,
  looksForwarded,
  parseAddress,
  parseBounceRecipient,
  parseForwardedSender,
  parseReferences,
  routeDesk,
  safeFilename,
  stripGroupFooter,
  stripQuotedReply,
  truncateBody,
} from './parse.ts'
import type { Header } from './parse.ts'

// The logic behind helpdesk-inbound, with its dependencies (database, Resend
// API) passed in so it can be tested without Deno, Supabase or the network.
// index.ts wires in the real ones.
//
// Shape of Resend's received-email object (GET /emails/receiving/:id) as seen
// on real group-delivered mail: headers is an object with lower-case keys;
// repeated headers (received, references, arc-*) arrive as a JSON array
// serialised into a string; the group's List-* headers arrive pre-parsed as a
// JSON object under "list".

export const ATTACHMENT_BUCKET = 'helpdesk-attachments'
export const MAILBOX = 'resend' // value of ticket_messages.mailbox / ingest_log.mailbox
const MAX_ATTACHMENTS_PER_MESSAGE = 20
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

// deno-lint-ignore no-explicit-any
export type Db = any

export interface ReceivedAttachment {
  id: string
  filename: string | null
  content_type: string | null
  content_disposition?: string | null
  size?: number | null
}

export interface ReceivedEmail {
  id: string
  from: string
  to: string[]
  cc?: string[]
  subject: string | null
  message_id: string | null
  text: string | null
  html: string | null
  headers: Record<string, string>
  received_for?: string[]
  attachments?: ReceivedAttachment[]
}

export interface ResendApi {
  getEmail(id: string): Promise<ReceivedEmail>
  getAttachment(emailId: string, attachmentId: string): Promise<Uint8Array>
}

export interface Config {
  maxAttachmentBytes: number
}

export interface Deps {
  db: Db
  resend: ResendApi
  config: Config
}

export type Outcome =
  | { status: 'ingested'; ticket_id: string; created: boolean; reopened: boolean }
  | { status: 'duplicate' }
  | { status: 'skipped'; reason: string }
  | { status: 'unrouted' }

// ── Webhook signature (Resend signs webhooks with Svix) ──────────────────

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

// secret is the endpoint's signing secret from Resend ("whsec_..."). The signed
// content is "<svix-id>.<svix-timestamp>.<raw body>"; the header can carry
// several space-separated "v1,<base64 hmac>" signatures (key rotation).
export async function verifyWebhook(
  rawBody: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!h.id || !h.timestamp || !h.signature || !secret) return false
  const ts = Number(h.timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) return false
  let keyBytes: Uint8Array<ArrayBuffer>
  try {
    keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''))
  } catch {
    return false
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h.id}.${h.timestamp}.${rawBody}`))
  )
  const expected = bytesToBase64(mac)
  return h.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    return version === 'v1' && !!sig && constantTimeEqual(sig, expected)
  })
}

// ── Headers ──────────────────────────────────────────────────────────────

// Resend's header object to the Header[] the parse helpers expect.
export function normalizeHeaders(raw: Record<string, string>): Header[] {
  const out: Header[] = []
  for (const [key, value] of Object.entries(raw ?? {})) {
    const name = key.toLowerCase()
    if (typeof value !== 'string') continue
    const trimmed = value.trim()

    if (name === 'list' && trimmed.startsWith('{')) {
      try {
        const list = JSON.parse(trimmed)
        if (list?.post?.mail) out.push({ name: 'list-post', value: `<mailto:${list.post.mail}>` })
        if (list?.id?.name) out.push({ name: 'list-id', value: `<${list.id.name}>` })
      } catch { /* ignore a malformed list object */ }
      continue
    }
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed)
        if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
          if (name === 'references') out.push({ name, value: arr.join(' ') })
          else for (const v of arr) out.push({ name, value: v })
          continue
        }
      } catch { /* not JSON: keep as a plain value below */ }
    }
    out.push({ name, value })
  }
  return out
}

// ── Processing ───────────────────────────────────────────────────────────

export async function loadAddressMap(db: Db): Promise<Map<string, string>> {
  const { data, error } = await db.from('desk_addresses').select('address, desk_id')
  if (error) throw new Error(`desk_addresses: ${error.message}`)
  return new Map((data as { address: string; desk_id: string }[]).map((a) => [a.address, a.desk_id]))
}

export async function processEmail(deps: Deps, emailId: string, addressToDesk: Map<string, string>): Promise<Outcome> {
  const { db, resend } = deps
  let email: ReceivedEmail
  try {
    email = await resend.getEmail(emailId)
  } catch (err) {
    await logOutcome(db, { id: emailId }, 'error', (err as Error).message, '', '')
    throw err
  }

  const headers = normalizeHeaders(email.headers)
  const subject = email.subject ?? getHeader(headers, 'subject')

  // Real sender: the group adds X-Original-Sender with the true address, and
  // may rewrite From (e.g. "Pat via Help Desk") when the sender's domain
  // enforces DMARC.
  const fromHeader = parseAddress(getHeader(headers, 'from') || email.from)
  const original = getHeader(headers, 'x-original-sender')
  const sender = original ? parseAddress(original).email : fromHeader.email
  const name = fromHeader.email === sender && fromHeader.name !== fromHeader.email ? fromHeader.name : null

  const skip = async (reason: string): Promise<Outcome> => {
    await logOutcome(db, email, 'skipped', reason, sender, subject)
    return { status: 'skipped', reason }
  }

  const rawText = email.text?.trim() ? email.text : htmlToText(email.html ?? '')

  // Mail loop protection: never turn our own mail, or automatic replies, into tickets.
  if (addressToDesk.has(sender)) return skip('sent from one of our own addresses')
  const auto = autoReplyReason(headers, sender, subject)
  // A bounce naming a real, identifiable person (e.g. a failed password-reset
  // delivery) still becomes a ticket — only genuinely unidentifiable noise
  // (a bare subscription confirmation, etc.) and non-bounce auto-replies
  // (out-of-office and the like) are dropped outright.
  let bounceRecipient: { name: string | null; email: string } | null = null
  if (auto) {
    if (BOUNCE_REASONS.has(auto)) bounceRecipient = parseBounceRecipient(rawText)
    if (!bounceRecipient) return skip(auto)
  }

  // Where it was sent: Resend's received_for first (the original recipient,
  // even when the group has rewritten To to our receiving address — and,
  // confirmed on real mail, it preserves a "+tag" sub-address), then the
  // header-derived candidates (envelope headers and To/Cc before the
  // group's own untagged identity headers — see candidateAddresses).
  const candidates = [...(email.received_for ?? []), ...(email.to ?? []), ...(email.cc ?? [])]
    .map((a) => parseAddress(a).email)
  for (const addr of candidateAddresses(headers)) {
    if (!candidates.includes(addr)) candidates.push(addr)
  }
  const route = routeDesk(candidates, addressToDesk, null)
  if (!route) {
    await logOutcome(db, email, 'unrouted', 'no recipient or group header matched a desk address', sender, subject)
    return { status: 'unrouted' }
  }

  const references = parseReferences(getHeader(headers, 'references'))
  const inReplyTo = parseReferences(getHeader(headers, 'in-reply-to'))[0] ?? null
  const isReply = references.length > 0 || inReplyTo !== null

  let body = stripGroupFooter(rawText)
  const forwarded = looksForwarded(subject, body)
  // Spec section 7, layer 1: a best-effort guess at who a forward or bounce is
  // really about. A cleanly-parsed forward header is confident enough to use
  // directly (ingest_inbound assigns it as the reporter outright); a bounce
  // recipient is a broader, fuzzier scan of the whole body, so it's kept as
  // a lower-confidence suggestion instead — the reporter still shows as
  // unverified for an agent to confirm.
  const detectedSender = forwarded ? parseForwardedSender(body) : bounceRecipient
  const detectedSenderConfidence = forwarded && detectedSender ? 0.9 : detectedSender ? 0.4 : null
  if (isReply && !forwarded) body = stripQuotedReply(body)
  body = truncateBody(body)

  const { data, error } = await db.rpc('ingest_inbound', {
    p: {
      mailbox: MAILBOX,
      desk_id: route.deskId,
      source_address: route.sourceAddress,
      gmail_message_id: email.id, // column is named for Gmail; holds the Resend email id
      gmail_thread_id: null,
      rfc_message_id: parseReferences(email.message_id ?? getHeader(headers, 'message-id'))[0] ?? null,
      in_reply_to: inReplyTo,
      references,
      from_email: sender,
      from_name: name,
      subject,
      body,
      forwarded,
      forwarded_sender_name: detectedSender?.name ?? null,
      forwarded_sender_email: detectedSender?.email ?? null,
      detected_sender_confidence: detectedSenderConfidence,
      headers: {
        from: getHeader(headers, 'from') || email.from,
        to: getHeader(headers, 'to'),
        date: getHeader(headers, 'date'),
        subject,
        message_id: email.message_id,
        list_id: getHeader(headers, 'list-id'),
        received_for: email.received_for ?? [],
        // Google's verdict on the original sender, before the group re-sent it.
        // Resend's own "authentication" block judges the group's copy, not this.
        original_authentication_results: getHeader(headers, 'x-original-authentication-results'),
      },
    },
  })
  if (error) {
    await logOutcome(db, email, 'error', `ingest_inbound failed: ${error.message}`, sender, subject)
    throw new Error(`ingest_inbound failed: ${error.message}`)
  }

  if (data.status === 'duplicate') return { status: 'duplicate' }

  await storeAttachments(deps, email, data.ticket_id, data.message_id)
  await logOutcome(db, email, 'ingested', null, sender, subject, data.ticket_id)
  return { status: 'ingested', ticket_id: data.ticket_id, created: !!data.created_ticket, reopened: !!data.reopened }
}

async function storeAttachments(deps: Deps, email: ReceivedEmail, ticketId: string, messageId: string) {
  const all = email.attachments ?? []
  const limit = deps.config.maxAttachmentBytes
  const mb = (n: number) => Math.round(n / 1024 / 1024)
  for (const [i, a] of all.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).entries()) {
    const filename = a.filename || 'attachment'
    const row: Record<string, unknown> = {
      ticket_id: ticketId,
      message_id: messageId,
      filename,
      content_type: a.content_type,
      size_bytes: a.size ?? null,
    }
    try {
      if ((a.size ?? 0) > limit) {
        row.skipped_reason = `larger than ${mb(limit)} MB`
      } else {
        const bytes = await deps.resend.getAttachment(email.id, a.id)
        if (bytes.length > limit) {
          row.skipped_reason = `larger than ${mb(limit)} MB`
        } else {
          const path = `${ticketId}/${messageId}/${i}-${safeFilename(filename)}`
          const { error } = await deps.db.storage.from(ATTACHMENT_BUCKET).upload(path, bytes, {
            contentType: a.content_type ?? 'application/octet-stream',
            upsert: false,
          })
          if (error) throw new Error(error.message)
          row.storage_path = path
          row.size_bytes = bytes.length
        }
      }
    } catch (err) {
      row.skipped_reason = `could not store: ${(err as Error).message}`.slice(0, 300)
    }
    await deps.db.from('ticket_attachments').insert(row)
  }
  if (all.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    await deps.db.from('ticket_attachments').insert({
      ticket_id: ticketId,
      message_id: messageId,
      filename: `(${all.length - MAX_ATTACHMENTS_PER_MESSAGE} more attachments not stored)`,
      skipped_reason: `more than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    })
  }
}

async function logOutcome(
  db: Db,
  email: { id: string; headers?: Record<string, string>; received_for?: string[]; text?: string | null },
  outcome: 'ingested' | 'skipped' | 'unrouted' | 'error',
  reason: string | null,
  fromEmail: string,
  subject: string,
  ticketId?: string
) {
  const { error } = await db.from('ingest_log').insert({
    mailbox: MAILBOX,
    gmail_message_id: email.id,
    outcome,
    reason: reason?.slice(0, 1000) ?? null,
    ticket_id: ticketId ?? null,
    from_email: fromEmail || null,
    subject: subject.slice(0, 300),
    snippet: (email.text ?? '').slice(0, 500),
    headers: { received_for: email.received_for ?? [], list_id: email.headers?.list ? 'see list' : null },
  })
  if (error) console.error('ingest_log insert failed:', error.message)
}

let bucketReady = false
export async function ensureBucket(db: Db) {
  if (bucketReady) return
  const { error } = await db.storage.createBucket(ATTACHMENT_BUCKET, { public: false })
  if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(`storage bucket: ${error.message}`)
  bucketReady = true
}

// ── Resend HTTP client ───────────────────────────────────────────────────

export class ResendClient implements ResendApi {
  private readonly apiKey: string
  private readonly fetchFn: typeof fetch
  constructor(apiKey: string, fetchFn: typeof fetch = fetch) {
    this.apiKey = apiKey
    this.fetchFn = fetchFn
  }

  private async get(path: string): Promise<Response> {
    const res = await this.fetchFn(`https://api.resend.com${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    })
    if (!res.ok) throw new Error(`Resend GET ${path.split('?')[0]} -> ${res.status}`)
    return res
  }

  async getEmail(id: string): Promise<ReceivedEmail> {
    return (await (await this.get(`/emails/receiving/${encodeURIComponent(id)}`)).json()) as ReceivedEmail
  }

  // The attachment-content endpoint is not yet confirmed against real mail:
  // this accepts either raw bytes or a JSON body with a download_url. A
  // failure is recorded on the attachment row (skipped_reason), never lost
  // silently. See SETUP.md "first attachment test".
  async getAttachment(emailId: string, attachmentId: string): Promise<Uint8Array> {
    const res = await this.get(
      `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`
    )
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      const meta = (await res.json()) as { download_url?: string }
      if (!meta.download_url) throw new Error('attachment response had no download_url')
      const file = await this.fetchFn(meta.download_url)
      if (!file.ok) throw new Error(`attachment download -> ${file.status}`)
      return new Uint8Array(await file.arrayBuffer())
    }
    return new Uint8Array(await res.arrayBuffer())
  }
}
