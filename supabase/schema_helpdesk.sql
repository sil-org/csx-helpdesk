-- ─── HELP DESK — APP SCHEMA ──────────────────────────────────────────────────
-- Run this AFTER schema.sql (the sil-app-template auth kernel). Draft, per
-- Section 3 of docs/HELPDESK_PROJECT_BRIEF.md — explicitly conceptual, refine
-- as the real build surfaces gaps. RLS policies below are a starting point,
-- not a security review.
--
-- Identity: every table below references profiles(id), never auth.users,
-- per the template's convention (profiles is the source of truth for "who").

create extension if not exists vector;

-- ── Desks ────────────────────────────────────────────────────────────────

create table desks (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table desk_settings (
  desk_id uuid primary key references desks(id) on delete cascade,
  business_hours_start time not null default '09:00',
  business_hours_end time not null default '17:00',
  business_hours_timezone text not null default 'UTC',
  follow_up_nudge_days int not null default 3,
  auto_close_days int not null default 7,
  updated_at timestamptz not null default now()
);

-- Which desk(s) a profile can work; also the ownership boundary for RLS.
create table agent_desks (
  profile_id uuid not null references profiles(id) on delete cascade,
  desk_id uuid not null references desks(id) on delete cascade,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  primary key (profile_id, desk_id)
);

-- ── Requesters ───────────────────────────────────────────────────────────

-- The problem-owner, distinct from sender_email on a given inbound message
-- (see "Requester vs. sender" in the brief — forwards, etc). Not necessarily
-- an SIL staff profile, so this is its own table rather than profiles.
create table requesters (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  display_name text,
  created_at timestamptz not null default now()
);

-- ── Tickets ──────────────────────────────────────────────────────────────

create type ticket_status as enum ('open', 'waiting', 'solved', 'closed', 'paused');

create table tickets (
  id uuid primary key default gen_random_uuid(),
  current_desk_id uuid not null references desks(id),
  status ticket_status not null default 'open',
  subject text,
  requester_id uuid references requesters(id),
  sender_email text not null,
  detected_language text,
  paused_until timestamptz,
  last_agent_reply_at timestamptz,
  last_requester_reply_at timestamptz,
  nudged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tickets_current_desk_id_idx on tickets(current_desk_id);
create index tickets_status_idx on tickets(status);

create table ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  internal boolean not null default false, -- staff-only; excluded from RAG corpus
  author_email text,
  profile_id uuid references profiles(id),
  body text not null,
  raw_headers jsonb,
  created_at timestamptz not null default now()
);

create index ticket_messages_ticket_id_idx on ticket_messages(ticket_id);

-- Audit log: reassignments, status changes, merges, pauses (who/what/when/why).
create table ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  event_type text not null,
  actor_profile_id uuid references profiles(id),
  from_value text,
  to_value text,
  note text,
  created_at timestamptz not null default now()
);

create index ticket_events_ticket_id_idx on ticket_events(ticket_id);

-- Related-but-distinct tickets get linked, never silently merged.
create table ticket_links (
  ticket_id uuid not null references tickets(id) on delete cascade,
  linked_ticket_id uuid not null references tickets(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ticket_id, linked_ticket_id)
);

-- ── RAG corpus ───────────────────────────────────────────────────────────

-- vector(1024) assumes Voyage voyage-3 — confirm the embedding model before
-- locking this dimension; changing it later requires re-embedding everything.
-- See memory/voyage_ai_training_policy.md before sending any real content —
-- Voyage AI trains on submitted data by default unless the account opts out.
create table corpus_documents (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('resolved_ticket', 'documentation')),
  source_desk_id uuid references desks(id),
  source_system text,
  source_ticket_id uuid references tickets(id),
  title text,
  content text not null,
  embedding vector(1024),
  created_at timestamptz not null default now()
);

create index corpus_documents_embedding_idx on corpus_documents
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ── Helper functions ─────────────────────────────────────────────────────

create or replace function is_desk_agent(p_desk_id uuid) returns boolean
language sql stable
as $$
  select exists (
    select 1 from agent_desks
    where desk_id = p_desk_id and profile_id = current_profile_id()
  )
$$;

-- ── Row-level security (draft — revisit before launch) ──────────────────

alter table desks enable row level security;
alter table desk_settings enable row level security;
alter table agent_desks enable row level security;
alter table requesters enable row level security;
alter table tickets enable row level security;
alter table ticket_messages enable row level security;
alter table ticket_events enable row level security;
alter table ticket_links enable row level security;
alter table corpus_documents enable row level security;

create policy "profiles read desk list" on desks
  for select using (auth.uid() is not null);

create policy "profiles read own desk settings" on desk_settings
  for select using (is_desk_agent(desk_id));

create policy "profiles read own agent_desks" on agent_desks
  for select using (profile_id = current_profile_id());

create policy "profiles read tickets in their desks" on tickets
  for select using (is_desk_agent(current_desk_id));
create policy "profiles insert tickets in their desks" on tickets
  for insert with check (is_desk_agent(current_desk_id));
create policy "profiles update tickets in their desks" on tickets
  for update using (is_desk_agent(current_desk_id));

create policy "profiles read messages on their desks' tickets" on ticket_messages
  for select using (
    exists (select 1 from tickets t where t.id = ticket_id and is_desk_agent(t.current_desk_id))
  );
create policy "profiles insert messages on their desks' tickets" on ticket_messages
  for insert with check (
    exists (select 1 from tickets t where t.id = ticket_id and is_desk_agent(t.current_desk_id))
  );

create policy "profiles read events on their desks' tickets" on ticket_events
  for select using (
    exists (select 1 from tickets t where t.id = ticket_id and is_desk_agent(t.current_desk_id))
  );
create policy "profiles insert events on their desks' tickets" on ticket_events
  for insert with check (
    exists (select 1 from tickets t where t.id = ticket_id and is_desk_agent(t.current_desk_id))
  );

create policy "profiles read requesters" on requesters
  for select using (auth.uid() is not null);

create policy "profiles read corpus" on corpus_documents
  for select using (auth.uid() is not null);
