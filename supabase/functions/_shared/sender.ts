// The From line for every email the help desk sends: "<Desk name> Helpdesk"
// as the display name on the shared sending address. Pure, no Deno APIs, so
// it's unit-testable with plain Node (see sender.test.ts).

// A desk's display name for email: drop a trailing "(pilot)"-style note and
// add " Helpdesk" unless the name already says Help Desk / Helpdesk.
export function senderName(deskName: string): string {
  const base = deskName.replace(/\s*\([^)]*\)\s*$/, '').trim()
  if (!base) return 'Helpdesk'
  return /help\s?desk$/i.test(base) ? base : `${base} Helpdesk`
}

// `configured` is HELPDESK_RESEND_FROM, which may be a bare address or
// "Name <address>"; only the address is used.
export function formatFrom(deskName: string, configured: string | undefined): string {
  const address = (configured || 'helpdesk@em.sil.org').split('<').pop()!.replace('>', '').trim()
  const name = senderName(deskName).replace(/["\\]/g, '')
  return `"${name}" <${address}>`
}
