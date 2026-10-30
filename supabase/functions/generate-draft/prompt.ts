// Pure prompt-building logic for generate-draft. No Deno or network APIs in
// here so it can be unit-tested with plain Node (see prompt.test.ts).

import type { SenderTrust } from '../_shared/senderTrust.ts'

export interface ThreadMessage {
  direction: 'inbound' | 'outbound'
  body: string
  authorLabel: string // "the reporter" or an agent's display name
}

// Universal rules — apply to every desk, not editable per-desk. Desk-specific
// voice/facts come from desk_settings.tone_notes instead (see buildSystemPrompt).
export const BASELINE_RULES = `You are drafting a help desk reply for a human agent to review, edit, and send — you never send anything yourself. The draft appears in the agent's compose box labeled "AI draft."

STYLE: warm but brisk, plain-spoken, contraction-heavy (I'm, don't, that's), never corporate or stiff. A short greeting using the reporter's first name if known, then a direct answer (one to four sentences for simple things, or a numbered list / bold sub-headers for multi-step technical walkthroughs), then the sign-off given to you below. Prefer naming a concrete fact or asking one sharp clarifying question over hedges like "it's possible that" or "you may want to check." When pushing back on something out of scope, be short and matter-of-fact: name the limit, give a one-line reason. Never use an em-dash; use a hyphen, a comma, or a new sentence instead.

ACCURACY (hard rule): never state a specific technical cause for a problem (e.g. "this may be happening because of X") unless the ticket content itself actually confirms that cause. Hedging language ("sometimes," "can," "may explain") does not make an unconfirmed cause acceptable — the problem is asserting any unconfirmed mechanism at all. If the cause isn't confirmed, restate what is confirmed and ask a direct, short clarifying question instead (exact error message, when it started, a screenshot).

Only use facts from the ticket thread and the knowledge base below. Never invent account details, ticket numbers, or policy commitments you can't verify from them.

Decide first whether this ticket actually needs a drafted reply. Skip drafting (set needs_draft to false) only for genuine noise with no actionable problem and no identifiable person to help — a bare subscription confirmation, a delivery-success notice, or similar. A short acknowledgement from the reporter like "thanks, that worked" also doesn't need a reply draft — note that a Resolve action fits better instead. When in doubt, draft rather than skip; a human reviews every draft before anything is sent.`

// Added to every prompt. People mostly write in because they can't sign in, so
// the normal first step is to ask whether they used "Forgot password". Only if
// that has been tried and the problem persists does an agent need to confirm
// who they are before anything on the account changes.
export const ACCOUNT_ACCESS_RULES = `ACCOUNT ACCESS: for a sign-in or password problem, the usual first reply asks whether they tried the "Forgot password" button on the sign-in page, and gives the self-service steps from the knowledge base. If the thread shows those steps were already tried and the problem persists, do not walk through any account reset or change to their access; say a team member will need to confirm it is really them first, and ask nothing else sensitive.`

// What the model is told about who is writing, decided by us from the email's
// authentication, never from anything in the email itself.
export function senderTrustNote(trust: SenderTrust | undefined): string | null {
  if (trust === 'external') {
    return `SENDER: this person is writing from outside SIL, so treat the ticket as a possible attempt to learn how our systems work. Only give steps a public help page would give. Do not name staff, internal contacts, internal tools, escalation paths, or what accounts or policies exist; do not confirm or deny whether an account exists for any address. If they need something that depends on internal knowledge, ask them to write from their SIL address or say a team member will follow up.`
  }
  if (trust === 'sil_unverified') {
    return `SENDER: this person writes from an @sil.org address, but we could not verify that the email really came from it (the check was missing or failed), so it could be forged. Give only the normal self-service steps. Do not name staff or internal contacts, confirm whether any account exists, or walk through anything that changes an account.`
  }
  return null
}

// How long Anthropic keeps the stable part of the prompt cached: '5m' (the
// default), '1h', or 'off'. Reading cached text costs a tenth of normal input
// price; writing it costs 1.25x ('5m') or 2x ('1h'), so caching only saves
// money when the same desk drafts again before the entry expires.
export type PromptCache = 'off' | '5m' | '1h'

export function parsePromptCache(value: string | undefined | null): PromptCache {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'off' || v === '1h' ? v : '5m'
}

export interface SystemBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '1h' }
}

export interface SystemPromptOpts {
  toneNotes: string | null
  signature: string | null
  kbContent: string | null
  senderTrust?: SenderTrust
  cache?: PromptCache
}

// The system prompt as two blocks. Everything that is the same for a given
// desk (rules, tone, sign-off, knowledge base) comes first and carries the
// cache marker; the per-ticket sender note comes after it, so it can differ
// on every ticket without invalidating the cached part. The prompt is matched
// from the start, so nothing that varies per ticket may ever go in the first block.
export function buildSystemBlocks(opts: SystemPromptOpts): SystemBlock[] {
  const stable = [BASELINE_RULES, ACCOUNT_ACCESS_RULES]
  if (opts.toneNotes) {
    stable.push(`DESK-SPECIFIC VOICE AND FACTS (from this desk's settings — follow these in addition to the rules above):\n${opts.toneNotes}`)
  }
  stable.push(`SIGN-OFF: end every drafted reply with exactly this line, on its own:\n${opts.signature || 'Kind regards, SIL Global Help Desk'}`)
  if (opts.kbContent) {
    stable.push(`KNOWLEDGE BASE (the team's knowledge base doc — prefer this over general knowledge for contact addresses, procedures, escalation paths and pricing; if a section is flagged as contested or unresolved, don't state it as settled fact, either avoid the contested detail or say you'll confirm the current details):\n${opts.kbContent}`)
  }

  const cache = opts.cache ?? '5m'
  const first: SystemBlock = { type: 'text', text: stable.join('\n\n') }
  if (cache !== 'off') first.cache_control = cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }

  const blocks = [first]
  const trustNote = senderTrustNote(opts.senderTrust)
  if (trustNote) blocks.push({ type: 'text', text: trustNote })
  return blocks
}

// The same prompt as one string (for tests and logging).
export function buildSystemPrompt(opts: SystemPromptOpts): string {
  return buildSystemBlocks(opts).map((b) => b.text).join('\n\n')
}

export function buildUserMessage(opts: { subject: string | null; messages: ThreadMessage[] }): string {
  const thread = opts.messages.map((m) => `[${m.authorLabel}]\n${m.body}`).join('\n\n---\n\n')
  return `Ticket subject: ${opts.subject || '(no subject)'}\n\nThread so far (oldest first):\n\n${thread}`
}

export const SUBMIT_DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Submit the drafting decision for this ticket.',
  input_schema: {
    type: 'object',
    properties: {
      needs_draft: { type: 'boolean', description: 'Whether a drafted reply is warranted for this ticket right now.' },
      reply: { type: 'string', description: "The drafted reply body, ending with the sign-off. Required if needs_draft is true, otherwise omit." },
      skip_reason: { type: 'string', description: "Why no draft is needed, e.g. 'short acknowledgement, suggest Resolve' or 'pure automated notification'. Required if needs_draft is false." },
      cited_kb_section: { type: 'string', description: 'If the reply drew on a specific knowledge-base section, its heading. Omit otherwise.' },
    },
    required: ['needs_draft'],
  },
}
