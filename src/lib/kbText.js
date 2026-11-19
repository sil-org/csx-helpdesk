// Pure text helpers for the help center (no network, no Supabase), so they
// can be unit-tested with plain Node. See kbText.test.js.

// Articles with no folder under their audience folder are shown under this name.
export const GENERAL = 'General'

// Paths of the stored images an article's text points at (kb-image:<path>).
export function imagePathsIn(body) {
  return [...new Set([...body.matchAll(/kb-image:([^\s)]+)/g)].map((m) => m[1]))]
}

// search_kb wraps matches in U+27E6 and U+27E7 (never HTML). Split a snippet
// into plain and highlighted parts, so the page can escape the text itself.
export function snippetParts(snippet) {
  const parts = []
  let rest = snippet ?? ''
  while (rest) {
    const open = rest.indexOf('⟦')
    if (open === -1) { parts.push({ text: rest, match: false }); break }
    if (open > 0) parts.push({ text: rest.slice(0, open), match: false })
    const close = rest.indexOf('⟧', open)
    if (close === -1) { parts.push({ text: rest.slice(open + 1), match: false }); break }
    parts.push({ text: rest.slice(open + 1, close), match: true })
    rest = rest.slice(close + 1)
  }
  return parts
}

// Over a year since the article was last edited in Drive.
export function isStale(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN
  return !Number.isNaN(t) && now - t > 365 * 24 * 3600 * 1000
}

export function formatDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}

// "## Heading" and "### Heading" lines (outside code fences), for the page's
// "On this page" list.
export function outline(body) {
  const items = []
  let fence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue }
    if (fence) continue
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) items.push({ level: m[1].length, text: plainHeading(m[2]), id: headingId(m[2]) })
  }
  return items
}

export function plainHeading(text) {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`\\]/g, '').trim()
}

export function headingId(text) {
  return 'h-' + plainHeading(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Drive Docs usually open with the title as a heading; the page already shows
// the title, so drop that first heading when it repeats it.
export function stripLeadingTitle(body, title) {
  const lines = body.split('\n')
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first === -1) return body
  const m = /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(lines[first])
  if (!m || plainHeading(m[1]).toLowerCase() !== plainHeading(title).toLowerCase()) return body
  return lines.slice(first + 1).join('\n').replace(/^\s*\n/, '')
}
