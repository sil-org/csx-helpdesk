-- Minimal stand-ins for the parts of Supabase the schema depends on (roles,
-- auth.users, auth.uid()), so supabase/schema.sql + schema_helpdesk.sql and the
-- tests can run against a plain local Postgres. SCRATCH DATABASES ONLY: never
-- run this against the real Supabase project.

do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Stand-ins for the other Supabase pieces schema_helpdesk.sql touches: the
-- storage.objects table (policy on it), Vault secrets, pg_net's http_post (a
-- no-op here) and pg_cron's schedule functions. The two `create extension`
-- lines in schema_helpdesk.sql need the real extensions, so load the schema
-- through: grep -v '^create extension' supabase/schema_helpdesk.sql
create schema extensions;
create schema storage;
create table storage.objects (bucket_id text, name text);
alter table storage.objects enable row level security;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema net;
create function net.http_post(url text default null, headers jsonb default null, body jsonb default null)
  returns bigint language sql as $$ select 1::bigint $$;
create schema cron;
create table cron.job (jobid bigint, jobname text);
create function cron.unschedule(bigint) returns boolean language sql as $$ select true $$;
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
