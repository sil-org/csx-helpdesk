# Setup Guide

One-time setup in external dashboards before this app can go live. Do them in order.

Replace `YOUR_DOMAIN` below with the subdomain you'll host this at (e.g. `helpdesk.sil.org`).

---

## 1. Use the shared Supabase project (same one as license-manager)

This app shares a Supabase project with `license-manager` rather than having
its own — both are `sil-app-template` apps for the same population of SIL
staff, so one project means one Google OAuth setup and one sign-in (via the
shared `profiles`/`linked_accounts` tables) instead of two. Their domain
tables don't collide: this app's tables live in their own Postgres schema,
`helpdesk`, and nothing in `public` is created, altered or dropped by it. That
also means the help desk can be split out into its own project later with
`pg_dump -n helpdesk`.

**If the shared project already exists** (license-manager's Supabase project
is already provisioned):

1. Get its **Project URL** and **anon public** key from
   **Project Settings > API** — reuse them for `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY` here, don't create a new project
2. **Check whether `resolve_profile()` already enforces the sil.org domain
   check** (open the function in SQL Editor, or check `license-manager`'s
   `supabase/schema.sql`). If not, run the "enable domain check" snippet in
   step 1a below — this app requires it, and since the function is shared,
   it needs to be enabled once for both apps.
3. **SQL Editor > New query**, paste `supabase/schema_helpdesk.sql`, run it.
   **Do not re-run `schema.sql`** — it's already been applied by
   license-manager's setup, and re-running it will error on
   `policy already exists` (the table/function statements are idempotent,
   but the `create policy` statements aren't).
4. Run `supabase/seed_pilot_desk.sql` (optional: only needed for the BTC
   pilot in step 9b)
5. Do step 1b below (expose the schema, create the first super admin)

**If the shared project doesn't exist yet** (starting fresh, license-manager
hasn't been set up either):

1. Go to [supabase.com](https://supabase.com) and sign in
2. **New project** → name it something that reflects both apps (e.g.
   `sil-internal-tools`), not just one — pick a region
3. Wait for it to provision
4. **Project Settings > API** → copy **Project URL** (`VITE_SUPABASE_URL`) and
   **anon public** key (`VITE_SUPABASE_ANON_KEY`)
5. **SQL Editor > New query**, paste `supabase/schema.sql` (the sil-app-template
   auth kernel — profiles, linked accounts, RLS, with the sil.org check
   already enabled in this copy), run it — **once, for both apps**
6. New query, paste `supabase/schema_helpdesk.sql`, run it
7. Also run `license-manager`'s `supabase/schema_licenses.sql` against this
   same project (see that repo's `SETUP.md`)
8. Run `supabase/seed_pilot_desk.sql` (optional: only needed for the BTC
   pilot in step 9b)
9. Do step 1b below (expose the schema, create the first super admin)

**Back up first.** Whichever case you're in, take a database backup (or work
on a Supabase branch) before running anything against a project that
`license-manager` is using.

**If you ran the earlier version of `schema_helpdesk.sql`** (it created
`desks`, `tickets`, ... in `public`), nothing breaks: the new file only touches
the `helpdesk` schema. Those old tables are pilot test data and can be dropped
once you've confirmed that; `supabase/cleanup_pilot_public_tables.sql` lists
the statements, commented out.

### 1a. Enable the sil.org domain check (only if it isn't already)

Safe to run any time — `create or replace function` doesn't error if the
function already exists, so this works whether or not the check is
currently enabled:

```sql
create or replace function resolve_profile(
  p_token uuid,
  p_supabase_user_id uuid,
  p_email text,
  p_display_name text
)
returns uuid language plpgsql security definer as $$
declare
  v_profile_id uuid;
begin
  -- case 1: already linked
  select profile_id into v_profile_id
  from linked_accounts where supabase_user_id = p_supabase_user_id;
  if v_profile_id is not null then
    return v_profile_id;
  end if;

  -- case 2: valid link token supplied — links this account to an existing
  -- profile regardless of email domain. The token is the security check
  -- here, not the domain — see schema.sql for why that's safe.
  if p_token is not null then
    select profile_id into v_profile_id
    from profile_link_tokens
    where token = p_token and used_at is null and expires_at > now();

    if v_profile_id is not null then
      insert into linked_accounts (supabase_user_id, profile_id, email)
      values (p_supabase_user_id, v_profile_id, p_email);
      update profile_link_tokens set used_at = now() where token = p_token;
      return v_profile_id;
    end if;
  end if;

  -- case 3: brand new person — the only path that creates a profile, so the
  -- only path that needs the sil.org check.
  if p_email not like '%@sil.org' then
    raise exception 'Access restricted to SIL staff (sil.org accounts).';
  end if;

  insert into profiles (display_name, primary_email)
  values (p_display_name, p_email)
  returning id into v_profile_id;

  insert into linked_accounts (supabase_user_id, profile_id, email)
  values (p_supabase_user_id, v_profile_id, p_email);

  return v_profile_id;
end;
$$;
```

---

### 1b. Expose the `helpdesk` schema and create the first super admin

1. **Project Settings > API > Exposed schemas**: *add* `helpdesk` to the list
   (keep `public`; this only appends, it doesn't affect license-manager)
2. Sign in to the app once with your SIL account so you have a profile, then
   in the SQL Editor:

   ```sql
   insert into helpdesk.super_admins (profile_id)
   select id from public.profiles where primary_email = 'your-email@sil.org';
   ```

   Super admin is its own table, **not** `public.profiles.role = 'admin'`:
   that role is shared with license-manager, and its admins shouldn't
   automatically be help desk super admins.
3. Super admins create desks and give each one at least one admin (the first
   admin is inserted directly, see the end of `seed_pilot_desk.sql`; after that
   admins manage people through the app).

---

## 2. Set up Google OAuth, restricted to SIL staff

Unlike the generic template, this app enforces the sil.org domain check
inside `resolve_profile()` in `schema.sql` (already enabled, not commented
out) — so any non-`@sil.org` sign-in attempt is rejected at the database
level. Still do this too, as a stronger first line of defense:

### Recommended — Internal consent screen (if this project lives in the sil.org Workspace org)
1. [console.cloud.google.com](https://console.cloud.google.com) → new project `helpdesk`
2. **APIs & Services > OAuth consent screen**
   - User type: **Internal** — this makes Google itself reject any non-sil.org
     sign-in before it ever reaches the app
3. **APIs & Services > Credentials > Create Credentials > OAuth client ID**
   - Application type: **Web application**
   - Authorised JavaScript origins: `https://YOUR_DOMAIN`
   - Authorised redirect URIs: `https://your-project-id.supabase.co/auth/v1/callback`
4. Copy **Client ID** and **Client Secret**

If Internal isn't available (project isn't in the sil.org Workspace org), use
**External** — the database-level check in `resolve_profile()` is the real
enforcement in that case.

### In Supabase
1. **Authentication > Providers > Google** → enable, paste Client ID/Secret
2. **Authentication > URL Configuration**:
   - Site URL: `https://YOUR_DOMAIN`
   - Redirect URLs: `https://YOUR_DOMAIN/auth/callback`, plus
     `http://localhost:5173/auth/callback` for local dev

---

## 3. Create the S3 bucket + CloudFront distribution

### S3 bucket
1. **S3 > Create bucket** → name `helpdesk-web` (globally unique — add a
   suffix if taken), region `us-east-1`
2. Uncheck "Block all public access" → confirm
3. **Permissions > Bucket policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::helpdesk-web/*"
  }]
}
```

4. **Properties > Static website hosting > Enable** — Index document: `index.html`,
   Error document: `index.html` (required for React Router)

### SSL certificate (ACM, must be in us-east-1)
1. **Certificate Manager > Request a public certificate** for `YOUR_DOMAIN`
2. DNS validation → create the validation record in Route 53
3. Wait for status **Issued**

### CloudFront distribution
1. **CloudFront > Create distribution**
2. Origin: the S3 bucket's **website endpoint** (not the bucket name directly)
3. Viewer protocol policy: **Redirect HTTP to HTTPS**
4. Alternate domain name (CNAME): `YOUR_DOMAIN`
5. Custom SSL certificate: the one from above
6. Default root object: `index.html`
7. Copy the **Distribution ID**

### Route 53 DNS
Create an **A** record (Alias) for `YOUR_DOMAIN` pointing at the CloudFront distribution.

---

## 4. Add GitHub Secrets

**Settings > Secrets and variables > Actions**:

| Secret name | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM credentials with S3 + CloudFront permissions |
| `AWS_SECRET_ACCESS_KEY` | " |
| `AWS_REGION` | `us-east-1` |
| `S3_BUCKET` | `helpdesk-web` |
| `CLOUDFRONT_DISTRIBUTION_ID` | from step 3 |
| `VITE_SUPABASE_URL` | Supabase Project Settings > API |
| `VITE_SUPABASE_ANON_KEY` | Supabase Project Settings > API |
| `SUPABASE_ACCESS_TOKEN` | for the edge-functions deploy job (it deploys every function in `supabase/functions/`) |
| `SUPABASE_PROJECT_REF` | your Supabase project ref |

---

## 5. Push and deploy

```bash
git push -u origin main
```

The GitHub Action deploys to S3 + invalidates CloudFront, and deploys the
edge functions (`embed-document`, `helpdesk-ingest`), automatically.

---

## 6. Local development

```bash
cp .env.example .env
# fill in .env with your Supabase URL and anon key
npm install
npm run dev
# open http://localhost:5173
```

---

## 7. Make yourself admin

After your first sign-in:

```sql
update profiles set role = 'admin'
where primary_email = 'your-email@sil.org';
```

---

## 8. Before embedding any real ticket content: opt out of Voyage AI training

Voyage AI trains on submitted content by default (unlike Anthropic's API).
The RAG corpus is internal SIL ticket content, so before setting
`VOYAGE_TRAINING_OPT_OUT_CONFIRMED=true`:

1. Create the Voyage AI account for this project
2. Opt out of training via the opt-out functionality on their account
   dashboard (account-level setting, not an API parameter)
3. Only then set `VOYAGE_API_KEY` and `VOYAGE_TRAINING_OPT_OUT_CONFIRMED=true`
   as secrets for the `embed-document` function (`supabase secrets set`)

The function refuses to call Voyage AI until that flag is `true`.

---

## 9. Email ingestion

`helpdesk-ingest` (an edge function) polls the mailboxes listed in
`helpdesk.desk_mailboxes` once a minute and turns inbound mail into tickets.
Design and reasoning: `docs/HELPDESK_SPEC.md` section 6.

**What this phase does:** receives mail, routes it to a desk by address,
creates or threads tickets, stores attachments, skips automatic replies, parks
mail that matches no desk. **What it doesn't do yet:** send any email
(replies, acknowledgements), detect the real reporter on a forward (it only
flags forwards as "reporter unverified"), or scan attachments for viruses.

### 9a. sil.org: ingest mailbox + service account (production path)

Needs a Google Workspace super admin.

1. **Create the ingest mailbox**, e.g. `helpdesk-ingest@sil.org`, a
   non-human user nobody reads mail in.
2. **Google Cloud Console** > a project > **APIs & Services > Library** >
   enable the **Gmail API**. **IAM & Admin > Service Accounts** > create one
   (e.g. `helpdesk-ingest`). Note its **Unique ID** (the numeric client ID).
3. **Admin console > Security > Access and data control > API controls >
   Manage Domain Wide Delegation > Add new**: Client ID = the Unique ID,
   scope = `https://www.googleapis.com/auth/gmail.modify` (read, label,
   archive). When reply-sending is built it will also need
   `https://www.googleapis.com/auth/gmail.send`.

   **Know what this grants:** delegation lets this service account act as
   *any* user in the domain for the scopes granted; only the code limits it
   to the ingest mailbox. Keep the key in Supabase secrets only, never in the
   repo, and keep the scope list minimal.
4. Create a key for the service account (**Keys > Add key > JSON**), then:

   ```bash
   supabase secrets set HELPDESK_GOOGLE_SA_JSON="$(cat key.json)"
   supabase secrets set HELPDESK_CRON_SECRET="$(openssl rand -hex 32)"
   ```

   (If your organization blocks service-account key creation, that's a policy
   decision to resolve with whoever owns the Cloud organization; the function
   needs a key or an equivalent way to mint the delegation token.)
5. **Register the mailbox and each desk's addresses** (SQL editor):

   ```sql
   insert into helpdesk.desk_mailboxes (mailbox, auth_type)
   values ('helpdesk-ingest@sil.org', 'service_account');   -- shared: desk_id null

   insert into helpdesk.desk_addresses (address, desk_id)
   select 'dallas-help@sil.org', id from helpdesk.desks where slug = 'dallas';
   ```

6. **Get mail into the ingest mailbox** (per address, see spec section 6):
   - *Parallel run with YouTrack:* add the ingest mailbox as another member of
     the desk's Google Group. YouTrack keeps receiving everything.
   - *Cutover:* move the address from the group to an alias on the ingest
     mailbox (an address can't be both). YouTrack stops receiving it at that
     point.

   Mail delivered through a group is routed by the group's own headers
   (`List-Post`, `Mailing-list`, `List-Id`). Those formats are handled from
   documentation, not yet confirmed on real mail: check the first real
   message with `select * from helpdesk.ingest_log` / `tickets` and tell
   whoever is maintaining this if routing misses.

### 9b. BTC conference pilot (OAuth, different Workspace domain)

For testing before sil.org mailboxes exist. `helpdesk-test@btconference.org`
is an alias on `info@btconference.org`, which also holds real conference
mail, so the poller is restricted to messages carrying the Gmail label
`HelpdeskPilot` (set by a Gmail filter): it can never see anything else.

1. **Admin console:** add `helpdesk-test@btconference.org` as an alias on the
   `info@btconference.org` account.
2. **Gmail (as info@btconference.org):** create the label `HelpdeskPilot`, and
   a filter *To: helpdesk-test@btconference.org -> Apply the label
   `HelpdeskPilot`* (optionally "Skip the Inbox").
3. **Get a refresh token** (3-legged OAuth, not delegation): in Google Cloud
   enable the Gmail API, **Credentials > Create credentials > OAuth client ID**,
   type **Web application**, redirect URI exactly
   `https://developers.google.com/oauthplayground`. In the
   [OAuth Playground](https://developers.google.com/oauthplayground): gear icon
   > "Use your own OAuth credentials", Access type **Offline**, Force prompt
   **Consent Screen**; authorize `https://www.googleapis.com/auth/gmail.modify`
   **signed in as info@btconference.org**; exchange the code and copy the
   refresh token (treat it like a password).
4. Secrets:

   ```bash
   supabase secrets set HELPDESK_BTC_CLIENT_ID=... HELPDESK_BTC_CLIENT_SECRET=... HELPDESK_BTC_REFRESH_TOKEN=...
   supabase secrets set HELPDESK_CRON_SECRET="$(openssl rand -hex 32)"   # once, if not set in 9a
   ```

5. Run `supabase/seed_pilot_desk.sql` (creates the pilot desk, its address and
   the mailbox row with `secret_prefix = 'HELPDESK_BTC'` and the isolation label).

### 9c. Deploy, test, schedule

1. Deploy: `supabase functions deploy helpdesk-ingest --no-verify-jwt`
   (the GitHub Action does this on push to `main`). The function refuses to
   run unless `HELPDESK_CRON_SECRET` is set and sent as `x-helpdesk-secret`,
   which is what stops anyone on the internet from triggering it.
2. Send a test email to a desk address, then poll once by hand:

   ```bash
   curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/helpdesk-ingest \
     -H "x-helpdesk-secret: $HELPDESK_CRON_SECRET" -H "Content-Type: application/json" -d '{}'
   ```

   Then check `helpdesk.tickets` and `helpdesk.ingest_runs` (the last poll per
   mailbox, with counts and any error: this is the "is it alive?" heartbeat).
3. **Schedule it:** `supabase/schedule_helpdesk_ingest.sql` (pg_cron + pg_net;
   a template, replace the project ref).
4. **Triage:** mail matching no desk address is parked, not lost: it keeps the
   Gmail label `HelpdeskUnrouted` and a row in `helpdesk.ingest_log`
   (`outcome = 'unrouted'`). After adding the missing address in
   `desk_addresses`, re-route with body `{"retry_unrouted": true}`. Messages
   that fail three times are labelled `HelpdeskFailed` and stay in
   `ingest_log` with the error.

### Tests

`npm run test:ingest` runs the function's unit tests (Node 22+). The database
access-rule tests are SQL; see `supabase/tests/README.md`.
