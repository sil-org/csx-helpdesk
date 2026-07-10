# Setup Guide

One-time setup in external dashboards before this app can go live. Do them in order.

Replace `YOUR_DOMAIN` below with the subdomain you'll host this at (e.g. `helpdesk.sil.org`).

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in
2. **New project** → Name: `helpdesk` → pick a region
3. Wait for it to provision
4. **Project Settings > API** → copy **Project URL** (`VITE_SUPABASE_URL`) and
   **anon public** key (`VITE_SUPABASE_ANON_KEY`)

### Run the database schema

1. **SQL Editor > New query**, paste the contents of `supabase/schema.sql` (the
   sil-app-template auth kernel — profiles, linked accounts, RLS), run it
2. New query, paste `supabase/schema_helpdesk.sql` (desks, tickets, messages,
   corpus — see Section 3 of `docs/HELPDESK_PROJECT_BRIEF.md`), run it

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

1. [console.cloud.google.com](https://console.cloud.google.com) → the same
   `helpdesk` project (or a new one) → **APIs & Services > Library** → enable
   the **Gmail API**
2. **APIs & Services > Credentials > Create Credentials > OAuth client ID**
   → Application type **Desktop app** (simplest for a one-time manual consent)
   → copy the Client ID and Client Secret
3. Use [Google OAuth Playground](https://developers.google.com/oauthplayground):
   - Gear icon → check "Use your own OAuth credentials" → paste the Client ID/Secret
   - Step 1: select scope `https://www.googleapis.com/auth/gmail.modify` → Authorize
     → **sign in as info@btconference.org** when prompted
   - Step 2: Exchange authorization code for tokens → copy the **refresh token**
     (this doesn't expire unless revoked — treat it like a password)

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
