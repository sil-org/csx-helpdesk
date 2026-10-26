// Pure parsing of a Google Docs API `documents.get` response into plain
// text. No Deno/network APIs here so it's unit-testable with plain Node.

interface TextRun { textRun?: { content?: string } }
interface Paragraph { paragraph?: { elements?: TextRun[] } }
interface TableCell { content?: StructuralElement[] }
interface TableRow { tableCells?: TableCell[] }
interface Table { table?: { tableRows?: TableRow[] } }
type StructuralElement = Paragraph & Table

export interface GoogleDoc {
  body?: { content?: StructuralElement[] }
}

export function docToPlainText(doc: GoogleDoc): string {
  return (doc.body?.content ?? []).map(elementText).join('').replace(/\n{3,}/g, '\n\n').trim()
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
