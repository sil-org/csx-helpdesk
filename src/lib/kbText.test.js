// Run with: node --test src/lib/kbText.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { snippetParts, isStale, outline, headingId, imagePathsIn, formatDate } from './kbText.js'

test('snippetParts splits plain text from matches without touching HTML', () => {
  assert.deepEqual(snippetParts('Use the ⟦reset⟧ link <b>now</b> to ⟦reset⟧'), [
    { text: 'Use the ', match: false },
    { text: 'reset', match: true },
    { text: ' link <b>now</b> to ', match: false },
    { text: 'reset', match: true },
  ])
  assert.deepEqual(snippetParts('no matches'), [{ text: 'no matches', match: false }])
  assert.deepEqual(snippetParts(''), [])
  assert.deepEqual(snippetParts(null), [])
  assert.deepEqual(snippetParts('broken ⟦open'), [{ text: 'broken ', match: false }, { text: 'open', match: false }])
})

test('an article not edited for over a year is stale', () => {
  const now = Date.parse('2026-11-19T00:00:00Z')
  assert.equal(isStale('2024-05-13T16:09:29Z', now), true)
  assert.equal(isStale('2026-09-10T13:15:50Z', now), false)
  assert.equal(isStale('2025-11-20T00:00:00Z', now), false)
  assert.equal(isStale(null, now), false)
  assert.equal(isStale('not a date', now), false)
})

test('outline lists ## and ### headings, skips code fences and the title', () => {
  const body = ['# Title', 'x', '## Before you start', '```', '## not a heading', '```', '### If you ARE using **your key**', '#### too deep', '## Steps ##'].join('\n')
  assert.deepEqual(outline(body), [
    { level: 2, text: 'Before you start', id: 'h-before-you-start' },
    { level: 3, text: 'If you ARE using your key', id: 'h-if-you-are-using-your-key' },
    { level: 2, text: 'Steps', id: 'h-steps' },
  ])
})

test('heading ids ignore emphasis and links', () => {
  assert.equal(headingId('Re-register [your key](https://x.org)'), 'h-re-register-your-key')
  assert.equal(headingId('*If asked:*'), 'h-if-asked')
})

test('imagePathsIn finds each stored image once', () => {
  const body = 'a ![](kb-image:d/a/1.png) b ![x](kb-image:d/a/2.jpg) c ![](kb-image:d/a/1.png)'
  assert.deepEqual(imagePathsIn(body), ['d/a/1.png', 'd/a/2.jpg'])
  assert.deepEqual(imagePathsIn('no images'), [])
})

test('formatDate handles a missing date', () => {
  assert.equal(formatDate(null), null)
  assert.match(formatDate('2026-09-10T13:15:50Z'), /2026/)
})

test('stripLeadingTitle removes a first heading that repeats the title, and only that', async () => {
  const { stripLeadingTitle } = await import('./kbText.js')
  assert.equal(stripLeadingTitle('# Re-Register Security Keys\n\nBody text', 'Re-Register Security Keys'), 'Body text')
  assert.equal(stripLeadingTitle('\n## re-register *security* keys\nBody', 'Re-Register Security Keys'), 'Body')
  assert.equal(stripLeadingTitle('# Something else\nBody', 'Re-Register Security Keys'), '# Something else\nBody')
  assert.equal(stripLeadingTitle('Body first\n# Re-Register Security Keys', 'Re-Register Security Keys'), 'Body first\n# Re-Register Security Keys')
  assert.equal(stripLeadingTitle('', 'T'), '')
})
