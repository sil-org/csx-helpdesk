-- Pilot desk for testing email ingestion via the BTC conference mailbox
-- alias (helpdesk-test@btconference.org), since sil.org MX record access
-- isn't available yet. Safe to re-run.

insert into desks (slug, name)
values ('pilot', 'Pilot (BTC test alias)')
on conflict (slug) do nothing;

insert into desk_settings (desk_id)
select id from desks where slug = 'pilot'
on conflict (desk_id) do nothing;
