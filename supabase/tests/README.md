# Database tests

`helpdesk_rls.test.sql` checks the help desk's access rules (who can see and
change what), the audit triggers, the role-change RPC and the `ingest_inbound`
function. It is plain SQL (no pgTAP) and runs in one transaction that rolls
back.

**Run it only against a scratch database**, never the real Supabase project.
It needs a local Postgres (16 is what it was written against) with Supabase's
roles and `auth.uid()` stubbed in:

```bash
createdb hd_test
psql -v ON_ERROR_STOP=1 -d hd_test -f supabase/tests/scratch_db_setup.sql   # roles + auth stubs
psql -v ON_ERROR_STOP=1 -d hd_test -f supabase/schema.sql                   # shared auth kernel
psql -d hd_test -c "grant all on all tables in schema public to authenticated, service_role"
grep -v '^create extension' supabase/schema_helpdesk.sql | psql -q -v ON_ERROR_STOP=1 -d hd_test   # pg_cron/pg_net don't exist locally; scratch_db_setup.sql stubs what the rest needs
psql -v ON_ERROR_STOP=1 -d hd_test -f supabase/tests/helpdesk_rls.test.sql   # prints "ok - ..." per check, then ALL TESTS PASSED
```

Any failing check raises `FAIL: <name>` and the script stops.

What these tests do **not** cover: the real Supabase API layer (PostgREST,
exposed schemas, storage), the Resend API, or the deployed edge function. Those need a
live project.
