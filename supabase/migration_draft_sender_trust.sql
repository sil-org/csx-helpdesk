-- One-off for a project that already has schema_helpdesk.sql applied:
-- record on each AI draft how far the sender was trusted (spec decision 22).
-- Already in schema_helpdesk.sql for fresh setups. Safe to run more than once.

alter table helpdesk.ticket_drafts add column if not exists sender_trust text
  check (sender_trust in ('sil_verified', 'sil_unverified', 'external'));
