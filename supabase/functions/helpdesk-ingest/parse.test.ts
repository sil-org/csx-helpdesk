// Run with: node --experimental-strip-types --test supabase/functions/helpdesk-ingest/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoReplyReason, candidateAddresses, decodeBase64Url, extractBody, listAttachments, looksForwarded,
  parseAddress, parseAddressList, parseReferences, routeDesk, safeFilename, stripGroupFooter, truncateBody, MAX_BODY_CHARS,
} from './parse.ts'

const h = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }))
const b64 = (s: string) => Buffer.from(s).toString('base64url')

test('parseAddress handles the common shapes', () => {
  assert.deepEqual(parseAddress('"Pat Smith" <Pat@X.org>'), { email: 'pat@x.org', name: 'Pat Smith' })
  assert.deepEqual(parseAddress('Pat <pat@x.org>'), { email: 'pat@x.org', name: 'Pat' })
  assert.deepEqual(parseAddress('<pat@x.org>'), { email: 'pat@x.org', name: 'pat@x.org' })
  assert.deepEqual(parseAddress('PAT@x.org'), { email: 'pat@x.org', name: 'pat@x.org' })
})

test('parseAddressList splits on commas outside quotes and brackets', () => {
  assert.deepEqual(
    parseAddressList('"Smith, Pat" <pat@x.org>, b@y.org, Lee <lee@z.org>'),
    ['pat@x.org', 'b@y.org', 'lee@z.org']
  )
  assert.deepEqual(parseAddressList('undisclosed-recipients:;'), [])
})

test('candidateAddresses puts group headers first and de-duplicates', () => {
  const c = candidateAddresses(h({
    'Delivered-To': 'helpdesk-ingest@sil.org',
    'List-Post': '<mailto:dallas-help@sil.org>',
    'To': 'Dallas Help <dallas-help@sil.org>',
    'Cc': 'someone@x.org',
    'List-Id': '<dallas-help.sil.org>',
  }))
  assert.deepEqual(c, ['dallas-help@sil.org', 'helpdesk-ingest@sil.org', 'someone@x.org'])
})

test('candidateAddresses reads Mailing-list and falls back to List-Id', () => {
  assert.deepEqual(candidateAddresses(h({ 'Mailing-list': 'list grp@sil.org; contact grp+owners@sil.org' })), ['grp@sil.org'])
  assert.deepEqual(candidateAddresses(h({ 'List-Id': '<globalit.sil.org>' })), ['globalit@sil.org'])
})

test('routeDesk: address match, mailbox default, or unrouted', () => {
  const map = new Map([['a@sil.org', 'desk-a'], ['b@sil.org', 'desk-b']])
  assert.deepEqual(routeDesk(['x@y.org', 'b@sil.org'], map, null), { deskId: 'desk-b', sourceAddress: 'b@sil.org' })
  assert.deepEqual(routeDesk(['x@y.org'], map, 'desk-default'), { deskId: 'desk-default', sourceAddress: null })
  assert.equal(routeDesk(['x@y.org'], map, null), null)
  // an address match beats the mailbox default
  assert.deepEqual(routeDesk(['a@sil.org'], map, 'desk-default'), { deskId: 'desk-a', sourceAddress: 'a@sil.org' })
})

test('autoReplyReason catches automatic mail but not real notifications or list mail', () => {
  assert.match(autoReplyReason(h({ 'Auto-Submitted': 'auto-replied' }), 'a@x.org', 'Re: hi')!, /Auto-Submitted/)
  assert.equal(autoReplyReason(h({ 'Auto-Submitted': 'no' }), 'a@x.org', 'hi'), null)
  assert.ok(autoReplyReason(h({ 'X-Autoreply': 'yes' }), 'a@x.org', 'hi'))
  assert.ok(autoReplyReason(h({ Precedence: 'auto_reply' }), 'a@x.org', 'hi'))
  assert.ok(autoReplyReason(h({}), 'mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure)'))
  assert.ok(autoReplyReason(h({ 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' }), 'a@x.org', 'x'))
  assert.ok(autoReplyReason(h({}), 'a@x.org', 'Automatic reply: Out of office'))
  assert.ok(autoReplyReason(h({}), 'a@x.org', 'Out of Office until Monday'))
  // Google Groups mail carries Precedence: list/bulk; that must NOT be skipped
  assert.equal(autoReplyReason(h({ Precedence: 'list' }), 'pat@x.org', 'Printer broken'), null)
  assert.equal(autoReplyReason(h({ Precedence: 'bulk' }), 'pat@x.org', 'Printer broken'), null)
  // an SES-style notification that names a real person still becomes a ticket (GHD-1183 case)
  assert.equal(autoReplyReason(h({}), 'no-reply@sns.amazonaws.com', 'AWS Notification Message'), null)
})

test('looksForwarded flags forward markers, not ordinary replies', () => {
  assert.ok(looksForwarded('Fwd: help', 'hi'))
  assert.ok(looksForwarded('help', 'see below\n---------- Forwarded message ---------\nFrom: x'))
  assert.ok(looksForwarded('help', 'Begin forwarded message:\n'))
  assert.ok(!looksForwarded('Re: help', 'On Monday Pat wrote:\n> -----Original Message-----'))
})

test('stripGroupFooter removes the Google Groups footer only', () => {
  const body = 'My printer is broken.\n\n--\nYou received this message because you are subscribed to the Google Groups "Dallas Help" group.\nTo unsubscribe from this group and stop receiving emails from it, send an email to dallas-help+unsubscribe@sil.org.'
  assert.equal(stripGroupFooter(body), 'My printer is broken.')
  const tricky = 'Note: You received this message because you are subscribed to nothing, ha.'
  assert.equal(stripGroupFooter(tricky), tricky)
  assert.equal(stripGroupFooter('plain mail'), 'plain mail')
})

test('parseReferences extracts message ids', () => {
  assert.deepEqual(parseReferences('<a@x> <b@y>\n <c@z>'), ['<a@x>', '<b@y>', '<c@z>'])
  assert.deepEqual(parseReferences(''), [])
})

test('extractBody prefers text/plain, falls back to stripped html', () => {
  const both = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', body: { data: b64('plain text') } },
    { mimeType: 'text/html', body: { data: b64('<p>html text</p>') } } ] }
  assert.equal(extractBody(both), 'plain text')
  const htmlOnly = { mimeType: 'text/html', body: { data: b64('<style>p{}</style><p>Hello&nbsp;<b>there</b></p><div>bye &amp; thanks</div>') } }
  assert.equal(extractBody(htmlOnly), 'Hello there\nbye & thanks')
  assert.equal(extractBody({ mimeType: 'image/png' }), '')
  // an attached .txt file is not the body
  const withAttachment = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attached'), attachmentId: 'a1' } },
    { mimeType: 'text/plain', body: { data: b64('real body') } } ] }
  assert.equal(extractBody(withAttachment), 'real body')
})

test('decodeBase64Url round-trips utf-8', () => {
  assert.equal(decodeBase64Url(b64('héllo wörld ✓')), 'héllo wörld ✓')
})

test('listAttachments finds nested attachment parts', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: b64('x') } },
    { mimeType: 'multipart/related', parts: [
      { mimeType: 'image/png', filename: 'shot.png', body: { attachmentId: 'att1', size: 1234 } } ] },
    { mimeType: 'application/pdf', filename: 'doc.pdf', body: { attachmentId: 'att2', size: 99 } } ] }
  assert.deepEqual(listAttachments(payload).map((a) => [a.filename, a.attachmentId, a.size]),
    [['shot.png', 'att1', 1234], ['doc.pdf', 'att2', 99]])
})

test('safeFilename neutralises path tricks', () => {
  assert.ok(!safeFilename('../../etc/passwd').includes('/'))
  assert.ok(!safeFilename('../../etc/passwd').startsWith('.'))
  assert.ok(!safeFilename('..\\..\\win.ini').includes('\\'))
  assert.equal(safeFilename('...hidden'), '_hidden')
  assert.equal(safeFilename(''), 'attachment')
  assert.equal(safeFilename('Q3 report (final).pdf'), 'Q3 report (final).pdf')
  assert.ok(safeFilename('x'.repeat(500)).length <= 120)
})

test('truncateBody caps very long bodies', () => {
  assert.equal(truncateBody('short'), 'short')
  assert.ok(truncateBody('x'.repeat(MAX_BODY_CHARS + 10)).endsWith('[truncated]'))
})
