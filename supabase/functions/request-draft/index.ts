import { createClient } from 'jsr:@supabase/supabase-js@2'

// Kicks off generate-draft for a ticket after a reporter comments in the app
// (the email path does this itself in helpdesk-inbound). generate-draft only
// accepts the service-role key, so the reporter's browser can't call it
// directly; this function checks the caller is allowed to see the ticket and
// that there is actually a new requester message to draft against, then
// calls it. The deploy workflow uses --no-verify-jwt, so authorization here is
// the RLS-scoped ticket lookup below (a bad or missing token finds nothing).
//
// The "new message" check bounds cost: one draft per inbound message, however
// many times this is called.

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const { ticket_id } = await req.json()
    if (!ticket_id) return json({ error: 'Missing required field: ticket_id' }, 400)

    // RLS decides whether the caller can see this ticket at all.
    const asCaller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      db: { schema: 'helpdesk' },
      global: { headers: { Authorization: authHeader } },
    })
    const { data: visible, error: visErr } = await asCaller.from('tickets').select('id').eq('id', ticket_id).maybeSingle()
    if (visErr) throw visErr
    if (!visible) return json({ error: 'ticket not found' }, 404)

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })
    const { data: last } = await db.from('ticket_messages')
      .select('direction, created_at').eq('ticket_id', ticket_id).eq('internal', false)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!last || last.direction !== 'inbound') return json({ skipped: 'latest public message is not from the requester' })

    const { data: draft } = await db.from('ticket_drafts')
      .select('created_at').eq('ticket_id', ticket_id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (draft && draft.created_at > last.created_at) return json({ skipped: 'already drafted for the latest message' })

    const call = fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-draft`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id }),
    }).catch((err) => console.error('generate-draft trigger failed:', err.message))
    const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
    if (runtime) runtime.waitUntil(call)

    return json({ requested: true })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
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
