import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildAssigneeEmail } from './message.ts'

const base = {
  ticketNumber: 42, subject: 'Printer down', requesterEmail: 'pat@example.org',
  deskName: 'Global IT Help Desk', body: 'Still broken', via: 'email' as const, link: 'https://x.test/d/it/t/42',
}

test('builds subject, quoted body and link for an emailed reply', () => {
  const m = buildAssigneeEmail(base)
  assert.equal(m.subject, '[Global IT Help Desk] #42: Printer down — new reply')
  assert.match(m.text, /pat@example\.org replied by email/)
  assert.match(m.text, /> Still broken/)
  assert.match(m.text, /https:\/\/x\.test\/d\/it\/t\/42/)
})

test('says the comment came from the app', () => {
  assert.match(buildAssigneeEmail({ ...base, via: 'app' }).text, /commented in the app/)
})

test('truncates long bodies and quotes every line', () => {
  const m = buildAssigneeEmail({ ...base, body: 'line one\nline two\n' + 'x'.repeat(600) })
  assert.match(m.text, /> line one\n> line two/)
  assert.ok(m.text.includes('…'))
  assert.ok(!m.text.includes('x'.repeat(600)))
})

test('falls back when subject, number and requester are missing', () => {
  const m = buildAssigneeEmail({ ...base, ticketNumber: null, subject: ' ', requesterEmail: null })
  assert.equal(m.subject, '[Global IT Help Desk] Ticket: (no subject) — new reply')
  assert.match(m.text, /^The requester replied/)
})
