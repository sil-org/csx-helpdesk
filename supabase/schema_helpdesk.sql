-- ─── HELP DESK — APP SCHEMA ──────────────────────────────────────────────────
-- Run this AFTER schema.sql (the sil-app-template auth kernel, shared with
-- license-manager). Implements docs/HELPDESK_SPEC.md sections 3-6 (roles,
-- data model, statuses, ingestion). Corpus / AI-draft tables (spec sections
-- 11-12) are NOT here yet; they land with that phase.
--
-- Isolation: everything lives in its own Postgres schema, `helpdesk`, so the
-- app can be split from license-manager later with `pg_dump -n helpdesk`.
-- The only coupling is foreign keys to public.profiles(id) and calls to
-- public.current_profile_id() (the shared identity kernel). Nothing in
-- `public` is created, altered, or dropped by this file.
--
-- After running it, add `helpdesk` to Supabase's exposed API schemas
-- (Settings > API > Exposed schemas — append, don't replace) and bootstrap
-- the first super admin (see the end of this file).
--
-- Safe to re-run: tables/functions use IF NOT EXISTS / OR REPLACE and
-- policies are dropped and recreated.

create schema if not exists helpdesk;

-- ── Types ────────────────────────────────────────────────────────────────

do $$ begin
  create type helpdesk.ticket_status as enum
    ('new', 'open', 'waiting', 'paused', 'resolved', 'closed', 'deleted');
exception when duplicate_object then null; end $$;

-- ── Desks ────────────────────────────────────────────────────────────────

create table if not exists helpdesk.desks (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  logo_url text,
  -- null = use the default SIL theme (see spec section 10)
  theme_primary text check (theme_primary ~ '^#[0-9A-Fa-f]{6}$'),
  theme_accent text check (theme_accent ~ '^#[0-9A-Fa-f]{6}$'),
  accepts_transfers boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists helpdesk.desk_settings (
  desk_id uuid primary key references helpdesk.desks(id) on delete cascade,
  business_hours_start time not null default '09:00',
  business_hours_end time not null default '17:00',
  business_hours_timezone text not null default 'UTC',
  follow_up_nudge_days int not null default 3,
  auto_close_days int not null default 7,
  signature text,
  tone_notes text,
  contribute_to_corpus boolean not null default true,
  -- null = use helpdesk.global_settings
  deleted_retention_days int check (deleted_retention_days > 0),
  attachment_retention_days int check (attachment_retention_days > 0),
  updated_at timestamptz not null default now()
);

-- Singleton row of global defaults, owned by super admins.
create table if not exists helpdesk.global_settings (
  id boolean primary key default true check (id),
  deleted_retention_days int not null default 30 check (deleted_retention_days > 0),
  attachment_retention_days int not null default 60 check (attachment_retention_days > 0)
);
insert into helpdesk.global_settings (id) values (true) on conflict do nothing;
update helpdesk.global_settings set deleted_retention_days = 30 where id = true;

-- ── People & roles ───────────────────────────────────────────────────────

-- Deliberately NOT public.profiles.role = 'admin': that role is shared with
-- license-manager, and its admins shouldn't automatically become help desk
-- super admins (or vice versa). Managed in the SQL editor / by service role.
create table if not exists helpdesk.super_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  granted_at timestamptz not null default now()
);

-- Which desk(s) a profile works; also the ownership boundary for RLS.
-- Written only through helpdesk.set_desk_role() (audited, keeps >= 1 admin).
create table if not exists helpdesk.agent_desks (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  primary key (profile_id, desk_id)
);

create table if not exists helpdesk.desk_role_events (
  id uuid primary key default gen_random_uuid(),
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  from_role text,
  to_role text,
  actor_profile_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ── Addresses & mailboxes (spec section 6) ───────────────────────────────

-- A desk can have several addresses. Mail routes to a desk by matching any
-- recipient/group header against this table.
create table if not exists helpdesk.desk_addresses (
  address text primary key check (address = lower(address)),
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  can_send_from boolean not null default false,
  is_default_reply boolean not null default false,
  -- Replies are only sent from an address once this is on (set when the
  -- address is moved from its Google Group to an alias on the ingest mailbox).
  live_replies boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'receiving')),
  first_received_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists desk_addresses_one_default_idx
  on helpdesk.desk_addresses(desk_id) where is_default_reply;

-- NOT USED by the current ingestion (helpdesk-inbound receives mail from
-- Resend; see SETUP.md step 9). Kept from the retired Gmail-polling design;
-- safe to ignore or drop later.
-- Mailboxes the poller read. desk_id null = shared mailbox (route by address).
-- No credentials here: 'service_account' uses the HELPDESK_GOOGLE_SA_JSON
-- secret; 'oauth' reads <secret_prefix>_CLIENT_ID / _CLIENT_SECRET /
-- _REFRESH_TOKEN secrets. isolation_label, when set, restricts the poller to
-- messages carrying that Gmail label (needed for mailboxes that also hold
-- real mail, like the BTC pilot).
create table if not exists helpdesk.desk_mailboxes (
  mailbox text primary key check (mailbox = lower(mailbox)),
  desk_id uuid references helpdesk.desks(id) on delete cascade,
  auth_type text not null check (auth_type in ('service_account', 'oauth')),
  secret_prefix text,
  isolation_label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  check (auth_type <> 'oauth' or secret_prefix is not null)
);

-- ── Requesters ───────────────────────────────────────────────────────────

-- The problem-owner (reporter), distinct from the email's literal sender.
-- profile_id links a requester to a SIL sign-in so they can see their own
-- tickets; null for outside senders (they follow by email only).
create table if not exists helpdesk.requesters (
  id uuid primary key default gen_random_uuid(),
  email text unique not null check (email = lower(email)),
  display_name text,
  profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists requesters_profile_id_idx on helpdesk.requesters(profile_id);

-- ── Tickets ──────────────────────────────────────────────────────────────

create table if not exists helpdesk.tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number bigint generated always as identity unique,
  current_desk_id uuid not null references helpdesk.desks(id),
  status helpdesk.ticket_status not null default 'new',
  subject text,
  requester_id uuid references helpdesk.requesters(id),
  sender_email text not null,
  assignee_profile_id uuid references public.profiles(id),
  detected_language text,
  paused_until timestamptz,
  last_agent_reply_at timestamptz,
  last_requester_reply_at timestamptz,
  nudged_at timestamptz,
  deleted_at timestamptz,
  sensitive boolean not null default false,
  reporter_confidence numeric(3, 2) check (reporter_confidence between 0 and 1),
  reporter_verified boolean not null default true,
  forwarded_to text,
  source_address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Reporter detection layer 1 (spec section 7): a best-effort guess at who a
-- forward is really about, parsed from the quoted "From:" line at ingestion.
-- Proposal only — never applied automatically; stays alongside requester_id
-- (the confirmed reporter) as the agent's starting point for reassignment.
alter table helpdesk.tickets add column if not exists detected_sender_name text;
alter table helpdesk.tickets add column if not exists detected_sender_email text
  check (detected_sender_email = lower(detected_sender_email));

-- True merge (not the never-silently-merged ticket_links — that's for
-- related-but-distinct tickets; this is for "these are actually the same
-- issue"). A merged-away ticket is closed and marked here; a later reply
-- threading onto it is redirected to the survivor instead (ingest_inbound).
alter table helpdesk.tickets add column if not exists merged_into_ticket_id uuid
  references helpdesk.tickets(id);
create index if not exists tickets_merged_into_idx on helpdesk.tickets(merged_into_ticket_id)
  where merged_into_ticket_id is not null;

create index if not exists tickets_current_desk_id_idx on helpdesk.tickets(current_desk_id);
create index if not exists tickets_status_idx on helpdesk.tickets(status);
create index if not exists tickets_requester_id_idx on helpdesk.tickets(requester_id);
create index if not exists tickets_assignee_idx on helpdesk.tickets(assignee_profile_id);

-- After a transfer the sending desk keeps read-only access (decision 6).
create table if not exists helpdesk.ticket_desk_access (
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (ticket_id, desk_id)
);

create table if not exists helpdesk.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  internal boolean not null default false, -- staff-only; never emailed, never in the corpus
  author_email text,
  profile_id uuid references public.profiles(id),
  body text not null,
  raw_headers jsonb,
  -- email identity, for idempotency and threading
  mailbox text,
  external_message_id text,
  rfc_message_id text,
  in_reply_to text,
  gmail_thread_id text,
  assignee_notified_at timestamptz, -- set by notify-assignee when it claims this requester message
  created_at timestamptz not null default now(),
  check (not (internal and direction = 'inbound'))
);
alter table helpdesk.ticket_messages add column if not exists assignee_notified_at timestamptz;
create index if not exists ticket_messages_ticket_id_idx on helpdesk.ticket_messages(ticket_id);
create index if not exists ticket_messages_thread_idx on helpdesk.ticket_messages(mailbox, gmail_thread_id);
create index if not exists ticket_messages_rfc_idx on helpdesk.ticket_messages(rfc_message_id);
create unique index if not exists ticket_messages_external_uniq
  on helpdesk.ticket_messages(mailbox, external_message_id) where external_message_id is not null;

create table if not exists helpdesk.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  message_id uuid not null references helpdesk.ticket_messages(id) on delete cascade,
  filename text not null,
  content_type text,
  size_bytes bigint,
  storage_path text,       -- null when skipped (too large / failed); see skipped_reason
  skipped_reason text,
  scan_status text not null default 'unscanned',
  removed_at timestamptz,  -- set by the retention job; the thread shows "attachment removed"
  created_at timestamptz not null default now()
);
create index if not exists ticket_attachments_ticket_idx on helpdesk.ticket_attachments(ticket_id);

-- CCs (email only, no app access — decision 10) and agent followers.
create table if not exists helpdesk.ticket_participants (
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  email text not null check (email = lower(email)),
  type text not null check (type in ('cc', 'follower')),
  profile_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (ticket_id, email)
);

-- Audit log: reassignments, status changes, transfers, reporter changes,
-- reopens (who / what / when / why). Written by triggers and RPCs only.
create table if not exists helpdesk.ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  event_type text not null,
  actor_profile_id uuid references public.profiles(id),
  from_value text,
  to_value text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists ticket_events_ticket_id_idx on helpdesk.ticket_events(ticket_id);

-- Related-but-distinct tickets get linked, never silently merged.
create table if not exists helpdesk.ticket_links (
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  linked_ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ticket_id, linked_ticket_id)
);

-- A named queue filter an agent saves for themselves (text + status chip +
-- assignee), scoped to one desk since the assignee value is desk-specific.
-- Private: RLS only ever shows a profile its own rows.
create table if not exists helpdesk.saved_searches (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  desk_id uuid not null references helpdesk.desks(id) on delete cascade,
  name text not null,
  query jsonb not null, -- { text?, status?, assignee?: 'all' | 'mine' | 'unassigned' | <profile_id> }
  created_at timestamptz not null default now()
);
create index if not exists saved_searches_profile_desk_idx on helpdesk.saved_searches(profile_id, desk_id);

-- ── AI drafts (spec section 11) ───────────────────────────────────────────

-- Never sent itself; the compose box starts from one of these and an agent
-- edits/sends it as a normal outbound ticket_messages row. Written by
-- generate-draft (service_role) only. superseded_at is set either by a new
-- requester reply (generate-draft supersedes the old one before inserting
-- a fresh draft) or by an agent dismissing it; either way "no longer the
-- active suggestion" — older drafts stay for history, never deleted.
create table if not exists helpdesk.ticket_drafts (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references helpdesk.tickets(id) on delete cascade,
  body text not null,
  cited_sources jsonb,
  model text,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ticket_drafts_ticket_id_idx on helpdesk.ticket_drafts(ticket_id, created_at desc);

-- Cached full text of the knowledge-base Google Doc (decision 19: the Doc
-- stays the single source of truth; v1 reads it in full, no embeddings).
-- Refreshed daily by refresh-kb-cache rather than fetched live on every
-- draft, since drafts are latency- and cost-sensitive and the Doc rarely
-- changes within a day.
create table if not exists helpdesk.kb_cache (
  id boolean primary key default true check (id),
  content text,
  source_doc_id text,
  refreshed_at timestamptz
);
insert into helpdesk.kb_cache (id) values (true) on conflict do nothing;

-- ── Ingestion bookkeeping ────────────────────────────────────────────────

-- One row per mailbox per poll: the "last successful run" heartbeat.
create table if not exists helpdesk.ingest_runs (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  processed int not null default 0,
  ingested int not null default 0,
  skipped int not null default 0,
  unrouted int not null default 0,
  errors int not null default 0,
  error text
);
create index if not exists ingest_runs_mailbox_idx on helpdesk.ingest_runs(mailbox, started_at desc);

-- Messages that did not become a ticket message (or failed), for triage.
-- outcome 'unrouted' is the super-admin queue for mail matching no desk.
create table if not exists helpdesk.ingest_log (
  id uuid primary key default gen_random_uuid(),
  mailbox text not null,
  gmail_message_id text not null,
  outcome text not null check (outcome in ('ingested', 'skipped', 'unrouted', 'error')),
  reason text,
  ticket_id uuid references helpdesk.tickets(id) on delete set null,
  from_email text,
  subject text,
  snippet text,
  headers jsonb,
  attempts int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists ingest_log_msg_idx on helpdesk.ingest_log(mailbox, gmail_message_id);
create index if not exists ingest_log_outcome_idx on helpdesk.ingest_log(outcome, created_at desc);

-- ── Helper functions ─────────────────────────────────────────────────────
-- security definer + pinned search_path so policies can call them without
-- recursing into the tables' own RLS.

create or replace function helpdesk.is_super_admin() returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select exists (select 1 from helpdesk.super_admins where profile_id = public.current_profile_id())
$$;

-- Member of the desk (agent or desk admin).
create or replace function helpdesk.is_desk_member(p_desk_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select exists (
    select 1 from helpdesk.agent_desks
    where desk_id = p_desk_id and profile_id = public.current_profile_id()
  )
$$;

-- Works tickets on the desk: a member, or a super admin (any desk).
create or replace function helpdesk.is_desk_agent(p_desk_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select helpdesk.is_desk_member(p_desk_id) or helpdesk.is_super_admin()
$$;

-- Manages the desk (settings, branding, people): desk admin or super admin.
create or replace function helpdesk.is_desk_admin(p_desk_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select helpdesk.is_super_admin() or exists (
    select 1 from helpdesk.agent_desks
    where desk_id = p_desk_id and profile_id = public.current_profile_id() and role = 'admin'
  )
$$;

create or replace function helpdesk.is_any_agent() returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select helpdesk.is_super_admin() or exists (
    select 1 from helpdesk.agent_desks where profile_id = public.current_profile_id()
  )
$$;

-- Staff may work the ticket: agent of its current desk. Deleted tickets are
-- visible only to desk admins / super admins (spec section 3).
create or replace function helpdesk.can_work_ticket(p_ticket_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select exists (
    select 1 from helpdesk.tickets t
    where t.id = p_ticket_id
      and helpdesk.is_desk_agent(t.current_desk_id)
      and (t.status <> 'deleted' or helpdesk.is_desk_admin(t.current_desk_id))
  )
$$;

-- Staff may at least read the ticket: works it, or sits on a desk that
-- previously held it (read-only after a transfer).
create or replace function helpdesk.is_ticket_staff(p_ticket_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select helpdesk.can_work_ticket(p_ticket_id) or exists (
    select 1
    from helpdesk.ticket_desk_access a
    join helpdesk.tickets t on t.id = a.ticket_id
    where a.ticket_id = p_ticket_id
      and t.status <> 'deleted'
      and helpdesk.is_desk_agent(a.desk_id)
  )
$$;

-- The signed-in person is the ticket's reporter (via requesters.profile_id).
create or replace function helpdesk.is_ticket_reporter(p_ticket_id uuid) returns boolean
language sql stable security definer set search_path = helpdesk, public
as $$
  select exists (
    select 1
    from helpdesk.tickets t
    join helpdesk.requesters r on r.id = t.requester_id
    where t.id = p_ticket_id
      and t.status <> 'deleted'
      and r.profile_id is not null
      and r.profile_id = public.current_profile_id()
  )
$$;

-- ── Triggers ─────────────────────────────────────────────────────────────

create or replace function helpdesk.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tickets_set_updated_at on helpdesk.tickets;
create trigger tickets_set_updated_at before update on helpdesk.tickets
  for each row execute function helpdesk.set_updated_at();
drop trigger if exists desk_settings_set_updated_at on helpdesk.desk_settings;
create trigger desk_settings_set_updated_at before update on helpdesk.desk_settings
  for each row execute function helpdesk.set_updated_at();

-- Soft-delete bookkeeping, and "New moves to Open on first agent action"
-- (assigning counts; replying is handled in ticket_messages_after_insert).
create or replace function helpdesk.tickets_before_update() returns trigger
language plpgsql as $$
begin
  if new.status = 'deleted' and old.status <> 'deleted' then
    new.deleted_at := now();
  elsif new.status <> 'deleted' and old.status = 'deleted' then
    new.deleted_at := null;
  end if;
  if new.status = 'new' and old.status = 'new'
     and new.assignee_profile_id is not null
     and new.assignee_profile_id is distinct from old.assignee_profile_id then
    new.status := 'open';
  end if;
  if new.status <> 'paused' then
    new.paused_until := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_before_update on helpdesk.tickets;
create trigger tickets_before_update before update on helpdesk.tickets
  for each row execute function helpdesk.tickets_before_update();

-- Automatic audit trail. actor is null for service-role (ingestion) changes.
create or replace function helpdesk.tickets_audit() returns trigger
language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_actor uuid := public.current_profile_id();
begin
  if tg_op = 'INSERT' then
    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, to_value)
    values (new.id, 'created', v_actor, new.status::text);
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, from_value, to_value)
    values (new.id, 'status_changed', v_actor, old.status::text, new.status::text);
  end if;
  if new.assignee_profile_id is distinct from old.assignee_profile_id then
    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, from_value, to_value)
    values (new.id, 'assigned', v_actor, old.assignee_profile_id::text, new.assignee_profile_id::text);
  end if;
  if new.current_desk_id is distinct from old.current_desk_id then
    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, from_value, to_value)
    values (new.id, 'transferred', v_actor, old.current_desk_id::text, new.current_desk_id::text);
  end if;
  if new.requester_id is distinct from old.requester_id then
    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, from_value, to_value)
    values (new.id, 'reporter_changed', v_actor, old.requester_id::text, new.requester_id::text);
  end if;
  if new.forwarded_to is distinct from old.forwarded_to then
    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, from_value, to_value)
    values (new.id, 'forwarded_outside', v_actor, old.forwarded_to, new.forwarded_to);
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_audit_insert on helpdesk.tickets;
create trigger tickets_audit_insert after insert on helpdesk.tickets
  for each row execute function helpdesk.tickets_audit();
drop trigger if exists tickets_audit_update on helpdesk.tickets;
create trigger tickets_audit_update after update on helpdesk.tickets
  for each row execute function helpdesk.tickets_audit();

-- An agent's outbound message: first one moves New -> Open; a public reply
-- stamps last_agent_reply_at (drives the nudge / auto-close clocks).
create or replace function helpdesk.ticket_messages_after_insert() returns trigger
language plpgsql security definer set search_path = helpdesk, public as $$
begin
  if new.direction = 'outbound' then
    update helpdesk.tickets
    set last_agent_reply_at = case when new.internal then last_agent_reply_at else now() end,
        status = case when status = 'new' then 'open'::helpdesk.ticket_status else status end
    where id = new.ticket_id;
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_messages_after_insert on helpdesk.ticket_messages;
create trigger ticket_messages_after_insert after insert on helpdesk.ticket_messages
  for each row execute function helpdesk.ticket_messages_after_insert();

-- Emails a "you've been added" sign-in link when someone is newly granted
-- access to a desk. Only fires on a genuine new row: set_desk_role's
-- `on conflict (profile_id, desk_id) do update` path for a role change on an
-- existing pairing (promote/demote) takes the UPDATE trigger path instead
-- (there isn't one), so this never re-fires for that.
--
-- One-time setup, not handled by this file (the secret must never be
-- committed): generate a secret the same way as the KB refresh one
-- (openssl rand -hex 32), then set the SAME value in both places —
--   supabase secrets set HELPDESK_NOTIFY_SECRET=<value>   (edge function)
--   select vault.create_secret('<value>', 'helpdesk_notify_secret');  (SQL editor)

create or replace function helpdesk.notify_new_agent() returns trigger
language plpgsql security definer set search_path = helpdesk, public, extensions as $$
begin
  perform net.http_post(
    url := 'https://lxomebvymgolbzgkxqgu.supabase.co/functions/v1/notify-agent-added',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-helpdesk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helpdesk_notify_secret')
    ),
    body := jsonb_build_object('profile_id', new.profile_id, 'desk_id', new.desk_id)
  );
  return new;
end;
$$;

drop trigger if exists agent_desks_notify_insert on helpdesk.agent_desks;
create trigger agent_desks_notify_insert after insert on helpdesk.agent_desks
  for each row execute function helpdesk.notify_new_agent();

-- ── RPC: change someone's role on a desk ─────────────────────────────────
-- Desk admins can promote/demote on their own desk; super admins on any.
-- Every change is logged, and a desk can never be left without an admin.
-- p_role: 'agent' | 'admin' | 'none' (remove from the desk).

create or replace function helpdesk.set_desk_role(p_desk_id uuid, p_profile_id uuid, p_role text)
returns void language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_old text;
  v_admins int;
begin
  if not helpdesk.is_desk_admin(p_desk_id) then
    raise exception 'not allowed: desk admin required';
  end if;
  if p_role not in ('agent', 'admin', 'none') then
    raise exception 'invalid role %', p_role;
  end if;

  select role into v_old from helpdesk.agent_desks
  where desk_id = p_desk_id and profile_id = p_profile_id;

  if v_old = 'admin' and p_role <> 'admin' then
    select count(*) into v_admins from helpdesk.agent_desks
    where desk_id = p_desk_id and role = 'admin';
    if v_admins <= 1 then
      raise exception 'a desk must keep at least one admin';
    end if;
  end if;

  if p_role = 'none' then
    delete from helpdesk.agent_desks where desk_id = p_desk_id and profile_id = p_profile_id;
  else
    insert into helpdesk.agent_desks (profile_id, desk_id, role)
    values (p_profile_id, p_desk_id, p_role)
    on conflict (profile_id, desk_id) do update set role = excluded.role;
  end if;

  if v_old is distinct from (case when p_role = 'none' then null else p_role end) then
    insert into helpdesk.desk_role_events (desk_id, profile_id, from_role, to_role, actor_profile_id)
    values (p_desk_id, p_profile_id, v_old, case when p_role = 'none' then null else p_role end,
            public.current_profile_id());
  end if;
end;
$$;

-- ── RPC: manual reporter reassignment (spec section 7, layer 4) ──────────
-- requester_id isn't in tickets' column grants (every other path to it is
-- audited), so this is the only way to change it. Finds or creates the
-- requester by email, marks the ticket verified at full confidence, and logs
-- 'reporter_changed' via the existing tickets_audit trigger.

create or replace function helpdesk.reassign_reporter(p_ticket_id uuid, p_email text, p_display_name text default null)
returns void language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_email text := lower(trim(p_email));
  v_requester uuid;
begin
  if not helpdesk.can_work_ticket(p_ticket_id) then
    raise exception 'not allowed: must be able to work this ticket';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email: %', p_email;
  end if;

  insert into helpdesk.requesters (email, display_name)
  values (v_email, nullif(trim(p_display_name), ''))
  on conflict (email) do update
    set display_name = coalesce(excluded.display_name, helpdesk.requesters.display_name)
  returning id into v_requester;

  update helpdesk.tickets
  set requester_id = v_requester, reporter_verified = true, reporter_confidence = 1.0
  where id = p_ticket_id;
end;
$$;

revoke all on function helpdesk.reassign_reporter(uuid, text, text) from public;
grant execute on function helpdesk.reassign_reporter(uuid, text, text) to authenticated;

-- ── RPC: true merge (distinct from ticket_links — see spec decision 8) ───
-- Moves every message, attachment (via message_id, no row change needed),
-- event, CC/follower, and link from each losing ticket onto the survivor,
-- then closes the losing ticket and marks merged_into_ticket_id so a later
-- reply threading onto it is redirected (ingest_inbound) instead of landing
-- on a dead ticket nobody's watching.

create or replace function helpdesk.merge_tickets(p_ticket_ids uuid[], p_survivor_id uuid)
returns void language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_id uuid;
  v_survivor_number bigint;
begin
  if p_survivor_id is null or not (p_survivor_id = any(p_ticket_ids)) then
    raise exception 'survivor must be one of the selected tickets';
  end if;
  if array_length(p_ticket_ids, 1) < 2 then
    raise exception 'need at least two tickets to merge';
  end if;

  foreach v_id in array p_ticket_ids loop
    if not helpdesk.can_work_ticket(v_id) then
      raise exception 'not allowed: must be able to work every selected ticket';
    end if;
  end loop;

  select ticket_number into v_survivor_number from helpdesk.tickets where id = p_survivor_id;

  foreach v_id in array p_ticket_ids loop
    continue when v_id = p_survivor_id;

    update helpdesk.ticket_messages set ticket_id = p_survivor_id where ticket_id = v_id;
    update helpdesk.ticket_events set ticket_id = p_survivor_id where ticket_id = v_id;

    insert into helpdesk.ticket_participants (ticket_id, email, type, profile_id)
    select p_survivor_id, email, type, profile_id from helpdesk.ticket_participants where ticket_id = v_id
    on conflict (ticket_id, email) do nothing;
    delete from helpdesk.ticket_participants where ticket_id = v_id;

    -- Any existing link to/from a losing ticket now points at the survivor.
    update helpdesk.ticket_links set ticket_id = p_survivor_id
      where ticket_id = v_id and linked_ticket_id <> p_survivor_id;
    update helpdesk.ticket_links set linked_ticket_id = p_survivor_id
      where linked_ticket_id = v_id and ticket_id <> p_survivor_id;
    delete from helpdesk.ticket_links where ticket_id = v_id or linked_ticket_id = v_id;

    update helpdesk.tickets
    set status = 'closed', merged_into_ticket_id = p_survivor_id
    where id = v_id;

    insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, to_value, note)
    values (v_id, 'merged', public.current_profile_id(), p_survivor_id::text,
            'merged into #' || v_survivor_number);
  end loop;

  insert into helpdesk.ticket_events (ticket_id, event_type, actor_profile_id, note)
  values (p_survivor_id, 'merge_received', public.current_profile_id(),
          (array_length(p_ticket_ids, 1) - 1) || ' ticket(s) merged into this one');
end;
$$;

revoke all on function helpdesk.merge_tickets(uuid[], uuid) from public;
grant execute on function helpdesk.merge_tickets(uuid[], uuid) to authenticated;

-- ── RPC: desk transfer (spec section 9, decisions 5/6/16) ─────────────────
-- current_desk_id isn't in tickets' column grants (every other path to it is
-- audited), so this is the only way to move a ticket. Only to a desk that
-- opted in (decision 5). Resets status to New and clears the assignee — a
-- transfer hands the ticket to a fresh queue, not a specific person on it —
-- and grants the sending desk read-only access going forward (decision 6).
-- tickets_audit logs 'transferred' / 'status_changed' / 'assigned' from the
-- ordinary column changes below. The reporter's "your ticket moved" email
-- (decision 16) is sent separately by send-transfer-notice, after this
-- commits, since a notice about a move that didn't happen is worse than one
-- that's merely late.
create or replace function helpdesk.transfer_ticket(p_ticket_id uuid, p_desk_id uuid)
returns void language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_old_desk uuid;
begin
  if not helpdesk.can_work_ticket(p_ticket_id) then
    raise exception 'not allowed: must be able to work this ticket';
  end if;
  if not exists (select 1 from helpdesk.desks where id = p_desk_id and accepts_transfers) then
    raise exception 'target desk does not accept transfers';
  end if;

  select current_desk_id into v_old_desk from helpdesk.tickets where id = p_ticket_id;
  if v_old_desk is null then
    raise exception 'ticket not found';
  end if;
  if v_old_desk = p_desk_id then
    raise exception 'ticket is already on that desk';
  end if;

  insert into helpdesk.ticket_desk_access (ticket_id, desk_id) values (p_ticket_id, v_old_desk)
  on conflict do nothing;

  update helpdesk.tickets
  set current_desk_id = p_desk_id, status = 'new', assignee_profile_id = null
  where id = p_ticket_id;
end;
$$;

revoke all on function helpdesk.transfer_ticket(uuid, uuid) from public;
grant execute on function helpdesk.transfer_ticket(uuid, uuid) to authenticated;

-- ── RPC: forward outside and close (spec section 9, decision 7) ───────────
-- forwarded_to isn't in tickets' column grants either. Closes the ticket and
-- records who it went to; an external reply reopens it (ingest_inbound
-- already checks forwarded_to). Called by send-forward-outside only after
-- the email itself is away, so a ticket is never marked forwarded unless it
-- actually was.
create or replace function helpdesk.forward_ticket_outside(p_ticket_id uuid, p_to_email text)
returns void language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_email text := lower(trim(p_to_email));
begin
  if not helpdesk.can_work_ticket(p_ticket_id) then
    raise exception 'not allowed: must be able to work this ticket';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email: %', p_to_email;
  end if;

  update helpdesk.tickets
  set status = 'closed', forwarded_to = v_email
  where id = p_ticket_id;
end;
$$;

revoke all on function helpdesk.forward_ticket_outside(uuid, text) from public;
grant execute on function helpdesk.forward_ticket_outside(uuid, text) to authenticated;

-- ── RPC: record one inbound email (used by the helpdesk-ingest function) ─
-- One transaction: dedupe, find/create requester, thread onto a ticket or
-- open a new one, reopen on reply, store the message, mark the address as
-- receiving. service_role only.
--
-- p keys: mailbox, desk_id, source_address, gmail_message_id, gmail_thread_id,
-- rfc_message_id, in_reply_to, references (array), from_email, from_name,
-- subject, body, headers (object), forwarded (bool), forwarded_sender_name,
-- forwarded_sender_email, detected_sender_confidence (layer-1 guess — from a
-- forward's header or a bounce's body — set only at ticket creation)
-- (The gmail_* keys are historical names: helpdesk-inbound puts the Resend
-- email id in gmail_message_id and leaves gmail_thread_id null.)

create or replace function helpdesk.ingest_inbound(p jsonb) returns jsonb
language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_mailbox text := p->>'mailbox';
  v_ext_id text := p->>'gmail_message_id';
  v_from text := lower(p->>'from_email');
  v_requester uuid;
  v_detected_requester uuid;
  v_confidence numeric(3, 2) := nullif(p->>'detected_sender_confidence', '')::numeric;
  v_ticket uuid;
  v_old_status helpdesk.ticket_status;
  v_forwarded_to text;
  v_created boolean := false;
  v_reopened boolean := false;
  v_message uuid;
  v_refs text[];
begin
  select ticket_id, id into v_ticket, v_message
  from helpdesk.ticket_messages where mailbox = v_mailbox and external_message_id = v_ext_id;
  if v_message is not null then
    return jsonb_build_object('status', 'duplicate', 'ticket_id', v_ticket, 'message_id', v_message);
  end if;

  insert into helpdesk.requesters (email, display_name)
  values (v_from, nullif(trim(p->>'from_name'), ''))
  on conflict (email) do update
    set display_name = coalesce(helpdesk.requesters.display_name, excluded.display_name)
  returning id into v_requester;

  -- A detected sender (parsed from a forward's header, or found in a bounce
  -- body — spec section 7, layers 1 and the bounce-handling extension of it)
  -- is always a better starting requester than the literal envelope sender
  -- (a colleague who merely forwarded it, or a bounce's own mailer-daemon).
  -- High confidence (a cleanly-parsed forward: 0.9) assigns it outright and
  -- marks the reporter verified; lower confidence (a bounce's broader body
  -- scan: 0.4) still uses it as requester_id but leaves reporter_verified
  -- false, so an agent still sees the unverified-reporter confirm UI.
  -- detected_sender_name/email on the ticket keep the original guess visible
  -- either way, for an agent who wants to double-check it.
  if p->>'forwarded_sender_email' is not null then
    insert into helpdesk.requesters (email, display_name)
    values (lower(p->>'forwarded_sender_email'), nullif(trim(p->>'forwarded_sender_name'), ''))
    on conflict (email) do update
      set display_name = coalesce(helpdesk.requesters.display_name, excluded.display_name)
    returning id into v_detected_requester;
  end if;

  -- Thread: Gmail thread in this mailbox first, then RFC In-Reply-To/References.
  select m.ticket_id into v_ticket
  from helpdesk.ticket_messages m
  where m.mailbox = v_mailbox and m.gmail_thread_id = p->>'gmail_thread_id'
    and p->>'gmail_thread_id' is not null
  order by m.created_at limit 1;

  if v_ticket is null then
    v_refs := array(select jsonb_array_elements_text(coalesce(p->'references', '[]'::jsonb)));
    if p->>'in_reply_to' is not null then
      v_refs := v_refs || (p->>'in_reply_to');
    end if;
    if array_length(v_refs, 1) > 0 then
      select m.ticket_id into v_ticket
      from helpdesk.ticket_messages m
      where m.rfc_message_id = any (v_refs)
      order by m.created_at limit 1;
    end if;
  end if;

  if v_ticket is null then
    insert into helpdesk.tickets
      (current_desk_id, subject, requester_id, sender_email, source_address,
       reporter_verified, reporter_confidence, detected_sender_name, detected_sender_email,
       last_requester_reply_at)
    values
      ((p->>'desk_id')::uuid, p->>'subject', coalesce(v_detected_requester, v_requester), v_from,
       lower(p->>'source_address'),
       case when v_detected_requester is not null and v_confidence >= 0.8 then true
            when v_detected_requester is not null then false
            else not coalesce((p->>'forwarded')::boolean, false) end,
       case when v_detected_requester is not null then coalesce(v_confidence, 0.5) else null end,
       nullif(p->>'forwarded_sender_name', ''), lower(nullif(p->>'forwarded_sender_email', '')),
       now())
    returning id into v_ticket;
    v_created := true;
  else
    select status, forwarded_to into v_old_status, v_forwarded_to
    from helpdesk.tickets where id = v_ticket;
    update helpdesk.tickets set last_requester_reply_at = now() where id = v_ticket;
    -- A reply reopens anything past "New/Open" except a deleted ticket.
    if v_old_status in ('waiting', 'paused', 'resolved', 'closed') then
      update helpdesk.tickets set status = 'open' where id = v_ticket;
      insert into helpdesk.ticket_events (ticket_id, event_type, from_value, to_value, note)
      values (v_ticket, 'reopened', v_old_status::text, 'open',
              case when v_forwarded_to is not null then 'reopened by external reply (ticket was forwarded to ' || v_forwarded_to || ')'
                   else 'reopened by reply' end);
      v_reopened := true;
    end if;
  end if;

  begin
    insert into helpdesk.ticket_messages
      (ticket_id, direction, author_email, body, raw_headers, mailbox, external_message_id,
       rfc_message_id, in_reply_to, gmail_thread_id)
    values
      (v_ticket, 'inbound', v_from, coalesce(nullif(p->>'body', ''), '(no text body)'), p->'headers',
       v_mailbox, v_ext_id, p->>'rfc_message_id', p->>'in_reply_to', p->>'gmail_thread_id')
    returning id into v_message;
  exception when unique_violation then
    select id into v_message from helpdesk.ticket_messages
    where mailbox = v_mailbox and external_message_id = v_ext_id;
    return jsonb_build_object('status', 'duplicate', 'ticket_id', v_ticket, 'message_id', v_message);
  end;

  if p->>'source_address' is not null then
    update helpdesk.desk_addresses
    set status = 'receiving', first_received_at = coalesce(first_received_at, now())
    where address = lower(p->>'source_address') and status = 'pending';
  end if;

  return jsonb_build_object('status', 'ingested', 'ticket_id', v_ticket, 'message_id', v_message,
                            'created_ticket', v_created, 'reopened', v_reopened);
end;
$$;

-- A reporter's comment from the web app (My tickets). Same effect as an
-- emailed reply (ingest_inbound): an inbound public message, the requester
-- reply clock, and a reopen if the ticket was waiting/paused/resolved/closed.
-- A function rather than an insert policy so a reporter can never choose
-- direction, internal, or author — only the body.
create or replace function helpdesk.add_reporter_comment(p_ticket_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = helpdesk, public as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_old_status helpdesk.ticket_status;
  v_email text;
  v_message uuid;
begin
  if not helpdesk.is_ticket_reporter(p_ticket_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_body = '' then
    raise exception 'comment is empty' using errcode = '22023';
  end if;
  if length(v_body) > 10000 then
    raise exception 'comment is too long (10,000 characters max)' using errcode = '22023';
  end if;

  select t.status, r.email into v_old_status, v_email
  from helpdesk.tickets t join helpdesk.requesters r on r.id = t.requester_id
  where t.id = p_ticket_id;

  insert into helpdesk.ticket_messages (ticket_id, direction, author_email, profile_id, body)
  values (p_ticket_id, 'inbound', v_email, public.current_profile_id(), v_body)
  returning id into v_message;

  update helpdesk.tickets set last_requester_reply_at = now() where id = p_ticket_id;
  if v_old_status in ('waiting', 'paused', 'resolved', 'closed') then
    update helpdesk.tickets set status = 'open' where id = p_ticket_id;
    insert into helpdesk.ticket_events (ticket_id, event_type, from_value, to_value, note)
    values (p_ticket_id, 'reopened', v_old_status::text, 'open', 'reopened by reporter comment in the app');
  end if;
  return v_message;
end;
$$;

-- ── Row-level security ───────────────────────────────────────────────────

alter table helpdesk.desks enable row level security;
alter table helpdesk.desk_settings enable row level security;
alter table helpdesk.global_settings enable row level security;
alter table helpdesk.super_admins enable row level security;
alter table helpdesk.agent_desks enable row level security;
alter table helpdesk.desk_role_events enable row level security;
alter table helpdesk.desk_addresses enable row level security;
alter table helpdesk.desk_mailboxes enable row level security;
alter table helpdesk.requesters enable row level security;
alter table helpdesk.tickets enable row level security;
alter table helpdesk.ticket_desk_access enable row level security;
alter table helpdesk.ticket_messages enable row level security;
alter table helpdesk.ticket_attachments enable row level security;
alter table helpdesk.ticket_participants enable row level security;
alter table helpdesk.ticket_events enable row level security;
alter table helpdesk.ticket_links enable row level security;
alter table helpdesk.ingest_runs enable row level security;
alter table helpdesk.ingest_log enable row level security;
alter table helpdesk.ticket_drafts enable row level security;
alter table helpdesk.kb_cache enable row level security;
alter table helpdesk.saved_searches enable row level security;

-- desks: branding is readable by any signed-in user (reporters see the
-- desk that owns their ticket); only super admins create/delete desks.
drop policy if exists desks_select on helpdesk.desks;
create policy desks_select on helpdesk.desks for select to authenticated using (true);
drop policy if exists desks_insert on helpdesk.desks;
create policy desks_insert on helpdesk.desks for insert to authenticated
  with check (helpdesk.is_super_admin());
drop policy if exists desks_update on helpdesk.desks;
create policy desks_update on helpdesk.desks for update to authenticated
  using (helpdesk.is_desk_admin(id)) with check (helpdesk.is_desk_admin(id));
drop policy if exists desks_delete on helpdesk.desks;
create policy desks_delete on helpdesk.desks for delete to authenticated
  using (helpdesk.is_super_admin());

drop policy if exists desk_settings_select on helpdesk.desk_settings;
create policy desk_settings_select on helpdesk.desk_settings for select to authenticated
  using (helpdesk.is_desk_agent(desk_id));
drop policy if exists desk_settings_insert on helpdesk.desk_settings;
create policy desk_settings_insert on helpdesk.desk_settings for insert to authenticated
  with check (helpdesk.is_desk_admin(desk_id));
drop policy if exists desk_settings_update on helpdesk.desk_settings;
create policy desk_settings_update on helpdesk.desk_settings for update to authenticated
  using (helpdesk.is_desk_admin(desk_id)) with check (helpdesk.is_desk_admin(desk_id));

drop policy if exists global_settings_select on helpdesk.global_settings;
create policy global_settings_select on helpdesk.global_settings for select to authenticated
  using (helpdesk.is_super_admin());
drop policy if exists global_settings_update on helpdesk.global_settings;
create policy global_settings_update on helpdesk.global_settings for update to authenticated
  using (helpdesk.is_super_admin()) with check (helpdesk.is_super_admin());

drop policy if exists super_admins_select on helpdesk.super_admins;
create policy super_admins_select on helpdesk.super_admins for select to authenticated
  using (profile_id = public.current_profile_id() or helpdesk.is_super_admin());

-- agent_desks / desk_role_events: readable by the desk; written only via set_desk_role().
drop policy if exists agent_desks_select on helpdesk.agent_desks;
create policy agent_desks_select on helpdesk.agent_desks for select to authenticated
  using (profile_id = public.current_profile_id() or helpdesk.is_desk_agent(desk_id));
drop policy if exists desk_role_events_select on helpdesk.desk_role_events;
create policy desk_role_events_select on helpdesk.desk_role_events for select to authenticated
  using (helpdesk.is_desk_admin(desk_id));

-- desk_addresses: agents see them; desk admins record them (status is set
-- by ingestion only — see column grants below).
drop policy if exists desk_addresses_select on helpdesk.desk_addresses;
create policy desk_addresses_select on helpdesk.desk_addresses for select to authenticated
  using (helpdesk.is_desk_agent(desk_id));
drop policy if exists desk_addresses_insert on helpdesk.desk_addresses;
create policy desk_addresses_insert on helpdesk.desk_addresses for insert to authenticated
  with check (helpdesk.is_desk_admin(desk_id));
drop policy if exists desk_addresses_update on helpdesk.desk_addresses;
create policy desk_addresses_update on helpdesk.desk_addresses for update to authenticated
  using (helpdesk.is_desk_admin(desk_id)) with check (helpdesk.is_desk_admin(desk_id));
drop policy if exists desk_addresses_delete on helpdesk.desk_addresses;
create policy desk_addresses_delete on helpdesk.desk_addresses for delete to authenticated
  using (helpdesk.is_desk_admin(desk_id));

-- desk_mailboxes: super admin only (they decide what the service account reads).
drop policy if exists desk_mailboxes_all on helpdesk.desk_mailboxes;
create policy desk_mailboxes_all on helpdesk.desk_mailboxes for all to authenticated
  using (helpdesk.is_super_admin()) with check (helpdesk.is_super_admin());

-- requesters: contact info is visible to any agent (they need it to pick a
-- reporter); a reporter sees only their own record.
drop policy if exists requesters_select on helpdesk.requesters;
create policy requesters_select on helpdesk.requesters for select to authenticated
  using (helpdesk.is_any_agent() or profile_id = public.current_profile_id());
drop policy if exists requesters_insert on helpdesk.requesters;
create policy requesters_insert on helpdesk.requesters for insert to authenticated
  with check (helpdesk.is_any_agent());
drop policy if exists requesters_update on helpdesk.requesters;
create policy requesters_update on helpdesk.requesters for update to authenticated
  using (helpdesk.is_any_agent()) with check (helpdesk.is_any_agent());

-- tickets: staff of the desk (or a former desk, read-only), or the reporter.
-- Agents change only the columns granted below; the desk and reporter change
-- through RPCs (later phases) so they're always audited.
drop policy if exists tickets_select on helpdesk.tickets;
create policy tickets_select on helpdesk.tickets for select to authenticated
  using (helpdesk.is_ticket_staff(id) or helpdesk.is_ticket_reporter(id));
drop policy if exists tickets_update on helpdesk.tickets;
create policy tickets_update on helpdesk.tickets for update to authenticated
  using (helpdesk.can_work_ticket(id))
  with check (helpdesk.is_desk_agent(current_desk_id));

drop policy if exists ticket_desk_access_select on helpdesk.ticket_desk_access;
create policy ticket_desk_access_select on helpdesk.ticket_desk_access for select to authenticated
  using (helpdesk.is_desk_agent(desk_id));

-- messages: staff see everything incl. internal notes; a reporter sees only
-- public messages. Agents may post outbound replies / internal notes as
-- themselves on tickets they can work.
drop policy if exists ticket_messages_select on helpdesk.ticket_messages;
create policy ticket_messages_select on helpdesk.ticket_messages for select to authenticated
  using (
    helpdesk.is_ticket_staff(ticket_id)
    or (helpdesk.is_ticket_reporter(ticket_id) and not internal)
  );
drop policy if exists ticket_messages_insert on helpdesk.ticket_messages;
create policy ticket_messages_insert on helpdesk.ticket_messages for insert to authenticated
  with check (
    helpdesk.can_work_ticket(ticket_id)
    and direction = 'outbound'
    and profile_id = public.current_profile_id()
  );

drop policy if exists ticket_attachments_select on helpdesk.ticket_attachments;
create policy ticket_attachments_select on helpdesk.ticket_attachments for select to authenticated
  using (
    helpdesk.is_ticket_staff(ticket_id)
    or (
      helpdesk.is_ticket_reporter(ticket_id)
      and exists (select 1 from helpdesk.ticket_messages m
                  where m.id = message_id and not m.internal)
    )
  );

-- participants, events, links: staff only (reporters and CCs never see them).
drop policy if exists ticket_participants_select on helpdesk.ticket_participants;
create policy ticket_participants_select on helpdesk.ticket_participants for select to authenticated
  using (helpdesk.is_ticket_staff(ticket_id));
drop policy if exists ticket_participants_insert on helpdesk.ticket_participants;
create policy ticket_participants_insert on helpdesk.ticket_participants for insert to authenticated
  with check (helpdesk.can_work_ticket(ticket_id));
drop policy if exists ticket_participants_delete on helpdesk.ticket_participants;
create policy ticket_participants_delete on helpdesk.ticket_participants for delete to authenticated
  using (helpdesk.can_work_ticket(ticket_id));

drop policy if exists ticket_events_select on helpdesk.ticket_events;
create policy ticket_events_select on helpdesk.ticket_events for select to authenticated
  using (helpdesk.is_ticket_staff(ticket_id));

drop policy if exists ticket_links_select on helpdesk.ticket_links;
create policy ticket_links_select on helpdesk.ticket_links for select to authenticated
  using (helpdesk.is_ticket_staff(ticket_id));
drop policy if exists ticket_links_insert on helpdesk.ticket_links;
create policy ticket_links_insert on helpdesk.ticket_links for insert to authenticated
  with check (helpdesk.can_work_ticket(ticket_id));
drop policy if exists ticket_links_delete on helpdesk.ticket_links;
create policy ticket_links_delete on helpdesk.ticket_links for delete to authenticated
  using (helpdesk.can_work_ticket(ticket_id));

-- saved_searches: strictly private — a profile only ever sees/touches its own.
drop policy if exists saved_searches_select on helpdesk.saved_searches;
create policy saved_searches_select on helpdesk.saved_searches for select to authenticated
  using (profile_id = public.current_profile_id());
drop policy if exists saved_searches_insert on helpdesk.saved_searches;
create policy saved_searches_insert on helpdesk.saved_searches for insert to authenticated
  with check (profile_id = public.current_profile_id() and helpdesk.is_desk_agent(desk_id));
drop policy if exists saved_searches_delete on helpdesk.saved_searches;
create policy saved_searches_delete on helpdesk.saved_searches for delete to authenticated
  using (profile_id = public.current_profile_id());

-- ingestion bookkeeping: super admins only for now.
drop policy if exists ingest_runs_select on helpdesk.ingest_runs;
create policy ingest_runs_select on helpdesk.ingest_runs for select to authenticated
  using (helpdesk.is_super_admin());
drop policy if exists ingest_log_select on helpdesk.ingest_log;
create policy ingest_log_select on helpdesk.ingest_log for select to authenticated
  using (helpdesk.is_super_admin());

-- ticket_drafts: staff of the ticket only (never the reporter). Written by
-- generate-draft (service_role); an agent may only dismiss one (see grants).
drop policy if exists ticket_drafts_select on helpdesk.ticket_drafts;
create policy ticket_drafts_select on helpdesk.ticket_drafts for select to authenticated
  using (helpdesk.is_ticket_staff(ticket_id));
drop policy if exists ticket_drafts_update on helpdesk.ticket_drafts;
create policy ticket_drafts_update on helpdesk.ticket_drafts for update to authenticated
  using (helpdesk.is_ticket_staff(ticket_id)) with check (helpdesk.is_ticket_staff(ticket_id));

-- kb_cache: operational/debugging visibility, super admin only.
drop policy if exists kb_cache_select on helpdesk.kb_cache;
create policy kb_cache_select on helpdesk.kb_cache for select to authenticated
  using (helpdesk.is_super_admin());

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

-- ── Grants ───────────────────────────────────────────────────────────────
-- A custom schema gets no default privileges in Supabase. RLS (above) is the
-- row guard; these grants are the column / operation guard.

grant usage on schema helpdesk to authenticated, service_role;

grant all on all tables in schema helpdesk to service_role;
grant all on all sequences in schema helpdesk to service_role;

grant select on all tables in schema helpdesk to authenticated;

grant insert, update, delete on helpdesk.desks to authenticated;
grant insert, update on helpdesk.desk_settings to authenticated;
grant update on helpdesk.global_settings to authenticated;
grant insert, update, delete on helpdesk.desk_mailboxes to authenticated;

grant insert, delete on helpdesk.desk_addresses to authenticated;
grant update (can_send_from, is_default_reply, live_replies) on helpdesk.desk_addresses to authenticated;

grant insert on helpdesk.requesters to authenticated;
grant update (display_name, profile_id) on helpdesk.requesters to authenticated;

grant update (status, assignee_profile_id, paused_until, sensitive, subject) on helpdesk.tickets to authenticated;

grant insert on helpdesk.ticket_messages to authenticated;
grant insert, delete on helpdesk.ticket_participants to authenticated;
grant insert, delete on helpdesk.ticket_links to authenticated;
grant insert, delete on helpdesk.saved_searches to authenticated;

-- An agent may only dismiss a draft (superseded_at); the content itself is
-- generate-draft's (service_role gets full access via the earlier blanket grant).
grant update (superseded_at) on helpdesk.ticket_drafts to authenticated;

revoke all on function helpdesk.set_desk_role(uuid, uuid, text) from public;
grant execute on function helpdesk.set_desk_role(uuid, uuid, text) to authenticated, service_role;
revoke all on function helpdesk.add_reporter_comment(uuid, text) from public;
grant execute on function helpdesk.add_reporter_comment(uuid, text) to authenticated;
revoke all on function helpdesk.ingest_inbound(jsonb) from public;
grant execute on function helpdesk.ingest_inbound(jsonb) to service_role;

-- ── Daily knowledge-base refresh ─────────────────────────────────────────
-- Project-specific (the URL below is this Supabase project's); update it if
-- this app is ever split to its own project (see SETUP.md step 1).
--
-- One-time setup, not handled by this file (the secret must never be
-- committed): generate a secret the same way as HELPDESK_REPROCESS_SECRET
-- (openssl rand -hex 32), then set the SAME value in both places —
--   supabase secrets set HELPDESK_KB_REFRESH_SECRET=<value>   (edge function)
--   select vault.create_secret('<value>', 'helpdesk_kb_refresh_secret');  (SQL editor)
-- Vault, not a plain column, so the cron job definition below (visible to
-- other admins on this shared project via cron.job) never shows the raw value.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'helpdesk-refresh-kb-cache';

select cron.schedule(
  'helpdesk-refresh-kb-cache',
  '17 3 * * *', -- once daily, off the hour
  $cron$
  select net.http_post(
    url := 'https://lxomebvymgolbzgkxqgu.supabase.co/functions/v1/refresh-kb-cache',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-helpdesk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helpdesk_kb_refresh_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- ── Daily purge of expired soft-deleted tickets ──────────────────────────
-- Spec decision 17: deleted tickets and their attachments are purged after
-- a retention window (default 30 days, desk_settings can override). Same
-- one-time setup pattern as the KB refresh job above —
--   supabase secrets set HELPDESK_PURGE_SECRET=<value>   (edge function)
--   select vault.create_secret('<value>', 'helpdesk_purge_secret');  (SQL editor)

select cron.unschedule(jobid) from cron.job where jobname = 'helpdesk-purge-deleted-tickets';

select cron.schedule(
  'helpdesk-purge-deleted-tickets',
  '41 3 * * *', -- once daily, off the hour (staggered from the KB refresh job)
  $cron$
  select net.http_post(
    url := 'https://lxomebvymgolbzgkxqgu.supabase.co/functions/v1/purge-deleted-tickets',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-helpdesk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helpdesk_purge_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- ── Bootstrap: first super admin ─────────────────────────────────────────
-- After your first sign-in, run this in the SQL editor (replace the email).
-- Then create desks and give each at least one admin with set_desk_role().
--
-- insert into helpdesk.super_admins (profile_id)
-- select id from public.profiles where primary_email = 'your-email@sil.org';
