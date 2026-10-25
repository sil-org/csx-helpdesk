// Pure parsing / routing helpers for helpdesk-ingest. No Deno or network APIs
// in here so they can be unit-tested with plain Node (see parse.test.ts).

export interface Header {
  name: string
  value: string
}

export interface AttachmentRef {
  filename: string
  mimeType: string
  size: number
  attachmentId: string
}

export function getHeader(headers: Header[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

export function getHeaders(headers: Header[], name: string): string[] {
  return headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value)
}

// "Pat Smith" <pat@x.org>, Pat <pat@x.org>, <pat@x.org>, pat@x.org
export function parseAddress(value: string): { email: string; name: string } {
  const v = value.trim()
  const angle = v.match(/^(.*?)<([^<>]+)>\s*$/)
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim()
    const email = angle[2].trim().toLowerCase()
    return { email, name: name || email }
  }
  const email = v.toLowerCase()
  return { email, name: email }
}

// Split an address-list header on commas that are not inside quotes or <>.
export function parseAddressList(value: string): string[] {
  const out: string[] = []
  let depthAngle = 0
  let inQuote = false
  let cur = ''
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote
    if (!inQuote && ch === '<') depthAngle++
    if (!inQuote && ch === '>') depthAngle = Math.max(0, depthAngle - 1)
    if (ch === ',' && !inQuote && depthAngle === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
    .map((s) => parseAddress(s).email)
    .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e))
}

// Addresses a message might have been sent to, most reliable first. Mail
// that arrives through a Google Group is delivered to the ingest mailbox, so
// the group's own headers come first; then the envelope-ish headers; then
// To/Cc. The exact header formats Google Groups uses still need confirming
// on real mail (see docs/HELPDESK_SPEC.md section 6).
export function candidateAddresses(headers: Header[]): string[] {
  const found: string[] = []
  const add = (e: string | undefined) => {
    if (e && /^[^@\s]+@[^@\s]+$/.test(e) && !found.includes(e.toLowerCase())) found.push(e.toLowerCase())
  }

  // List-Post: <mailto:group@domain>
  for (const v of getHeaders(headers, 'List-Post')) {
    const m = v.match(/mailto:([^>\s?]+)/i)
    add(m?.[1])
  }
  // Mailing-list: list group@domain; contact group+owners@domain
  for (const v of getHeaders(headers, 'Mailing-list')) {
    const m = v.match(/list\s+([^\s;]+)/i)
    add(m?.[1])
  }
  for (const name of ['X-Original-To', 'X-Forwarded-To', 'X-Envelope-To', 'Delivered-To', 'Resent-To']) {
    for (const v of getHeaders(headers, name)) parseAddressList(v).forEach(add)
  }
  for (const name of ['To', 'Cc']) {
    for (const v of getHeaders(headers, name)) parseAddressList(v).forEach(add)
  }
  // Weakest signal: List-Id <group.domain.org> read as group@domain.org
  for (const v of getHeaders(headers, 'List-Id')) {
    const m = v.match(/<([^<>\s]+)>/)
    const id = m?.[1]
    if (id && id.includes('.')) {
      const dot = id.indexOf('.')
      add(`${id.slice(0, dot)}@${id.slice(dot + 1)}`)
    }
  }
  return found
}

export interface Route {
  deskId: string
  sourceAddress: string | null
}

// First candidate that is a known desk address wins; otherwise a mailbox
// bound to a single desk falls back to that desk; otherwise unrouted (null).
export function routeDesk(
  candidates: string[],
  addressToDesk: Map<string, string>,
  mailboxDeskId: string | null
): Route | null {
  for (const c of candidates) {
    const desk = addressToDesk.get(c)
    if (desk) return { deskId: desk, sourceAddress: c }
  }
  if (mailboxDeskId) return { deskId: mailboxDeskId, sourceAddress: null }
  return null
}

// Returns a reason string if this is an automatic reply / bounce that must not
// become a ticket (and must never be answered), or null for real mail.
// Deliberately narrow: notifications that name a real person who needs help
// (e.g. an SES bounce for a password-reset mail) are NOT auto-replies and must
// still become tickets.
export function autoReplyReason(headers: Header[], from: string, subject: string): string | null {
  const autoSubmitted = getHeader(headers, 'Auto-Submitted').trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== 'no') return `Auto-Submitted: ${autoSubmitted}`
  if (getHeader(headers, 'X-Autoreply') || getHeader(headers, 'X-Autorespond')) return 'X-Autoreply header'
  const precedence = getHeader(headers, 'Precedence').trim().toLowerCase()
  if (precedence === 'auto_reply') return 'Precedence: auto_reply'
  if (/^multipart\/report/i.test(getHeader(headers, 'Content-Type')) &&
      /report-type=delivery-status/i.test(getHeader(headers, 'Content-Type'))) {
    return 'delivery status notification'
  }
  const local = from.split('@')[0]
  if (local === 'mailer-daemon' || local === 'postmaster') return 'mailer-daemon sender'
  if (/^\s*(automatic reply|auto(matic)?[- ]?reply|autoreply|out of office|abwesenheitsnotiz|r[eé]ponse automatique|respuesta autom[aá]tica)\b/i.test(subject)) {
    return 'auto-reply subject'
  }
  return null
}

export function looksForwarded(subject: string, body: string): boolean {
  if (/^\s*(fwd?|wg|tr|rv|enc)\s*:/i.test(subject)) return true
  return /-{3,}\s*forwarded message\s*-{3,}|begin forwarded message:/i.test(body)
}

// Remove the footer Google Groups appends to every delivered message.
export function stripGroupFooter(body: string): string {
  const m = body.match(/\n[-_ ]*\n?You received this message because you are subscribed to/i)
  if (m && m.index !== undefined) {
    const tail = body.slice(m.index)
    if (/unsubscribe/i.test(tail.slice(0, 800))) return body.slice(0, m.index).trimEnd()
  }
  return body
}

export function parseReferences(value: string): string[] {
  return (value.match(/<[^<>\s]+>/g) ?? []).map((s) => s.trim())
}

// ── MIME payload helpers ─────────────────────────────────────────────────

export interface Payload {
  mimeType?: string
  filename?: string
  headers?: Header[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: Payload[]
}

export function decodeBase64Url(data: string): string {
  const bytes = decodeBase64UrlBytes(data)
  return new TextDecoder().decode(bytes)
}

export function decodeBase64UrlBytes(data: string): Uint8Array {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
}

function findPart(payload: Payload, mimeType: string): Payload | null {
  if (payload.mimeType === mimeType && payload.body?.data && !payload.filename) return payload
  for (const part of payload.parts ?? []) {
    const found = findPart(part, mimeType)
    if (found) return found
  }
  return null
}

export function extractBody(payload: Payload): string {
  const plain = findPart(payload, 'text/plain')
  if (plain?.body?.data) return decodeBase64Url(plain.body.data)
  const html = findPart(payload, 'text/html')
  if (html?.body?.data) {
    return decodeBase64Url(html.body.data)
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }
  return ''
}

export function listAttachments(payload: Payload): AttachmentRef[] {
  const out: AttachmentRef[] = []
  const walk = (p: Payload) => {
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        size: p.body.size ?? 0,
        attachmentId: p.body.attachmentId,
      })
    }
    for (const part of p.parts ?? []) walk(part)
  }
  walk(payload)
  return out
}

// Safe storage-path segment from an untrusted filename.
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '_').trim()
  return (cleaned || 'attachment').slice(0, 120)
}

export const MAX_BODY_CHARS = 200_000

export function truncateBody(body: string): string {
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '\n\n[truncated]' : body
}
