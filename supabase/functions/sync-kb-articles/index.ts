import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getServiceAccountToken } from '../_shared/googleAuth.ts'
import { syncDesk } from './sync.ts'

// Syncs each desk's knowledge-base Drive folder into helpdesk.kb_articles
// (spec decision 23). Run hourly by pg_cron, or on demand. For every desk with
// a kb_folder_id it walks the folder tree, exports each Google Doc as markdown,
// and stores one article per Doc:
//   - the first folder under the desk's folder is the audience (public, internal
//     or agents); a Doc anywhere else is NOT published and is reported;
//   - the next folder down is the topic; an Archive folder archives the Doc;
//     a folder called Drafts is skipped; a Doc that says it is a draft is kept
//     out of the help center;
//   - images are taken out of the text into the private helpdesk-kb bucket;
//   - [no-quote] sections are kept in the full text and left out of the
//     shareable text (spec decisions 21 and 22).
// A Doc is only read again when Drive says it changed (or its folder changed),
// so a quiet hour costs one small listing per folder. The Docs are only ever
// read: this function never writes to Drive.
//
// Folder IDs come from the database (only a super admin can set them), never
// from the request, so a caller cannot point a desk at an arbitrary folder.
// An article is only removed after a complete walk of its desk's folder, so a
// Drive hiccup cannot unpublish everything. The logic lives in sync.ts.

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  // Deployed with --no-verify-jwt so the pg_cron job can call it with a narrow
  // secret (the same one refresh-kb-cache uses), not the service role key.
  const secret = Deno.env.get('HELPDESK_KB_REFRESH_SECRET')
  if (!secret || req.headers.get('x-helpdesk-secret') !== secret) return json({ error: 'unauthorized' }, 401)

  try {
    const email = Deno.env.get('HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL')
    const key = Deno.env.get('HELPDESK_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
    if (!email || !key) return json({ error: 'HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY not configured' }, 500)

    // {desk_id}: just that desk. {force}: re-read every Doc.
    let body: { desk_id?: string; force?: boolean } = {}
    if (req.method === 'POST') body = await req.json().catch(() => ({}))

    const token = await getServiceAccountToken(email, key, 'https://www.googleapis.com/auth/drive.readonly')
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    let q = db.from('desk_settings').select('desk_id, kb_folder_id').not('kb_folder_id', 'is', null)
    if (body.desk_id) q = q.eq('desk_id', body.desk_id)
    const { data: desks, error: dErr } = await q
    if (dErr) throw dErr
    if (body.desk_id && !desks?.length) return json({ error: 'that desk has no knowledge base folder set' }, 404)

    const deps = { db, fetch, now: () => Date.now() }
    const started = deps.now()
    const results = []
    for (const d of desks ?? []) {
      results.push(await syncDesk(deps, token, email, d.desk_id, d.kb_folder_id, !!body.force, started))
    }
    return json({ desks: results }, results.some((r) => r.errors.length > 0) ? 500 : 200)
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}
