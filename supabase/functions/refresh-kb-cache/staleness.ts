// Decides whether a cached knowledge-base Doc needs reading again. Pure (no
// Deno or network APIs) so it is unit-testable with plain Node (see
// staleness.test.ts).
//
// `cachedAt` is the moment BEFORE the cached copy was fetched (the caller
// stores the fetch start, not the finish), so an edit made while we were
// reading it still has a modified time later than `cachedAt` and gets picked
// up next time instead of being missed.

export function shouldRefresh(opts: {
  force?: boolean
  docId: string
  cachedDocId: string | null | undefined
  cachedAt: string | null | undefined
  modifiedTime: string | null | undefined // Google Drive's modifiedTime; null if the check failed
}): { refresh: boolean; reason: string } {
  if (opts.force) return { refresh: true, reason: 'forced' }
  if (opts.cachedDocId !== opts.docId) return { refresh: true, reason: 'new or changed Doc' }
  const cached = opts.cachedAt ? Date.parse(opts.cachedAt) : NaN
  if (Number.isNaN(cached)) return { refresh: true, reason: 'never read' }
  const modified = opts.modifiedTime ? Date.parse(opts.modifiedTime) : NaN
  if (Number.isNaN(modified)) return { refresh: true, reason: 'could not check when the Doc changed' }
  return modified > cached
    ? { refresh: true, reason: 'Doc changed since last read' }
    : { refresh: false, reason: 'Doc unchanged since last read' }
}
