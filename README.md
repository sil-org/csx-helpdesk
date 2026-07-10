# SIL Help Desk

Unified help desk & ticketing platform for SIL departments (Dallas, Africa, Global IT, others TBD). See [docs/HELPDESK_PROJECT_BRIEF.md](docs/HELPDESK_PROJECT_BRIEF.md) for full context — **this is pre-build; several open strategic questions in that doc are still unresolved (Section 10).**

Built on [`sil-app-template`](https://github.com/kode-monki/sil-app-template) — the shared identity model, RLS conventions, SIL branding, and S3/CloudFront deploy pipeline all come from there. App-specific tables and pages are additions on top.

**Shares its Supabase project with [`license-manager`](https://github.com/kode-monki/license-manager)** rather than having its own — same `sil-app-template` auth kernel, same population of SIL staff, no table-name collisions between the two apps' domain schemas. One Google OAuth setup and one sign-in covers both. See `SETUP.md` step 1.

## Stack

React + Vite + Tailwind, Supabase (Postgres/Auth), Gmail API per-mailbox OAuth for inbound/outbound email, Voyage AI embeddings + `pgvector` for RAG, Claude API for draft generation. Deployed to AWS S3/CloudFront via GitHub Actions.

## Status

Repo scaffold only. Built so far:
- Vite/React app shell (from `sil-app-template`): Google OAuth restricted to `sil.org` (enforced in `resolve_profile()`, not just client-side), `profiles`/`linked_accounts` identity model, role-based route guards, SIL branding
- Draft Supabase schema split in two: `supabase/schema.sql` is the template's auth kernel unmodified (except the sil.org check is enabled, scoped to new-profile creation only — see account linking below); `supabase/schema_helpdesk.sql` adds the help-desk entities from brief Section 3 — `desks`, `desk_settings`, `agent_desks`, `requesters`, `tickets`, `ticket_messages`, `ticket_events`, `ticket_links`, `corpus_documents` — all referencing `profiles(id)`, not `auth.users`
- `/account` page for staff to link a personal Google account (e.g. a personal Gmail) as backup sign-in access, in case they ever lose access to their SIL email
- Stub `embed-document` edge function (`supabase/functions/embed-document/`) that embeds a corpus document via Voyage AI — gated on `VOYAGE_TRAINING_OPT_OUT_CONFIRMED` (see below)
- Pilot `ingest-email` edge function (`supabase/functions/ingest-email/`) that turns inbound mail into tickets — see the BTC-alias pilot note below
- `.github/workflows/deploy.yml` — builds + deploys the frontend to S3/CloudFront and edge functions to Supabase on push to `main`

Not started: ticket UI beyond the placeholder, RAG retrieval, AWS-ticket automation logging, migration tooling, a recurring trigger for `ingest-email` (it currently only runs when invoked manually). Per the brief's own recommendation, hold off on AWS-ticket integration and migration tooling until desk participation is confirmed.

### Email intake is piloted on a BTC alias, not sil.org — temporary

sil.org MX record access isn't available yet, so `ingest-email` polls `helpdesk-test@btconference.org` (an alias on the existing `info@btconference.org` Google Workspace mailbox) instead of a real department address, isolated via a Gmail filter + label so it can't touch real BTC conference mail. **This needs to move to a real sil.org alias once DNS access is sorted** — see `SETUP.md` step 9 for the full setup and the reasoning behind the label-based isolation.

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
