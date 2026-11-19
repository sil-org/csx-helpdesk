// The sync itself, with everything it talks to passed in (`deps`) so it can be
// tested with fakes (see sync.test.ts). index.ts supplies the real ones.
// What it does is described at the top of index.ts.

import {
  applyImageUrls, cleanMarkdown, extractImages, imageExtension, isDraft, isExcludedFolder,
  sha256Hex, splitNoQuote,
} from './articles.ts'
import { planSync } from './plan.ts'
import type { ExistingArticle, FoundDoc, PlanItem } from './plan.ts'

export const BUCKET = 'helpdesk-kb'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DOC_MIME = 'application/vnd.google-apps.document'
const MAX_DEPTH = 8

// How long a run may keep starting new Docs; the next run carries on.
export const TIME_BUDGET_MS = 110_000

// The Supabase client, scoped to the helpdesk schema (only the parts used here).
// deno-lint-ignore no-explicit-any
export type Db = any

export interface Deps {
  db: Db
  fetch: typeof fetch
  now: () => number
}

interface DriveItem { id: string; name: string; mimeType: string; modifiedTime: string }

export interface DeskReport {
  desk_id: string
  synced: string[]
  unchanged: number
  removed: number
  skipped: { name: string; reason: string }[]
  // How many Google Docs the walk found, and the files it ignored because they
  // are not Google Docs (uploaded Word files, PDFs, shortcuts, ...). Without
  // these a folder the service account cannot see looks like a quiet success.
  docs_found: number
  ignored: { name: string; type: string }[]
  errors: { doc?: string; error: string }[]
  partial: boolean
}

interface WalkStats {
  rootItems: number
  ignored: { name: string; type: string }[]
}

const MAX_IGNORED_REPORTED = 25

function friendlyType(mime: string): string {
  if (mime === 'application/vnd.google-apps.shortcut') return 'shortcut'
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'Google Sheet'
  if (mime === 'application/vnd.google-apps.presentation') return 'Google Slides'
  if (mime === 'application/pdf') return 'PDF'
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return 'Word file'
  return mime
}

export async function syncDesk(
  deps: Deps,
  token: string,
  serviceAccountEmail: string,
  deskId: string,
  folderId: string,
  force: boolean,
  started: number,
): Promise<DeskReport> {
  const { db } = deps
  const report: DeskReport = {
    desk_id: deskId, synced: [], unchanged: 0, removed: 0, skipped: [], docs_found: 0, ignored: [], errors: [], partial: false,
  }

  let found: FoundDoc[]
  const stats: WalkStats = { rootItems: 0, ignored: [] }
  try {
    found = await walk(deps, token, folderId, [], 0, new Set(), stats)
  } catch (err) {
    report.errors.push({ error: `${err.message}. Confirm the folder is shared (view access is enough) with ${serviceAccountEmail}.` })
    return report // never remove anything after an incomplete walk
  }
  report.docs_found = found.length
  report.ignored = stats.ignored.slice(0, MAX_IGNORED_REPORTED)

  // Drive answers "nothing here" with no error both for an empty folder and for
  // a folder the service account cannot see. Either way this is not a walk to
  // act on: without this check, losing access would unpublish every article.
  if (stats.rootItems === 0) {
    report.errors.push({
      error: `The folder is empty or not visible to the service account. Share it (view access is enough, and for a Shared Drive the folder itself or the drive) with ${serviceAccountEmail}. Nothing was changed.`,
    })
    return report
  }

  const { data: existing, error: eErr } = await db.from('kb_articles')
    .select('id, drive_id, slug, tier, topic, archived, drive_modified_at').eq('desk_id', deskId)
  if (eErr) {
    report.errors.push({ error: eErr.message })
    return report
  }

  // Every Doc vanishing at once is far more likely a sharing change than an
  // editor deleting the whole KB, so it is left for a person to look at.
  if (found.length === 0 && (existing ?? []).length > 0 && !force) {
    report.errors.push({
      error: `No Google Docs were found, but ${(existing ?? []).length} articles are published. Nothing was removed. If you really emptied the folder, run the sync again with {"force": true}.`,
    })
    return report
  }

  const plan = planSync({ found, existing: (existing ?? []) as ExistingArticle[], force })
  report.skipped = plan.skipped.map((s) => ({ name: s.name, reason: s.reason }))
  report.unchanged = plan.items.filter((i) => i.action === 'unchanged').length

  for (const item of plan.items) {
    if (item.action !== 'sync') continue
    if (deps.now() - started > TIME_BUDGET_MS) {
      report.partial = true // the rest is picked up by the next run
      break
    }
    try {
      await syncDoc(deps, token, deskId, item)
      report.synced.push(item.doc.name)
    } catch (err) {
      report.errors.push({ doc: item.doc.name, error: err.message })
    }
  }

  // Unpublish what Drive no longer publishes (the walk above was complete).
  if (plan.remove.length) {
    try {
      const { data: gone } = await db.from('kb_articles').select('id').eq('desk_id', deskId).in('drive_id', plan.remove)
      for (const a of gone ?? []) await removeImages(db, a.id, null)
      const { error } = await db.from('kb_articles').delete().eq('desk_id', deskId).in('drive_id', plan.remove)
      if (error) throw error
      report.removed = plan.remove.length
    } catch (err) {
      report.errors.push({ error: `removing deleted articles: ${err.message}` })
    }
  }
  return report
}

async function syncDoc(deps: Deps, token: string, deskId: string, item: PlanItem) {
  const { db } = deps
  const { doc, placement, slug, existing } = item
  const raw = cleanMarkdown(await exportMarkdown(deps, token, doc.id))
  const { markdown, images } = extractImages(raw)
  const articleId = existing?.id ?? crypto.randomUUID()

  // Store the images first so the article text can point at them.
  const stored: { path: string; ref: string; mime: string }[] = []
  const urls: Record<string, string> = {}
  for (const [n, img] of images.entries()) {
    const path = `${deskId}/${articleId}/${n + 1}.${imageExtension(img.mime)}`
    const { error } = await db.storage.from(BUCKET).upload(path, img.data, { contentType: img.mime, upsert: true })
    if (error) continue // the text shows "(image not available)" for it
    urls[img.ref] = `kb-image:${path}`
    stored.push({ path, ref: img.ref, mime: img.mime })
  }

  const text = applyImageUrls(markdown, urls)
  const { full, shareable } = splitNoQuote(text)
  const title = doc.name.trim() || 'Untitled'

  const { error: upErr } = await db.from('kb_articles').upsert({
    id: articleId,
    desk_id: deskId,
    drive_id: doc.id,
    slug,
    title,
    tier: placement.tier,
    topic: placement.topic,
    body: full,
    body_shareable: shareable,
    is_draft: isDraft(title, markdown),
    archived: placement.archived,
    content_hash: await sha256Hex(raw),
    drive_modified_at: doc.modifiedTime,
    synced_at: new Date(deps.now()).toISOString(),
  }, { onConflict: 'desk_id,drive_id' })
  if (upErr) throw upErr

  // Replace the article's image rows, then delete files it no longer uses.
  await removeImages(db, articleId, new Set(stored.map((s) => s.path)))
  if (stored.length) {
    const { error } = await db.from('kb_article_images').upsert(
      stored.map((s) => ({ storage_path: s.path, article_id: articleId, ref: s.ref, mime: s.mime })),
      { onConflict: 'storage_path' },
    )
    if (error) throw error
  }
}

// Removes an article's stored images, except the paths in `keep`.
async function removeImages(db: Db, articleId: string, keep: Set<string> | null) {
  const { data } = await db.from('kb_article_images').select('storage_path').eq('article_id', articleId)
  const drop = (data ?? []).map((r: { storage_path: string }) => r.storage_path).filter((p: string) => !keep?.has(p))
  if (!drop.length) return
  await db.storage.from(BUCKET).remove(drop)
  await db.from('kb_article_images').delete().in('storage_path', drop)
}

// Every Google Doc under the folder, with the folder names above it. Throws if
// any folder cannot be listed, so the caller knows the result is incomplete.
async function walk(
  deps: Deps, token: string, folderId: string, segments: string[], depth: number, seen: Set<string>, stats: WalkStats,
): Promise<FoundDoc[]> {
  if (depth > MAX_DEPTH || seen.has(folderId)) return []
  seen.add(folderId)
  const docs: FoundDoc[] = []
  const items = await listChildren(deps, token, folderId)
  if (depth === 0) stats.rootItems = items.length
  for (const item of items) {
    if (item.mimeType === FOLDER_MIME) {
      if (isExcludedFolder(item.name)) continue
      docs.push(...await walk(deps, token, item.id, [...segments, item.name], depth + 1, seen, stats))
    } else if (item.mimeType === DOC_MIME) {
      docs.push({ id: item.id, name: item.name, modifiedTime: item.modifiedTime, segments })
    } else {
      stats.ignored.push({ name: [...segments, item.name].join(' / '), type: friendlyType(item.mimeType) })
    }
  }
  return docs
}

async function listChildren(deps: Deps, token: string, folderId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${folderId.replace(/'/g, '')}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await deps.fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Drive API ${res.status} listing folder ${folderId}: ${await res.text()}`)
    const page = await res.json()
    out.push(...(page.files ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

async function exportMarkdown(deps: Deps, token: string, docId: string): Promise<string> {
  const res = await deps.fetch(`https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/markdown`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Drive API ${res.status} exporting ${docId}: ${await res.text()}`)
  return await res.text()
}
