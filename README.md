# SIL Help Desk

Unified help desk & ticketing platform for SIL departments (Dallas, Africa, Global IT, others TBD). See [docs/HELPDESK_PROJECT_BRIEF.md](docs/HELPDESK_PROJECT_BRIEF.md) for full context — **this is pre-build; several open strategic questions in that doc are still unresolved (Section 10).**

Built on [`sil-app-template`](https://github.com/kode-monki/sil-app-template) — the shared identity model, RLS conventions, SIL branding, and S3/CloudFront deploy pipeline all come from there. App-specific tables and pages are additions on top.

**Shares its Supabase project with [`license-manager`](https://github.com/kode-monki/license-manager)** rather than having its own — same `sil-app-template` auth kernel, same population of SIL staff, no table-name collisions between the two apps' domain schemas. One Google OAuth setup and one sign-in covers both. See `SETUP.md` step 1.

## Stack

React + Vite + Tailwind, Supabase (Postgres/Auth), Gmail API (OAuth refresh token for the one dedicated ingest mailbox; a service account with delegation is an optional alternative) for inbound email, Voyage AI embeddings + `pgvector` for RAG, Claude API for draft generation. Deployed to AWS S3/CloudFront via GitHub Actions.

## Status

Repo scaffold only. Built so far:
- Vite/React app shell (from `sil-app-template`): Google OAuth restricted to `sil.org` (enforced in `resolve_profile()`, not just client-side), `profiles`/`linked_accounts` identity model, role-based route guards, SIL branding
- Supabase schema in two files: `supabase/schema.sql` is the template's auth kernel (shared with license-manager; the sil.org check is enabled, scoped to new-profile creation only — see account linking below); `supabase/schema_helpdesk.sql` is the help desk, in its own Postgres schema `helpdesk` so the app can be split out later — desks and per-desk branding, desk addresses and mailboxes, requesters, tickets (seven statuses), messages, attachments, participants, an audit log, and role-aware row-level security for super admins, desk admins, agents and reporters (implements `docs/HELPDESK_SPEC.md` sections 3-6). Corpus/AI-draft tables come with that phase. Access rules are covered by SQL tests in `supabase/tests/`
- `/account` page for staff to link a personal Google account (e.g. a personal Gmail) as backup sign-in access, in case they ever lose access to their SIL email
- Stub `embed-document` edge function (`supabase/functions/embed-document/`) that embeds a corpus document via Voyage AI — gated on `VOYAGE_TRAINING_OPT_OUT_CONFIRMED` (see below)
- `helpdesk-ingest` edge function (`supabase/functions/helpdesk-ingest/`): polls the mailboxes in `helpdesk.desk_mailboxes` (OAuth for the dedicated ingest mailbox and the BTC pilot, or optionally a service account), routes mail to a desk by address, threads replies, reopens tickets on reply, stores attachments, skips automatic replies, and parks unroutable mail. Receive-only for now (sends nothing). `npm run test:ingest` runs its unit tests; setup is `SETUP.md` step 9
- `.github/workflows/deploy.yml` — builds + deploys the frontend to S3/CloudFront and edge functions to Supabase on push to `main`

Not started: ticket UI beyond the placeholder, RAG retrieval, AWS-ticket automation logging, migration tooling, sending email (replies, acknowledgements), real reporter detection on forwards, and the roles/admin UI (the database side exists). `helpdesk-ingest` has a pg_cron schedule template (`supabase/schedule_helpdesk_ingest.sql`) that hasn't been run against a live project. Per the brief's own recommendation, hold off on AWS-ticket integration and migration tooling until desk participation is confirmed.

### Email intake: sil.org ingest mailbox (production path) and a BTC test pilot

The production design is one dedicated ingest mailbox on sil.org (e.g. `helpdesk-ingest@sil.org`), read with an OAuth refresh token for that one mailbox (no domain-wide delegation needed), with each desk's addresses added as Google Group memberships (parallel run alongside YouTrack) or aliases (cutover). See `SETUP.md` step 9a and `docs/HELPDESK_SPEC.md` section 6. Until those are set up, `SETUP.md` step 9b describes a test pilot on `helpdesk-test@btconference.org` (an alias on `info@btconference.org`), isolated by a Gmail filter + label so the poller can't touch real BTC conference mail. That pilot is a stand-in only; don't leave production ticket intake on a conference domain.

### Voyage AI data-training opt-out — required before embedding real ticket content

Voyage AI trains on submitted content by default, unlike Anthropic's API. Since the RAG corpus is internal SIL ticket content, **opt out of training in the Voyage AI account dashboard before sending any real data** (it's an account-level setting on their end, not something this codebase can set for you). The `embed-document` function checks `VOYAGE_TRAINING_OPT_OUT_CONFIRMED` and refuses to call Voyage AI until that env var is `true` — set it only after confirming the opt-out.

## Local development

```bash
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your Supabase project
npm run dev
```

Point `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` at the same Supabase project as `license-manager` (don't create a separate one), then run `supabase/schema_helpdesk.sql` and `supabase/seed_pilot_desk.sql` against it — `schema.sql` (the auth kernel) only needs to be applied once for both apps combined. Full walkthrough, including what to do if the shared project doesn't exist yet, in `SETUP.md`.

## Before this goes further

The brief flags these as unresolved — confirm with Kate before treating any of them as settled:
- Why this project, why now (ROI/pitch)
- Whether prior "combine the helpdesks" attempts failed for tooling or organizational reasons
- The concrete case for pooling vs. each department improving its own tool
