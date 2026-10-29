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

rollback;
\echo ALL TESTS PASSED
