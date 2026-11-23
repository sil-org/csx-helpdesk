# Setup Guide

One-time setup in external dashboards before this app can go live. Do them in order.

Replace `YOUR_DOMAIN` below with the subdomain you'll host this at (e.g. `helpdesk.sil.org`).

---

## 1. Use the shared Supabase project (same one as license-manager)

This app shares a Supabase project with `license-manager` rather than having
its own — both are `sil-app-template` apps for the same population of SIL
staff, so one project means one sign-in setup (via the shared
`profiles`/`linked_accounts` tables) instead of two — note that helpdesk and
license-manager can still use different sign-in methods on this one project
(see step 2): helpdesk is SSO-only, license-manager may still be on Google.
Their domain
tables don't collide: this app's tables live in their own Postgres schema,
`helpdesk`, and nothing in `public` is created, altered or dropped by it. That
also means the help desk can be split out into its own project later with
`pg_dump -n helpdesk`.

**If the shared project already exists** (license-manager's Supabase project
is already provisioned):

1. Get its **Project URL** and **anon public** key from
   **Project Settings > API** — reuse them for `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY` here, don't create a new project
2. **Check whether `resolve_profile()` is on the hardened, post-2026-09-25
   version** (open the function in SQL Editor — it should derive identity
   from `auth.uid()`, not from its `p_supabase_user_id`/`p_email`
   parameters; see `license-manager`'s `supabase/schema.sql` for the
   canonical copy and why — the pre-hardening version had a real
   privilege-escalation hole). If it isn't, run `supabase/migration_sso_auth.sql`
   once — this app's `resolve_profile_sso()` depends on the same fix
   (`is_eligible_staff_email()`, identity from the session), and since
   `resolve_profile()` itself is shared, bringing it up to date here also
   fixes it for license-manager if their deploy hasn't picked it up yet.
3. **SQL Editor > New query**, paste `supabase/schema_helpdesk.sql`, run it.
   Re-running `supabase/schema.sql` itself is also safe now (policies are
   dropped and recreated), but there's no need to if step 2 already applied
   the same fix via `migration_sso_auth.sql`.
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
   auth kernel — profiles, linked accounts, RLS, with the eligible-staff-email
   check already enabled in this copy), run it — **once, for both apps**
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

### 1a. Bring `resolve_profile()` up to the hardened version (only if it isn't already)

There used to be a copy-pasteable SQL snippet here. Don't use an old copy of
it (from git history, a chat log, etc.) — it had two problems, found
2026-09-25 in a license-manager security review and fixed there first:

- It trusted the caller-supplied `p_supabase_user_id`/`p_email` parameters
  instead of deriving identity from the session, so any signed-in user could
  link their own account to any existing profile (an admin's included) just
  by naming its email and user id in the RPC call.
- It hardcoded `@sil.org`, missing the handful of other SIL-affiliated
  domains `is_eligible_staff_email()` now covers.

Run `supabase/migration_sso_auth.sql` instead — it's safe to run any time
(`create or replace` / drop-and-recreate throughout) and brings
`resolve_profile()`, `is_eligible_staff_email()`, and the
`profiles_block_self_escalation` trigger up to the same hardened state as
`license-manager`'s `supabase/schema.sql`, in addition to adding this app's
own `resolve_profile_sso()`.

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

## 2. Set up SAML SSO, restricted to SIL staff

This app signs in via the in-house SAML identity provider (the same one
`global-finance-payreq` uses) instead of Google OAuth. The app code side of
this (`src/lib/auth.js` calling `supabase.auth.signInWithSSO()`, and the
helpdesk-only `helpdesk.resolve_profile_sso()` RPC) is already done — this
section is the external setup needed to make it work.

`helpdesk.resolve_profile_sso()` enforces `is_eligible_staff_email()` as the
database-level backstop behind whatever the IdP itself restricts, and
refuses to run for any session that isn't a real SSO sign-in
(`auth.users.is_sso_user`), so a stale Google or password session from
elsewhere on this shared project can never create or link a helpdesk
profile.

### 2a. A blocker that's now fixed in `migration_sso_auth.sql` — read this anyway

`license-manager` already has its own `signInWithSSO()` wired up
(`src/lib/auth.js`), pointed at the same shared project this app uses — but
its sign-in button was deliberately **disabled** from 2026-09-21 to
2026-11-23, with this comment:

> Hidden for now (Kate, 2026-09-21) while the shared-project auth trigger
> gap (`handle_new_auth_user()` bypassing `is_eligible_staff_email()`) is
> unresolved — `signInWithSSO()` and its wiring are untouched, so
> re-enabling is just flipping this back to true.

**Found 2026-11-23, confirmed from the live function body:** that trigger
(`on_auth_user_created` → `handle_new_auth_user()`, undocumented, not in
either app's migrations) had no eligibility check *at all* — not an
incomplete one — and because it fires on `auth.users` INSERT before either
app's client code calls `resolve_profile()`/`resolve_profile_sso()`, it won
the race every time: `linked_accounts` already had a row by the time those
RPCs ran, so their eligibility checks never actually applied to a new
sign-in. `migration_sso_auth.sql` part 1 drops it (Kate's call, as its
owner, over fixing it in place) — `resolve_profile()`/`resolve_profile_sso()`
already do the same matching correctly and are both already called right
after sign-in on this project, so one source of truth replaces two. Make
sure `migration_sso_auth.sql` has been run — on this project — before
re-enabling SSO sign-in anywhere, including license-manager's button.

### 2b. Supabase SSO add-on
SAML SSO is a paid Team/Enterprise feature, not available on Supabase's free
tier. Confirm it's enabled for this project (**Project Settings > Add-ons**).

### 2c. Register the IdP — check for an existing registration first
`license-manager`'s `.env.example` already has a `VITE_SSO_PROVIDER_ID`
entry, and its code comment (as of when it was written) describes "the same
shared Supabase project's SAML provider Finance already signs in through" —
but `global-finance-payreq` is confirmed to be on its **own**, separate
Supabase project now (not this one), so that comment is stale. Before
registering anything:
1. Check license-manager's actual **deployed** environment (Amplify, not
   just its local `.env.example`) for an existing `VITE_SSO_PROVIDER_ID` —
   if one's there, that's this project's own registration (from
   license-manager's earlier, currently-disabled SSO work), not Finance's.
   Reuse it rather than registering a duplicate.
2. If none exists: **Authentication > Sign In / Up > SSO with SAML 2.0**
   (dashboard), or via the CLI:
   `npx supabase sso add --project-ref <ref> --metadata-file idp.xml`, using
   metadata from whoever administers the in-house IdP (the same
   organization-wide IdP `global-finance-payreq` and `license-manager` both
   use, even though on different Supabase-side registrations).
3. Copy the provider UUID into `VITE_SSO_PROVIDER_ID` (`.env`).
4. **Authentication > URL Configuration** → add
   `https://YOUR_DOMAIN/auth/callback` and
   `http://localhost:5173/auth/callback` to Redirect URLs (same step as the
   old Google setup used).

### 2d. Database — add the SSO-only RPC
If `schema_helpdesk.sql` hasn't been (re-)run since this RPC was added, run
`supabase/migration_sso_auth.sql` once in the SQL Editor (safe to run
again). Fresh setups following step 1 above already get it from
`schema_helpdesk.sql` and `schema.sql`.

### 2e. Cutover — existing staff who signed in with Google
Supabase won't let a SAML identity coexist with an existing identity for the
same email (confirmed in `global-finance-payreq`'s own pilot migration,
`scripts/sso-migration/README.md`, on its prior shared project — same
underlying Supabase behavior). For every staff member who already has a
Google-linked account on this shared project:
1. **Authentication > Users** → delete their Google identity.
2. Delete the matching stale row in `public.linked_accounts`
   (`supabase_user_id` = that deleted `auth.users.id`) — otherwise their
   first SSO sign-in can fail with "Database error saving new user", because
   of `handle_new_auth_user()` (see 2a) matching by email but excluding any
   profile with an existing `linked_accounts` row, including a stale one.

**Pilot this with 1-2 test accounts first**, not a full-staff cutover —
confirm `profile_id` stays the same before and after for a piloted account
before doing the rest. Rollback is simple while piloting: leave the Google
provider enabled (`license-manager` needs it anyway) and signing in with
Google again just re-creates the identity and reattaches by email.

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

**This section describes the sil-app-template's generic S3/CloudFront
deploy — this app's actual frontend currently runs on AWS Amplify instead**
(see "New-ticket alerts" below, `HELPDESK_APP_URL`). `.github/workflows/deploy.yml`
only deploys edge functions; there's no frontend-deploy GitHub Action in
this repo. Any `VITE_*` env var (including `VITE_SSO_PROVIDER_ID`) needs to
be set in the **Amplify Console's environment variables** for this to take
effect in production, not as a GitHub secret — GitHub secrets only reach
`SUPABASE_ACCESS_TOKEN`/`SUPABASE_PROJECT_REF` (used by the edge-functions
job) today. If this app moves to the S3/CloudFront pipeline described
below, the GitHub secrets table becomes accurate and this note can go.

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
4. **Check plan and limits** before sending real traffic through it. From
   Resend's quotas page: every *received* email counts as one email against
   the account's daily and monthly quota, the same as a sent one (so does each
   To/Cc/Bcc recipient of a sent email); the free plan allows 100 emails a day
   and 3,000 a month, paid plans have no daily limit but a monthly quota by
   tier; the API allows 10 requests a second per team, shared by every API key
   (this function makes one request per email, plus one per attachment); and
   Resend keeps email data for **30 days**. The quota and rate limit are per
   Resend *team*, so any other project on the same team shares them. Still
   unchecked: the maximum size of a received message. Check the **Usage page**
   for current volume before connecting `helpdesk@sil.org`.

### 9b. Supabase secrets and deploy

```bash
supabase secrets set HELPDESK_RESEND_API_KEY=re_... HELPDESK_RESEND_WEBHOOK_SECRET=whsec_...
# optional: lets you re-process one stored email by hand (see 9d); leave unset to disable
supabase secrets set HELPDESK_REPROCESS_SECRET="$(openssl rand -hex 32)"
```

`HELPDESK_`-prefixed (not just `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`)
because this project's secrets are shared with `license-manager` in one flat
namespace — if that project already has a secret of some other name, setting
an unprefixed name here would silently overwrite it.

(Or Dashboard > Edge Functions > Secrets.) Deploy with
`supabase functions deploy helpdesk-inbound --no-verify-jwt`; the GitHub
Action does this on push to `main`. The function checks Resend's signature
itself and refuses to run without `HELPDESK_RESEND_WEBHOOK_SECRET`, which is what stops
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
  `outcome = 'unrouted'` (and stays in Resend for 30 days; after that it can't
  be re-processed). After adding the missing address to `desk_addresses`,
  re-process it with the `email_id`
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

---

## New-ticket alerts

`helpdesk-inbound` emails every agent and admin on a desk whenever a brand-new
ticket is created on it (replies to existing tickets don't trigger it). Each
person gets their own message. It needs `HELPDESK_RESEND_SENDING_API_KEY` and
`HELPDESK_APP_URL` (also used by `notify-agent-added`); the frontend is
currently on Amplify, so:

```bash
supabase secrets set HELPDESK_APP_URL=https://main.d3lqctg50qa0pq.amplifyapp.com
```

Update that secret when a real domain replaces the Amplify URL.

Optionally, `HELPDESK_NEW_TICKET_NOTIFY=a@sil.org,b@sil.org` adds extra
recipients on every desk (e.g. someone who isn't an agent). Leave it unset
otherwise.

## Per-desk knowledge bases

Each desk has its own knowledge-base Google Doc (spec decisions 14 and 19-21).

1. **Database.** On a project that already has `schema_helpdesk.sql`, run the
   whole of `supabase/migration_kb_learning_loop.sql` in the SQL editor. It is a
   complete script (not a diff) and safe to run again. Fresh setups skip it:
   `schema_helpdesk.sql` already includes everything in it.
2. **Doc access.** Share each desk's Doc with the help desk service account
   (`HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL`). View access is enough for now; the
   nightly suggestions will need comment access.
3. **Link the Doc to the desk.** A super admin pastes the Doc link under
   Admin > the desk > Knowledge base. Desk admins cannot do this: the service
   account can read any Doc it has been given, so the Doc ID decides whose KB a
   desk reads.
4. **Refresh.** Deploy `refresh-kb-cache` and `generate-draft`. The daily
   refresh reads every desk's Doc (one Doc failing does not stop the others);
   to refresh one desk now, POST `{"desk_id": "<uuid>"}` with the
   `x-helpdesk-secret` header. A desk with no Doc of its own keeps using the
   old merged Doc until it has one.
   To skip Docs that have not changed it first asks Google when each Doc was last
   modified (a tiny call). That needs the Google Drive API enabled in the service
   account's Google Cloud project; if it is not, nothing breaks and every Doc is
   simply read each night. Add `"force": true` to the POST body to read a Doc
   regardless.
5. **Sharing.** Each desk admin chooses whether to share their KB and which
   other desks' KBs to use. Put `[no-quote]` in a heading to keep that section
   (and everything under it) out of other desks' drafts. It does not hide
   anything from people, so share each Doc as view-only to all of SIL.

Test the Doc parsing with `npm run test:kb` and the draft assembly with
`npm run test:draft`.

### Help-center articles from a Drive folder (spec decision 23)

Requesters read articles in the app. Each desk's articles live in one Drive
folder; the sync copies every Google Doc in it into the database.

1. **Database.** On an existing project run, in this order, the whole of
   `supabase/migration_kb_articles.sql`, `supabase/migration_kb_images.sql` and
   `supabase/migration_kb_sync_schedule.sql`. Each is complete and safe to run
   again. Fresh setups skip them (`schema_helpdesk.sql` includes all three).
2. **Folder layout.** Inside the desk's folder, the first folder sets who can
   read a Doc: `public/` (anyone, even signed out), `internal/` (signed-in
   people) and `agents/` (the desk's agents). The next folder down is the
   article's topic. A folder named `Archive` archives what is in it; a folder
   named `Drafts` is ignored; a Doc that starts with a line saying DRAFT, or
   whose title starts "Draft:", stays out of the help center. **A Doc anywhere
   else is not published** (the sync report lists it), so a misplaced Doc can
   never become public by accident.
3. **Folder access.** Share the folder with the service account
   (`HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL`), view access. The Drive API must be
   enabled in its Google Cloud project. The sync only reads Drive.
4. **Link the folder to the desk.** Only a super admin can, in the SQL editor.
   Look the desk up by its slug (`ghd` for the pilot desk), so you never need its
   UUID, and paste the folder ID, which is the last part of the folder's Drive URL
   after `/folders/`:

   ```sql
   update helpdesk.desk_settings
   set kb_folder_id = '<folder id>'
   where desk_id = (select id from helpdesk.desks where slug = 'ghd')
   returning desk_id, kb_folder_id;
   ```

   `returning` shows the row it changed. If no row comes back, the desk has no
   settings row yet: run the insert below, then the update again.

   ```sql
   insert into helpdesk.desk_settings (desk_id)
   select id from helpdesk.desks where slug = 'ghd'
   on conflict do nothing;
   ```

   The same folder cannot be given to two desks. Optional: add
   `kb_internal_audience = 'ticket_requesters'` to the `set` list to limit
   `internal/` articles to people who have a ticket on that desk. To see the
   slug and UUID of every desk: `select id, slug, name from helpdesk.desks;`.
5. **Deploy and run.** `supabase functions deploy sync-kb-articles --no-verify-jwt`.
   It uses the same `HELPDESK_KB_REFRESH_SECRET` and Vault secret
   (`helpdesk_kb_refresh_secret`) as `refresh-kb-cache`, and runs hourly. Run it
   now by hand (use your own project ref and the secret value):

   ```bash
   curl -X POST https://YOUR_PROJECT_REF.supabase.co/functions/v1/sync-kb-articles \
     -H "x-helpdesk-secret: $HELPDESK_KB_REFRESH_SECRET" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

   With `{}` it covers every desk that has a folder linked. To limit it to one
   desk add `"desk_id": "<uuid>"` (the UUID, not the slug), and add
   `"force": true` to re-read every Doc even if it looks unchanged.
   The reply lists, per desk, what was synced, unchanged, removed and skipped
   (`skipped` names each Doc that is not inside a `public`, `internal` or
   `agents` folder), plus any errors. A Doc is only read again when Drive says it
   changed, and an article is only removed after a complete walk of the folder.
   The reply also shows `docs_found` (Google Docs seen) and `ignored` (files it
   skipped because they are not Google Docs: uploaded Word files, PDFs, Sheets and
   shortcuts, with their type). If an article does not appear: check it sits
   inside one of the three audience folders, is a real Google Doc (not a shortcut
   or uploaded file) and is not marked DRAFT. An error saying the folder is
   "empty or not visible to the service account" means it is not shared with the
   service account (for a Shared Drive, share the folder or add the account to the
   drive); Drive reports an unshared folder as simply empty. In that case, and when
   every Doc seems to vanish at once, nothing is removed.

Test it with `npm run test:kbsync` (it runs the whole sync against a fake Drive
and database).

### Prompt caching for drafts (optional setting)

Every draft sends the desk's whole knowledge base to Claude. Anthropic can keep
that text cached so a repeat costs a tenth of the normal price. Set
`HELPDESK_PROMPT_CACHE` as an edge-function secret:

- `5m` (the default): cached for 5 minutes after each use. Best when a desk gets
  several drafts close together; if drafts are sparse, each one pays a 25%
  surcharge on the KB text for a cache nobody reuses.
- `1h`: cached for an hour. Costs double to write, so it only pays if the same
  desk gets about three or more drafts an hour.
- `off`: no caching.

Each draft logs its usage (`generate-draft usage` in the function logs, with
`cache_read` and `cache_write` token counts). If `cache_read` is mostly 0 after
the first draft for a desk, caching is not saving anything; try `1h`, or `off`.
