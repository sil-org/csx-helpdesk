// Pure parsing / routing helpers for helpdesk-inbound. No Deno or network APIs
// in here so they can be unit-tested with plain Node (see parse.test.ts).

export interface Header {
  name: string
  value: string
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
// that arrives through a Google Group carries the group's own headers, so
// those come first; then the envelope-ish headers; then To/Cc. (Confirmed on
// real group mail: To and Mailing-list name the group; List-Id is the weakest.)
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

// Which autoReplyReason()s are bounce-shaped (vs. a genuine out-of-office /
// auto-reply, which should always be dropped): only these are worth looking
// inside for a real person before giving up on the message entirely.
export const BOUNCE_REASONS = new Set(['delivery status notification', 'mailer-daemon sender'])

const BOUNCE_SYSTEM_LOCALPART = /^(mailer-daemon|postmaster|bounce(s)?|no-?reply|mdaemon|abuse)\b/i

// A bounce naming a real, identifiable person (e.g. a failed password-reset
// delivery) must still become a ticket, per autoReplyReason()'s own contract
// above — this is what actually finds that person. Deliberately broad (any
// email address in the body that isn't the bounce machinery itself): a
// false positive just means one extra ticket a human reviews, never an
// auto-sent reply, so erring toward finding someone is the safer default.
export function parseBounceRecipient(body: string): { name: string | null; email: string } | null {
  const matches = body.match(/[^\s<>()[\]",;]+@[^\s<>()[\]",;]+\.[a-zA-Z]{2,}/g) ?? []
  for (const raw of matches) {
    const email = raw.replace(/[.,;:]+$/, '').toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue
    if (BOUNCE_SYSTEM_LOCALPART.test(email.split('@')[0])) continue
    return { name: null, email }
  }
  return null
}

export function looksForwarded(subject: string, body: string): boolean {
  if (/^\s*(fwd?|wg|tr|rv|enc)\s*:/i.test(subject)) return true
  return /-{3,}\s*forwarded message\s*-{3,}|begin forwarded message:/i.test(body)
}

const FORWARD_MARKERS: RegExp[] = [
  /-{3,}\s*forwarded message\s*-{3,}/i,
  /^begin forwarded message:\s*$/im,
  /^-{2,}\s*original message\s*-{2,}\s*$/im,
]

// Best-effort original sender from a forward's quoted header block (spec
// section 7, layer 1: "parse the forwarded block"). A proposal only, at low
// confidence — never applied automatically; an agent confirms or picks
// someone else.
//
// Matched by shape, not by the "From:" label text: Gmail and Outlook always
// put the sender on the forwarded block's first header line, but the label
// itself ("From:", "De:", "Von:", "Da:", ...) is localized to the ORIGINAL
// sender's own account language, which can differ from the forwarding
// agent's. So this looks for the first line with a "Name <email>" or bare
// email token, which is reliably that first line regardless of language.
export function parseForwardedSender(body: string): { name: string; email: string } | null {
  let markerEnd = -1
  for (const re of FORWARD_MARKERS) {
    const m = re.exec(body)
    if (m) { markerEnd = m.index + m[0].length; break }
  }
  if (markerEnd === -1) return null
  const lines = body.slice(markerEnd, markerEnd + 2000).split('\n').slice(0, 12)
  for (const line of lines) {
    const m = line.match(/^[^:<]{0,40}:?\s*(.+<[^<>\s]+@[^<>\s]+>|[^\s<>:]+@[^\s<>:]+)\s*$/)
    if (!m) continue
    const { name, email } = parseAddress(m[1])
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { name, email }
  }
  return null
}

// Remove the footer Google Groups appends to every delivered message. Seen
// in two forms: the long "You received this message because you are
// subscribed to..." and the short "To unsubscribe from this group and stop
// receiving emails from it, send an email to x+unsubscribe@..." on its own.
export function stripGroupFooter(body: string): string {
  const long = body.match(/\n[-_ ]*\n?You received this message because you are subscribed to/i)
  if (long && long.index !== undefined) {
    const tail = body.slice(long.index)
    if (/unsubscribe/i.test(tail.slice(0, 800))) return body.slice(0, long.index).trimEnd()
  }
  const short = body.match(/\n+To unsubscribe from this group and stop receiving emails from it, send an email to \S+\.?\s*$/i)
  if (short && short.index !== undefined) return body.slice(0, short.index).trimEnd()
  return body
}

// Cut the quoted earlier messages off a reply so the ticket thread shows only
// what the sender just wrote. Conservative on purpose: only well-known
// markers, and only when something was written above them (a message that
// is nothing but a quote, such as a forward, is kept whole).
const QUOTE_MARKERS: RegExp[] = [
  /^#{2}-+\s*please enter your reply above this line\s*-+#{2}\s*$/im, // YouTrack and similar
  /^On\b[^\n]{0,300}(\n[^\n]{0,200})?\bwrote:\s*$/m, // Gmail, Apple Mail: "On <date> <name> wrote:"
  /^-{2,}\s*original message\s*-{2,}\s*$/im, // Outlook
  /^From:[^\n]*\n(Sent|Date):[^\n]*\n(To|Cc|Subject):/m, // Outlook header block
  /^_{20,}\s*$/m, // Outlook divider
]
export function stripQuotedReply(body: string): string {
  let cut = -1
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(body)
    if (m && (cut === -1 || m.index < cut)) cut = m.index
  }
  if (cut <= 0) return body
  const above = body.slice(0, cut).trimEnd()
  return above.replace(/\s/g, '') === '' ? body : above
}

export function parseReferences(value: string): string[] {
  return (value.match(/<[^<>\s]+>/g) ?? []).map((s) => s.trim())
}

// Plain-text rendering of an HTML body, for the rare message with no text part.
export function htmlToText(html: string): string {
  return html
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

// Safe storage-path segment from an untrusted filename.
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '_').replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '_').trim()
  return (cleaned || 'attachment').slice(0, 120)
}

export const MAX_BODY_CHARS = 200_000

export function truncateBody(body: string): string {
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '\n\n[truncated]' : body
}
