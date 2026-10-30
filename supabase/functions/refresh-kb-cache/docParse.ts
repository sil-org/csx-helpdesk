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

// A heading containing this marker (e.g. "Escalation contacts [no-quote]")
// keeps its whole section out of other desks' drafts, and tells this desk's
// own drafts never to quote it. It hides nothing from people: the Doc itself
// is readable by all of SIL. The
// section runs until the next heading at the same or a higher level.
const NO_QUOTE_MARKER = /\[no[- ]quote\]/i

function headingLevel(el: StructuralElement): number | null {
  const m = /^HEADING_(\d)$/.exec(el.paragraph?.paragraphStyle?.namedStyleType ?? '')
  return m ? Number(m[1]) : null
}

// The Doc's text twice: in full (the desk's own drafts), and without
// [no-quote] sections (what other desks' drafts may see).
export function docToKbText(doc: GoogleDoc): { full: string; shareable: string } {
  const full: string[] = []
  const visible: string[] = []
  let hiddenAt: number | null = null // heading level that opened the hidden section
  for (const el of doc.body?.content ?? []) {
    const text = elementText(el)
    const level = headingLevel(el)
    if (level !== null) {
      if (NO_QUOTE_MARKER.test(text)) hiddenAt = hiddenAt === null ? level : Math.min(hiddenAt, level)
      else if (hiddenAt !== null && level <= hiddenAt) hiddenAt = null
    }
    full.push(text)
    if (hiddenAt === null) visible.push(text)
  }
  return { full: tidy(full), shareable: tidy(visible) }
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
