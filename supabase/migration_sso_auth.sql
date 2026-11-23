-- Adds helpdesk.resolve_profile_sso(), the SSO-only sibling of the shared
-- public.resolve_profile(); brings the shared auth kernel up to the
-- hardened version license-manager already applied on 2026-09-25 (see its
-- supabase/pending/78_critical_auth_hardening.sql); AND removes an
-- undocumented trigger that was bypassing all of the above for every new
-- sign-in. Run this once in the Supabase SQL editor against a project that
-- already has schema.sql and schema_helpdesk.sql applied. Safe to run again
-- (create or replace / drop and recreate / drop if exists throughout).
-- Fresh setups do not need this file: schema.sql + schema_helpdesk.sql
-- already include the kernel and RPC parts; the trigger (see part 1) only
-- needs dropping on a project where it was ever created by hand, which
-- fresh setups never had.
--
-- Why all of this in one file: resolve_profile_sso() depends on
-- is_eligible_staff_email() and on identity coming from auth.uid() rather
-- than caller-supplied parameters — the same fix license-manager's
-- resolve_profile() already got. Skipping those statements would leave
-- resolve_profile_sso() either broken (missing function) or carrying the
-- same caller-trusts-its-own-identity hole license-manager fixed in
-- September. See SETUP.md step 2 for how to register the SAML provider and
-- the VITE_SSO_PROVIDER_ID env var this function's caller
-- (src/lib/auth.js) needs.
--
-- Before relying on this in production: existing staff who signed in with
-- Google need their Google identity removed (Authentication > Users > Delete,
-- for that identity) and their stale public.linked_accounts row cleaned up,
-- or their first SSO sign-in may fail with a database error — the old
-- trigger below (part 1) is why; this migration fixes the error's root
-- cause going forward, but a stale row from BEFORE this migration ran still
-- needs manual cleanup for that one person. Pilot with 1-2 accounts before
-- a full staff cutover.

-- ─── 1. Drop handle_new_auth_user() — superseded by resolve_profile() ───────
-- Found 2026-11-23: an undocumented trigger on this shared project
-- (on_auth_user_created, AFTER INSERT ON auth.users), not created by either
-- app's migrations, owned by Kate. It auto-created or matched a profile for
-- ANY new auth.users row — any sign-in method, any email — with NO
-- eligibility check at all (it never called is_eligible_staff_email() or
-- any domain check). Worse, because it fires on auth.users INSERT, before
-- either app's client code gets a chance to call resolve_profile() /
-- resolve_profile_sso(), it won the race every time: by the time those RPCs
-- ran, linked_accounts already had a row from this trigger (case 1,
-- "already linked"), so the RPCs' own eligibility checks never actually
-- applied to a new sign-in. It also only matched a profile with zero
-- existing linked_accounts rows (meant for placeholder profiles from the
-- team-hierarchy import), so a stale orphaned row — e.g. left behind after
-- deleting someone's Google identity during an SSO cutover — made it try to
-- insert a second profile with the same primary_email and collide on that
-- unique index, surfacing to the client as "Database error saving new
-- user".
--
-- Dropped rather than fixed in place: resolve_profile()/resolve_profile_sso()
-- already do this matching correctly (by-email upsert, is_eligible_staff_email(),
-- no stale-row bug) and are already called by every app on this shared
-- project right after sign-in — one source of truth instead of two that
-- have to stay in sync. The only behavior change: a profile/linked_accounts
-- row now appears a moment later (after the app's RPC call) instead of
-- instantly at auth.users insert time.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_auth_user();

-- ─── 2. is_eligible_staff_email() — broader than a hardcoded @sil.org check ──
-- Keep this list in sync with license-manager's copy (supabase/schema.sql).

create or replace function is_eligible_staff_email(p_email text)
returns boolean language sql immutable as $$
  select lower(split_part(p_email, '@', 2)) in (
    'sil.org', 'hipaa.sil.org', 'ethnologue.com', 'scriptsource.org',
    'email7.net', 'i55seed.com', 'koastal.net', 'mailrapide.com',
    'pike34.net', 'sall.com', 'spbangladesh.org'
  )
$$;

-- ─── 3. public.resolve_profile() — identity from the session, not params ────
-- Shared with license-manager; this is its already-applied, hardened body.

create or replace function resolve_profile(
  p_token uuid,
  p_supabase_user_id uuid,
  p_email text,
  p_display_name text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed_at timestamptz;
  v_display_name text;
  v_profile_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;

  select u.email, u.email_confirmed_at,
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''), u.email)
    into v_email, v_confirmed_at, v_display_name
  from auth.users u where u.id = v_uid;
  if v_email is null then raise exception 'signed-in account has no email address'; end if;

  -- case 1: already linked
  select profile_id into v_profile_id
  from linked_accounts where supabase_user_id = v_uid;
  if v_profile_id is not null then
    return v_profile_id;
  end if;

  -- case 2: valid link token — links this account to the token's profile
  -- regardless of email domain (the token itself is the proof). Locked so
  -- two concurrent sign-ins can't both redeem the same token.
  if p_token is not null then
    select profile_id into v_profile_id
    from profile_link_tokens
    where token = p_token and used_at is null and expires_at > now()
    for update;

    if v_profile_id is not null then
      insert into linked_accounts (supabase_user_id, profile_id, email)
      values (v_uid, v_profile_id, v_email);
      update profile_link_tokens set used_at = now() where token = p_token;
      return v_profile_id;
    end if;
  end if;

  -- case 3: new person, or first sign-in for a pre-created placeholder profile.
  if not is_eligible_staff_email(v_email) then
    raise exception 'Access restricted to SIL staff.';
  end if;
  if v_confirmed_at is null then
    raise exception 'email address not confirmed';
  end if;

  select id into v_profile_id from profiles where lower(primary_email) = lower(v_email);
  if v_profile_id is not null then
    update profiles set display_name = v_display_name where id = v_profile_id;
  else
    insert into profiles (display_name, primary_email)
    values (v_display_name, v_email)
    returning id into v_profile_id;
  end if;

  insert into linked_accounts (supabase_user_id, profile_id, email)
  values (v_uid, v_profile_id, v_email);

  return v_profile_id;
end;
$$;

-- No insert policy: rows are only ever created by resolve_profile(), a
-- security definer RPC. (A `with check (true)` policy used to live here,
-- which let any signed-in user link themselves to any profile directly.)
drop policy if exists "linked_accounts: insert own" on linked_accounts;

-- The own-update policy on profiles still lets a user rewrite every other
-- column of their own row. This trigger rejects client-side changes to
-- authorization-relevant columns; security-definer RPCs are unaffected.
create or replace function profiles_block_self_escalation()
returns trigger language plpgsql set search_path = public as $$
declare
  k text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  foreach k in array array['id', 'primary_email', 'role', 'manager_email', 'sco', 'job_title', 'department'] loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'profiles.% can only be changed by an administrator', k using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists profiles_block_self_escalation on profiles;
create trigger profiles_block_self_escalation
  before update on profiles
  for each row execute function profiles_block_self_escalation();

-- ─── 4. helpdesk.resolve_profile_sso() — the new, helpdesk-only RPC ─────────
-- Does NOT replace or alter public.resolve_profile() above — license-manager
-- keeps using that one for Google sign-in on this same shared project.

create or replace function helpdesk.resolve_profile_sso(
  p_token uuid,
  p_supabase_user_id uuid,
  p_email text,
  p_display_name text
)
returns uuid language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed_at timestamptz;
  v_display_name text;
  v_is_sso boolean;
  v_profile_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;

  select u.email, u.email_confirmed_at, u.is_sso_user,
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''), u.email)
    into v_email, v_confirmed_at, v_is_sso, v_display_name
  from auth.users u where u.id = v_uid;
  if v_email is null then raise exception 'signed-in account has no email address'; end if;
  if v_is_sso is not true then raise exception 'SSO sign-in required.'; end if;

  -- case 1: already linked
  select profile_id into v_profile_id
  from public.linked_accounts where supabase_user_id = v_uid;
  if v_profile_id is not null then
    return v_profile_id;
  end if;

  -- case 2: valid link token — links this identity to the token's profile
  -- regardless of email domain (the token itself is the proof). Locked so
  -- two concurrent sign-ins can't both redeem the same token.
  if p_token is not null then
    select profile_id into v_profile_id
    from public.profile_link_tokens
    where token = p_token and used_at is null and expires_at > now()
    for update;

    if v_profile_id is not null then
      insert into public.linked_accounts (supabase_user_id, profile_id, email)
      values (v_uid, v_profile_id, v_email);
      update public.profile_link_tokens set used_at = now() where token = p_token;
      return v_profile_id;
    end if;
  end if;

  -- case 3: new person, or first sign-in for a pre-created placeholder profile.
  if not public.is_eligible_staff_email(v_email) then
    raise exception 'Access restricted to SIL staff.';
  end if;
  if v_confirmed_at is null then
    raise exception 'email address not confirmed';
  end if;

  select id into v_profile_id from public.profiles where lower(primary_email) = lower(v_email);
  if v_profile_id is not null then
    update public.profiles set display_name = v_display_name where id = v_profile_id;
  else
    insert into public.profiles (display_name, primary_email)
    values (v_display_name, v_email)
    returning id into v_profile_id;
  end if;

  insert into public.linked_accounts (supabase_user_id, profile_id, email)
  values (v_uid, v_profile_id, v_email);

  return v_profile_id;
end;
$$;
