import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildSystemPrompt, buildUserMessage, SUBMIT_DRAFT_TOOL } from './prompt.ts'
import type { ThreadMessage } from './prompt.ts'
import { assembleKb } from './kb.ts'
import { senderTrust, weakestTrust } from '../_shared/senderTrust.ts'
import type { KbSource } from './kb.ts'

// Generates (or regenerates) one ticket's AI draft reply (spec section 11).
// Fired-and-forgotten by helpdesk-inbound via EdgeRuntime.waitUntil right
// after a ticket is created or gets a new non-internal requester reply, so a
// slow or down Claude API can never affect email-ingestion reliability —
// a failed call here just means no draft, not a broken ticket.
//
// Internal notes are never included in the thread sent to the model (spec:
// "cannot leak into a reply"). The knowledge base is read from the cached
// Docs (refreshed daily by refresh-kb-cache), not fetched live, since Doc reads
// are both slower and metered separately from this function's own cost budget:
// the desk's own KB in full, plus the shareable part (no [no-quote] sections) of any other
// desk's shared KB that this desk has chosen to use (spec decision 14).

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
      .select('direction, body, profile_id, author_email, raw_headers')
      .eq('ticket_id', ticket_id)
      .eq('internal', false)
      .order('created_at')
    if (mErr) throw mErr
    if (!msgs || msgs.length === 0) return json({ skipped: 'no public messages yet' })

    const { data: settings } = await db.from('desk_settings')
      .select('tone_notes, signature, kb_doc_id')
      .eq('desk_id', ticket.current_desk_id)
      .maybeSingle()

    // Decided by us from the email's authentication (spec decision 22), never
    // from what the email says. A message from the signed-in app (profile_id
    // set) is verified by sign-in; the thread is as trusted as its weakest sender.
    const trust = weakestTrust(msgs.filter((m) => m.direction === 'inbound').map((m) =>
      m.profile_id
        ? 'sil_verified' as const
        : senderTrust({ fromEmail: m.author_email, originalAuthResults: m.raw_headers?.original_authentication_results }),
    ))

    // Unless the sender is verified SIL, [no-quote] sections are not just
    // discouraged in the prompt, they are left out of what the model sees.
    const kbContent = await loadKb(db, ticket.current_desk_id, settings?.kb_doc_id ?? null, trust !== 'sil_verified')

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
      senderTrust: trust,
      toneNotes: settings?.tone_notes ?? null,
      signature: settings?.signature ?? null,
      kbContent,
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
      sender_trust: trust,
    })
    if (insertErr) throw insertErr

    return json({ drafted: true })
  } catch (err) {
    console.error('generate-draft failed:', err.message)
    return json({ error: err.message }, 500)
  }
})

async function loadKb(
  db: ReturnType<typeof createClient>, deskId: string, kbDocId: string | null, shareableOnly: boolean,
): Promise<string | null> {
  // A desk with no KB Doc of its own yet keeps using the legacy merged one.
  if (!kbDocId) {
    const { data } = await db.from('kb_cache').select('content').eq('id', true).maybeSingle()
    return data?.content ?? null
  }

  // A cache row from a previous Doc (source_doc_id differs) is ignored, so
  // changing a desk's Doc never serves the old Doc's text.
  const { data: own } = await db.from('desk_kb_cache').select('content, shareable_content, source_doc_id').eq('desk_id', deskId).maybeSingle()

  const { data: links } = await db.from('desk_kb_sources')
    .select('source_desk_id').eq('desk_id', deskId).order('precedence').order('created_at')
  const ids = (links ?? []).map((l) => l.source_desk_id)
  const sources: KbSource[] = []
  if (ids.length) {
    const [{ data: settings }, { data: caches }, { data: desks }] = await Promise.all([
      db.from('desk_settings').select('desk_id, kb_shared, kb_doc_id').in('desk_id', ids),
      db.from('desk_kb_cache').select('desk_id, shareable_content, source_doc_id').in('desk_id', ids),
      db.from('desks').select('id, name').in('id', ids),
    ])
    for (const id of ids) {
      const st = settings?.find((x) => x.desk_id === id)
      const cache = caches?.find((x) => x.desk_id === id)
      // Only a desk that is still sharing counts, and only the part of its
      // Doc that is safe for another desk's requesters to see.
      if (!st?.kb_shared || !st.kb_doc_id || cache?.source_doc_id !== st.kb_doc_id || !cache.shareable_content) continue
      sources.push({ deskName: desks?.find((x) => x.id === id)?.name ?? 'another', content: cache.shareable_content })
    }
  }

  return assembleKb({ own: own?.source_doc_id === kbDocId ? (shareableOnly ? own.shareable_content : own.content) : null, sources })
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
