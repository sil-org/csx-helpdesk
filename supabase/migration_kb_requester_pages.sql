-- Two helpers for the requester help center.
--
-- Run this whole script once in the Supabase SQL editor, on a project that
-- already has migration_kb_articles.sql. It is complete and safe to run again.
-- Fresh setups do not need this file: schema_helpdesk.sql already includes it.
--
--   kb_desks()         the desks that have at least one article the caller may
--                      read, with the branding and support address the help
--                      center needs. Signed-out visitors cannot read the desks
--                      table, so this is a definer function; it only names a
--                      desk when the caller can read one of its articles
--                      (branding is already visible to every signed-in person).
--   kb_signin_hint()   for a signed-out visitor, how many staff-only articles
--                      match a search, so the page can say "2 more results for
--                      signed-in staff". Returns a number only, never titles,
--                      and 0 for anyone signed in.

create or replace function helpdesk.kb_desks()
returns table (id uuid, slug text, name text, logo_url text, theme_primary text, support_address text)
language sql stable security definer set search_path = helpdesk, public
as $$
  select d.id, d.slug, d.name, d.logo_url, d.theme_primary,
    (select a.address from helpdesk.desk_addresses a
      where a.desk_id = d.id
      order by a.is_default_reply desc, (a.status = 'receiving') desc, a.created_at
      limit 1)
  from helpdesk.desks d
  where exists (
    select 1 from helpdesk.kb_articles k
    where k.desk_id = d.id and not k.is_draft and not k.archived
      and helpdesk.kb_can_read_tier(k.desk_id, k.tier)
  )
  order by d.name
$$;

create or replace function helpdesk.kb_signin_hint(p_query text) returns int
language sql stable security definer set search_path = helpdesk, public
as $$
  select case
    when public.current_profile_id() is not null then 0
    else (
      select count(*)::int from helpdesk.kb_articles k
      where k.tier = 'internal' and not k.is_draft and not k.archived
        and k.search_tsv @@ websearch_to_tsquery('english', coalesce(p_query, ''))
    )
  end
$$;

revoke all on function helpdesk.kb_desks() from public;
grant execute on function helpdesk.kb_desks() to anon, authenticated, service_role;
revoke all on function helpdesk.kb_signin_hint(text) from public;
grant execute on function helpdesk.kb_signin_hint(text) to anon, authenticated, service_role;
