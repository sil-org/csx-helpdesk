# Setup Guide

One-time setup in external dashboards before this app can go live. Do them in order.

Replace `YOUR_DOMAIN` below with the subdomain you'll host this at (e.g. `helpdesk.sil.org`).

---

## 1. Use the shared Supabase project (same one as license-manager)

This app shares a Supabase project with `license-manager` rather than having
its own — both are `sil-app-template` apps for the same population of SIL
staff, so one project means one Google OAuth setup and one sign-in (via the
shared `profiles`/`linked_accounts` tables) instead of two. Their domain
tables don't collide (`desks`/`tickets`/... vs `suite_keys`/`licenses`/...),
so this is safe.

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
4. Run `supabase/seed_pilot_desk.sql`

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
8. Run `supabase/seed_pilot_desk.sql`

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
| `SUPABASE_ACCESS_TOKEN` | for the edge-functions deploy job (the `embed-document` function) |
| `SUPABASE_PROJECT_REF` | your Supabase project ref |

---

## 5. Push and deploy

```bash
git push -u origin main
```

The GitHub Action deploys to S3 + invalidates CloudFront, and deploys the
`embed-document` edge function, automatically.

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

## 9. Pilot email ingestion (temporary — BTC alias, not sil.org)

sil.org MX record access isn't available yet, so ticket intake is piloted on
`helpdesk-test@btconference.org`, an alias on the existing `info@btconference.org`
Google Workspace mailbox, instead of a real department address. **Swap this
out for a real `sil.org` alias once DNS access comes through** — don't leave
production ticket intake on a conference domain.

### Add the alias and an isolating filter

Because the Gmail API OAuth grant below covers the *entire* `info@` mailbox
(there's no way to scope it to just the alias), a Gmail filter + label is
what actually keeps this pilot from touching real BTC conference mail — the
ingestion function only ever reads messages carrying the label.

1. **Google Workspace Admin console** (needs admin rights on the Workspace,
   not just a regular user on `info@`): add `helpdesk-test@btconference.org`
   as an alias on the `info@btconference.org` account
2. **Gmail (as info@btconference.org) > Settings > Labels**: create a label
   `HelpdeskPilot`
3. **Settings > Filters and Blocked Addresses > Create a new filter**:
   - To: `helpdesk-test@btconference.org`
   - Create filter → Apply the label `HelpdeskPilot` (optionally also
     "Skip the Inbox" so pilot mail doesn't clutter the real inbox)

### Get a Gmail API refresh token (3-legged OAuth, not domain-wide delegation)

This is a separate OAuth client from the one used for staff sign-in — don't
reuse that one, it has different redirect URIs and scopes.

1. [console.cloud.google.com](https://console.cloud.google.com) → the same
   `helpdesk` project (or a new one) → **APIs & Services > Library** → enable
   the **Gmail API**
2. **APIs & Services > Credentials > Create Credentials > OAuth client ID**
   → Application type **Web application** (not Desktop app — Desktop app
   clients can't set a redirect URI, and OAuth Playground needs one)
   → name it something like "Gmail ingestion (OAuth Playground)"
   → under **Authorized redirect URIs**, add exactly
   `https://developers.google.com/oauthplayground`
   → Create → copy the **Client ID** and **Client Secret**
3. Use [Google OAuth Playground](https://developers.google.com/oauthplayground):
   - Gear icon (top right) → check **"Use your own OAuth credentials"** →
     paste the Client ID/Secret
   - Same settings panel: set **Access type** to **Offline** and
     **Force prompt** to **Consent Screen** — both are required or Google
     won't return a refresh token
   - Step 1: find **Gmail API v1**, check scope
     `https://www.googleapis.com/auth/gmail.modify` → **Authorize APIs**
     → **sign in as info@btconference.org** when prompted (not your personal
     or SIL account — it has to be that mailbox's account)
   - Step 2: **Exchange authorization code for tokens** → copy the
     **refresh token** from the response (this doesn't expire unless
     revoked — treat it like a password)

### Wire it up

1. Run `supabase/seed_pilot_desk.sql` in the SQL Editor (creates the `pilot` desk)
2. Set secrets: `supabase secrets set GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_REFRESH_TOKEN=...`
3. Deploy: `supabase functions deploy ingest-email --no-verify-jwt`
4. Test by emailing `helpdesk-test@btconference.org`, then manually invoke the
   function (`curl -X POST https://your-project-id.supabase.co/functions/v1/ingest-email`)
   and confirm a row shows up in `tickets`

**Not done yet:** this only runs when invoked manually. Real polling needs a
recurring trigger (`pg_cron` calling the function on a schedule, or an
external scheduler) — add that once the pilot itself is confirmed working.
