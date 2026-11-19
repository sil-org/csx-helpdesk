import { hd } from './helpdesk'
import { supabase } from './supabase'
import { GENERAL } from './kbText'
export * from './kbText'

// Help-center data (spec decision 23). Every call here runs as whoever is
// looking, signed in or not, so row-level security decides which articles come
// back: signed-out visitors get published public articles, signed-in people
// also get internal ones, a desk's agents get everything on their desk. Nothing
// here filters by audience itself.

export const KB_BUCKET = 'helpdesk-kb'
export const DEFAULT_COLOR = '#005CB9'

// Desks that have at least one article the caller can read.
export async function loadKbDesks() {
  const { data, error } = await hd.rpc('kb_desks')
  if (error) throw error
  return data ?? []
}

export async function searchKb(query, deskId) {
  const { data, error } = await hd.rpc('search_kb', { p_query: query, p_desk_id: deskId ?? null, p_limit: 30 })
  if (error) throw error
  return data ?? []
}

// Staff-only matches a signed-out visitor cannot read (a number, never titles).
export async function signInHint(query) {
  const { data, error } = await hd.rpc('kb_signin_hint', { p_query: query })
  if (error) return 0
  return data ?? 0
}

export async function loadTopics() {
  const { data, error } = await hd.rpc('kb_topics')
  if (error) throw error
  return data ?? []
}

const LIST_COLUMNS = 'id, desk_id, slug, title, topic, drive_modified_at'

// Published articles only: agents can read drafts and archived articles, but
// those never belong in the help center.
function published(query) {
  return query.eq('is_draft', false).eq('archived', false)
}

export async function listArticles({ topic, deskId }) {
  let q = published(hd.from('kb_articles').select(LIST_COLUMNS)).order('title')
  if (deskId) q = q.eq('desk_id', deskId)
  q = topic === GENERAL ? q.is('topic', null) : q.eq('topic', topic)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

export async function listRecent(limit = 6) {
  const { data, error } = await published(hd.from('kb_articles').select(LIST_COLUMNS))
    .order('drive_modified_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function loadArticle(deskId, slug) {
  const { data, error } = await hd.from('kb_articles')
    .select('id, desk_id, slug, title, tier, topic, body, is_draft, archived, drive_modified_at')
    .eq('desk_id', deskId).eq('slug', slug).maybeSingle()
  if (error) throw error
  return data
}

// Short-lived links for the images an article uses. The bucket is private and
// storage only hands a link to someone who can read the article.
export async function signedImageUrls(paths) {
  if (!paths.length) return {}
  const { data, error } = await supabase.storage.from(KB_BUCKET).createSignedUrls(paths, 3600)
  if (error) throw error
  const urls = {}
  for (const item of data ?? []) if (item.signedUrl) urls[item.path] = item.signedUrl
  return urls
}
