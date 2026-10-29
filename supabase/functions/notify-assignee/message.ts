// Pure email content building for the "requester updated your ticket" notice.
// No Deno/network APIs here so it's unit-testable with plain Node (see message.test.ts).

const PREVIEW_CHARS = 500

export function buildAssigneeEmail(opts: {
  ticketNumber: number | null
  subject: string | null
  requesterEmail: string | null
  deskName: string
  body: string
  via: 'email' | 'app'
  link: string
}) {
  const label = opts.ticketNumber != null ? `#${opts.ticketNumber}` : 'Ticket'
  const subject = (opts.subject || '').trim() || '(no subject)'
  const flat = opts.body.trim()
  const preview = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat
  const quoted = preview.split('\n').map((l) => `> ${l}`).join('\n')
  const how = opts.via === 'app' ? 'commented in the app' : 'replied by email'
  return {
    subject: `[${opts.deskName}] ${label}: ${subject} — new reply`,
    text: `${opts.requesterEmail || 'The requester'} ${how} on a ticket assigned to you.\n\n${quoted}\n\n${opts.link}\n\nYou're getting this because this ticket is assigned to you.`,
  }
}
