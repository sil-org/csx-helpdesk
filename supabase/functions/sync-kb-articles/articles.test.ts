// Run with: node --experimental-strip-types --test supabase/functions/sync-kb-articles/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPath, slugify, uniqueSlug, cleanMarkdown, extractImages, applyImageUrls,
  imageExtension, splitNoQuote, isDraft, isExcludedFolder, sha256Hex,
} from './articles.ts'

test('a Doc is placed by its first folder, case-insensitively', () => {
  assert.deepEqual(classifyPath(['public']), { tier: 'public', topic: null, archived: false })
  assert.deepEqual(classifyPath(['Internal', 'Sign-in']), { tier: 'internal', topic: 'Sign-in', archived: false })
  assert.deepEqual(classifyPath(['AGENTS', 'Runbooks', 'Mail']), { tier: 'agents', topic: 'Runbooks', archived: false })
})

test('a Doc outside the audience folders is never published', () => {
  assert.deepEqual(classifyPath([]), { skip: 'not inside a public, internal or agents folder' })
  assert.deepEqual(classifyPath(['Random']), { skip: 'not inside a public, internal or agents folder' })
  assert.deepEqual(classifyPath(['google-admins']), { skip: 'not inside a public, internal or agents folder' })
})

test('an Archive folder archives the Doc and is not its topic', () => {
  assert.deepEqual(classifyPath(['internal', 'Archive']), { tier: 'internal', topic: null, archived: true })
  assert.deepEqual(classifyPath(['internal', 'archive', 'Old topic']), { tier: 'internal', topic: 'Old topic', archived: true })
  assert.deepEqual(classifyPath(['public', 'Topic', 'Archive']), { tier: 'public', topic: 'Topic', archived: true })
})

test('Drafts folders are skipped', () => {
  assert.equal(isExcludedFolder('Drafts'), true)
  assert.equal(isExcludedFolder(' drafts '), true)
  assert.equal(isExcludedFolder('Draft notes'), false)
})

test('slugs are plain ASCII and unique per desk', () => {
  assert.equal(slugify('Re-Register Security Keys'), 're-register-security-keys')
  assert.equal(slugify('  Résumé: « Café »  '), 'resume-cafe')
  assert.equal(slugify('!!!'), 'untitled')
  const taken = new Set(['sign-in-help', 'sign-in-help-2'])
  assert.equal(uniqueSlug('sign-in-help', taken), 'sign-in-help-3')
  assert.equal(uniqueSlug('other', taken), 'other')
})

test('cleanMarkdown drops empty headings and extra blank lines', () => {
  assert.equal(cleanMarkdown('# Title\r\n\r\n##\r\n\r\n\r\n\r\nText\n'), '# Title\n\nText')
})

test('extractImages moves base64 definitions out and keeps the references', () => {
  const md = 'See ![][image1] and ![shot][image2].\n\n[image1]: <data:image/png;base64,AAEC>\n[image2]: <data:image/jpeg;base64,AwQF>\n[docs]: https://example.org\n'
  const { markdown, images } = extractImages(md)
  assert.equal(markdown, 'See ![][image1] and ![shot][image2].\n\n[docs]: https://example.org')
  assert.deepEqual(images.map((i) => [i.ref, i.mime, [...i.data]]), [
    ['image1', 'image/png', [0, 1, 2]],
    ['image2', 'image/jpeg', [3, 4, 5]],
  ])
})

test('extractImages also handles inline data images', () => {
  const { markdown, images } = extractImages('Here: ![alt](data:image/png;base64,AAEC) done')
  assert.equal(markdown, 'Here: ![alt][inline-image-1] done')
  assert.equal(images.length, 1)
  assert.deepEqual([...images[0].data], [0, 1, 2])
})

test('applyImageUrls links stored images and flags the missing ones', () => {
  const out = applyImageUrls('A ![][image1] B ![cap][image2] C [link][docs]', { image1: 'kb-image:d/1.png' })
  assert.equal(out, 'A ![](kb-image:d/1.png) B *(image not available)* C [link][docs]')
})

test('imageExtension', () => {
  assert.equal(imageExtension('image/jpeg'), 'jpg')
  assert.equal(imageExtension('image/png'), 'png')
  assert.equal(imageExtension('image/svg+xml'), 'svg')
})

const DOC = [
  '# Guide',
  'Intro.',
  '## Public steps',
  'Do this.',
  '## Escalation contacts [no-quote]',
  'Call Sam.',
  '### Sub of hidden',
  'Secret detail.',
  '## Back to normal',
  'Visible again.',
].join('\n')

test('a [no-quote] section runs to the next heading of the same or higher level', () => {
  const { full, shareable } = splitNoQuote(DOC)
  assert.equal(full, DOC)
  assert.equal(shareable, '# Guide\nIntro.\n## Public steps\nDo this.\n## Back to normal\nVisible again.')
})

test('a [no-quote] top-level heading hides the rest of its level', () => {
  const { shareable } = splitNoQuote('# A\nkeep\n# B [No Quote]\nhide\n## inner\nhide too\n# C\nkeep C')
  assert.equal(shareable, '# A\nkeep\n# C\nkeep C')
})

test('headings inside code fences are not headings', () => {
  const md = '# A\n```\n## not [no-quote]\n```\ntext'
  assert.equal(splitNoQuote(md).shareable, md)
})

test('a Doc with no marker is shared whole', () => {
  assert.equal(splitNoQuote('# A\ntext').shareable, '# A\ntext')
})

test('drafts are recognised by a bare DRAFT line or a Draft: title, not by the word alone', () => {
  assert.equal(isDraft('Protecting SIL from Phishing email', '**DRAFT**\n**Subject:** Security Alert'), true)
  assert.equal(isDraft('Anything', '\n\n  Draft  \nText'), true)
  assert.equal(isDraft('Draft: new policy', 'Text'), true)
  assert.equal(isDraft('[DRAFT] Mail rules', 'Text'), true)
  assert.equal(isDraft('Draft policies explained', 'How draft policies work.'), false)
  assert.equal(isDraft('Re-Register Security Keys', '# Re-Register\nDraft your plan first.'), false)
})

test('sha256Hex is stable', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
