# SIL Help Desk: Product Spec (draft for review)

Status: draft, written from the design conversation of 2026-10-25 and revised 2026-10-30 (per-desk knowledge bases, decisions 14 and 19-21). Most of this file is still unbuilt; the build order in Section 13 says what is. It supersedes the open questions in `HELPDESK_PROJECT_BRIEF.md` Sections 3-6 where they conflict; the brief remains the source for corpus migration (Section 8) and AWS tickets (Section 7), which stay deferred.

UI mockups: https://claude.ai/artifact/SHBBmhf25HyUG8VCGn9RLv (private canvas; four screens: agent queue, ticket detail, reporter view, admin desks).

## 1. Decisions log

| # | Decision |
|---|---|
| 1 | Help desk tables live in their own Postgres schema, `helpdesk`, inside the shared Supabase project. The only coupling to `license-manager` is the shared identity kernel (`profiles`, `linked_accounts`). |
| 2 | Only SIL staff can sign in (Google now, SSO in about two weeks). Anyone can email a ticket in. |
| 3 | Seven statuses: New, Open, Waiting for response, Paused (with `paused_until`), Resolved, Closed, Deleted (soft delete). |
| 4 | When a ticket is forwarded in, the real reporter gets an acknowledgement only when detection confidence is high. Agents can always change the reporter manually. |
| 5 | Transfers go only to desks that opt in ("accepts transfers" per desk). |
| 6 | After a transfer, the sending desk keeps read-only access. |
| 7 | An external reply to a ticket closed by forwarding reopens the original ticket. |
| 8 | Desk admins can promote agents on their own desk to desk admin. Logged; a desk always keeps at least one admin. |
| 9 | An agent can work on several desks, with a desk switcher. |
| 10 | CCs get email only; no app access. |
| 11 | Ingestion uses Resend inbound (revised from a Gmail-polled ingest mailbox; tested on real group-delivered mail). People keep writing to their usual @sil.org desk addresses; a Resend receiving address is a hidden member of each desk's Google Group and Resend's `email.received` webhook creates the ticket. No Google Cloud project, OAuth token or delegation is needed. Parallel run with YouTrack first; per-address cutover later. |
| 12 | Each desk can have several addresses, and optionally its own mailbox. |
| 13 | AI drafts are generated automatically on every new ticket and on every new requester reply (cached), draft-only in v1. |
| 14 | Revised 2026-10-30. Each desk has its own knowledge base (KB), a Google Doc. Sharing is opt-in on both sides: a desk chooses whether to share its KB (`kb_shared`), and another desk chooses whether to use it as a source for its drafts (`desk_kb_sources`). A desk's own tickets only ever feed its own KB. Sharing a KB means other desks' drafts can quote it to their requesters, so it is effectively publishing. Replaces the earlier shared-by-default corpus. |
| 15 | Default theme is SIL brand (SIL Blue `#005CB9`). Playfair for titles, Source Sans 3 for UI. Per-desk logo and optional color override. |
| 16 | The reporter is emailed when their ticket is transferred to another desk (from the new desk's address). |
| 17 | Deleted tickets are purged, and all ticket attachments and media are removed, after a configurable retention period, default 60 days. |
| 18 | The parallel run with YouTrack is per address: an address runs in shadow mode (the Resend address is just another group member; the app reads and drafts but sends nothing, `live_replies` off) until a desk trusts it, then `live_replies` is turned on for that address. Outbound replies go from `@em.sil.org` (already verified on Resend) with Reply-To set to the desk's @sil.org address. |
| 19 | Revised 2026-10-30. Each desk's Google Doc stays the source of truth for that desk's KB. A one-click rating on resolve (Covered / Wrong or out of date / Missing) and a nightly digest that compares each AI draft with what was actually sent produce proposals, deduplicated so repeated issues don't each create an entry. The app never edits a Doc: a service account with commenter access posts the proposals as comments (one batched comment per desk per night) and a desk admin applies approved changes by hand. |
| 20 | The proposals table in the database is the authority on proposal status (pending, approved, rejected, applied). The Doc comment is only the delivery channel, because Google's "resolved" cannot tell applied from rejected. Admins approve or reject in the app; rejected proposals are suppressed. |
| 21 | Each KB section has a visibility, set by putting `[staff-only]` in its heading (the section runs to the next heading of the same or higher level). A desk's own drafts see its whole KB but are told never to quote staff-only sections. Other desks that use a shared KB, and requesters who sign in to a read-only KB view, see only the requester-visible sections. |

## 2. Architecture

- **Frontend:** React + Vite + Tailwind (from `sil-app-template`), S3/CloudFront.
- **Backend:** Supabase Postgres with RLS, edge functions, `pg_cron` for scheduled polling.
- **Schema isolation:** move every help desk table, type and function from `public` into schema `helpdesk` (decision 1).
  - Add `helpdesk` to Supabase's exposed API schemas last, after the schema exists. The setting only appends to the list.
  - Foreign keys reference `public.profiles(id)` only. Splitting the apps later is `pg_dump -n helpdesk` plus copying `profiles` and `linked_accounts`.
  - **Check first:** whether `schema_helpdesk.sql` was ever applied to the shared project's `public` schema. If so, migrate with `ALTER ... SET SCHEMA`; if not, rewrite the file.
- **Auth:** the app keeps authentication separate from help desk code so the move from Google OAuth to SSO doesn't touch it.
- **AI:** Voyage AI embeddings with `pgvector`, Claude API for drafts. Voyage's training opt-out must be confirmed before any real data is embedded (`VOYAGE_TRAINING_OPT_OUT_CONFIRMED`).

## 3. Roles and permissions

| Capability | Super admin | Desk admin | Agent | Reporter | CC |
|---|---|---|---|---|---|
| Create/delete desks | yes | no | no | no | no |
| Desk settings, branding, addresses | yes | own desk | no | no | no |
| Assign agents / promote to desk admin | yes | own desk | no | no | no |
| Work tickets on a desk | yes | own desk | own desk | no | no |
| See internal notes and audit log | yes | own desk | own desk | no | no |
| See own tickets and public thread | n/a | n/a | n/a | yes | no (email only) |
| See Deleted tickets | yes | yes (filter) | no | no | no |

- Super admin is a row in `helpdesk.super_admins`, deliberately **not** `public.profiles.role = 'admin'`: that role is shared with license-manager, and its admins should not automatically become help desk super admins (and the apps stay separable). Desk roles live in `agent_desks.role` (`agent` or `admin`) and change only through `helpdesk.set_desk_role()`, which audits each change and keeps at least one admin per desk.
- A reporter is derived: anyone with no desk role who owns a requester record linked to their profile.
- A sending desk keeps read-only access to a transferred ticket.
- RLS: internal messages and `ticket_events` are never visible to reporters or CCs; reporters see only tickets where `requesters.profile_id` is their profile.

## 4. Data model (changes to `schema_helpdesk.sql`)

- `desks`: add `logo_url`, theme columns (primary and accent, nullable, default means SIL theme), `accepts_transfers boolean default false`.
- `desk_addresses(address, desk_id, can_send_from, is_default_reply, live_replies)`: several addresses per desk. `live_replies` is per address and defaults to false; it is turned on when a desk is ready to answer from the app. Until then the address is ingested in shadow mode (read and draft, no replies).
- `desk_mailboxes`: left over from the retired Gmail-polling design; unused by Resend ingestion and safe to drop later. No credentials are stored in the database either way.
- `requesters`: add `profile_id` (nullable), linked on sign-in by email match or manually by an agent.
- `tickets`: rename status `solved` to `resolved`; add `new`, `deleted`; add `assignee_profile_id`, `deleted_at`, `sensitive boolean`, `detected_reporter_confidence`, `reporter_verified boolean`, `forwarded_to`, `source_address`.
- `ticket_participants(ticket_id, email, type)`: CCs and agent followers.
- `ticket_messages`: keep `internal`; add attachment references.
- `ticket_events`: used for every reassignment, transfer, reporter change, promotion and reopen.
- `desk_settings`: add per-desk tone/signature, `kb_doc_id` (the desk's own KB Google Doc), `kb_shared boolean default false`, holiday calendar, `deleted_retention_days` (nullable; null uses the global default).
- `desk_settings`: also `attachment_retention_days` (nullable; null uses the global default) (`live_replies` lives on `desk_addresses`, not here).
- Global settings (super admin): default `deleted_retention_days` = 60 and default `attachment_retention_days` = 60.
- `desk_kb_sources(desk_id, source_desk_id, precedence)`: which other desks' shared KBs a desk uses as sources, and in what order when they contradict. A row is only valid while the source desk has `kb_shared` on.
- `kb_cache(desk_id, content, source_doc_id, refreshed_at)`: one cached copy of each desk's KB Doc (replaces the single-row table).
- `corpus_documents`: becomes an index or cache of the Google Docs (for example if embeddings are added later), not a separate source of truth. Keeps the redaction flag and the exclusions for internal notes and sensitive tickets.
- `ticket_drafts`: add `loaded_by` and `sent_message_id` so each draft can be compared with the reply that was actually sent. History before this change has no link and is not analyzed.
- `corpus_proposals(id, desk_id, kind, target_entry_ref, proposed_text, source_ticket_ids, origin, status, proposed_by, reviewed_by, reviewed_at, applied_at, comment_id)`: `kind` is new or amend; `origin` is on_resolve_rating, nightly_digest or draft_diff; `status` is pending, approved, rejected or applied; `comment_id` is the Doc comment the proposal was delivered in.
- `kb_ratings(ticket_id, rating, note, rated_by, rated_at)` and `kb_entry_usage(entry_ref, covered_count)` for the one-click rating and use counts.
- Reporters see Paused as "On hold" with no date, and never see Deleted.
- Closing by forwarding outside records `forwarded_to` so reports don't count it as a resolution.
- An external reply to a forwarded-closed ticket reopens it and logs "reopened by external reply".
- Nudge after X days of reporter silence and auto-close after a further Y days (per-desk settings already exist).

## 6. Email ingestion

**Decision and why.** Inbound mail arrives through Resend (SIL already runs it: `em.sil.org` is verified and webhooks are used in another project), not a Gmail mailbox that we poll. That removes the Google Cloud project, the OAuth consent and refresh token (which can break on a password change), the ingest mailbox and the polling schedule. Senders are unaffected: they keep writing to `helpdesk@sil.org` and the other desk addresses.

**Path.** Each desk address is a Google Group (YouTrack is already a member). A Resend receiving address (`something@<id>.resend.app`) is added as one more member. When the group delivers a copy, Resend stores it and calls the `helpdesk-inbound` edge function with an `email.received` webhook (signed with Svix; the function verifies the signature). The webhook carries only metadata; the function fetches the full email (`GET /emails/receiving/:id`: headers, text, html, attachment list), then routes and ingests it.

**Verified on real mail (two test messages through the live helpdesk@ group):**
- `received_for` lists the original recipient (`helpdesk@sil.org`) even though the group rewrites the envelope `to` to the Resend address. The headers also keep `To`, `Mailing-list`, and the list object (post address, `List-Id`).
- `X-Original-Sender` carries the real sender; `From` is not rewritten for senders whose DMARC policy allows it (for strict-DMARC senders Google rewrites it, so the app reads `X-Original-Sender`).
- `In-Reply-To` and `References` are preserved, so replies thread.
- Body arrives as `text` and `html`, including the quoted history and the group footer ("To unsubscribe from this group..."), both stripped before storing.
- Resend's own `authentication` block (`dmarc: fail`) judges the group's re-sent copy and must not be used. Use `X-Original-Authentication-Results` (Google's verdict before the group) for reporter verification.
- Repeated headers arrive as JSON-array strings and the group's `List-*` headers as one JSON object; `normalizeHeaders` expands both.

**From Resend's quotas page:** received emails count toward the same daily and monthly quota as sent ones (free plan: 100 a day and 3,000 a month; paid plans: no daily cap, monthly quota by tier); the API rate limit is 10 requests a second per team across all keys; email data is kept 30 days (so an unrouted message can be re-processed only within 30 days, and everything we need must be stored in our own database, which the function does at receipt). The quota and rate limit are per Resend team, so another project on the same team shares them, and spam sent to a group address counts like real mail. Resend also has an "Inboxes" feature (3 included, more at $1 each); the managed receiving address worked without creating one and a single address is enough for routing by `received_for`, so we don't use it.

**Not yet verified:** the attachment-content download call, whether the 40 MB per-email limit Resend documents for sending also applies to received mail (not stated for inbound; our own cap is 10 MB per stored attachment, `HELPDESK_MAX_ATTACHMENT_BYTES`), delivery from groups that restrict external senders, what happens to mail that arrives after the quota is exhausted, and a second group's headers (a single Resend address serves every desk, routed by `received_for`).

**Processing (`supabase/functions/helpdesk-inbound/`).**
- The deploy uses `--no-verify-jwt`, so authentication is ours: the Svix signature against `HELPDESK_RESEND_WEBHOOK_SECRET` (the function refuses to run without it). One stored email can be re-processed by hand with `HELPDESK_REPROCESS_SECRET`.
- Sender = `X-Original-Sender`, else `From`. Desk = first of: group headers, `To`/`Cc`, `received_for`, matched against `desk_addresses`. Mail matching no desk gets an `ingest_log` row (`unrouted`) for the super admin and is re-processed after the address is added.
- Failures return an error so Resend retries the webhook; the Resend email id is the dedupe key, so duplicates are harmless.
- Threading by `In-Reply-To`/`References`. Replies have quoted history stripped (known markers only, and only when something was written above them); forwards are kept whole and flagged.
- **Loop protection (must-have):** ignore `Auto-Submitted`, out-of-office replies and bounce messages, and mail from our own desk addresses; never auto-reply to unknown or automated senders.
- Attachments stored in Supabase Storage with size limits (scanning later); an attachment that can't be stored is recorded with the reason, never dropped silently.
- Basic spam flagging, since anyone can email in.

**Sending (not built).** Replies go out through Resend from an `@em.sil.org` address with Reply-To set to the desk's `@sil.org` address, so the sender's reply returns through the group to the app. GHD-382 records that GTIS will not add vendor includes to SIL's SPF, which is why the already-verified `em.sil.org` is used. A desk can never send from another desk's address. Store the Message-ID Resend assigns to each outbound message so replies thread.

**Cutover (later, per address).** Because the Resend address is only a group member, YouTrack and the app run side by side as long as wanted. To retire YouTrack for a desk: turn on `live_replies` for its addresses, then remove YouTrack from the group. Addresses that are plain aliases (not groups) can deliver a copy to the Resend address through a Workspace routing rule, one rule per address.

## 7. Reporter detection

Layered, cheapest first; each layer yields a proposed reporter and a confidence.

1. **Forwarding headers and body:** parse the forwarded block (`---------- Forwarded message ---------`, `Reply-To`, `X-Forwarded-For`).
2. **Sender role:** if the sender is an agent or known staff member, treat it as a forward and look inside; otherwise the sender is the reporter.
3. **Claude** for messy cases (stripped headers, "Bob asked me to ask you..."), returning a proposal with a confidence score. Build only if layers 1, 2 and 4 miss too often.
4. **Manual reassign:** one click on the ticket. Writes a `ticket_events` row (from, to, who) and relinks the requester.

Behaviour by confidence:
- High: assign automatically and send the acknowledgement to the reporter.
- Low: show "Reporter unverified", hold the acknowledgement until an agent confirms or changes the reporter, then send it and log who was acknowledged.
- The forwarding agent does not become a watcher (brief Section 5).
- Typical low-confidence cases: stripped forward headers, long multi-person threads, "Bob can't log in", no-reply/shared senders, ambiguous names.

## 8. Participants and internal notes

- CCs and agent followers live in `ticket_participants`. CCs receive public replies by email and their replies thread in. They cannot open the ticket in the app, even with a SIL account.
- Internal notes: staff only, never emailed, excluded from the corpus. The compose box has Reply and Internal note tabs that change color, banner and send button so a note can't be sent publicly by accident.

## 9. Desk transfers and external forwards

- **Transfer:** agent picks a desk that accepts transfers. `current_desk_id` changes, status resets to New, assignee clears, history stays. The sending desk keeps read-only access. The reporter is emailed that the ticket moved and which desk now has it, from the new desk's address so replies go to the right place.
- **Forward outside:** agent forwards the thread to an external address; the ticket closes with a "forwarded to" note. A reply reopens it.
- Every transfer and forward writes `ticket_events`.

## 10. Branding

- Default: SIL brand. SIL Blue `#005CB9`, darker `#034D8A`, tints from the brand sheet. Playfair (titles), Source Sans 3 (UI). Violet `#93358D` and the darker green `#38751C` are examples of per-desk overrides (white text on standard green fails contrast).
- Per desk: logo upload and optional primary color; "Reset to default".
- Reporters see the branding of the desk that owns their ticket.
- The SIL logo itself is never redrawn; artwork comes from the Brand Help Desk (communications_global@sil.org). Desk sub-brand logos need Global Marketing and Communications approval.
- Yellow and Light Blue are not used for text (contrast).

## 11. AI draft responses

**Pipeline.** On creation of each new ticket: embed the text, retrieve the top matches from the shared corpus (resolved tickets and documentation), and call Claude to produce a draft in the ticket's detected language. The draft is stored and cached; it appears in the compose box labeled as an AI draft. Nothing auto-sends in v1.

**Replies from the requester.** The same pipeline runs on every new inbound message from the requester, not only the first.
- Context is the full public thread plus fresh corpus retrieval for the latest message. Internal notes are not given to the model for requester-facing drafts, so they cannot leak into a reply.
- A new inbound message replaces any unsent draft for that ticket (older drafts are kept in history so an agent can recover one).
- Not every reply gets a draft. Detect and skip auto-replies (see loop protection), and for short acknowledgements such as "thanks, that worked" suggest **Resolve** to the agent instead of drafting.
- If the reply answers a question the agent asked, the draft moves the ticket forward (next step or resolution); if it adds new problems, the draft says what is being done about each.
- Cost control: one draft per inbound message at most, retrieval and model calls skipped for skipped messages, and per-desk monthly spend visible to admins.

**Features.**
- Cited sources on every draft (ticket or doc, with the originating desk) and a confidence label; thumbs up/down per draft; edit-distance tracking between draft and sent reply.
- Per-desk tone, signature and boilerplate; default follows SIL's brand voice (competent, caring, engaging).
- Drafts in the reporter's language with an English view for the agent (Claude translation first; DeepL only if needed).
- Clarifying-question drafts when key details are missing.
- Thread summaries and automatic handoff summaries on transfer.
- Agent-facing suggestions, never auto-applied: category, a likely desk to transfer to (opted-in desks only), related or duplicate tickets (linked, never merged).
- Gap detection: a "no known answer" flag on the ticket, feeding the "Missing" rating and the learning loop below.
- Later tier, deferred: auto-send for high-confidence matches with "this solved it" / "I still need help" signed links.

**Learning loop: each desk's Google Doc is its KB.** Every desk has its own KB Doc and it stays the source of truth. Drafts read the desk's own Doc plus any shared Docs it has chosen to use (v1, no embeddings; move to entry-level retrieval if the combined text gets too large). The system proposes changes; a person approves every one; a person makes every edit.

- **Draft versus sent (the main signal).** The app records which AI draft was loaded into the compose box and links it to the reply that was sent. The nightly job classifies each difference as a knowledge correction, a style change, or personalization for this requester. Only knowledge corrections can become KB proposals. Style changes become suggestions for the desk's tone notes. Personalization is ignored. A draft sent unedited is not counted as confirmation of anything in the KB, so the KB cannot reinforce itself.
- **On resolve (one click).** When an agent marks a ticket Resolved, they rate the KB for that ticket: **Covered**, **Wrong or out of date**, or **Missing**, with an optional note.
  - *Covered:* nothing is proposed; the app counts the use against the matching entry so admins can see which entries matter most.
  - *Wrong or out of date:* creates an **amendment proposal** against that entry, showing the current text and the suggested fix.
  - *Missing:* held, not proposed. The nightly job groups similar misses, and once the same gap recurs (default three tickets in 30 days, configurable) it creates one **new-entry proposal** citing all the tickets. An agent can also use "propose now" for a one-off that matters.
- **Nightly job.** For each desk: classify the draft-versus-sent differences, cluster "Missing" ratings, find answers that contradict existing entries, and deduplicate against open and rejected proposals.
- **Delivery by Doc comment.** The service account has commenter access only. It posts one batched comment per desk per night. Google's API cannot reliably anchor a comment to a specific entry, so each proposal in the comment names the entry, quotes the current text, gives the proposed text, and lists source tickets by number only (never quoted ticket content, since anyone with the Doc can read comments). Each proposal also appears in the desk's review queue in the app.
- **Review.** A desk admin approves, edits or rejects each proposal in the app, then applies approved text to the Doc by hand and marks it applied. Rejected proposals are suppressed so they do not return. Items the Doc lists under "Open Items to Resolve" are never promoted to settled fact.
- **Test first.** Before building delivery, test commenting on a copy of one Doc to confirm what the API does with anchoring and notifications.
- Ticket text is untrusted input and proposals are only suggestions, which is one more reason nothing is applied automatically.
- Personal details are redacted before analysis; internal notes and sensitive tickets are excluded.

**Corpus policy.**
- Per desk, with opt-in sharing (decision 14). A desk's tickets only feed its own KB; redaction is on by default.
- Redact emails, phone numbers, passwords and tokens before embedding.
- Excluded always: internal notes and tickets marked sensitive.
- Ticket text is untrusted input. Drafts are text only and never trigger actions.
- Voyage's training opt-out must be confirmed before real data is embedded.

## 12. Other features

**Before a real pilot:** loop protection, attachments, notifications (new ticket, assigned, @mention, reporter reply, reporter status emails), search with saved views, reply threading.

**Soon after:** collision warning when two agents reply at once, @mentions, auto-assign or round-robin, SLA timers and per-desk reports (with business hours and holidays), out-of-hours auto-reply, one-click satisfaction rating on resolve, tags and categories, bulk actions, CSV export, nudge and auto-close, YouTrack history import into the corpus.

**Policy decisions still open:** handling of a data-erasure request.

## 13. Suggested build order

0. **Admin prerequisites (Kate):** Resend receiving address added to one test group (done for helpdesk@sil.org), Resend API key and webhook signing secret into Supabase secrets, webhook endpoint added in Resend, check Resend receiving limits and plan.
1. **Schema:** `helpdesk` schema, statuses, roles, RLS, address and mailbox tables. *(Built: `supabase/schema_helpdesk.sql`, with 63 access-rule checks in `supabase/tests/`.)*
2. **Ingestion:** Resend webhook, routing, unrouted queue, loop protection, threading, attachments. Parallel run on one desk alongside YouTrack. *(Built: `supabase/functions/helpdesk-inbound/`. Receive-only: it sends no email yet, only flags forwards as reporter-unverified, and does not scan attachments. Unit-tested against fixtures shaped like real group-delivered mail; not yet deployed or run against a live Supabase project. See SETUP.md step 9.)*
3. **Ticket UI:** queue, ticket detail, reply and internal note, assignment, CCs, notifications.
4. **Reporter view, admin screens, branding.**
5. **Reporter detection:** layers 1, 2 and 4, then layer 3 only if needed.
6. **Transfers and external forwards.**
7. **Per-desk knowledge bases and automatic AI drafts, then the learning loop:**
   a. Per-desk KB Docs, share and use-as-source toggles, per-section visibility. *(Built: `migration_kb_per_desk.sql`, `refresh-kb-cache`, `generate-draft/kb.ts`, the admin Knowledge base card. Not yet deployed or run against live Docs.)*
   b. Link each draft to the reply sent; capture the difference.
   c. Nightly job: classify differences and ratings, deduplicate, write proposals.
   d. Delivery as one batched Doc comment per desk; approve, reject and applied tracked in the app.
   e. Read-only KB view for signed-in requesters (requester-visible entries only).
8. **SLA, reports, nudge, auto-close, satisfaction rating.**
9. **SSO swap; per-desk alias cutover and YouTrack retirement.**

## 14. Risks and open items

- Resend credentials: the API key can read received mail (and, if Full access, send); keep it in Supabase secrets only, use the narrowest scope Resend offers, and give outbound sending its own key. A forged webhook is prevented by the Svix signature check. Resend holds copies of ticket email for 30 days, which is a data-policy point to confirm. Quota: received mail shares the Resend team's email quota with anything else on that team, so a spam burst or a busy day could block other sending; decide whether helpdesk traffic needs its own plan or team.
- Whether `schema_helpdesk.sql` was already applied to the shared project (affects the schema move).
- Erasure requests (a person asking for their data to be removed before the retention window ends): handling not decided.
- Doc comments from the service account have not been tested; try one on a copy first (anchoring, notification volume). The service account needs commenter access to each desk's Doc and no more.
- Confirm `live_replies` is on for every address. The draft-versus-sent comparison only sees replies sent from the app.
- Sharing a KB is effectively publishing it to other desks' requesters through drafts; desk admins need to be told this when they turn sharing on.
- Who reviews proposals: each desk admin for their own desk (default), or one person for everything.
- Strategic questions in the brief Section 10 (why now, ROI, why earlier combine attempts failed) remain unanswered; none of the above depends on them.
