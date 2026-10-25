-- Pilot desk for testing email ingestion via the BTC conference mailbox
-- alias (helpdesk-test@btconference.org), since sil.org mailboxes aren't set
-- up yet. Run AFTER schema_helpdesk.sql. Safe to re-run.
--
-- The mailbox row uses OAuth (the BTC mailbox is in a different Workspace
-- domain, so the service account can't act as it) and an isolation label, so
-- the poller can only ever see messages Gmail's own filter labelled
-- HelpdeskPilot, never real BTC conference mail. See SETUP.md step 9b.

insert into helpdesk.desks (slug, name)
values ('pilot', 'Pilot (BTC test alias)')
on conflict (slug) do nothing;

insert into helpdesk.desk_settings (desk_id)
select id from helpdesk.desks where slug = 'pilot'
on conflict (desk_id) do nothing;

insert into helpdesk.desk_addresses (address, desk_id)
select 'helpdesk-test@btconference.org', id from helpdesk.desks where slug = 'pilot'
on conflict (address) do nothing;

insert into helpdesk.desk_mailboxes (mailbox, desk_id, auth_type, secret_prefix, isolation_label)
select 'info@btconference.org', id, 'oauth', 'HELPDESK_BTC', 'HelpdeskPilot'
from helpdesk.desks where slug = 'pilot'
on conflict (mailbox) do nothing;

-- Give someone access to the pilot desk once they have signed in (replace the
-- email). Run this in the SQL editor: helpdesk.set_desk_role() needs a
-- signed-in desk admin, so the very first admin is inserted directly; after
-- that, admins manage people through the app.
--
-- insert into helpdesk.agent_desks (profile_id, desk_id, role)
-- select p.id, d.id, 'admin'
-- from public.profiles p, helpdesk.desks d
-- where p.primary_email = 'your-email@sil.org' and d.slug = 'pilot';
