// Run with: node --experimental-strip-types --test supabase/functions/refresh-kb-cache/
import test from 'node:test'
import assert from 'node:assert/strict'
import { docToPlainText } from './docParse.ts'

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
