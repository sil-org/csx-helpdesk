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
4. Run `supabase/seed_pilot_desk.sql` (creates the pilot Global IT Help Desk
   with the address helpdesk@sil.org; needed for step 9)
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
8. Run `supabase/seed_pilot_desk.sql` (creates the pilot Global IT Help Desk
   with the address helpdesk@sil.org; needed for step 9)
9. Do step 1b below (expose the schema, create the first super admin)

**How to tell whether `schema.sql` has already been applied.** In the SQL
Editor run this; a value in each column means yes (skip `schema.sql`), and
`null` in the first column means no (run `schema.sql` once, first):

```sql
select
  to_regclass('public.profiles')        as profiles_table,
  to_regclass('public.linked_accounts') as linked_accounts_table,
  to_regprocedure('public.resolve_profile(uuid,uuid,text,text)') as resolve_profile_function,
  exists (select 1 from information_schema.schemata where schema_name = 'helpdesk') as helpdesk_schema_exists;
```

If `license-manager` sign-in already works on this project, `schema.sql` has
been applied. `helpdesk_schema_exists` stays `false` until you run
`schema_helpdesk.sql`.

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
   (keep `public`; this only appends, it doesn't affect license-manager). The
   schema only appears in that list **after** `schema_helpdesk.sql` has run, so
   do this last
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
edge functions (`embed-document`, `helpdesk-inbound`), automatically.

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

## 9. Email ingestion (Resend)

`helpdesk-inbound` (an edge function) receives Resend's `email.received`
webhook and turns each email into a ticket. Design and reasoning:
`docs/HELPDESK_SPEC.md` section 6.

**How mail gets in.** People keep writing to the usual `@sil.org` desk
addresses; nobody ever sees a Resend address. Each desk address is a Google
Group, and the group also delivers a copy to a Resend receiving address (a
hidden group member, the same way YouTrack receives it). Resend stores the
message and calls the function, which fetches the full email, finds the desk,
creates or threads the ticket, stores attachments, skips automatic replies
and parks mail that matches no desk. The Resend address is verified to work
with a Google Group: the original recipient comes through in `received_for`,
the true sender in `X-Original-Sender`, and `In-Reply-To`/`References` are
preserved.

**What this phase does not do yet:** send any email (replies,
acknowledgements; those will go out from `@em.sil.org` with Reply-To set to the
desk's `@sil.org` address), detect the real reporter on a forward (it only
flags forwards as "reporter unverified"), or scan attachments for viruses.

### 9a. Resend

1. **Receiving address.** Resend dashboard > **Emails > Receiving**: use the
   managed address (`something@<id>.resend.app`). One address is enough: add
   it to every desk's group. (A custom receiving subdomain such as
   `in.sil.org` is optional later; it needs an MX record. Never point the MX
   of `sil.org` itself at Resend.)
2. **API key.** **API Keys > Create**, name `helpdesk-inbound`. The function
   only reads received mail. If Resend offers a read-only or receiving-only
   scope, choose it; otherwise Full access. Outbound sending will get its own
   key later (Sending access, limited to em.sil.org).
3. **Webhook.** **Webhooks > Add endpoint**:
   URL `https://YOUR_PROJECT_REF.supabase.co/functions/v1/helpdesk-inbound`,
   event **`email.received`** only. Copy the endpoint's **signing secret**
   (`whsec_...`). Use the exact https URL (a redirect makes Resend retry
   forever, since it does not follow redirects).
4. **Check plan and limits** in Resend (maximum received message size, how long
   received mail is kept, monthly receiving volume and price) before sending
   real traffic through it.

### 9b. Supabase secrets and deploy

```bash
supabase secrets set RESEND_API_KEY=re_... RESEND_WEBHOOK_SECRET=whsec_...
# optional: lets you re-process one stored email by hand (see 9d); leave unset to disable
supabase secrets set HELPDESK_REPROCESS_SECRET="$(openssl rand -hex 32)"
```

(Or Dashboard > Edge Functions > Secrets.) Deploy with
`supabase functions deploy helpdesk-inbound --no-verify-jwt`; the GitHub
Action does this on push to `main`. The function checks Resend's signature
itself and refuses to run without `RESEND_WEBHOOK_SECRET`, which is what stops
anyone on the internet from posting fake mail to it.

### 9c. Connect a desk address (parallel run first)

1. Make sure the desk and its address exist: `supabase/seed_pilot_desk.sql`
   creates the Global IT Help Desk (pilot) with `helpdesk@sil.org`. For more
   desks: `insert into helpdesk.desk_addresses (address, desk_id) select 'dallas-help@sil.org', id from helpdesk.desks where slug = 'dallas';`
2. Admin console > Groups > the desk's group > add the Resend receiving
   address as a member. YouTrack keeps receiving everything.
3. Send a test email to the desk address from an outside account, then check
   `select * from helpdesk.tickets order by created_at desc limit 5;` and
   `select * from helpdesk.ingest_log order by created_at desc limit 10;`
   (`ingested`, `skipped`, `unrouted` and `error` rows; the newest row is the
   "is it alive?" heartbeat).
4. **First attachment test.** Send one with a small attachment and confirm a
   `helpdesk.ticket_attachments` row has a `storage_path`. The attachment
   download call is written from Resend's response shape but has not been run
   against a real attachment; if the row shows `skipped_reason = 'could not
   store: ...'`, send that message to whoever maintains this.
5. **Cutover (later, per address).** Moving an address off its group to a
   plain alias needs a Workspace routing rule delivering a copy to the Resend
   address; do that deliberately per address, not in bulk.

### 9d. Triage and re-processing

- Mail matching no desk address is not lost: it has an `ingest_log` row with
  `outcome = 'unrouted'` (and stays in Resend). After adding the missing
  address to `desk_addresses`, re-process it with the `email_id`
  (the id on the Resend Receiving page, or in the log row's
  `gmail_message_id` column):

  ```bash
  curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/helpdesk-inbound \
    -H "x-helpdesk-secret: $HELPDESK_REPROCESS_SECRET" -H "Content-Type: application/json" \
    -d '{"email_id": "THE-EMAIL-ID"}'
  ```

- A failure (Supabase down, bad key) returns an error to Resend, which retries
  the webhook automatically; the failed attempt is an `error` row in
  `ingest_log`. A message delivered twice is ignored the second time.
- If real mail stops appearing: Resend dashboard > Webhooks > the endpoint's
  event log shows delivery attempts and the response each got.

### Tests

`npm run test:inbound` runs the function's unit tests (Node 22+), including
the real group-delivered mail shape. The database access-rule tests are SQL;
see `supabase/tests/README.md`.
