import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getServiceAccountToken } from '../_shared/googleAuth.ts'

// A throwaway check that the help desk service account can comment on a
// knowledge-base Doc, and what Google does with those comments (spec decision
// 19: proposals are delivered as Doc comments). Not part of the product; delete
// it once the nightly job's comment delivery is built.
//
// Protected by the same secret as refresh-kb-cache (x-helpdesk-secret). It only
// touches Docs the app already knows (a desk's kb_doc_id, or the legacy merged
// Doc), never an arbitrary Doc ID. POST a JSON body:
//   {"action": "post",   "desk_id": "<uuid>"?, "content": "..."?}   post two test comments
//   {"action": "list",   "desk_id": "<uuid>"?}                      list comments with replies/resolved
//   {"action": "delete", "desk_id": "<uuid>"?, "comment_id": "..."} remove a test comment
// Leave desk_id out to use the legacy merged Doc.
//
// The two test comments show the choice we have: a plain comment that quotes
// the entry in its text, and a comment that also sets quotedFileContent (Google
// shows it as the quoted passage). Neither can be anchored to the exact text by
// the API as far as we know; this is how to see what actually happens.

const LEGACY_DOC_ID = '1T3S2Cohx3gmXBVKBtQSXVCKQAJqn5R1JGaxzbHu1_ww'
const DRIVE = 'https://www.googleapis.com/drive/v3'
// The token's power is bounded by the Doc's own sharing: the service account is
// only a commenter, so it cannot edit or delete anything else whatever the scope.
const SCOPE = 'https://www.googleapis.com/auth/drive'

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  const secret = Deno.env.get('HELPDESK_KB_REFRESH_SECRET')
  if (!secret || req.headers.get('x-helpdesk-secret') !== secret) return json({ error: 'unauthorized' }, 401)

  try {
    const email = Deno.env.get('HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL')
    const key = Deno.env.get('HELPDESK_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')
    if (!email || !key) return json({ error: 'HELPDESK_GOOGLE_SERVICE_ACCOUNT_EMAIL / _PRIVATE_KEY not configured' }, 500)

    const body: { action?: string; desk_id?: string; content?: string; comment_id?: string } = await req.json().catch(() => ({}))
    let docId = LEGACY_DOC_ID
    if (body.desk_id) {
      const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
        db: { schema: 'helpdesk' },
        auth: { persistSession: false },
      })
      const { data } = await db.from('desk_settings').select('kb_doc_id').eq('desk_id', body.desk_id).maybeSingle()
      if (!data?.kb_doc_id) return json({ error: 'that desk has no knowledge base Doc set' }, 404)
      docId = data.kb_doc_id
    }

    const token = await getServiceAccountToken(email, key, SCOPE)
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const action = body.action ?? 'post'

    if (action === 'post') {
      const base = body.content || 'Test comment from the help desk service account. Safe to delete.'
      const out = []
      for (const [label, payload] of [
        ['plain', { content: `[test 1 of 2: plain] ${base}` }],
        ['with_quote', {
          content: `[test 2 of 2: with quotedFileContent] ${base}`,
          quotedFileContent: { mimeType: 'text/plain', value: 'Part 1: Staff Help' },
        }],
      ] as const) {
        const res = await fetch(`${DRIVE}/files/${docId}/comments?fields=id,content,anchor,quotedFileContent,createdTime,author(displayName)&supportsAllDrives=true`, {
          method: 'POST', headers, body: JSON.stringify(payload),
        })
        out.push({ label, status: res.status, result: await res.json().catch(() => null) })
      }
      return json({ doc_id: docId, posted: out })
    }

    if (action === 'list') {
      const res = await fetch(`${DRIVE}/files/${docId}/comments?fields=comments(id,content,resolved,anchor,quotedFileContent,createdTime,author(displayName),replies(id,content,author(displayName))),nextPageToken&includeDeleted=false&pageSize=100`, { headers })
      return json({ doc_id: docId, status: res.status, result: await res.json().catch(() => null) })
    }

    if (action === 'delete') {
      if (!body.comment_id) return json({ error: 'comment_id required' }, 400)
      const res = await fetch(`${DRIVE}/files/${docId}/comments/${encodeURIComponent(body.comment_id)}`, { method: 'DELETE', headers })
      return json({ doc_id: docId, status: res.status, deleted: res.status === 204, detail: res.status === 204 ? null : await res.text() })
    }

    return json({ error: `unknown action ${action}` }, 400)
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } })
}
