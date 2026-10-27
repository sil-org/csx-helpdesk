import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildNewTicketEmail } from './notify.ts'

test('builds subject and body for a numbered ticket', () => {
  const m = buildNewTicketEmail({
    ticketNumber: 42, subject: 'Printer down', senderEmail: 'a@sil.org',
    deskName: 'Global IT Help Desk', link: 'https://x.test/d/it/tickets/1',
  })
  assert.equal(m.subject, '[Global IT Help Desk] #42: Printer down')
  assert.match(m.text, /From: a@sil\.org/)
  assert.match(m.text, /https:\/\/x\.test\/d\/it\/tickets\/1/)
})

test('falls back when subject and sender are missing', () => {
  const m = buildNewTicketEmail({ ticketNumber: null, subject: '  ', senderEmail: null, deskName: 'D', link: 'l' })
  assert.equal(m.subject, '[D] New ticket: (no subject)')
  assert.match(m.text, /From: unknown/)
})
