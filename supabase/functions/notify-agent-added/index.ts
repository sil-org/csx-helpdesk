import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildNotifyEmail } from './message.ts'

// Sends a "you've been added" email with a sign-in link when someone is
// newly granted access to a desk. Fired by helpdesk.agent_desks' AFTER
// INSERT trigger (see schema_helpdesk.sql) via pg_net — only a genuinely
// new grant inserts a row; set_desk_role's ON CONFLICT DO UPDATE path for a
// role change on an existing row fires no INSERT trigger, so promoting or
// demoting someone already on the desk never re-sends this.
//
// Deployed --no-verify-jwt (like refresh-kb-cache): the trigger calls it
// with a dedicated secret rather than the service role key, since a trigger
// definition is visible to other admins on this shared Supabase project.

const RESEND_FROM = Deno.env.get('HELPDESK_RESEND_FROM') || 'helpdesk@em.sil.org'

interface NotifyRequest {
  profile_id: string
  desk_id: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  const notifySecret = Deno.env.get('HELPDESK_NOTIFY_SECRET')
  if (!notifySecret || req.headers.get('x-helpdesk-secret') !== notifySecret) {
    return json({ error: 'unauthorized' }, 401)
  }

  try {
    const sendKey = Deno.env.get('HELPDESK_RESEND_SENDING_API_KEY')
    if (!sendKey) return json({ error: 'HELPDESK_RESEND_SENDING_API_KEY is not configured' }, 500)
    const appUrl = Deno.env.get('HELPDESK_APP_URL')
    if (!appUrl) return json({ error: 'HELPDESK_APP_URL is not configured' }, 500)

    const { profile_id, desk_id }: NotifyRequest = await req.json()
    if (!profile_id || !desk_id) return json({ error: 'Missing required fields: profile_id, desk_id' }, 400)

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    })
    const hd = db.schema('helpdesk')

    const { data: profile, error: profileErr } = await db.from('profiles')
      .select('primary_email, display_name').eq('id', profile_id).maybeSingle()
    if (profileErr) throw profileErr
    if (!profile) return json({ skipped: 'profile not found' })

    const { data: desk, error: deskErr } = await hd.from('desks').select('name, slug').eq('id', desk_id).maybeSingle()
    if (deskErr) throw deskErr
    if (!desk) return json({ skipped: 'desk not found' })

    const link = `${appUrl.replace(/\/$/, '')}/d/${desk.slug}`
    const { subject, text } = buildNotifyEmail({ displayName: profile.display_name, deskName: desk.name, link })

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to: profile.primary_email, subject, text }),
    })
    if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`)

    return json({ sent: true })
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
