// Pure email content building for the new-ticket notification. No Deno/network
// APIs here so it's unit-testable with plain Node (see notify.test.ts).

const PREVIEW_CHARS = 500

export function buildNewTicketEmail(opts: {
  ticketNumber: number | null
  subject: string | null
  senderEmail: string | null
  deskName: string
  link: string
  messageBody: string
  draftBody: string | null
}) {
  const label = opts.ticketNumber != null ? `#${opts.ticketNumber}` : 'New ticket'
  const subject = (opts.subject || '').trim() || '(no subject)'
  const flat = opts.messageBody.trim()
  const preview = flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…` : flat
  const quoted = preview.split('\n').map((l) => `> ${l}`).join('\n')
  const draftSection = opts.draftBody
    ? `Suggested reply (AI-generated — check before sending):\n\n${opts.draftBody.trim()}`
    : 'No AI-suggested reply for this one.'
  return {
    subject: `[${opts.deskName}] ${label}: ${subject}`,
    text: `A new ticket arrived on the ${opts.deskName}.\n\nSubject: ${subject}\nFrom: ${opts.senderEmail || 'unknown'}\n\n${quoted}\n\n${draftSection}\n\n${opts.link}\n\nYou're getting this because you're an agent on this desk.`,
  }
}
