-- Pilot desk for the parallel run with YouTrack: the Global IT Help Desk's
-- public address, helpdesk@sil.org. Run AFTER schema_helpdesk.sql. Safe to re-run.
--
-- helpdesk@sil.org is a Google Group with YouTrack as a member. The Resend
-- receiving address is added as one more member, so every message sent to it
-- also reaches this app; YouTrack keeps working untouched. live_replies stays
-- false (the default), so the app never sends anything from this address.
-- See SETUP.md step 9.
--
-- Rename the desk or change its slug later from the app; the slug is only a
-- handle for the seed and the commented-out grant below.

insert into helpdesk.desks (slug, name)
values ('ghd', 'Global IT Help Desk (pilot)')
on conflict (slug) do nothing;

insert into helpdesk.desk_settings (desk_id)
select id from helpdesk.desks where slug = 'ghd'
on conflict (desk_id) do nothing;

insert into helpdesk.desk_addresses (address, desk_id)
select 'helpdesk@sil.org', id from helpdesk.desks where slug = 'ghd'
on conflict (address) do nothing;

-- Give someone access to the pilot desk once they have signed in (replace the
-- email). Run this in the SQL editor: helpdesk.set_desk_role() needs a
-- signed-in desk admin, so the very first admin is inserted directly; after
-- that, admins manage people through the app.
--
-- insert into helpdesk.agent_desks (profile_id, desk_id, role)
-- select p.id, d.id, 'admin'
-- from public.profiles p, helpdesk.desks d
-- where p.primary_email = 'your-email@sil.org' and d.slug = 'ghd';
