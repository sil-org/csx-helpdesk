-- Poll the help desk mailboxes once a minute with pg_cron + pg_net.
-- TEMPLATE: replace YOUR_PROJECT_REF, run once in the SQL editor. Not tested
-- against a live project (needs the pg_cron, pg_net and vault extensions
-- enabled: Database > Extensions; availability depends on your plan).
--
-- 1. Store the same shared secret the function checks (HELPDESK_CRON_SECRET)
--    in Vault so it isn't written into the cron job text:
--
--      select vault.create_secret('<the same value as HELPDESK_CRON_SECRET>', 'helpdesk_cron_secret');
--
-- 2. Schedule the call:

select cron.schedule(
  'helpdesk-ingest',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/helpdesk-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-helpdesk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helpdesk_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Check it is running:   select * from cron.job_run_details order by start_time desc limit 5;
-- And that polls succeed: select * from helpdesk.ingest_runs order by started_at desc limit 5;
-- Stop it:               select cron.unschedule('helpdesk-ingest');
