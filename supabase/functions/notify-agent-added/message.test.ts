// Run with: node --experimental-strip-types --test supabase/functions/notify-agent-added/
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNotifyEmail } from './message.ts'

test('buildNotifyEmail greets by first name and includes the sign-in link', () => {
  const email = buildNotifyEmail({ displayName: 'Sam Torres', deskName: 'Dallas Help Desk', link: 'https://example.com/d/dallas' })
  assert.equal(email.subject, "You've been added to the Dallas Help Desk")
  assert.match(email.text, /^Hi Sam,/)
  assert.match(email.text, /https:\/\/example\.com\/d\/dallas/)
})

test('buildNotifyEmail falls back to a generic greeting with no display name', () => {
  const email = buildNotifyEmail({ displayName: null, deskName: 'Dallas Help Desk', link: 'https://example.com/d/dallas' })
  assert.match(email.text, /^Hi there,/)
})
