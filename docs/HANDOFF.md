# Handoff: where this project stands

For a fresh Claude Code session (or a person) picking this up. Read in this order:

1. `docs/HELPDESK_SPEC.md`: every decision made so far (numbered table), roles,
   statuses, data model, ingestion design (section 6), build order (section 13), risks.
2. `SETUP.md`: the steps Kate has to do herself (Supabase, Resend, secrets, deploy).
3. `README.md`: what is built and what isn't.

## State (branch `ccr-a8382b2a-759lic`)

- Built and tested: the `helpdesk` schema with RLS (63 SQL checks in
  `supabase/tests/`), and the Resend inbound function
  `supabase/functions/helpdesk-inbound/` (`npm run test:inbound`, 31 tests).
- Not yet run anywhere real: nothing has been deployed or run against the live
  Supabase project. Attachment download from Resend is untested against a real attachment.
- Not built: ticket UI, sending email (replies/acknowledgements), RAG and AI drafts,
  reporter detection beyond a "forwarded" flag, SLA and reports.

## Decisions worth knowing that are not obvious from the code

- Inbound email is **Resend**, not a polled Gmail mailbox (changed after a live
  test on the real helpdesk@sil.org group). The earlier Gmail/OAuth poller was
  removed; it is in git history (before the commit "Move inbound email to Resend").
- Senders keep using `@sil.org` addresses. A Resend receiving address is a hidden
  member of each desk's Google Group. Outbound will use `@em.sil.org` with Reply-To
  set to the desk's `@sil.org` address (SPF can't be extended, GHD-382).
- The `gmail_message_id` / `gmail_thread_id` keys of `helpdesk.ingest_inbound` are
  historical names; the function stores the Resend email id there.
- Use `X-Original-Authentication-Results`, not Resend's `authentication` block, to
  judge whether a sender is who they claim.
- The Google Doc knowledge base is the AI-draft corpus. Merged copy:
  `1T3S2Cohx3gmXBVKBtQSXVCKQAJqn5R1JGaxzbHu1_ww` (the original,
  `1BVAgmI9kZbbERGTB_S5vNah0BZftazg96uzqVlJyQ40`, is untouched). Where ticket
  history and the old doc disagreed, ticket history won.

## Open questions waiting on Kate

Resend receiving limits/plan/retention; data-policy sign-off; who reviews corpus
proposals; SSO timing; pilot desk agents and success criteria; erasure-request
handling; whether the GHD responder should point at the merged Doc.
