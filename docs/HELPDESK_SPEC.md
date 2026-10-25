# SIL Help Desk: Product Spec (draft for review)

Status: draft, written from the design conversation of 2026-10-25. Nothing in this file has been built. It supersedes the open questions in `HELPDESK_PROJECT_BRIEF.md` Sections 3-6 where they conflict; the brief remains the source for corpus migration (Section 8) and AWS tickets (Section 7), which stay deferred.

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
| 11 | Ingestion: service account with domain-wide delegation reading one dedicated ingest mailbox. Parallel run with YouTrack first; alias cutover per desk later. |
| 12 | Each desk can have several addresses, and optionally its own mailbox. |
| 13 | AI drafts are generated automatically on every new ticket and on every new requester reply (cached), draft-only in v1. |
| 14 | Shared RAG corpus across all desks; each desk may opt out of contributing. |
| 15 | Default theme is SIL brand (SIL Blue `#005CB9`). Playfair for titles, Source Sans 3 for UI. Per-desk logo and optional color override. |
| 16 | The reporter is emailed when their ticket is transferred to another desk (from the new desk's address). |
| 17 | Deleted tickets are purged, and all ticket attachments and media are removed, after a configurable retention period, default 60 days. |
| 18 | The parallel run with YouTrack is per address: lesser-used addresses move from their Google Group to an alias on the ingest mailbox and run live in the app (replies enabled); busy addresses stay on their groups and YouTrack until cutover. |

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

- Super admin is a global role on `profiles`. Desk roles live in `agent_desks.role` (`agent` or `admin`).
- A reporter is derived: anyone with no desk role who owns a requester record linked to their profile.
- A sending desk keeps read-only access to a transferred ticket.
- RLS: internal messages and `ticket_events` are never visible to reporters or CCs; reporters see only tickets where `requesters.profile_id` is their profile.

## 4. Data model (changes to `schema_helpdesk.sql`)

- `desks`: add `logo_url`, theme columns (primary and accent, nullable, default means SIL theme), `accepts_transfers boolean default false`.
- `desk_addresses(address, desk_id, can_send_from, is_default_reply, live_replies)`: several addresses per desk. `live_replies` is per address and defaults to false; it is turned on when the address is moved to an alias on the ingest mailbox. Addresses still on a group are either not ingested or ingested in shadow mode (read and draft, no replies).
- `desk_mailboxes(mailbox, desk_id, auth_type)`: which mailbox feeds which desk (service account, or stored OAuth for outside domains).
- `requesters`: add `profile_id` (nullable), linked on sign-in by email match or manually by an agent.
- `tickets`: rename status `solved` to `resolved`; add `new`, `deleted`; add `assignee_profile_id`, `deleted_at`, `sensitive boolean`, `detected_reporter_confidence`, `reporter_verified boolean`, `forwarded_to`, `source_address`.
- `ticket_participants(ticket_id, email, type)`: CCs and agent followers.
- `ticket_messages`: keep `internal`; add attachment references.
- `ticket_events`: used for every reassignment, transfer, reporter change, promotion and reopen.
- `desk_settings`: add per-desk tone/signature, `contribute_to_corpus`, holiday calendar, `deleted_retention_days` (nullable; null uses the global default).
- `desk_settings`: also `attachment_retention_days` (nullable; null uses the global default) (`live_replies` lives on `desk_addresses`, not here).
- Global settings (super admin): default `deleted_retention_days` = 60 and default `attachment_retention_days` = 60.
- `corpus_documents`: add redaction flag; exclusions for internal notes and sensitive tickets.

## 5. Statuses

New (default) -> Open (first agent action: reply, assign or status change) -> Waiting for response (agent asked a question) -> Open (reporter replies) -> Resolved -> Closed. Paused (until date Z) freezes the SLA clock and auto-resumes to Open. Deleted is a soft delete with an audit event. A daily job permanently removes tickets `deleted_retention_days` after deletion (global default 60, per-desk override), together with their attachments and any corpus documents made from them. Attachments and media on every ticket are removed `attachment_retention_days` after the ticket is Closed (or after deletion, for Deleted tickets); the thread then shows "attachment removed" in place of the file. Closed and Resolved ticket text is kept and continues to feed the corpus.

- Reporters see Paused as "On hold" with no date, and never see Deleted.
- Closing by forwarding outside records `forwarded_to` so reports don't count it as a resolution.
- An external reply to a forwarded-closed ticket reopens it and logs "reopened by external reply".
- Nudge after X days of reporter silence and auto-close after a further Y days (per-desk settings already exist).

## 6. Email ingestion

**Mailbox and auth.** One dedicated, non-human ingest mailbox (for example `helpdesk-ingest@sil.org`) read through a Google Cloud service account with domain-wide delegation. Scopes: `gmail.modify` and `gmail.send` (to be confirmed before authorizing). The key lives in Supabase secrets only.

- Risk to document: delegation lets the service account impersonate any domain user for the granted scopes; only our code limits it to the ingest mailbox. Admin review required.
- The BTC pilot stays on its OAuth token until sil.org is ready (different Workspace domain).

**Parallel run (first).** Existing desks use Google Groups with YouTrack as a subscriber. Add the ingest mailbox as another member of one test desk's group. YouTrack keeps working untouched.

- Group delivery means `deliveredto:` filters won't match. Route by group headers (`List-Id` / `X-Google-Group-Id`), falling back to recipient addresses, through `desk_addresses`.
- Strip group footers and subject prefixes before storing text.
- **Parallel run is per address.** Move lesser-used addresses off their group and onto the ingest mailbox as aliases; they run live in the app (plain "send as", `live_replies` on). Busy addresses stay on their groups and YouTrack, either not ingested or ingested in shadow mode (the app reads and drafts but does not send). This avoids needing to test sending as a group.
- Moving an address stops YouTrack receiving it. Replies to older YouTrack conversations on that address become new tickets in the app, so move addresses at quiet times or let open YouTrack tickets finish first. A desk can have live and not-yet-moved addresses at the same time.

**Cutover (later, per desk).** When a desk trusts the app, move its address from the group to an alias on the ingest mailbox. YouTrack stops receiving mail at that point. Aliases make `deliveredto:` filters and "send as" straightforward. An address cannot be both a group and an alias.

**Processing.**
- Poll every minute via `pg_cron`. Pub/Sub push can come later if latency matters.
- Per-desk Gmail label as the isolation boundary, as in the pilot. Unlabelled or unmatched mail goes to an **unrouted queue** for the super admin.
- Threading by `In-Reply-To`/`References`, with Gmail thread ID as fallback.
- **Loop protection (must-have):** ignore `Auto-Submitted`, out-of-office replies and bounce messages; never auto-reply to unknown or automated senders.
- Attachments stored in Supabase Storage with size limits and scanning.
- Basic spam flagging, since anyone can email in.
- Replies are sent from the address the ticket arrived on. A desk can never send from another desk's address.
- A desk address first shows "pending" in admin, then "receiving mail" after the first message arrives. Only a Workspace admin creates the alias or group membership; desk admins only record the address.

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
- Gap detection: "no known answer" flag, and "add to knowledge base" on resolve with a redaction preview.
- Later tier, deferred: auto-send for high-confidence matches with "this solved it" / "I still need help" signed links.

**Corpus policy.**
- Shared across all desks (decision 14). Each desk may opt out of contributing (`contribute_to_corpus`); redaction is on by default.
- Redact emails, phone numbers, passwords and tokens before embedding.
- Excluded always: internal notes and tickets marked sensitive.
- Ticket text is untrusted input. Drafts are text only and never trigger actions.
- Voyage's training opt-out must be confirmed before real data is embedded.

## 12. Other features

**Before a real pilot:** loop protection, attachments, notifications (new ticket, assigned, @mention, reporter reply, reporter status emails), search with saved views, reply threading.

**Soon after:** collision warning when two agents reply at once, @mentions, auto-assign or round-robin, SLA timers and per-desk reports (with business hours and holidays), out-of-hours auto-reply, one-click satisfaction rating on resolve, tags and categories, bulk actions, CSV export, nudge and auto-close, YouTrack history import into the corpus.

**Policy decisions still open:** handling of a data-erasure request.

## 13. Suggested build order

0. **Admin prerequisites (Kate):** ingest user, Google Cloud service account with Gmail API, delegation authorization, one test group with the ingest mailbox as a member, key into Supabase secrets.
1. **Schema:** `helpdesk` schema, statuses, roles, RLS, address and mailbox tables.
2. **Ingestion:** poller, routing, unrouted queue, loop protection, threading, attachments. Parallel run on one desk alongside YouTrack.
3. **Ticket UI:** queue, ticket detail, reply and internal note, assignment, CCs, notifications.
4. **Reporter view, admin screens, branding.**
5. **Reporter detection:** layers 1, 2 and 4, then layer 3 only if needed.
6. **Transfers and external forwards.**
7. **RAG and automatic AI drafts.**
8. **SLA, reports, nudge, auto-close, satisfaction rating.**
9. **SSO swap; per-desk alias cutover and YouTrack retirement.**

## 14. Risks and open items

- Domain-wide delegation scope: a leaked key could read any mailbox for the granted scopes. Mitigate with secrets-only storage, minimal scopes, admin review.
- Whether `schema_helpdesk.sql` was already applied to the shared project (affects the schema move).
- Erasure requests (a person asking for their data to be removed before the retention window ends): handling not decided.
- Strategic questions in the brief Section 10 (why now, ROI, why earlier combine attempts failed) remain unanswered; none of the above depends on them.
