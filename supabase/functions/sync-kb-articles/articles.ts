// Pure helpers for turning a Drive folder of Google Docs into knowledge-base
// articles. No Deno or network APIs in here so they can be unit-tested with
// plain Node (see articles.test.ts).

export const AUDIENCES = ['public', 'internal', 'agents'] as const
export type Audience = (typeof AUDIENCES)[number]

// A folder with this name (any depth) is skipped entirely: not-yet-ready work.
const EXCLUDED_FOLDERS = ['drafts']
export function isExcludedFolder(name: string): boolean {
  return EXCLUDED_FOLDERS.includes(name.trim().toLowerCase())
}

export interface Placement {
  tier: Audience
  topic: string | null
  archived: boolean
}

// Where a Doc sits decides who may read it (spec decision 23). `segments` are
// the folder names between the desk's KB folder and the Doc. A Doc outside the
// three audience folders is NOT published: the old Hugo pipeline defaulted
// such Docs to public, which put staff-only articles on the open internet once,
// so here the safe default is to leave them out and report them.
export function classifyPath(segments: string[]): Placement | { skip: string } {
  const first = segments[0]?.trim().toLowerCase()
  const tier = AUDIENCES.find((a) => a === first)
  if (!tier) {
    return { skip: 'not inside a public, internal or agents folder' }
  }
  const below = segments.slice(1)
  const archived = below.some((s) => s.trim().toLowerCase() === 'archive')
  const topic = below.find((s) => s.trim().toLowerCase() !== 'archive')?.trim() || null
  return { tier, topic, archived }
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'untitled'
}

// A slug nobody on the desk is using yet: base, base-2, base-3, ...
export function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ── Markdown ─────────────────────────────────────────────────────────────

// Drive's markdown export leaves bare "##" lines (horizontal rules and similar)
// that render as empty headings. Drop them and tidy blank lines.
export function cleanMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^#{1,6}[ \t]*$\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface ExtractedImage {
  ref: string
  mime: string
  data: Uint8Array
}

const DEFINITION_RE = /^\[([^\]\n]+)\]:[ \t]*<?data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)>?[ \t]*$/gim
const INLINE_RE = /!\[([^\]\n]*)\]\(<?data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+?)>?\)/gi

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Google's export embeds every image as base64 (a 300 KB Doc is mostly image
// data). Pull the bytes out so they can live in storage, and leave a plain
// reference-style image in the text: ![alt][ref].
export function extractImages(md: string): { markdown: string; images: ExtractedImage[] } {
  const images: ExtractedImage[] = []
  const seen = new Set<string>()
  let inlineCount = 0

  let markdown = md.replace(DEFINITION_RE, (_m, ref: string, mime: string, b64: string) => {
    if (!seen.has(ref)) {
      seen.add(ref)
      images.push({ ref, mime, data: decodeBase64(b64) })
    }
    return ''
  })
  markdown = markdown.replace(INLINE_RE, (_m, alt: string, mime: string, b64: string) => {
    const ref = `inline-image-${++inlineCount}`
    images.push({ ref, mime, data: decodeBase64(b64) })
    return `![${alt}][${ref}]`
  })
  return { markdown: markdown.replace(/\n{3,}/g, '\n\n').trim(), images }
}

// Point each ![alt][ref] at its stored image. An image that could not be
// stored becomes visible text instead of a broken picture.
export function applyImageUrls(md: string, urls: Record<string, string>): string {
  return md.replace(/!\[([^\]\n]*)\]\[([^\]\n]+)\]/g, (_m, alt: string, ref: string) => {
    const url = urls[ref]
    return url ? `![${alt}](${url})` : '*(image not available)*'
  })
}

export function imageExtension(mime: string): string {
  const sub = mime.split('/')[1]?.split('+')[0]?.toLowerCase() ?? 'bin'
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'bin'
}

// A heading containing [no-quote] opens a section that runs to the next
// heading of the same or a higher level. People can read it; the marker only
// keeps it out of AI replies to other desks and to unverified senders (spec
// decisions 21 and 22). Same rule as the Doc-based docParse.ts, on markdown.
const NO_QUOTE = /\[no[- ]quote\]/i

export function splitNoQuote(md: string): { full: string; shareable: string } {
  const visible: string[] = []
  let hiddenAt: number | null = null
  let fence: string | null = null
  for (const line of md.split('\n')) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line)
    if (fenceMatch) fence = fence === null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence
    const heading = fence === null ? /^(#{1,6})\s+(.*)$/.exec(line) : null
    if (heading) {
      const level = heading[1].length
      if (NO_QUOTE.test(heading[2])) hiddenAt = hiddenAt === null ? level : Math.min(hiddenAt, level)
      else if (hiddenAt !== null && level <= hiddenAt) hiddenAt = null
    }
    if (hiddenAt === null) visible.push(line)
  }
  return { full: md, shareable: visible.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

// A Doc that says it is a draft stays out of the help center. Only a title
// that starts "Draft:" / "[Draft]", or a first line that is just the word
// DRAFT (in any emphasis), counts: a real article about "draft policies" does not.
export function isDraft(title: string, md: string): boolean {
  if (/^\s*(\[draft\]|draft\s*[:\-–—])/i.test(title)) return true
  const first = md.split('\n').find((l) => l.trim() !== '') ?? ''
  const bare = first.replace(/[*_`#>\s]/g, '')
  return /^draft[:.!\-–—]?$/i.test(bare)
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
