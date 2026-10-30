// Run with: node --experimental-strip-types --test supabase/functions/refresh-kb-cache/
import test from 'node:test'
import assert from 'node:assert/strict'
import { docToPlainText, docToKbText } from './docParse.ts'

test('docToPlainText joins paragraph text runs and collapses extra blank lines', () => {
  const doc = {
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Part 1: Staff Help\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        { paragraph: { elements: [{ textRun: { content: 'Contact: ' } }, { textRun: { content: 'help@sil.org\n' } }] } },
      ],
    },
  }
  assert.equal(docToPlainText(doc), 'Part 1: Staff Help\n\nContact: help@sil.org')
})

test('docToPlainText flattens a table into pipe-separated rows', () => {
  const doc = {
    body: {
      content: [{
        table: {
          tableRows: [{
            tableCells: [
              { content: [{ paragraph: { elements: [{ textRun: { content: 'Zoom' } }] } }] },
              { content: [{ paragraph: { elements: [{ textRun: { content: '$15/mo' } }] } }] },
            ],
          }],
        },
      }],
    },
  }
  assert.equal(docToPlainText(doc), 'Zoom | $15/mo')
})

test('docToPlainText handles an empty document', () => {
  assert.equal(docToPlainText({}), '')
  assert.equal(docToPlainText({ body: { content: [] } }), '')
})

const h = (level: number, text: string) => ({
  paragraph: { paragraphStyle: { namedStyleType: `HEADING_${level}` }, elements: [{ textRun: { content: text + '\n' } }] },
})
const p = (text: string) => ({ paragraph: { elements: [{ textRun: { content: text + '\n' } }] } })

test('docToKbText hides a [no-quote] section from the shareable text but keeps it in full', () => {
  const { full, shareable } = docToKbText({
    body: { content: [h(1, 'Accounts'), p('Reset at account.sil.org.'), h(2, 'Escalation [no-quote]'), p('Page Sam at 555-0100.'), h(2, 'Billing'), p('Invoices monthly.')] },
  })
  assert.match(full, /Page Sam/)
  assert.match(shareable, /Reset at account/)
  assert.match(shareable, /Invoices monthly/)
  assert.doesNotMatch(shareable, /Page Sam|Escalation/)
})

test('docToKbText: a no-quote section includes its sub-headings and ends at the next heading of the same or higher level', () => {
  const { shareable } = docToKbText({
    body: { content: [h(1, 'A [No-Quote]'), p('secret a'), h(2, 'A.1'), p('secret a1'), h(1, 'B'), p('public b'), h(2, 'B.1 [no quote]'), p('secret b1'), h(1, 'C'), p('public c')] },
  })
  assert.doesNotMatch(shareable, /secret/)
  assert.match(shareable, /public b/)
  assert.match(shareable, /public c/)
})

test('docToKbText without any marker returns the same text twice', () => {
  const { full, shareable } = docToKbText({ body: { content: [h(1, 'Hi'), p('there')] } })
  assert.equal(full, 'Hi\nthere')
  assert.equal(shareable, full)
})

test('docToKbText only treats real headings as section starts, not body text mentioning the marker', () => {
  const { shareable } = docToKbText({ body: { content: [h(1, 'Docs'), p('Mark a heading [no-quote] to hide it.'), p('still visible')] } })
  assert.match(shareable, /still visible/)
})
