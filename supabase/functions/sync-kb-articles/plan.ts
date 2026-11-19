// Decides what one sync run does for a desk, from what Drive holds and what
// the database already has. Pure (no network) so it is unit-tested with plain
// Node (see plan.test.ts).

import { classifyPath, slugify, uniqueSlug } from './articles.ts'
import type { Placement } from './articles.ts'

export interface FoundDoc {
  id: string // Drive file id
  name: string
  modifiedTime: string
  segments: string[] // folder names between the desk's KB folder and the Doc
}

export interface ExistingArticle {
  id: string
  drive_id: string
  slug: string
  tier: string
  topic: string | null
  archived: boolean
  drive_modified_at: string | null
}

export interface PlanItem {
  doc: FoundDoc
  placement: Placement
  slug: string
  existing: ExistingArticle | undefined
  action: 'sync' | 'unchanged'
}

export interface Plan {
  items: PlanItem[]
  // Docs left out because of where they sit, with why.
  skipped: { id: string; name: string; reason: string }[]
  // Drive ids that have an article but are no longer published from Drive
  // (deleted, trashed, moved to Drafts or out of the audience folders).
  remove: string[]
}

export function planSync(opts: { found: FoundDoc[]; existing: ExistingArticle[]; force?: boolean }): Plan {
  const byDrive = new Map(opts.existing.map((e) => [e.drive_id, e]))
  const taken = new Set(opts.existing.map((e) => e.slug))
  const items: PlanItem[] = []
  const skipped: Plan['skipped'] = []
  const published = new Set<string>()

  for (const doc of opts.found) {
    const placement = classifyPath(doc.segments)
    if ('skip' in placement) {
      skipped.push({ id: doc.id, name: doc.name, reason: placement.skip })
      continue
    }
    published.add(doc.id)
    const existing = byDrive.get(doc.id)
    // A slug is assigned once and kept when the Doc is renamed, so links last.
    let slug = existing?.slug
    if (!slug) {
      slug = uniqueSlug(slugify(doc.name), taken)
      taken.add(slug)
    }
    const unchanged =
      !opts.force &&
      existing !== undefined &&
      existing.tier === placement.tier &&
      existing.topic === placement.topic &&
      existing.archived === placement.archived &&
      isNotNewer(doc.modifiedTime, existing.drive_modified_at)
    items.push({ doc, placement, slug, existing, action: unchanged ? 'unchanged' : 'sync' })
  }

  const remove = opts.existing.filter((e) => !published.has(e.drive_id)).map((e) => e.drive_id)
  return { items, skipped, remove }
}

// True when the stored copy is at least as new as Drive's (unparseable dates
// count as "changed", so the Doc is read again).
function isNotNewer(driveModified: string, storedModified: string | null): boolean {
  const drive = Date.parse(driveModified)
  const stored = storedModified ? Date.parse(storedModified) : NaN
  if (Number.isNaN(drive) || Number.isNaN(stored)) return false
  return stored >= drive
}
