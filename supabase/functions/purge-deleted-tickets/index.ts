import { createClient } from 'jsr:@supabase/supabase-js@2'

// Hard-deletes tickets that have been soft-deleted (status = 'deleted') past
// their retention window (spec decision 17: default 30 days, desk_settings
// can override). Run daily by pg_cron. A ticket's own row delete cascades to
// its messages/attachments/events/participants/links (all ON DELETE CASCADE),
// but the actual files in Storage need their own delete — hence an edge
// function rather than a plain SQL job.
//
// Deployed --no-verify-jwt (like refresh-kb-cache / notify-agent-added): the
// cron job calls it with a dedicated secret, not the service role key, since
// a cron job's definition is visible to other admins on this shared project.

const ATTACHMENT_BUCKET = 'helpdesk-attachments'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  const purgeSecret = Deno.env.get('HELPDESK_PURGE_SECRET')
  if (!purgeSecret || req.headers.get('x-helpdesk-secret') !== purgeSecret) {
    return json({ error: 'unauthorized' }, 401)
  }

  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    const { data: globalSettings, error: gErr } = await db.from('global_settings')
      .select('deleted_retention_days').eq('id', true).single()
    if (gErr) throw gErr

    const { data: tickets, error: tErr } = await db.from('tickets')
      .select('id, ticket_number, deleted_at, current_desk_id')
      .eq('status', 'deleted')
      .not('deleted_at', 'is', null)
    if (tErr) throw tErr

    const deskIds = [...new Set((tickets ?? []).map((t) => t.current_desk_id))]
    const { data: deskSettings, error: dsErr } = await db.from('desk_settings')
      .select('desk_id, deleted_retention_days').in('desk_id', deskIds.length ? deskIds : ['00000000-0000-0000-0000-000000000000'])
    if (dsErr) throw dsErr
    const retentionByDesk = new Map((deskSettings ?? []).map((d) => [d.desk_id, d.deleted_retention_days]))

    const now = Date.now()
    const expired = (tickets ?? []).filter((t) => {
      const days = retentionByDesk.get(t.current_desk_id) ?? globalSettings.deleted_retention_days
      return now - new Date(t.deleted_at).getTime() > days * 24 * 60 * 60 * 1000
    })

    let purgedCount = 0
    let attachmentErrors = 0
    for (const t of expired) {
      const { data: attachments } = await db.from('ticket_attachments')
        .select('storage_path').eq('ticket_id', t.id).not('storage_path', 'is', null)
      const paths = (attachments ?? []).map((a) => a.storage_path).filter(Boolean)
      if (paths.length) {
        const { error: removeErr } = await db.storage.from(ATTACHMENT_BUCKET).remove(paths)
        if (removeErr) { attachmentErrors++; console.error(`purge: failed removing attachments for ticket ${t.ticket_number}:`, removeErr.message) }
      }
      const { error: deleteErr } = await db.from('tickets').delete().eq('id', t.id)
      if (deleteErr) { console.error(`purge: failed deleting ticket ${t.ticket_number}:`, deleteErr.message); continue }
      purgedCount++
    }

    return json({ purged: purgedCount, attachment_errors: attachmentErrors, checked: (tickets ?? []).length })
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
