import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNewTicketEmail } from './notify.ts'

test('builds subject and body for a numbered ticket', () => {
  const m = buildNewTicketEmail({
    ticketNumber: 42, subject: 'Printer down', senderEmail: 'a@sil.org',
    deskName: 'Global IT Help Desk', link: 'https://x.test/d/it/tickets/1',
    messageBody: 'The printer on 3rd floor is jammed again.', draftBody: 'Try clearing tray 2 and restarting it.',
  })
  assert.equal(m.subject, '[Global IT Help Desk] #42: Printer down')
  assert.match(m.text, /From: a@sil\.org/)
  assert.match(m.text, /> The printer on 3rd floor is jammed again\./)
  assert.match(m.text, /Suggested reply \(AI-generated — check before sending\):\n\nTry clearing tray 2 and restarting it\./)
  assert.match(m.text, /https:\/\/x\.test\/d\/it\/tickets\/1/)
})

test('falls back when subject, sender and draft are missing', () => {
  const m = buildNewTicketEmail({
    ticketNumber: null, subject: '  ', senderEmail: null, deskName: 'D', link: 'l',
    messageBody: 'Help please', draftBody: null,
  })
  assert.equal(m.subject, '[D] New ticket: (no subject)')
  assert.match(m.text, /From: unknown/)
  assert.match(m.text, /No AI-suggested reply for this one\./)
})

test('truncates a long message body', () => {
  const long = 'x'.repeat(600)
  const m = buildNewTicketEmail({
    ticketNumber: 1, subject: 'S', senderEmail: 'a@sil.org', deskName: 'D', link: 'l',
    messageBody: long, draftBody: null,
  })
  assert.match(m.text, /x{500}…/)
  assert.doesNotMatch(m.text, /x{501}/)
})
