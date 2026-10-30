// How far to trust a ticket's sender, from data the inbound function already
// stores. Pure (no Deno or network APIs) so it is unit-testable with plain
// Node (see senderTrust.test.ts).
//
// The check uses Google's verdict on the ORIGINAL sender, kept in the
// X-Original-Authentication-Results header. Resend's own `authentication`
// block judges the group's re-sent copy and is not usable (spec section 6).
// Only DMARC counts: SPF or DKIM can pass for the attacker's own domain while
// the visible From says sil.org; DMARC is the check that ties them together.

export type SenderTrust = 'sil_verified' | 'sil_unverified' | 'external'

export const SIL_DOMAINS = ['sil.org']

const RANK: Record<SenderTrust, number> = { external: 0, sil_unverified: 1, sil_verified: 2 }

function isSilDomain(domain: string, silDomains: string[]): boolean {
  return silDomains.some((d) => domain === d || domain.endsWith('.' + d))
}

// True only if some segment says dmarc=pass for the sender's own domain (when
// the segment names one) and no segment says anything but pass.
export function dmarcPassesFor(authResults: string | null | undefined, domain: string): boolean {
  if (!authResults) return false
  let passed = false
  for (const segment of authResults.split(';')) {
    const m = /^\s*dmarc\s*=\s*(\w+)/i.exec(segment)
    if (!m) continue
    if (m[1].toLowerCase() !== 'pass') return false
    const from = /header\.from\s*=\s*"?([\w.-]+)/i.exec(segment)?.[1]?.toLowerCase()
    if (from && from !== domain) return false
    passed = true
  }
  return passed
}

export function senderTrust(
  msg: { fromEmail: string | null | undefined; originalAuthResults?: string | null },
  silDomains: string[] = SIL_DOMAINS,
): SenderTrust {
  const domain = (msg.fromEmail ?? '').trim().toLowerCase().split('@').pop() ?? ''
  if (!domain || !isSilDomain(domain, silDomains)) return 'external'
  return dmarcPassesFor(msg.originalAuthResults, domain) ? 'sil_verified' : 'sil_unverified'
}

// A ticket is only as trustworthy as its least trustworthy sender, so one
// outside reply in a thread makes the whole thread "external".
export function weakestTrust(list: SenderTrust[]): SenderTrust {
  if (list.length === 0) return 'external'
  return list.reduce((a, b) => (RANK[b] < RANK[a] ? b : a))
}
