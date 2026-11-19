-- Hourly sync of every desk's knowledge-base Drive folder into articles.
--
-- Run this whole script once in the Supabase SQL editor, on a project that
-- already has migration_kb_articles.sql, migration_kb_images.sql and the daily
-- refresh job from schema_helpdesk.sql. It is safe to run again: it replaces
-- the job. Fresh setups do not need this file: schema_helpdesk.sql already
-- includes it.
--
-- It calls the sync-kb-articles edge function with the same Vault secret as the
-- daily KB refresh (helpdesk_kb_refresh_secret; see that job's setup note), so
-- there is nothing new to configure. The function skips every Doc Drive reports
-- unchanged, so a quiet hour costs one small listing per folder.
-- Project-specific: the URL below is this Supabase project's.

select cron.unschedule(jobid) from cron.job where jobname = 'helpdesk-sync-kb-articles';

select cron.schedule(
  'helpdesk-sync-kb-articles',
  '23 * * * *', -- hourly, off the hour and away from the other jobs
  $cron$
  select net.http_post(
    url := 'https://lxomebvymgolbzgkxqgu.supabase.co/functions/v1/sync-kb-articles',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-helpdesk-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helpdesk_kb_refresh_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);
