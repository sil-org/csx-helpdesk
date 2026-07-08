import { createClient } from 'jsr:@supabase/supabase-js@2'

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-3'

interface EmbedRequest {
  corpus_document_id: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  try {
    // Voyage AI trains on submitted content by default unless the account has
    // opted out (dashboard setting on their end, not an API param — see
    // memory/voyage_ai_training_policy.md). This corpus is internal SIL ticket
    // content, so refuse to call Voyage at all until that's confirmed done.
    if (Deno.env.get('VOYAGE_TRAINING_OPT_OUT_CONFIRMED') !== 'true') {
      return json({
        error: 'Voyage AI training opt-out not confirmed. Opt out in the Voyage AI ' +
          'dashboard, then set VOYAGE_TRAINING_OPT_OUT_CONFIRMED=true on this function ' +
          'before embedding any ticket content.',
      }, 412)
    }

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body: EmbedRequest = await req.json()
    const { corpus_document_id } = body
    if (!corpus_document_id) {
      return json({ error: 'Missing required field: corpus_document_id' }, 400)
    }

    const { data: doc, error: fetchError } = await supabase
      .from('corpus_documents')
      .select('id, content')
      .eq('id', corpus_document_id)
      .single()
    if (fetchError || !doc) {
      return json({ error: 'corpus_document not found' }, 404)
    }

    const voyageRes = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('VOYAGE_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: [doc.content],
        model: VOYAGE_MODEL,
        input_type: 'document',
      }),
    })

    if (!voyageRes.ok) {
      const detail = await voyageRes.json()
      return json({ error: 'Voyage AI embedding request failed', detail }, 502)
    }

    const voyageData = await voyageRes.json()
    const embedding = voyageData.data[0].embedding

    const { error: updateError } = await supabase
      .from('corpus_documents')
      .update({ embedding })
      .eq('id', corpus_document_id)
    if (updateError) {
      return json({ error: 'Failed to store embedding', detail: updateError.message }, 500)
    }

    return json({ success: true, corpus_document_id })
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
