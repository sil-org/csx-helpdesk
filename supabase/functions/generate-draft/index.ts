import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildSystemPrompt, buildUserMessage, SUBMIT_DRAFT_TOOL } from './prompt.ts'
import type { ThreadMessage } from './prompt.ts'

// Generates (or regenerates) one ticket's AI draft reply (spec section 11).
// Fired-and-forgotten by helpdesk-inbound via EdgeRuntime.waitUntil right
// after a ticket is created or gets a new non-internal requester reply, so a
// slow or down Claude API can never affect email-ingestion reliability —
// a failed call here just means no draft, not a broken ticket.
//
// Internal notes are never included in the thread sent to the model (spec:
// "cannot leak into a reply"). The knowledge base is read from helpdesk.kb_cache
// (refreshed daily by refresh-kb-cache), not fetched live, since Doc reads are
// both slower and metered separately from this function's own cost budget.

const ANTHROPIC_MODEL = Deno.env.get('HELPDESK_DRAFT_MODEL') || 'claude-sonnet-5-5'
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

interface GenerateDraftRequest {
  ticket_id: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const apiKey = Deno.env.get('HELPDESK_ANTHROPIC_API_KEY')
    if (!apiKey) {
      console.error('generate-draft failed: HELPDESK_ANTHROPIC_API_KEY is not configured')
      return json({ error: 'HELPDESK_ANTHROPIC_API_KEY is not configured' }, 500)
    }

    const { ticket_id }: GenerateDraftRequest = await req.json()
    if (!ticket_id) return json({ error: 'Missing required field: ticket_id' }, 400)

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      db: { schema: 'helpdesk' },
      auth: { persistSession: false },
    })

    const { data: ticket, error: tErr } = await db.from('tickets')
      .select('id, subject, current_desk_id')
      .eq('id', ticket_id)
      .maybeSingle()
    if (tErr) throw tErr
    if (!ticket) return json({ error: 'ticket not found' }, 404)

    const { data: msgs, error: mErr } = await db.from('ticket_messages')
      .select('direction, body, profile_id')
      .eq('ticket_id', ticket_id)
      .eq('internal', false)
      .order('created_at')
    if (mErr) throw mErr
    if (!msgs || msgs.length === 0) return json({ skipped: 'no public messages yet' })

    const { data: settings } = await db.from('desk_settings')
      .select('tone_notes, signature')
      .eq('desk_id', ticket.current_desk_id)
      .maybeSingle()

    const { data: kb } = await db.from('kb_cache').select('content').eq('id', true).maybeSingle()

    const agentIds = [...new Set(msgs.filter((m) => m.direction === 'outbound' && m.profile_id).map((m) => m.profile_id))]
    const agentNames = new Map<string, string>()
    if (agentIds.length) {
      const pub = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
        auth: { persistSession: false },
      })
      const { data: profiles } = await pub.from('profiles').select('id, display_name').in('id', agentIds)
      for (const p of profiles ?? []) agentNames.set(p.id, p.display_name)
    }

    const threadMessages: ThreadMessage[] = msgs.map((m) => ({
      direction: m.direction,
      body: m.body,
      authorLabel: m.direction === 'inbound' ? 'the reporter' : (agentNames.get(m.profile_id) ?? 'an agent'),
    }))

    const system = buildSystemPrompt({
      toneNotes: settings?.tone_notes ?? null,
      signature: settings?.signature ?? null,
      kbContent: kb?.content ?? null,
    })
    const userMessage = buildUserMessage({ subject: ticket.subject, messages: threadMessages })

    const anthropicRes = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system,
        // This model rejects forced tool_choice (400), so ask for the tool in
        // the prompt and let the model call it under 'auto'.
        messages: [{ role: 'user', content: `${userMessage}\n\nRespond by calling the submit_draft tool. Do not write a reply as plain text.` }],
        tools: [SUBMIT_DRAFT_TOOL],
        tool_choice: { type: 'auto' },
      }),
    })
    if (!anthropicRes.ok) {
      const detail = await anthropicRes.text()
      throw new Error(`Claude API ${anthropicRes.status}: ${detail}`)
    }
    const anthropicData = await anthropicRes.json()
    const toolUse = anthropicData.content?.find((b: { type: string }) => b.type === 'tool_use')
    if (!toolUse) throw new Error('Claude response had no submit_draft tool call')
    const decision = toolUse.input as { needs_draft: boolean; reply?: string; skip_reason?: string; cited_kb_section?: string }

    // Either way, this ticket's state has moved on: any earlier active draft
    // is no longer current, whether we're replacing it or deciding none is needed.
    await db.from('ticket_drafts').update({ superseded_at: new Date().toISOString() })
      .eq('ticket_id', ticket_id).is('superseded_at', null)

    if (!decision.needs_draft || !decision.reply) {
      console.log('generate-draft skipped:', decision.skip_reason ?? 'model decided no draft was needed')
      return json({ skipped: decision.skip_reason ?? 'model decided no draft was needed' })
    }

    const { error: insertErr } = await db.from('ticket_drafts').insert({
      ticket_id,
      body: decision.reply,
      cited_sources: decision.cited_kb_section ? { kb_section: decision.cited_kb_section } : null,
      model: ANTHROPIC_MODEL,
    })
    if (insertErr) throw insertErr

    return json({ drafted: true })
  } catch (err) {
    console.error('generate-draft failed:', err.message)
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
