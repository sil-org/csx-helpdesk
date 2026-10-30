-- Knowledge base per desk, sender trust and draft outcomes.
--
-- Run this whole script once in the Supabase SQL editor, on a project that
-- already has schema_helpdesk.sql from before 2026-10-30. It is complete (not a
-- diff) and safe to run again: it only adds what is missing.
--
-- What it adds:
--   * desk_settings.kb_doc_id / kb_shared, desk_kb_cache, desk_kb_sources (each
--     desk's own knowledge-base Google Doc, with opt-in sharing)
--   * ticket_drafts.sender_trust (how far the sender was trusted)
--   * ticket_drafts.sent_message_id / used_draft / outcome / outcome_by /
--     outcome_at and record_draft_outcome() (how each AI draft compares with
--     the reply actually sent)
-- Fresh setups do not need this file: schema_helpdesk.sql already includes it.

-- How far generate-draft trusted the sender (spec decision 22): derived from
-- the email's DMARC result, never from the email's own text.
alter table helpdesk.ticket_drafts add column if not exists sender_trust text
  check (sender_trust in ('sil_verified', 'sil_unverified', 'external'));

-- What became of the draft (spec section 11, learning loop): which reply was
-- sent while it was the active suggestion, whether the agent loaded it into the
-- compose box, and how the sent text compares. Written only by
-- record_draft_outcome (below). The nightly job reads these to find drafts
-- agents had to correct.
alter table helpdesk.ticket_drafts add column if not exists sent_message_id uuid
  references helpdesk.ticket_messages(id) on delete set null;
alter table helpdesk.ticket_drafts add column if not exists used_draft boolean;
alter table helpdesk.ticket_drafts add column if not exists outcome text
  check (outcome in ('as_written', 'edited', 'rewritten'));
alter table helpdesk.ticket_drafts add column if not exists outcome_by uuid references public.profiles(id);
alter table helpdesk.ticket_drafts add column if not exists outcome_at timestamptz;

-- ── Per-desk knowledge bases (spec decisions 14, 19-21) ──────────────────
-- Each desk's KB is its own Google Doc. A desk shares it (kb_shared) and
-- other desks choose to use it (desk_kb_sources); both sides are opt-in.
-- Only a super admin can set kb_doc_id: the service account can read any Doc
-- it has been given, so letting a desk admin type an arbitrary Doc ID would
-- let them pull another desk's unshared KB into their own drafts.
alter table helpdesk.desk_settings add column if not exists kb_doc_id text unique;
alter table helpdesk.desk_settings add column if not exists kb_shared boolean not null default false;
comment on column helpdesk.desk_settings.contribute_to_corpus is 'Unused since the per-desk KB redesign (spec decision 14); kept so old data is not dropped.';

create or replace function helpdesk.guard_kb_doc_id() returns trigger
language plpgsql set search_path = helpdesk, public as $$
begin
  if new.kb_doc_id is distinct from (case when tg_op = 'UPDATE' then old.kb_doc_id end)
     and public.current_profile_id() is not null
     and not helpdesk.is_super_admin() then
    raise exception 'only a super admin can set a desk''s knowledge base Doc' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists desk_settings_guard_kb_doc_id on helpdesk.desk_settings;
create trigger desk_settings_guard_kb_doc_id before insert or update on helpdesk.desk_settings
  for each row execute function helpdesk.guard_kb_doc_id();

-- One cached copy of each desk's KB Doc, written by refresh-kb-cache.
-- shareable_content is the Doc minus sections whose heading is marked
-- [no-quote]; it is what other desks' drafts see. source_doc_id lets the
-- reader ignore a cache left over from a previous Doc.
create table if not exists helpdesk.desk_kb_cache (
  desk_id uuid primary key references helpdesk.desks(id) on delete cascade,
  content text,
  shareable_content text,
  source_doc_id text,
  refreshed_at timestamptz
);

-- Desk `desk_id` uses `source_desk_id`'s shared KB as a source for its drafts.
-- Lower precedence wins when sources disagree; the desk's own KB always wins.
-- Rows are only honoured while the source desk has kb_shared on (checked when
-- the row is written, and again by generate-draft when it reads).
create table if not exists helpdesk.desk_kb_sources (
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  source_desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  precedence int not null default 100,
  created_at timestamptz not null default now(),
  primary key (desk_id, source_desk_id),
  check (desk_id <> source_desk_id)
);

-- desk_settings is readable only by the desk's own agents, so "is that desk
-- sharing?" needs a definer function.
create or replace function helpdesk.desk_kb_is_shared(p_desk_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select coalesce((select kb_shared from helpdesk.desk_settings where desk_id = p_desk_id), false)
$$;

create or replace function helpdesk.shared_kb_desk_ids() returns setof uuid
language sql stable security definer set search_path = helpdesk, public
as $$
  select desk_id from helpdesk.desk_settings where kb_shared and helpdesk.is_any_agent()
$$;

alter table helpdesk.desk_kb_cache enable row level security;
alter table helpdesk.desk_kb_sources enable row level security;

drop policy if exists desk_kb_cache_select on helpdesk.desk_kb_cache;
create policy desk_kb_cache_select on helpdesk.desk_kb_cache for select to authenticated
  using (helpdesk.is_desk_agent(desk_id));

drop policy if exists desk_kb_sources_select on helpdesk.desk_kb_sources;
create policy desk_kb_sources_select on helpdesk.desk_kb_sources for select to authenticated
  using (helpdesk.is_desk_agent(desk_id));
drop policy if exists desk_kb_sources_insert on helpdesk.desk_kb_sources;
create policy desk_kb_sources_insert on helpdesk.desk_kb_sources for insert to authenticated
  with check (helpdesk.is_desk_admin(desk_id) and helpdesk.desk_kb_is_shared(source_desk_id));
drop policy if exists desk_kb_sources_update on helpdesk.desk_kb_sources;
create policy desk_kb_sources_update on helpdesk.desk_kb_sources for update to authenticated
  using (helpdesk.is_desk_admin(desk_id))
  with check (helpdesk.is_desk_admin(desk_id) and helpdesk.desk_kb_is_shared(source_desk_id));
drop policy if exists desk_kb_sources_delete on helpdesk.desk_kb_sources;
create policy desk_kb_sources_delete on helpdesk.desk_kb_sources for delete to authenticated
  using (helpdesk.is_desk_admin(desk_id));

grant select on helpdesk.desk_kb_cache, helpdesk.desk_kb_sources to authenticated;
grant insert, update, delete on helpdesk.desk_kb_sources to authenticated;
grant all on helpdesk.desk_kb_cache, helpdesk.desk_kb_sources to service_role;
revoke all on function helpdesk.shared_kb_desk_ids() from public;
grant execute on function helpdesk.shared_kb_desk_ids() to authenticated, service_role;

-- ── Draft outcomes (spec section 11) ─────────────────────────────────────
-- Called by the ticket screen right after an agent sends a public reply, with
-- the draft that was active and the message just saved. The outcome is worked
-- out here, not by the browser: 'as_written' if the sent text equals the draft
-- (ignoring whitespace), else 'edited' if the agent loaded the draft into the
-- compose box first, else 'rewritten' (they wrote their own). A function
-- rather than a column grant so an agent can only ever link a real public
-- reply on the same ticket, sent after the draft, and the first send wins.
create or replace function helpdesk.record_draft_outcome(p_draft_id uuid, p_message_id uuid, p_used boolean)
returns text
language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_draft helpdesk.ticket_drafts;
  v_msg helpdesk.ticket_messages;
  v_outcome text;
begin
  select * into v_draft from helpdesk.ticket_drafts where id = p_draft_id;
  -- can_work_ticket, not is_ticket_staff: a desk with read-only access (the
  -- sending desk after a transfer) must not write to the record.
  if not found or not helpdesk.can_work_ticket(v_draft.ticket_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select * into v_msg from helpdesk.ticket_messages where id = p_message_id;
  if not found or v_msg.ticket_id <> v_draft.ticket_id or v_msg.direction <> 'outbound'
     or v_msg.internal or v_msg.created_at < v_draft.created_at then
    raise exception 'that message is not a public reply sent after this draft on the same ticket' using errcode = '22023';
  end if;

  if v_draft.outcome is not null then
    return v_draft.outcome;
  end if;

  v_outcome := case
    when btrim(regexp_replace(v_msg.body, '\s+', ' ', 'g')) = btrim(regexp_replace(v_draft.body, '\s+', ' ', 'g')) then 'as_written'
    when coalesce(p_used, false) then 'edited'
    else 'rewritten'
  end;

  update helpdesk.ticket_drafts
  set sent_message_id = p_message_id,
      used_draft = coalesce(p_used, false),
      outcome = v_outcome,
      outcome_by = public.current_profile_id(),
      outcome_at = now(),
      superseded_at = coalesce(superseded_at, now())
  where id = p_draft_id;
  return v_outcome;
end $$;
revoke all on function helpdesk.record_draft_outcome(uuid, uuid, boolean) from public;
grant execute on function helpdesk.record_draft_outcome(uuid, uuid, boolean) to authenticated, service_role;
