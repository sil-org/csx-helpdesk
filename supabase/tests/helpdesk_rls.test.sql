-- Access-rule tests for the helpdesk schema (RLS, column grants, RPCs, the
-- ingest_inbound function). Plain SQL, no pgTAP needed.
--
-- Run against a SCRATCH database that has schema.sql and schema_helpdesk.sql
-- applied and Supabase-like roles (anon, authenticated, service_role) and
-- auth.uid() — see supabase/tests/README.md. Everything runs in one
-- transaction that is rolled back, but still: never point this at the real
-- project database.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/helpdesk_rls.test.sql <db>

\set ON_ERROR_STOP on
begin;

create schema t;
grant usage on schema t to authenticated, service_role;

create function t.ok(name text, cond boolean) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'ok - %', name;
end $$;

-- act as a signed-in user / the service role / the table owner
create function t.as_user(p uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p::text, true);
  execute 'set local role authenticated';
end $$;
create function t.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
end $$;
create function t.as_owner() returns void language plpgsql as $$
begin
  execute 'reset role';
end $$;

-- true if the statement is refused (permission denied or RLS violation)
create function t.denied(sql text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when insufficient_privilege then
  return true;
end $$;
-- true if the statement raises an exception whose message contains `frag`
create function t.raises(sql text, frag text) returns boolean language plpgsql as $$
begin
  execute sql;
  return false;
exception when others then
  return sqlerrm like '%' || frag || '%';
end $$;
create function t.rows_affected(sql text) returns int language plpgsql as $$
declare n int;
begin
  execute sql;
  get diagnostics n = row_count;
  return n;
end $$;
create function t.count(sql text) returns int language plpgsql as $$
declare n int;
begin
  execute 'select count(*) from (' || sql || ') q' into n;
  return n;
end $$;

-- ── Fixtures (as the table owner) ────────────────────────────────────────

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006'),
  ('a0000000-0000-0000-0000-000000000007');

insert into public.profiles (id, display_name, primary_email) values
  ('b0000000-0000-0000-0000-000000000001', 'Super Admin', 'sa@sil.org'),
  ('b0000000-0000-0000-0000-000000000002', 'Dallas Admin', 'dadmin@sil.org'),
  ('b0000000-0000-0000-0000-000000000003', 'Dallas Agent', 'dagent@sil.org'),
  ('b0000000-0000-0000-0000-000000000004', 'GIT Agent', 'gagent@sil.org'),
  ('b0000000-0000-0000-0000-000000000005', 'Reporter', 'maria@sil.org'),
  ('b0000000-0000-0000-0000-000000000006', 'Bystander', 'bystander@sil.org'),
  ('b0000000-0000-0000-0000-000000000007', 'GIT Admin', 'gadmin@sil.org');
insert into public.linked_accounts (supabase_user_id, profile_id, email)
select ('a' || substr(id::text, 2))::uuid, id, primary_email from public.profiles;

insert into helpdesk.super_admins (profile_id) values ('b0000000-0000-0000-0000-000000000001');

insert into helpdesk.desks (id, slug, name) values
  ('d0000000-0000-0000-0000-000000000001', 'dallas', 'Dallas'),
  ('d0000000-0000-0000-0000-000000000002', 'git', 'Global IT');
insert into helpdesk.agent_desks (profile_id, desk_id, role) values
  ('b0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', 'admin'),
  ('b0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'agent'),
  ('b0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002', 'agent'),
  ('b0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000002', 'admin');

insert into helpdesk.requesters (id, email, display_name, profile_id) values
  ('c0000000-0000-0000-0000-000000000001', 'maria@sil.org', 'Maria', 'b0000000-0000-0000-0000-000000000005'),
  ('c0000000-0000-0000-0000-000000000002', 'outsider@gmail.com', 'Outsider', null);

insert into helpdesk.tickets (id, current_desk_id, subject, requester_id, sender_email, status) values
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'Maria ticket', 'c0000000-0000-0000-0000-000000000001', 'maria@sil.org', 'new'),
  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'GIT ticket', 'c0000000-0000-0000-0000-000000000002', 'outsider@gmail.com', 'new'),
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'Deleted ticket', 'c0000000-0000-0000-0000-000000000001', 'maria@sil.org', 'deleted');

insert into helpdesk.ticket_messages (id, ticket_id, direction, internal, author_email, body) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'inbound', false, 'maria@sil.org', 'Help!'),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'outbound', true, 'dagent@sil.org', 'internal secret');
insert into helpdesk.ticket_attachments (ticket_id, message_id, filename) values
  ('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 'public.png'),
  ('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000002', 'internal.png');
insert into helpdesk.ticket_participants (ticket_id, email, type) values
  ('e0000000-0000-0000-0000-000000000001', 'cc@example.org', 'cc');

grant all on all tables in schema public to authenticated, service_role;

-- shorthand ids
create function t.u(n int) returns uuid language sql as $$
  select ('a0000000-0000-0000-0000-00000000000' || n)::uuid $$;

-- ── Ticket visibility ────────────────────────────────────────────────────

select t.as_user(t.u(3));  -- Dallas agent
select t.ok('agent sees own desk tickets, not other desks or deleted',
  t.count('select 1 from helpdesk.tickets') = 1);
select t.ok('agent sees internal notes on own tickets',
  t.count('select 1 from helpdesk.ticket_messages where internal') = 1);
select t.ok('agent sees ticket events and participants',
  t.count('select 1 from helpdesk.ticket_events') >= 1 and t.count('select 1 from helpdesk.ticket_participants') = 1);

select t.as_user(t.u(2));  -- Dallas desk admin
select t.ok('desk admin also sees the deleted ticket', t.count('select 1 from helpdesk.tickets') = 2);

select t.as_user(t.u(1));  -- super admin
select t.ok('super admin sees every ticket', t.count('select 1 from helpdesk.tickets') = 3);

select t.as_user(t.u(5));  -- reporter
select t.ok('reporter sees only their own non-deleted ticket', t.count('select 1 from helpdesk.tickets') = 1);
select t.ok('reporter sees public messages only',
  t.count('select 1 from helpdesk.ticket_messages') = 1
  and t.count('select 1 from helpdesk.ticket_messages where internal') = 0);
select t.ok('reporter sees only the public attachment',
  t.count('select 1 from helpdesk.ticket_attachments') = 1);
select t.ok('reporter cannot see events, participants, links, settings',
  t.count('select 1 from helpdesk.ticket_events') = 0
  and t.count('select 1 from helpdesk.ticket_participants') = 0
  and t.count('select 1 from helpdesk.desk_settings') = 0);
select t.ok('reporter sees only their own requester record',
  t.count('select 1 from helpdesk.requesters') = 1);
select t.ok('reporter can read desk branding', t.count('select 1 from helpdesk.desks') = 2);

select t.as_user(t.u(6));  -- bystander, no roles
select t.ok('bystander sees no tickets or messages',
  t.count('select 1 from helpdesk.tickets') = 0 and t.count('select 1 from helpdesk.ticket_messages') = 0);

-- ── Writes ───────────────────────────────────────────────────────────────

select t.as_user(t.u(5));  -- reporter cannot write
select t.ok('reporter cannot update a ticket',
  t.rows_affected($$update helpdesk.tickets set status = 'closed' where id = 'e0000000-0000-0000-0000-000000000001'$$) = 0
  or t.denied($$update helpdesk.tickets set status = 'closed' where id = 'e0000000-0000-0000-0000-000000000001'$$));
select t.ok('reporter cannot post a message',
  t.denied($$insert into helpdesk.ticket_messages (ticket_id, direction, author_email, body, profile_id)
    values ('e0000000-0000-0000-0000-000000000001', 'outbound', 'maria@sil.org', 'x', 'b0000000-0000-0000-0000-000000000005')$$));
select t.ok('reporter cannot create requesters',
  t.denied($$insert into helpdesk.requesters (email) values ('new@x.org')$$));

select t.as_user(t.u(3));  -- Dallas agent
select t.ok('agent can update permitted ticket columns on own ticket',
  t.rows_affected($$update helpdesk.tickets set subject = 'renamed' where id = 'e0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('agent cannot update a ticket on another desk',
  t.rows_affected($$update helpdesk.tickets set subject = 'x' where id = 'e0000000-0000-0000-0000-000000000002'$$) = 0);
select t.ok('agent cannot change the desk directly (transfer is an RPC)',
  t.denied($$update helpdesk.tickets set current_desk_id = 'd0000000-0000-0000-0000-000000000002' where id = 'e0000000-0000-0000-0000-000000000001'$$));
select t.ok('agent cannot change the reporter directly',
  t.denied($$update helpdesk.tickets set requester_id = null where id = 'e0000000-0000-0000-0000-000000000001'$$));
select t.ok('agent cannot post as someone else',
  t.denied($$insert into helpdesk.ticket_messages (ticket_id, direction, author_email, body, profile_id)
    values ('e0000000-0000-0000-0000-000000000001', 'outbound', 'x', 'x', 'b0000000-0000-0000-0000-000000000002')$$));
select t.ok('agent cannot forge an inbound message',
  t.denied($$insert into helpdesk.ticket_messages (ticket_id, direction, author_email, body, profile_id)
    values ('e0000000-0000-0000-0000-000000000001', 'inbound', 'x', 'x', 'b0000000-0000-0000-0000-000000000003')$$));
select t.ok('agent cannot post on another desk ticket',
  t.denied($$insert into helpdesk.ticket_messages (ticket_id, direction, author_email, body, profile_id)
    values ('e0000000-0000-0000-0000-000000000002', 'outbound', 'x', 'x', 'b0000000-0000-0000-0000-000000000003')$$));

-- internal note: New -> Open, no reply stamp
select t.as_owner();
update helpdesk.tickets set status = 'new', last_agent_reply_at = null where id = 'e0000000-0000-0000-0000-000000000001';
select t.as_user(t.u(3));
insert into helpdesk.ticket_messages (ticket_id, direction, internal, author_email, body, profile_id)
values ('e0000000-0000-0000-0000-000000000001', 'outbound', true, 'dagent@sil.org', 'note', 'b0000000-0000-0000-0000-000000000003');
select t.as_owner();
select t.ok('internal note moves New to Open but does not stamp last_agent_reply_at',
  (select status::text = 'open' and last_agent_reply_at is null from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000001'));
select t.as_user(t.u(3));
insert into helpdesk.ticket_messages (ticket_id, direction, internal, author_email, body, profile_id)
values ('e0000000-0000-0000-0000-000000000001', 'outbound', false, 'dagent@sil.org', 'reply', 'b0000000-0000-0000-0000-000000000003');
select t.as_owner();
select t.ok('public reply stamps last_agent_reply_at',
  (select last_agent_reply_at is not null from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000001'));

-- assigning moves New -> Open
update helpdesk.tickets set status = 'new' where id = 'e0000000-0000-0000-0000-000000000002';
select t.as_user(t.u(4));
update helpdesk.tickets set assignee_profile_id = 'b0000000-0000-0000-0000-000000000004'
where id = 'e0000000-0000-0000-0000-000000000002';
select t.as_owner();
select t.ok('assigning a New ticket moves it to Open',
  (select status::text = 'open' from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000002'));

-- audit trail
select t.ok('status and assignment changes are audited with the actor',
  exists (select 1 from helpdesk.ticket_events
          where ticket_id = 'e0000000-0000-0000-0000-000000000002' and event_type = 'assigned'
            and actor_profile_id = 'b0000000-0000-0000-0000-000000000004')
  and exists (select 1 from helpdesk.ticket_events
              where ticket_id = 'e0000000-0000-0000-0000-000000000002' and event_type = 'status_changed'
                and from_value = 'new' and to_value = 'open'));

-- soft delete bookkeeping
select t.as_user(t.u(2));
update helpdesk.tickets set status = 'deleted' where id = 'e0000000-0000-0000-0000-000000000001';
select t.as_owner();
select t.ok('deleting sets deleted_at', (select deleted_at is not null from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000001'));
select t.as_user(t.u(5));
select t.ok('reporter loses sight of a deleted ticket', t.count('select 1 from helpdesk.tickets') = 0);
select t.as_user(t.u(2));
update helpdesk.tickets set status = 'open' where id = 'e0000000-0000-0000-0000-000000000001';
select t.as_owner();
select t.ok('restoring clears deleted_at', (select deleted_at is null from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000001'));

-- ── Transfers: sending desk keeps read-only access ───────────────────────

insert into helpdesk.ticket_desk_access (ticket_id, desk_id)
values ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002');
select t.as_user(t.u(4));  -- GIT agent has read access via the access row
select t.ok('former/other desk with an access row can read the ticket',
  t.count($$select 1 from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('...but cannot update it',
  t.rows_affected($$update helpdesk.tickets set subject = 'nope' where id = 'e0000000-0000-0000-0000-000000000001'$$) = 0);
select t.ok('...or post on it',
  t.denied($$insert into helpdesk.ticket_messages (ticket_id, direction, author_email, body, profile_id)
    values ('e0000000-0000-0000-0000-000000000001', 'outbound', 'x', 'x', 'b0000000-0000-0000-0000-000000000004')$$));

-- ── Desk settings, addresses, mailboxes ──────────────────────────────────

select t.as_user(t.u(3));  -- Dallas agent
select t.ok('agent cannot edit desk branding',
  t.rows_affected($$update helpdesk.desks set logo_url = 'x' where id = 'd0000000-0000-0000-0000-000000000001'$$) = 0);
select t.ok('agent cannot add an address',
  t.denied($$insert into helpdesk.desk_addresses (address, desk_id) values ('a@sil.org', 'd0000000-0000-0000-0000-000000000001')$$));
select t.ok('agent cannot read mailboxes, ingest logs or global settings',
  t.count('select 1 from helpdesk.desk_mailboxes') = 0 and t.count('select 1 from helpdesk.ingest_log') = 0
  and t.count('select 1 from helpdesk.global_settings') = 0);

select t.as_user(t.u(2));  -- Dallas desk admin
select t.ok('desk admin can edit own desk branding',
  t.rows_affected($$update helpdesk.desks set logo_url = 'x', theme_primary = '#93358D' where id = 'd0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('desk admin cannot edit another desk',
  t.rows_affected($$update helpdesk.desks set logo_url = 'x' where id = 'd0000000-0000-0000-0000-000000000002'$$) = 0);
select t.ok('desk admin cannot create a desk',
  t.denied($$insert into helpdesk.desks (slug, name) values ('new', 'New')$$));
select t.ok('desk admin can record an address on own desk',
  t.rows_affected($$insert into helpdesk.desk_addresses (address, desk_id) values ('dallas-help@sil.org', 'd0000000-0000-0000-0000-000000000001')$$) = 1);
select t.ok('desk admin cannot add an address to another desk',
  t.denied($$insert into helpdesk.desk_addresses (address, desk_id) values ('x@sil.org', 'd0000000-0000-0000-0000-000000000002')$$));
select t.ok('desk admin can switch live_replies but not forge status',
  t.rows_affected($$update helpdesk.desk_addresses set live_replies = true where address = 'dallas-help@sil.org'$$) = 1
  and t.denied($$update helpdesk.desk_addresses set status = 'receiving' where address = 'dallas-help@sil.org'$$));
select t.ok('desk admin cannot manage mailboxes',
  t.denied($$insert into helpdesk.desk_mailboxes (mailbox, auth_type) values ('x@sil.org', 'service_account')$$));
select t.ok('desk admin can edit own desk settings (insert) but not another desk',
  t.rows_affected($$insert into helpdesk.desk_settings (desk_id) values ('d0000000-0000-0000-0000-000000000001')$$) = 1
  and t.denied($$insert into helpdesk.desk_settings (desk_id) values ('d0000000-0000-0000-0000-000000000002')$$));

select t.as_user(t.u(1));  -- super admin
select t.ok('super admin can create desks and mailboxes',
  t.rows_affected($$insert into helpdesk.desks (slug, name) values ('africa', 'Africa')$$) = 1
  and t.rows_affected($$insert into helpdesk.desk_mailboxes (mailbox, auth_type) values ('helpdesk-ingest@sil.org', 'service_account')$$) = 1);
select t.ok('super admin can read ingest logs and global settings',
  t.count('select 1 from helpdesk.global_settings') = 1);
select t.ok('super_admins table is read-only through the API',
  t.denied($$insert into helpdesk.super_admins (profile_id) values ('b0000000-0000-0000-0000-000000000006')$$));

-- ── set_desk_role ────────────────────────────────────────────────────────

select t.as_user(t.u(3));  -- plain agent
select t.ok('agent cannot call set_desk_role',
  t.raises($$select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'admin')$$, 'desk admin required'));
select t.as_user(t.u(6));  -- bystander
select t.ok('bystander cannot call set_desk_role',
  t.raises($$select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000006', 'agent')$$, 'desk admin required'));

select t.as_user(t.u(2));  -- Dallas desk admin
select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'admin');
select t.as_owner();
select t.ok('desk admin can promote an agent on their own desk, and it is logged',
  (select role = 'admin' from helpdesk.agent_desks
    where desk_id = 'd0000000-0000-0000-0000-000000000001' and profile_id = 'b0000000-0000-0000-0000-000000000003')
  and exists (select 1 from helpdesk.desk_role_events
    where profile_id = 'b0000000-0000-0000-0000-000000000003' and from_role = 'agent' and to_role = 'admin'
      and actor_profile_id = 'b0000000-0000-0000-0000-000000000002'));
select t.as_user(t.u(2));
select t.ok('desk admin cannot change roles on another desk',
  t.raises($$select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 'admin')$$, 'desk admin required'));
select t.ok('invalid role is rejected',
  t.raises($$select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'boss')$$, 'invalid role'));
select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'agent');
select t.ok('with two admins, one can be demoted',
  (select count(*) = 1 from helpdesk.agent_desks where desk_id = 'd0000000-0000-0000-0000-000000000001' and role = 'admin'));
select t.ok('the last admin on a desk cannot be demoted or removed',
  t.raises($$select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'agent')$$, 'at least one admin')
  and t.raises($$select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'none')$$, 'at least one admin'));
select t.as_user(t.u(1));  -- super admin
select helpdesk.set_desk_role('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'none');
select t.as_owner();
select t.ok('super admin can remove someone from any desk',
  not exists (select 1 from helpdesk.agent_desks
    where desk_id = 'd0000000-0000-0000-0000-000000000001' and profile_id = 'b0000000-0000-0000-0000-000000000003'));

-- ── ingest_inbound (service role only) ───────────────────────────────────

select t.as_user(t.u(3));
select t.ok('signed-in users cannot call ingest_inbound',
  t.denied($$select helpdesk.ingest_inbound('{}'::jsonb)$$));
select t.as_service();

create temp table r (n int, res jsonb);
grant all on r to service_role;
insert into r values (1, helpdesk.ingest_inbound(jsonb_build_object(
  'mailbox', 'helpdesk-ingest@sil.org', 'desk_id', 'd0000000-0000-0000-0000-000000000001',
  'source_address', 'dallas-help@sil.org', 'gmail_message_id', 'g1', 'gmail_thread_id', 'th1',
  'rfc_message_id', '<m1@x>', 'from_email', 'Pat@Example.org', 'from_name', 'Pat',
  'subject', 'Printer broken', 'body', 'It is on fire', 'headers', '{"from":"Pat"}'::jsonb)));
select t.ok('first email creates a New ticket and a lowercased requester',
  (select res->>'status' = 'ingested' and (res->>'created_ticket')::boolean from r where n = 1)
  and (select status::text = 'new' and sender_email = 'pat@example.org' and reporter_verified
       from helpdesk.tickets where id = (select (res->>'ticket_id')::uuid from r where n = 1))
  and exists (select 1 from helpdesk.requesters where email = 'pat@example.org' and display_name = 'Pat'));
select t.ok('the address flips from pending to receiving',
  (select status = 'receiving' and first_received_at is not null from helpdesk.desk_addresses where address = 'dallas-help@sil.org'));

insert into r values (2, helpdesk.ingest_inbound(jsonb_build_object(
  'mailbox', 'helpdesk-ingest@sil.org', 'desk_id', 'd0000000-0000-0000-0000-000000000001',
  'gmail_message_id', 'g1', 'gmail_thread_id', 'th1', 'from_email', 'pat@example.org', 'body', 'again')));
select t.ok('the same Gmail message is not ingested twice',
  (select res->>'status' = 'duplicate' from r where n = 2)
  and (select count(*) = 1 from helpdesk.ticket_messages where external_message_id = 'g1'));

insert into r values (3, helpdesk.ingest_inbound(jsonb_build_object(
  'mailbox', 'helpdesk-ingest@sil.org', 'desk_id', 'd0000000-0000-0000-0000-000000000001',
  'gmail_message_id', 'g2', 'gmail_thread_id', 'th1', 'rfc_message_id', '<m2@x>', 'from_email', 'pat@example.org',
  'subject', 'Re: Printer broken', 'body', 'still on fire')));
select t.ok('a reply in the same Gmail thread joins the ticket',
  (select (res->>'ticket_id') = (select res->>'ticket_id' from r where n = 1) and not (res->>'created_ticket')::boolean from r where n = 3));

-- reply by RFC In-Reply-To after the ticket was forwarded outside and closed
update helpdesk.tickets set status = 'closed', forwarded_to = 'vendor@acme.com'
where id = (select (res->>'ticket_id')::uuid from r where n = 1);
insert into r values (4, helpdesk.ingest_inbound(jsonb_build_object(
  'mailbox', 'helpdesk-ingest@sil.org', 'desk_id', 'd0000000-0000-0000-0000-000000000001',
  'gmail_message_id', 'g3', 'gmail_thread_id', 'th-other', 'rfc_message_id', '<m3@x>', 'in_reply_to', '<m2@x>',
  'from_email', 'support@acme.com', 'subject', 'Re: Printer broken', 'body', 'vendor says restart it')));
select t.ok('a reply threaded by In-Reply-To reopens a closed ticket and logs why',
  (select (res->>'reopened')::boolean and res->>'ticket_id' = (select res->>'ticket_id' from r where n = 1) from r where n = 4)
  and (select status::text = 'open' from helpdesk.tickets where id = (select (res->>'ticket_id')::uuid from r where n = 1))
  and exists (select 1 from helpdesk.ticket_events
    where ticket_id = (select (res->>'ticket_id')::uuid from r where n = 1)
      and event_type = 'reopened' and note like '%forwarded to vendor@acme.com%'));

-- a reply on a deleted ticket is stored but does not resurrect it
update helpdesk.tickets set status = 'deleted' where id = (select (res->>'ticket_id')::uuid from r where n = 1);
insert into r values (5, helpdesk.ingest_inbound(jsonb_build_object(
  'mailbox', 'helpdesk-ingest@sil.org', 'desk_id', 'd0000000-0000-0000-0000-000000000001',
  'gmail_message_id', 'g4', 'gmail_thread_id', 'th1', 'from_email', 'pat@example.org', 'body', 'hello?')));
select t.ok('a reply on a deleted ticket does not reopen it',
  (select not (res->>'reopened')::boolean from r where n = 5)
  and (select status::text = 'deleted' from helpdesk.tickets where id = (select (res->>'ticket_id')::uuid from r where n = 1)));

-- a forwarded email is flagged as reporter-unverified; a new thread is a new ticket
insert into r values (6, helpdesk.ingest_inbound(jsonb_build_object(
  'mailbox', 'helpdesk-ingest@sil.org', 'desk_id', 'd0000000-0000-0000-0000-000000000001',
  'gmail_message_id', 'g5', 'gmail_thread_id', 'th2', 'from_email', 'kate@sil.org', 'subject', 'Fwd: help',
  'body', '---------- Forwarded message ---------', 'forwarded', true)));
select t.ok('a forwarded email makes a new ticket flagged reporter_verified = false',
  (select (res->>'created_ticket')::boolean from r where n = 6)
  and (select not reporter_verified from helpdesk.tickets where id = (select (res->>'ticket_id')::uuid from r where n = 6)));

select t.as_owner();
select t.ok('an inbound message can never be marked internal',
  t.raises($$insert into helpdesk.ticket_messages (ticket_id, direction, internal, body)
    values ('e0000000-0000-0000-0000-000000000002', 'inbound', true, 'x')$$, 'ticket_messages_check'));

-- ── Reporter comments from the app ───────────────────────────────────────

select t.as_owner();
update helpdesk.tickets set status = 'waiting' where id = 'e0000000-0000-0000-0000-000000000001';
select t.as_user(t.u(5));  -- reporter
select helpdesk.add_reporter_comment('e0000000-0000-0000-0000-000000000001', '  Still broken, thanks  ');
select t.ok('a reporter can comment: stored as a trimmed, public, inbound message from them',
  t.count($$select 1 from helpdesk.ticket_messages where ticket_id = 'e0000000-0000-0000-0000-000000000001'
    and direction = 'inbound' and not internal and body = 'Still broken, thanks'
    and author_email = 'maria@sil.org' and profile_id = 'b0000000-0000-0000-0000-000000000005'$$) = 1);
select t.as_owner();
select t.ok('a reporter comment reopens a waiting ticket, logs it and stamps the reply clock',
  (select status::text = 'open' and last_requester_reply_at is not null
   from helpdesk.tickets where id = 'e0000000-0000-0000-0000-000000000001')
  and exists (select 1 from helpdesk.ticket_events
    where ticket_id = 'e0000000-0000-0000-0000-000000000001' and event_type = 'reopened' and from_value = 'waiting'));
select t.as_user(t.u(5));
select t.ok('a reporter cannot comment on another reporter''s ticket',
  t.denied($$select helpdesk.add_reporter_comment('e0000000-0000-0000-0000-000000000002', 'hi')$$));
select t.ok('a reporter cannot comment on a deleted ticket',
  t.denied($$select helpdesk.add_reporter_comment('e0000000-0000-0000-0000-000000000003', 'hi')$$));
select t.ok('an empty comment is refused',
  t.raises($$select helpdesk.add_reporter_comment('e0000000-0000-0000-0000-000000000001', '   ')$$, 'empty'));
select t.as_user(t.u(6));  -- bystander
select t.ok('someone who is not the reporter cannot comment',
  t.denied($$select helpdesk.add_reporter_comment('e0000000-0000-0000-0000-000000000001', 'hi')$$));
select t.as_owner();

-- ── Per-desk knowledge bases ─────────────────────────────────────────────

select t.as_service();
insert into helpdesk.desk_settings (desk_id) values
  ('d0000000-0000-0000-0000-000000000001'), ('d0000000-0000-0000-0000-000000000002')
  on conflict do nothing;

select t.as_user(t.u(2));  -- Dallas admin
select t.ok('a desk admin cannot set their desk''s KB Doc (only a super admin can)',
  t.raises($$update helpdesk.desk_settings set kb_doc_id = 'doc-dallas' where desk_id = 'd0000000-0000-0000-0000-000000000001'$$, 'only a super admin'));
select t.ok('a desk admin can turn sharing on for their own desk',
  t.rows_affected($$update helpdesk.desk_settings set kb_shared = true where desk_id = 'd0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('a desk admin cannot change sharing on another desk',
  t.rows_affected($$update helpdesk.desk_settings set kb_shared = true where desk_id = 'd0000000-0000-0000-0000-000000000002'$$) = 0);

select t.as_user(t.u(1));  -- super admin
select t.ok('a super admin can set a desk''s KB Doc',
  t.rows_affected($$update helpdesk.desk_settings set kb_doc_id = 'doc-dallas' where desk_id = 'd0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('two desks cannot claim the same KB Doc',
  t.raises($$update helpdesk.desk_settings set kb_doc_id = 'doc-dallas' where desk_id = 'd0000000-0000-0000-0000-000000000002'$$, 'duplicate key'));
select t.as_service();
select t.ok('the service role (and the SQL editor) can set a KB Doc',
  t.rows_affected($$update helpdesk.desk_settings set kb_doc_id = 'doc-git' where desk_id = 'd0000000-0000-0000-0000-000000000002'$$) = 1);

-- Dallas is sharing; GIT is not.
select t.as_user(t.u(2));  -- Dallas admin
select t.ok('a desk cannot use a desk that is not sharing as a source',
  t.denied($$insert into helpdesk.desk_kb_sources (desk_id, source_desk_id) values ('d0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002')$$));
select t.as_user(t.u(7));  -- GIT admin
select t.ok('a desk admin can use a sharing desk as a source',
  t.rows_affected($$insert into helpdesk.desk_kb_sources (desk_id, source_desk_id) values ('d0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001')$$) = 1);
select t.ok('a desk admin cannot add sources for another desk',
  t.denied($$insert into helpdesk.desk_kb_sources (desk_id, source_desk_id) values ('d0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001')$$));
select t.ok('a desk admin cannot make their own desk a source for itself',
  t.denied($$insert into helpdesk.desk_kb_sources (desk_id, source_desk_id) values ('d0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002')$$));
select t.as_service();
select t.ok('a desk cannot be its own source, even for the service role',
  t.raises($$insert into helpdesk.desk_kb_sources (desk_id, source_desk_id) values ('d0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002')$$, 'check'));
select t.as_user(t.u(2));  -- Dallas member (the Dallas agent was removed by the set_desk_role tests)
select t.ok('another desk''s source choices are not visible to a desk''s agents',
  t.count('select 1 from helpdesk.desk_kb_sources') = 0);
select t.as_user(t.u(4));  -- GIT agent
select t.ok('an agent sees their own desk''s source choices',
  t.count('select 1 from helpdesk.desk_kb_sources') = 1);
select t.ok('an agent (not admin) cannot change their desk''s sources',
  t.rows_affected($$delete from helpdesk.desk_kb_sources$$) = 0);
select t.as_user(t.u(2));  -- Dallas admin
select t.ok('a desk admin cannot remove another desk''s source choice',
  t.rows_affected($$delete from helpdesk.desk_kb_sources$$) = 0);

-- Cached KB text: written by the service role, read by the desk's own agents.
select t.as_service();
insert into helpdesk.desk_kb_cache (desk_id, content, shareable_content, source_doc_id) values
  ('d0000000-0000-0000-0000-000000000001', 'dallas full', 'dallas public', 'doc-dallas'),
  ('d0000000-0000-0000-0000-000000000002', 'git full', 'git public', 'doc-git');
select t.as_user(t.u(2));  -- Dallas member (the Dallas agent was removed by the set_desk_role tests)
select t.ok('an agent reads only their own desk''s cached KB',
  t.count('select 1 from helpdesk.desk_kb_cache') = 1
  and t.count($$select 1 from helpdesk.desk_kb_cache where desk_id = 'd0000000-0000-0000-0000-000000000002'$$) = 0);
select t.ok('an agent cannot write the cached KB',
  t.denied($$update helpdesk.desk_kb_cache set content = 'x'$$));
select t.as_user(t.u(5));  -- reporter
select t.ok('a reporter cannot read any cached KB',
  t.count('select 1 from helpdesk.desk_kb_cache') = 0);
select t.ok('a non-agent sees no sharing desks',
  t.count('select 1 from helpdesk.shared_kb_desk_ids()') = 0);
select t.as_user(t.u(4));  -- GIT agent
select t.ok('an agent can list which desks are sharing a KB',
  (select array_agg(d) from helpdesk.shared_kb_desk_ids() d) = array['d0000000-0000-0000-0000-000000000001'::uuid]);

select t.as_service();

-- ── Knowledge base articles: audiences, drafts, search ───────────────────

select t.as_owner();
grant usage on schema t to anon;
create function t.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $$;

-- Dallas (d1): public, internal, agents, a draft, an archived page.
-- Global IT (d2): public, internal, agents.
select t.as_service();
insert into helpdesk.kb_articles (desk_id, drive_id, slug, title, tier, topic, body, body_shareable, is_draft, archived) values
  ('d0000000-0000-0000-0000-000000000001', 'x1', 'reset-password', 'Reset your password', 'public', 'Sign-in', 'Use the reset link to choose a new password.', 'Use the reset link to choose a new password.', false, false),
  ('d0000000-0000-0000-0000-000000000001', 'x2', 'security-keys', 'Security keys', 'internal', 'Sign-in', 'Re-register your security key. Never reuse a password.', 'Re-register your security key. Never reuse a password.', false, false),
  ('d0000000-0000-0000-0000-000000000001', 'x3', 'unlock-account', 'Account unlock procedure', 'agents', null, 'Agents only: unlock the password from the console.', 'Agents only: unlock the password from the console.', false, false),
  ('d0000000-0000-0000-0000-000000000001', 'x4', 'phishing-draft', 'Phishing draft', 'internal', null, 'Draft text about password phishing.', 'Draft text about password phishing.', true, false),
  ('d0000000-0000-0000-0000-000000000001', 'x5', 'old-password-page', 'Old password page', 'public', null, 'An old password page.', 'An old password page.', false, true),
  ('d0000000-0000-0000-0000-000000000002', 'y1', 'sign-in-help', 'Sign-in help', 'public', null, 'Password help for sign in.', 'Password help for sign in.', false, false),
  ('d0000000-0000-0000-0000-000000000002', 'y2', 'vpn-setup', 'VPN setup', 'internal', null, 'Configure the VPN with your password.', 'Configure the VPN with your password.', false, false),
  ('d0000000-0000-0000-0000-000000000002', 'y3', 'runbook', 'GIT runbook', 'agents', null, 'Runbook for password rotation.', 'Runbook for password rotation.', false, false);

select t.as_anon();
select t.ok('a signed-out visitor sees only published public articles',
  t.count('select 1 from helpdesk.kb_articles') = 2
  and t.count($$select 1 from helpdesk.kb_articles where tier <> 'public' or is_draft or archived$$) = 0);
select t.ok('a signed-out visitor can search public articles only',
  t.count($$select 1 from helpdesk.search_kb('password')$$) = 2);
select t.ok('a signed-out visitor can list topics for public articles only',
  t.count('select 1 from helpdesk.kb_topics()') = 2);
select t.ok('a signed-out visitor still cannot read tickets or settings',
  t.denied('select 1 from helpdesk.tickets') and t.denied('select 1 from helpdesk.desk_settings'));
select t.ok('a signed-out visitor cannot write articles',
  t.denied($$update helpdesk.kb_articles set title = 'x'$$)
  and t.denied($$delete from helpdesk.kb_articles$$));

select t.as_user(t.u(6));  -- bystander: signed in, no tickets; both desks default to signed_in
select t.ok('a signed-in person sees public and internal articles on every desk, nothing else',
  t.count('select 1 from helpdesk.kb_articles') = 4
  and t.count($$select 1 from helpdesk.kb_articles where tier = 'agents' or is_draft or archived$$) = 0);
select t.ok('a signed-in person cannot write articles',
  t.denied($$insert into helpdesk.kb_articles (desk_id, drive_id, slug, title, tier, body, body_shareable)
    values ('d0000000-0000-0000-0000-000000000001', 'z', 'z', 'z', 'public', 'z', 'z')$$)
  and t.denied($$update helpdesk.kb_articles set tier = 'agents'$$)
  and t.denied($$delete from helpdesk.kb_articles$$));

-- Dallas now limits internal articles to people with a ticket on the desk.
select t.as_service();
update helpdesk.desk_settings set kb_internal_audience = 'ticket_requesters' where desk_id = 'd0000000-0000-0000-0000-000000000001';

select t.as_user(t.u(6));  -- bystander
select t.ok('with ticket_requesters, a person with no ticket loses that desk''s internal articles only',
  t.count('select 1 from helpdesk.kb_articles') = 3
  and t.count($$select 1 from helpdesk.kb_articles where desk_id = 'd0000000-0000-0000-0000-000000000001' and tier = 'internal'$$) = 0);
select t.ok('search follows the same rule',
  t.count($$select 1 from helpdesk.search_kb('password')$$) = 3
  and t.count($$select 1 from helpdesk.search_kb('security key')$$) = 0);
select t.as_user(t.u(5));  -- reporter with a live ticket on Dallas
select t.ok('a person with a ticket on the desk sees its internal articles',
  t.count('select 1 from helpdesk.kb_articles') = 4
  and t.count($$select 1 from helpdesk.search_kb('security key')$$) = 1);
select t.ok('a reporter still does not see agent-only articles or drafts',
  t.count($$select 1 from helpdesk.kb_articles where tier = 'agents' or is_draft or archived$$) = 0);
select t.ok('search snippets mark matches with U+27E6, not HTML',
  (select snippet from helpdesk.search_kb('security key') limit 1) like '%⟦%⟧%'
  and (select snippet from helpdesk.search_kb('security key') limit 1) not like '%<b>%');
select t.ok('requesting unpublished articles does not reveal them to a non-agent',
  t.count($$select 1 from helpdesk.search_kb('password', null, true)$$) = 4
  and t.count($$select 1 from helpdesk.kb_topics(null, true)$$) >= 1);
select t.ok('topics count only what the person can read',
  (select article_count from helpdesk.kb_topics('d0000000-0000-0000-0000-000000000001') where topic = 'Sign-in') = 2
  and (select article_count from helpdesk.kb_topics('d0000000-0000-0000-0000-000000000002') where topic = 'General') = 2);

select t.as_user(t.u(2));  -- Dallas desk admin
select t.ok('a desk''s agents read every audience on their desk, including drafts and archived',
  t.count($$select 1 from helpdesk.kb_articles where desk_id = 'd0000000-0000-0000-0000-000000000001'$$) = 5);
select t.ok('a desk''s agents get only the other desk''s readable articles',
  t.count($$select 1 from helpdesk.kb_articles where desk_id = 'd0000000-0000-0000-0000-000000000002'$$) = 2);
select t.ok('agents search published articles by default, and drafts when they ask',
  t.count($$select 1 from helpdesk.search_kb('password', 'd0000000-0000-0000-0000-000000000001')$$) = 3
  and t.count($$select 1 from helpdesk.search_kb('password', 'd0000000-0000-0000-0000-000000000001', true)$$) = 5);
select t.ok('an agent cannot write articles',
  t.denied($$update helpdesk.kb_articles set title = 'x'$$));
select t.as_user(t.u(4));  -- Global IT agent
select t.ok('an agent of another desk gets that desk''s public articles but not its internal ones (ticket_requesters)',
  t.count($$select 1 from helpdesk.kb_articles where desk_id = 'd0000000-0000-0000-0000-000000000001'$$) = 1
  and t.count($$select 1 from helpdesk.kb_articles where desk_id = 'd0000000-0000-0000-0000-000000000002'$$) = 3);
select t.as_user(t.u(1));  -- super admin
select t.ok('a super admin reads every article', t.count('select 1 from helpdesk.kb_articles') = 8);

-- Desk settings: who may change what.
select t.as_user(t.u(2));  -- Dallas desk admin
select t.ok('a desk admin cannot set the desk''s KB folder',
  t.denied($$update helpdesk.desk_settings set kb_folder_id = 'folder-dallas' where desk_id = 'd0000000-0000-0000-0000-000000000001'$$));
select t.ok('a desk admin can choose who reads internal articles',
  t.rows_affected($$update helpdesk.desk_settings set kb_internal_audience = 'signed_in' where desk_id = 'd0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('only the two known audiences are accepted',
  t.raises($$update helpdesk.desk_settings set kb_internal_audience = 'everyone' where desk_id = 'd0000000-0000-0000-0000-000000000001'$$, 'check'));
select t.as_user(t.u(1));  -- super admin
select t.ok('a super admin can set a desk''s KB folder',
  t.rows_affected($$update helpdesk.desk_settings set kb_folder_id = 'folder-dallas' where desk_id = 'd0000000-0000-0000-0000-000000000001'$$) = 1);
select t.ok('two desks cannot claim the same KB folder',
  t.raises($$update helpdesk.desk_settings set kb_folder_id = 'folder-dallas' where desk_id = 'd0000000-0000-0000-0000-000000000002'$$, 'duplicate key'));
select t.as_service();
select t.ok('the service role can set a KB folder',
  t.rows_affected($$update helpdesk.desk_settings set kb_folder_id = 'folder-git' where desk_id = 'd0000000-0000-0000-0000-000000000002'$$) = 1);
select t.ok('the service role can write articles',
  t.rows_affected($$update helpdesk.kb_articles set synced_at = now() where drive_id = 'x1'$$) = 1);
select t.ok('one article per Drive file and slug on a desk',
  t.raises($$insert into helpdesk.kb_articles (desk_id, drive_id, slug, title, tier, body, body_shareable)
    values ('d0000000-0000-0000-0000-000000000001', 'x1', 'other', 't', 'public', 'b', 'b')$$, 'duplicate key')
  and t.raises($$insert into helpdesk.kb_articles (desk_id, drive_id, slug, title, tier, body, body_shareable)
    values ('d0000000-0000-0000-0000-000000000001', 'new', 'reset-password', 't', 'public', 'b', 'b')$$, 'duplicate key'));
select t.ok('an unknown audience is rejected',
  t.raises($$insert into helpdesk.kb_articles (desk_id, drive_id, slug, title, tier, body, body_shareable)
    values ('d0000000-0000-0000-0000-000000000001', 'bad', 'bad', 't', 'mail-admins', 'b', 'b')$$, 'check'));

select t.as_service();

-- ── Draft outcomes ───────────────────────────────────────────────────────

select t.as_service();
insert into helpdesk.ticket_drafts (id, ticket_id, body) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', E'Hi Maria,\nTry the reset link.\nKind regards'),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'Second draft text'),
  ('f0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'Third draft text'),
  ('f0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'Fourth draft text');
insert into helpdesk.ticket_messages (id, ticket_id, direction, internal, body, profile_id, created_at) values
  ('f1000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'outbound', false, E'Hi Maria,   Try the reset link.\r\nKind regards  ', 'b0000000-0000-0000-0000-000000000002', now()),
  ('f1000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'outbound', false, 'Second draft text, plus a phone number', 'b0000000-0000-0000-0000-000000000002', now()),
  ('f1000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'outbound', false, 'Something I wrote myself', 'b0000000-0000-0000-0000-000000000002', now()),
  ('f1000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'outbound', true,  'internal note', 'b0000000-0000-0000-0000-000000000002', now()),
  ('f1000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000001', 'inbound',  false, 'a requester message', null, now()),
  ('f1000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000002', 'outbound', false, 'a reply on another ticket', 'b0000000-0000-0000-0000-000000000007', now()),
  ('f1000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000001', 'outbound', false, 'sent before the draft existed', 'b0000000-0000-0000-0000-000000000002', now() - interval '1 hour');

select t.as_user(t.u(5));  -- reporter
select t.ok('a reporter cannot record a draft outcome',
  t.denied($$select helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', true)$$));
select t.as_user(t.u(4));  -- GIT agent, other desk
select t.ok('an agent from a desk with only read-only access to the ticket cannot record a draft outcome',
  t.denied($$select helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', true)$$));

select t.as_user(t.u(2));  -- Dallas admin
select t.ok('a reply equal to the draft apart from whitespace is "as_written", even if never loaded',
  helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', false) = 'as_written');
select t.ok('a changed reply to a loaded draft is "edited"',
  helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000002', true) = 'edited');
select t.ok('a different reply to a draft that was never loaded is "rewritten"',
  helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000003', false) = 'rewritten');
select t.ok('recording stores the message, who, and retires the draft',
  t.count($$select 1 from helpdesk.ticket_drafts where id = 'f0000000-0000-0000-0000-000000000002'
    and sent_message_id = 'f1000000-0000-0000-0000-000000000002' and used_draft and outcome = 'edited'
    and outcome_by = 'b0000000-0000-0000-0000-000000000002' and outcome_at is not null and superseded_at is not null$$) = 1);
select t.ok('the first recorded outcome wins; a later call changes nothing',
  helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000003', true) = 'as_written'
  and t.count($$select 1 from helpdesk.ticket_drafts where id = 'f0000000-0000-0000-0000-000000000001'
    and sent_message_id = 'f1000000-0000-0000-0000-000000000001'$$) = 1);

select t.ok('an internal note cannot be linked as the sent reply',
  t.raises($$select helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000004', true)$$, 'not a public reply'));
select t.ok('an inbound message cannot be linked as the sent reply',
  t.raises($$select helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000005', true)$$, 'not a public reply'));
select t.ok('a reply on another ticket cannot be linked',
  t.raises($$select helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000006', true)$$, 'not a public reply'));
select t.ok('a reply sent before the draft existed cannot be linked',
  t.raises($$select helpdesk.record_draft_outcome('f0000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000007', true)$$, 'not a public reply'));
select t.ok('a refused call leaves the draft untouched',
  t.count($$select 1 from helpdesk.ticket_drafts where id = 'f0000000-0000-0000-0000-000000000004' and outcome is null and sent_message_id is null$$) = 1);
select t.ok('an agent cannot write the outcome columns directly',
  t.denied($$update helpdesk.ticket_drafts set outcome = 'as_written' where id = 'f0000000-0000-0000-0000-000000000004'$$));

select t.as_service();

rollback;
\echo ALL TESTS PASSED
