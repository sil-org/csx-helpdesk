// Pure email content building for the new-ticket notification. No Deno/network
// APIs here so it's unit-testable with plain Node (see notify.test.ts).

export function buildNewTicketEmail(opts: {
  ticketNumber: number | null
  subject: string | null
  senderEmail: string | null
  deskName: string
  link: string
}) {
  const label = opts.ticketNumber != null ? `#${opts.ticketNumber}` : 'New ticket'
  const subject = (opts.subject || '').trim() || '(no subject)'
  return {
    subject: `[${opts.deskName}] ${label}: ${subject}`,
    text: `A new ticket arrived on the ${opts.deskName}.\n\nSubject: ${subject}\nFrom: ${opts.senderEmail || 'unknown'}\n\n${opts.link}\n\nYou're getting this because new-ticket notifications are switched on for testing.`,
  }
}
