// Run with: node --experimental-strip-types --test supabase/functions/helpdesk-inbound/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoReplyReason, candidateAddresses, htmlToText, looksForwarded,
  parseAddress, parseAddressList, parseBounceRecipient, parseForwardedSender, parseReferences, routeDesk,
  safeFilename, stripGroupFooter, stripQuotedReply, truncateBody, MAX_BODY_CHARS,
} from './parse.ts'

const h = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }))

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
    'Delivered-To': 'helpdesk-inbound@sil.org',
    'List-Post': '<mailto:dallas-help@sil.org>',
    'To': 'Dallas Help <dallas-help@sil.org>',
    'Cc': 'someone@x.org',
    'List-Id': '<dallas-help.sil.org>',
  }))
  assert.deepEqual(c, ['dallas-help@sil.org', 'helpdesk-inbound@sil.org', 'someone@x.org'])
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

test('parseForwardedSender reads the From: line of a Gmail-style forward', () => {
  const body = 'FYI, please help.\n\n---------- Forwarded message ---------\n' +
    'From: J. Whitfield <jwhitfield@example.org>\nDate: Mon, Oct 20, 2026\nSubject: access\nTo: Kate <kate@sil.org>\n\nHi Kate, can you help?'
  assert.deepEqual(parseForwardedSender(body), { name: 'J. Whitfield', email: 'jwhitfield@example.org' })
})

test('parseForwardedSender reads an Outlook-style original message block', () => {
  const body = 'Please see below.\n\n-----Original Message-----\nFrom: Pat Lee <pat.lee@example.org>\nSent: Monday\nTo: Kate\nSubject: help'
  assert.deepEqual(parseForwardedSender(body), { name: 'Pat Lee', email: 'pat.lee@example.org' })
})

test('parseForwardedSender matches by shape, not label, for a localized forward', () => {
  // Real example: Gmail localizes the "From:" label to the original
  // sender's account language (here Spanish "De:"), not the forwarding
  // agent's — this must not depend on matching the word "From".
  const body = 'Kate Brenner\nSIL Global\n\n\n---------- Forwarded message ---------\n' +
    'De: Tom Brenner <thomasbrenner@gmail.com>\nDate: lun, 26 oct 2026\nSubject: test\nTo: <kate_brenner@sil.org>\n\ntest test'
  assert.deepEqual(parseForwardedSender(body), { name: 'Tom Brenner', email: 'thomasbrenner@gmail.com' })
})

test('parseForwardedSender returns null with no marker or no usable From: line', () => {
  assert.equal(parseForwardedSender('just a normal message, nothing quoted'), null)
  assert.equal(parseForwardedSender('---------- Forwarded message ---------\nSubject: no from line here'), null)
})

test('parseBounceRecipient finds a real recipient in an SES bounce, skipping the bounce machinery', () => {
  const body = 'An error occurred while trying to deliver the mail to the following recipients:\n\n' +
    'marc_aarnoudse@sil.org:\nRemote host said: 550 5.1.1 unknown user\n\n' +
    'This is an automatically generated Delivery Status Notification.\nMAILER-DAEMON@amazonses.com'
  assert.deepEqual(parseBounceRecipient(body), { name: null, email: 'marc_aarnoudse@sil.org' })
})

test('parseBounceRecipient returns null for pure infrastructure noise with no real recipient', () => {
  const body = 'This confirms your subscription request.\nSent by MAILER-DAEMON@amazonses.com\nbounce@amazonses.com'
  assert.equal(parseBounceRecipient(body), null)
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

test('stripGroupFooter also removes the short unsubscribe footer seen on real group mail', () => {
  const body = 'now with attachys\n\nKate\n\nTo unsubscribe from this group and stop receiving emails from it, send an email to helpdesk+unsubscribe@sil.org.\n'
  assert.equal(stripGroupFooter(body), 'now with attachys\n\nKate')
})

test('htmlToText strips tags and entities', () => {
  assert.equal(htmlToText('<style>p{}</style><p>Hello&nbsp;<b>there</b></p><div>bye &amp; thanks</div>'), 'Hello there\nbye & thanks')
})

test('stripQuotedReply cuts known quote markers when there is new text above', () => {
  const gmail = 'and a better test!\n\nKate\n\nOn Mon, Oct 26, 2026 at 8:54 AM SIL Global IT Helpdesk\n<service@youtrack.cloud> wrote:\n\n> ##- Please enter your reply above this line -##\n> hi'
  assert.equal(stripQuotedReply(gmail), 'and a better test!\n\nKate')
  const oneLine = 'Thanks!\n\nOn Tue, 3 Mar 2026, Pat <pat@x.org> wrote:\n> old'
  assert.equal(stripQuotedReply(oneLine), 'Thanks!')
  const youtrack = 'Fixed it.\n##- Please enter your reply above this line -##\nrest'
  assert.equal(stripQuotedReply(youtrack), 'Fixed it.')
  const outlook = 'Yes please.\n\n-----Original Message-----\nFrom: a\nSent: b'
  assert.equal(stripQuotedReply(outlook), 'Yes please.')
  const outlookBlock = 'Yes.\n\nFrom: Pat <p@x.org>\nSent: Monday\nTo: me\nSubject: x\n\nold'
  assert.equal(stripQuotedReply(outlookBlock), 'Yes.')
})

test('stripQuotedReply leaves text alone when nothing was written above the marker', () => {
  const onlyQuote = 'On Mon, Pat <p@x.org> wrote:\n> the whole question'
  assert.equal(stripQuotedReply(onlyQuote), onlyQuote)
  assert.equal(stripQuotedReply('no markers here'), 'no markers here')
  // a sentence that merely contains "wrote:" is not a marker
  assert.equal(stripQuotedReply('The vendor wrote: do not reboot'), 'The vendor wrote: do not reboot')
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
