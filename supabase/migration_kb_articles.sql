-- Knowledge base articles: per-desk Drive folders, three audiences, search.
--
-- Run this whole script once in the Supabase SQL editor, on a project that
-- already has schema_helpdesk.sql. It is complete (not a diff) and safe to run
-- again: it only adds what is missing.
-- Fresh setups do not need this file: schema_helpdesk.sql already includes it.
--
-- What it adds:
--   * desk_settings.kb_folder_id (the desk's KB folder in Drive, super admin
--     only) and kb_internal_audience (who may read the desk's internal articles)
--   * kb_articles: one row per article, written only by the sync (service role)
--   * kb_can_read_tier(): the one rule for who may read which audience
--   * search_kb() and kb_topics(): full-text search and topic list, run as the
--     caller so the same row-level rules apply
--
-- Audiences come from the subfolder an article lives in (spec decision 23):
--   public/    anyone, including signed-out visitors (sign-in help lives here)
--   internal/  any signed-in person, or only people who have a ticket on the
--              desk (desk_settings.kb_internal_audience)
--   agents/    the desk's agents and admins, and super admins
-- Drafts and archived articles are visible to the desk's agents only.
--
-- Signed-out visitors are given USAGE on the helpdesk schema and SELECT on
-- kb_articles, limited by policy to published public articles. Nothing else in
-- the schema is granted to the anon role.

-- ── Desk settings ────────────────────────────────────────────────────────

alter table helpdesk.desk_settings add column if not exists kb_folder_id text unique;
alter table helpdesk.desk_settings add column if not exists kb_internal_audience text not null default 'signed_in'
  check (kb_internal_audience in ('signed_in', 'ticket_requesters'));
comment on column helpdesk.desk_settings.kb_folder_id is
  'Drive folder holding this desk''s KB (public/, internal/, agents/ subfolders). Super admin only: the service account can read any folder it is shared on.';
comment on column helpdesk.desk_settings.kb_internal_audience is
  'signed_in: any signed-in person may read internal articles. ticket_requesters: only people who have a ticket on this desk (agents always can).';

-- Only a super admin (or the SQL editor / service role) may point a desk at a
-- Doc or a folder. Replaces the Doc-only guard from migration_kb_learning_loop.sql.
create or replace function helpdesk.guard_kb_doc_id() returns trigger
language plpgsql set search_path = helpdesk, public as $$
begin
  if (new.kb_doc_id is distinct from (case when tg_op = 'UPDATE' then old.kb_doc_id end)
      or new.kb_folder_id is distinct from (case when tg_op = 'UPDATE' then old.kb_folder_id end))
     and public.current_profile_id() is not null
     and not helpdesk.is_super_admin() then
    raise exception 'only a super admin can set a desk''s knowledge base Doc or folder' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists desk_settings_guard_kb_doc_id on helpdesk.desk_settings;
create trigger desk_settings_guard_kb_doc_id before insert or update on helpdesk.desk_settings
  for each row execute function helpdesk.guard_kb_doc_id();

-- ── Articles ─────────────────────────────────────────────────────────────

create table if not exists helpdesk.kb_articles (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  drive_id text not null,
  -- Assigned once by the sync and kept when the Doc is renamed, so links last.
  slug text not null,
  title text not null,
  tier text not null check (tier in ('public', 'internal', 'agents')),
  -- First folder below the audience folder (internal/Sign-in/Foo -> Sign-in).
  topic text,
  -- The whole article as markdown, [no-quote] sections included (people may
  -- read them; the marker only keeps them out of AI replies).
  body text not null,
  -- The same article without [no-quote] sections, for other desks' drafts and
  -- for senders who are not verified (spec decisions 21 and 22).
  body_shareable text not null,
  is_draft boolean not null default false,
  archived boolean not null default false,
  content_hash text,
  drive_modified_at timestamptz,
  synced_at timestamptz not null default now(),
  search_tsv tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(topic, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C')
  ) stored,
  unique (desk_id, drive_id),
  unique (desk_id, slug)
);
create index if not exists kb_articles_search_idx on helpdesk.kb_articles using gin (search_tsv);
create index if not exists kb_articles_desk_tier_idx on helpdesk.kb_articles (desk_id, tier);

-- ── Who may read what ────────────────────────────────────────────────────

-- Whether the caller may read a published article of this audience on this
-- desk. Agents, admins and super admins read every audience; drafts and
-- archived articles are handled by the policy, not here.
create or replace function helpdesk.kb_can_read_tier(p_desk_id uuid, p_tier text) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select case p_tier
    when 'public' then true
    when 'internal' then
      public.current_profile_id() is not null
      and (
        helpdesk.is_desk_agent(p_desk_id)
        or coalesce((select kb_internal_audience from helpdesk.desk_settings where desk_id = p_desk_id), 'signed_in') = 'signed_in'
        or exists (
          select 1
          from helpdesk.tickets t
          join helpdesk.requesters r on r.id = t.requester_id
          where t.current_desk_id = p_desk_id
            and t.status <> 'deleted'
            and r.profile_id = public.current_profile_id()
        )
      )
    when 'agents' then helpdesk.is_desk_agent(p_desk_id)
    else false
  end
$$;

alter table helpdesk.kb_articles enable row level security;

drop policy if exists kb_articles_select on helpdesk.kb_articles;
create policy kb_articles_select on helpdesk.kb_articles for select to authenticated
  using (
    helpdesk.is_desk_agent(desk_id)
    or (not is_draft and not archived and helpdesk.kb_can_read_tier(desk_id, tier))
  );

drop policy if exists kb_articles_select_anon on helpdesk.kb_articles;
create policy kb_articles_select_anon on helpdesk.kb_articles for select to anon
  using (tier = 'public' and not is_draft and not archived);

-- No insert/update/delete grants for signed-in users: only the sync writes.
grant usage on schema helpdesk to anon;
grant select on helpdesk.kb_articles to anon, authenticated;
grant all on helpdesk.kb_articles to service_role;

-- ── Search and topics ────────────────────────────────────────────────────
-- Both run as the caller (no security definer), so the policy above decides
-- which articles they can see. Matches in the snippet are wrapped in the
-- characters U+27E6 and U+27E7, never HTML, so the page can escape the text
-- and then mark the matches.

create or replace function helpdesk.search_kb(
  p_query text,
  p_desk_id uuid default null,
  p_include_unpublished boolean default false,
  p_limit int default 20
) returns table (
  id uuid, desk_id uuid, slug text, title text, topic text, tier text,
  is_draft boolean, archived boolean, snippet text, rank real, drive_modified_at timestamptz
)
language sql stable
as $$
  with q as (select websearch_to_tsquery('english', coalesce(p_query, '')) as tsq)
  select a.id, a.desk_id, a.slug, a.title, a.topic, a.tier, a.is_draft, a.archived,
         ts_headline('english', a.body, q.tsq,
           'StartSel=⟦, StopSel=⟧, MaxWords=35, MinWords=15, ShortWord=2, MaxFragments=1'),
         ts_rank(a.search_tsv, q.tsq),
         a.drive_modified_at
  from helpdesk.kb_articles a, q
  where a.search_tsv @@ q.tsq
    and (p_desk_id is null or a.desk_id = p_desk_id)
    and (p_include_unpublished or (not a.is_draft and not a.archived))
  order by ts_rank(a.search_tsv, q.tsq) desc, a.title
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

create or replace function helpdesk.kb_topics(
  p_desk_id uuid default null,
  p_include_unpublished boolean default false
) returns table (desk_id uuid, topic text, article_count bigint)
language sql stable
as $$
  select a.desk_id, coalesce(a.topic, 'General'), count(*)
  from helpdesk.kb_articles a
  where (p_desk_id is null or a.desk_id = p_desk_id)
    and (p_include_unpublished or (not a.is_draft and not a.archived))
  group by a.desk_id, coalesce(a.topic, 'General')
  order by 2
$$;

revoke all on function helpdesk.kb_can_read_tier(uuid, text) from public;
grant execute on function helpdesk.kb_can_read_tier(uuid, text) to authenticated, anon, service_role;
revoke all on function helpdesk.search_kb(text, uuid, boolean, int) from public;
grant execute on function helpdesk.search_kb(text, uuid, boolean, int) to authenticated, anon, service_role;
revoke all on function helpdesk.kb_topics(uuid, boolean) from public;
grant execute on function helpdesk.kb_topics(uuid, boolean) to authenticated, anon, service_role;
