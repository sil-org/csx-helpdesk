import { createClient } from 'jsr:@supabase/supabase-js@2'

// Polls a single Gmail mailbox for messages carrying GMAIL_LABEL and turns
// each into a ticket/ticket_message. Pilot scope only — see SETUP.md step 9.
//
// Safety note: the OAuth grant behind GMAIL_REFRESH_TOKEN is for the WHOLE
// mailbox (info@btconference.org), not just the helpdesk-test@ alias — Gmail
// API scopes can't be narrowed further than that. The label is the actual
// isolation boundary: this function only ever looks at messages Gmail itself
// already sorted into GMAIL_LABEL via a filter, so it structurally can't see
// real BTC conference correspondence. Don't change the query below to scan
// the inbox more broadly.
//
// Deliberately NOT implemented yet (see brief Section 5 — do this later,
// as an agent-confirmed suggestion, not automatically):
//   - forwarded-message detection / requester-vs-sender correction
//   - duplicate/related-ticket suggestions
// This function only threads by Gmail thread ID and otherwise creates one
// ticket per new thread.

const GMAIL_LABEL = Deno.env.get('GMAIL_LABEL') || 'HelpdeskPilot'
const PILOT_DESK_SLUG = Deno.env.get('PILOT_DESK_SLUG') || 'pilot'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: desk, error: deskError } = await supabase
      .from('desks')
      .select('id')
      .eq('slug', PILOT_DESK_SLUG)
      .single()
    if (deskError || !desk) {
      return json({
        error: `Desk with slug "${PILOT_DESK_SLUG}" not found — run supabase/seed_pilot_desk.sql first`,
      }, 500)
    }

    const accessToken = await getGmailAccessToken()
    const labelId = await getLabelId(accessToken, GMAIL_LABEL)

    const list = await gmailFetch(accessToken, `/messages?q=${encodeURIComponent(`label:${GMAIL_LABEL}`)}&maxResults=25`)
    const refs = list.messages ?? []

    const results = []
    for (const ref of refs) {
      results.push({ id: ref.id, ...(await processMessage(supabase, accessToken, ref.id, desk.id, labelId)) })
    }

    return json({ processed: results.length, results })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

async function processMessage(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  messageId: string,
  deskId: string,
  labelId: string
) {
  // Idempotency: if we've already ingested this Gmail message, just clear
  // the label so it stops showing up in future polls, and stop.
  const { data: existing } = await supabase
    .from('ticket_messages')
    .select('id')
    .eq('raw_headers->>gmail_message_id', messageId)
    .maybeSingle()
  if (existing) {
    await removeLabel(accessToken, messageId, labelId)
    return { status: 'already_ingested' }
  }

  const message = await gmailFetch(accessToken, `/messages/${messageId}?format=full`)
  const headers: { name: string; value: string }[] = message.payload.headers
  const fromHeader = getHeader(headers, 'From')
  const toHeader = getHeader(headers, 'To')
  const subject = getHeader(headers, 'Subject')
  const dateHeader = getHeader(headers, 'Date')
  const { email: senderEmail, displayName } = parseFromHeader(fromHeader)
  const body = extractBody(message.payload) || '(no plain-text body found)'

  const requesterId = await findOrCreateRequester(supabase, senderEmail, displayName)

  let ticketId = await findTicketByThread(supabase, message.threadId)
  if (!ticketId) {
    const { data: ticket, error: ticketError } = await supabase
      .from('tickets')
      .insert({
        current_desk_id: deskId,
        subject,
        requester_id: requesterId,
        sender_email: senderEmail,
        last_requester_reply_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (ticketError) throw ticketError
    ticketId = ticket.id
  } else {
    await supabase
      .from('tickets')
      .update({ last_requester_reply_at: new Date().toISOString(), status: 'open' })
      .eq('id', ticketId)
  }

  const { error: msgError } = await supabase.from('ticket_messages').insert({
    ticket_id: ticketId,
    direction: 'inbound',
    author_email: senderEmail,
    body,
    raw_headers: {
      gmail_message_id: messageId,
      gmail_thread_id: message.threadId,
      subject,
      from: fromHeader,
      to: toHeader,
      date: dateHeader,
    },
  })
  if (msgError) throw msgError

  await removeLabel(accessToken, messageId, labelId)
  return { status: 'ingested', ticket_id: ticketId }
}

// ── Gmail API ────────────────────────────────────────────────────────────

async function getGmailAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GMAIL_CLIENT_ID')!,
      client_secret: Deno.env.get('GMAIL_CLIENT_SECRET')!,
      refresh_token: Deno.env.get('GMAIL_REFRESH_TOKEN')!,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Failed to refresh Gmail access token: ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

async function gmailFetch(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Gmail API error on ${path}: ${await res.text()}`)
  return res.json()
}

async function getLabelId(accessToken: string, labelName: string): Promise<string> {
  const { labels } = await gmailFetch(accessToken, '/labels')
  const label = labels.find((l: { name: string; id: string }) => l.name === labelName)
  if (!label) {
    throw new Error(`Gmail label "${labelName}" not found — create it (and the filter that applies it) first`)
  }
  return label.id
}

async function removeLabel(accessToken: string, messageId: string, labelId: string) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: [labelId] }),
  })
}

// ── Message parsing ──────────────────────────────────────────────────────

function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function parseFromHeader(from: string): { email: string; displayName: string } {
  const match = from.match(/^"?([^"<]*)"?\s*<(.+)>$/)
  if (match) {
    return { displayName: match[1].trim() || match[2].trim(), email: match[2].trim().toLowerCase() }
  }
  return { displayName: from.trim(), email: from.trim().toLowerCase() }
}

function findPart(payload: any, mimeType: string): any {
  if (payload.mimeType === mimeType && payload.body?.data) return payload
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findPart(part, mimeType)
      if (found) return found
    }
  }
  return null
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
}

function extractBody(payload: any): string {
  const plain = findPart(payload, 'text/plain')
  if (plain) return decodeBase64Url(plain.body.data)
  const html = findPart(payload, 'text/html')
  if (html) return decodeBase64Url(html.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return ''
}

// ── Supabase helpers ─────────────────────────────────────────────────────

async function findOrCreateRequester(
  supabase: ReturnType<typeof createClient>,
  email: string,
  displayName: string
): Promise<string> {
  const { data: existing } = await supabase.from('requesters').select('id').eq('email', email).maybeSingle()
  if (existing) return existing.id
  const { data: inserted, error } = await supabase
    .from('requesters')
    .insert({ email, display_name: displayName || email })
    .select('id')
    .single()
  if (error) throw error
  return inserted.id
}

async function findTicketByThread(
  supabase: ReturnType<typeof createClient>,
  threadId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('ticket_messages')
    .select('ticket_id')
    .eq('raw_headers->>gmail_thread_id', threadId)
    .limit(1)
    .maybeSingle()
  return data?.ticket_id ?? null
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

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
