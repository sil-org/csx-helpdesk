-- One-off for a project that already has schema_helpdesk.sql applied:
-- per-desk knowledge bases (spec decisions 14, 19-21). The same statements are
-- in schema_helpdesk.sql for fresh setups. Safe to run more than once.

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
-- requester_visible_content is the Doc minus sections whose heading is marked
-- [staff-only]; it is what other desks' drafts see. source_doc_id lets the
-- reader ignore a cache left over from a previous Doc.
create table if not exists helpdesk.desk_kb_cache (
  desk_id uuid primary key references helpdesk.desks(id) on delete cascade,
  content text,
  requester_visible_content text,
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
