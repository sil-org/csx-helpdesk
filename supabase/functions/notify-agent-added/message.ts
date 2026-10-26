// Pure email content building. No Deno/network APIs here so it's
// unit-testable with plain Node (see message.test.ts).

export function buildNotifyEmail(opts: { displayName: string | null; deskName: string; link: string }) {
  const firstName = (opts.displayName || '').trim().split(/\s+/)[0] || 'there'
  return {
    subject: `You've been added to the ${opts.deskName}`,
    text: `Hi ${firstName},\n\nYou've been added to the ${opts.deskName} on the SIL Help Desk. Sign in to get started:\n\n${opts.link}\n\nSign in with your SIL Google account.`,
  }
}
