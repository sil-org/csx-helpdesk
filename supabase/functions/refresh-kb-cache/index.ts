import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getServiceAccountToken } from './googleAuth.ts'
import { docToPlainText, docToKbText } from './docParse.ts'
import type { GoogleDoc } from './docParse.ts'

// Refreshes the cached text of the knowledge-base Google Docs. Run daily by
// pg_cron, or on demand by a super admin. Reads each real Doc live — no
// condensed/lossy local copy, unlike the old Claude-Desktop-connector-based
// design this replaces, which had to compress the doc to work around that
// connector's per-call size limit; the Docs API has no such limit.
//
// Two kinds of Doc (spec decisions 14, 19):
//  - each desk's own KB (desk_settings.kb_doc_id) -> helpdesk.desk_kb_cache,
//    with a second copy minus [no-quote] sections for other desks to use;
//  - the legacy merged "SIL Global Helpdesk Knowledge Base" -> helpdesk.kb_cache,
//    still used by desks that have no kb_doc_id of their own yet.
// Doc IDs for desks come from the database (only a super admin can set them),
// never from the request, so a caller cannot point a desk at an arbitrary Doc.

const DEFAULT_DOC_ID = '1T3S2Cohx3gmXBVKBtQSXVCKQAJqn5R1JGaxzbHu1_ww' // legacy merged "SIL Global Helpdesk Knowledge Base"

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  // Deployed with --no-verify-jwt (like helpdesk-inbound) so the daily
  // pg_cron job can call it with a narrow, dedicated secret rather than the
  // service role key — a cron job's definition is visible to other admins
  // on this shared Supabase project, so it should never hold that key.
  const refreshSecret = Deno.env.get('HELPDESK_KB_REFRESH_SECRET')
  if (!refreshSecret || req.headers.get('x-helpdesk-secret') !== refreshSecret) {
    return json({ error: 'unauthorized' }, 401)
  }

  try {
    const email = Deno.env.get('HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL')
    const key = Deno.env.get('HELPDESK_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
    if (!email || !key) return json({ error: 'HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY not configured' }, 500)

    // {desk_id}: refresh just that desk. {doc_id}: override the legacy Doc.
    // No body (the cron job): the legacy Doc and every desk that has one.
    let body: { desk_id?: string; doc_id?: string } = {}
    if (req.method === 'POST') body = await req.json().catch(() => ({}))

    const token = await getServiceAccountToken(email, key, 'https://www.googleapis.com/auth/documents.readonly')
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    const refreshed: { desk_id: string | null; chars: number }[] = []
    const errors: { desk_id: string | null; error: string }[] = []

    // One Doc failing (usually: not yet shared with the service account)
    // must not stop the others from refreshing.
    async function attempt(deskId: string | null, work: () => Promise<number>) {
      try {
        refreshed.push({ desk_id: deskId, chars: await work() })
      } catch (err) {
        errors.push({ desk_id: deskId, error: err.message })
      }
    }

    if (!body.desk_id) {
      const docId = body.doc_id || DEFAULT_DOC_ID
      await attempt(null, async () => {
        const doc = await fetchDoc(token, docId, email)
        const content = docToPlainText(doc)
        const { error } = await db.from('kb_cache').update({
          content,
          source_doc_id: docId,
          refreshed_at: new Date().toISOString(),
        }).eq('id', true)
        if (error) throw error
        return content.length
      })
    }

    let q = db.from('desk_settings').select('desk_id, kb_doc_id').not('kb_doc_id', 'is', null)
    if (body.desk_id) q = q.eq('desk_id', body.desk_id)
    const { data: desks, error: dErr } = await q
    if (dErr) throw dErr
    if (body.desk_id && !desks?.length) return json({ error: 'that desk has no knowledge base Doc set' }, 404)

    for (const d of desks ?? []) {
      await attempt(d.desk_id, async () => {
        const { full, shareable } = docToKbText(await fetchDoc(token, d.kb_doc_id, email))
        const { error } = await db.from('desk_kb_cache').upsert({
          desk_id: d.desk_id,
          content: full,
          shareable_content: shareable,
          source_doc_id: d.kb_doc_id,
          refreshed_at: new Date().toISOString(),
        })
        if (error) throw error
        return full.length
      })
    }

    return json({ refreshed, errors }, errors.length ? 500 : 200)
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

async function fetchDoc(token: string, docId: string, serviceAccountEmail: string): Promise<GoogleDoc> {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(
      `Docs API ${res.status} for ${docId}: ${detail}. Confirm the Doc is shared (view or comment access) with ${serviceAccountEmail}.`
    )
  }
  return await res.json()
}

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
