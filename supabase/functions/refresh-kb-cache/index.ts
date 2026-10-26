import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getServiceAccountToken } from './googleAuth.ts'
import { docToPlainText } from './docParse.ts'
import type { GoogleDoc } from './docParse.ts'

// Refreshes helpdesk.kb_cache with the full text of the knowledge-base
// Google Doc (decision 19: the Doc is the single source of truth; v1 reads
// it in full, no embeddings). Run daily by pg_cron, or on demand by a
// super admin. Reads the real Doc live each time — no condensed/lossy
// local copy, unlike the old Claude-Desktop-connector-based design this
// replaces, which had to compress the doc to work around that connector's
// per-call size limit; the Docs API has no such limit.

const DEFAULT_DOC_ID = '1T3S2Cohx3gmXBVKBtQSXVCKQAJqn5R1JGaxzbHu1_ww' // merged "SIL Global Helpdesk Knowledge Base"

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

    let docId = DEFAULT_DOC_ID
    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      if (body.doc_id) docId = body.doc_id
    }

    const token = await getServiceAccountToken(email, key, 'https://www.googleapis.com/auth/documents.readonly')
    const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!docRes.ok) {
      const detail = await docRes.text()
      throw new Error(
        `Docs API ${docRes.status}: ${detail}. Confirm the Doc is shared (view access) with ${email}.`
      )
    }
    const doc: GoogleDoc = await docRes.json()
    const content = docToPlainText(doc)

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })
    const { error } = await db.from('kb_cache').update({
      content,
      source_doc_id: docId,
      refreshed_at: new Date().toISOString(),
    }).eq('id', true)
    if (error) throw error

    return json({ refreshed: true, chars: content.length })
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
