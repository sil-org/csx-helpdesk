# SIL Help Desk

Unified help desk & ticketing platform for SIL departments (Dallas, Africa, Global IT, others TBD). See [docs/HELPDESK_PROJECT_BRIEF.md](docs/HELPDESK_PROJECT_BRIEF.md) for full context — **this is pre-build; several open strategic questions in that doc are still unresolved (Section 10).**

Built on [`sil-app-template`](https://github.com/kode-monki/sil-app-template) — the shared identity model, RLS conventions, SIL branding, and S3/CloudFront deploy pipeline all come from there. App-specific tables and pages are additions on top.

## Stack

React + Vite + Tailwind, Supabase (Postgres/Auth), Gmail API per-mailbox OAuth for inbound/outbound email, Voyage AI embeddings + `pgvector` for RAG, Claude API for draft generation. Deployed to AWS S3/CloudFront via GitHub Actions.

## Status

Repo scaffold only. Built so far:
- Vite/React app shell (from `sil-app-template`): Google OAuth restricted to `sil.org` (enforced in `resolve_profile()`, not just client-side), `profiles`/`linked_accounts` identity model, role-based route guards, SIL branding
- Draft Supabase schema split in two: `supabase/schema.sql` is the template's auth kernel unmodified (except the sil.org check is enabled); `supabase/schema_helpdesk.sql` adds the help-desk entities from brief Section 3 — `desks`, `desk_settings`, `agent_desks`, `requesters`, `tickets`, `ticket_messages`, `ticket_events`, `ticket_links`, `corpus_documents` — all referencing `profiles(id)`, not `auth.users`
- Stub `embed-document` edge function (`supabase/functions/embed-document/`) that embeds a corpus document via Voyage AI — gated on `VOYAGE_TRAINING_OPT_OUT_CONFIRMED` (see below)
- `.github/workflows/deploy.yml` — builds + deploys the frontend to S3/CloudFront and the edge function to Supabase on push to `main`

Not started: Gmail ingestion, ticket UI beyond the placeholder, RAG retrieval, AWS-ticket automation logging, migration tooling. Per the brief's own recommendation, hold off on AWS-ticket integration and migration tooling until desk participation is confirmed.

### Voyage AI data-training opt-out — required before embedding real ticket content

Voyage AI trains on submitted content by default, unlike Anthropic's API. Since the RAG corpus is internal SIL ticket content, **opt out of training in the Voyage AI account dashboard before sending any real data** (it's an account-level setting on their end, not something this codebase can set for you). The `embed-document` function checks `VOYAGE_TRAINING_OPT_OUT_CONFIRMED` and refuses to call Voyage AI until that env var is `true` — set it only after confirming the opt-out.

## Local development

```bash
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from your Supabase project
npm run dev
```

Run `supabase/schema.sql` then `supabase/schema_helpdesk.sql` against a fresh Supabase project (SQL Editor, or `supabase db push` once linked) before signing in — the app calls a `resolve_profile` RPC defined in the first file. Full walkthrough in `SETUP.md`.

## Before this goes further

The brief flags these as unresolved — confirm with Kate before treating any of them as settled:
- Why this project, why now (ROI/pitch)
- Whether prior "combine the helpdesks" attempts failed for tooling or organizational reasons
- The concrete case for pooling vs. each department improving its own tool
