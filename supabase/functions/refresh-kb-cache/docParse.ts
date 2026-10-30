// Pure parsing of a Google Docs API `documents.get` response into plain
// text. No Deno/network APIs here so it's unit-testable with plain Node.

interface TextRun { textRun?: { content?: string } }
interface Paragraph { paragraph?: { elements?: TextRun[]; paragraphStyle?: { namedStyleType?: string } } }
interface TableCell { content?: StructuralElement[] }
interface TableRow { tableCells?: TableCell[] }
interface Table { table?: { tableRows?: TableRow[] } }
type StructuralElement = Paragraph & Table

export interface GoogleDoc {
  body?: { content?: StructuralElement[] }
}

export function docToPlainText(doc: GoogleDoc): string {
  return tidy((doc.body?.content ?? []).map(elementText))
}

function tidy(parts: string[]): string {
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

// A heading containing this marker (e.g. "Escalation contacts [staff-only]")
// hides its whole section from requesters and from other desks' drafts. The
// section runs until the next heading at the same or a higher level.
const STAFF_ONLY_MARKER = /\[staff[- ]only\]/i

function headingLevel(el: StructuralElement): number | null {
  const m = /^HEADING_(\d)$/.exec(el.paragraph?.paragraphStyle?.namedStyleType ?? '')
  return m ? Number(m[1]) : null
}

// The Doc's text twice: in full (the desk's own drafts), and without
// [staff-only] sections (what other desks and requesters may see).
export function docToKbText(doc: GoogleDoc): { full: string; requesterVisible: string } {
  const full: string[] = []
  const visible: string[] = []
  let hiddenAt: number | null = null // heading level that opened the hidden section
  for (const el of doc.body?.content ?? []) {
    const text = elementText(el)
    const level = headingLevel(el)
    if (level !== null) {
      if (STAFF_ONLY_MARKER.test(text)) hiddenAt = hiddenAt === null ? level : Math.min(hiddenAt, level)
      else if (hiddenAt !== null && level <= hiddenAt) hiddenAt = null
    }
    full.push(text)
    if (hiddenAt === null) visible.push(text)
  }
  return { full: tidy(full), requesterVisible: tidy(visible) }
}

function elementText(el: StructuralElement): string {
  if (el.paragraph) {
    return (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join('')
  }
  if (el.table) {
    const rows = el.table.tableRows ?? []
    return rows
      .map((row) => (row.tableCells ?? []).map((cell) => (cell.content ?? []).map(elementText).join('').trim()).join(' | '))
      .join('\n') + '\n'
  }
  return ''
}
