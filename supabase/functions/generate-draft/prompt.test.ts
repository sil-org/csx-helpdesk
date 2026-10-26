// Run with: node --experimental-strip-types --test supabase/functions/generate-draft/
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, buildUserMessage } from './prompt.ts'

test('buildSystemPrompt always includes the baseline rules and a sign-off', () => {
  const prompt = buildSystemPrompt({ toneNotes: null, signature: null, kbContent: null })
  assert.match(prompt, /never use an em-dash/i)
  assert.match(prompt, /Kind regards, SIL Global Help Desk/)
  assert.doesNotMatch(prompt, /DESK-SPECIFIC/)
  assert.doesNotMatch(prompt, /KNOWLEDGE BASE/)
})

test('buildSystemPrompt appends desk tone notes, signature and KB content when given', () => {
  const prompt = buildSystemPrompt({
    toneNotes: 'Never imply a third party owns Claude/Anthropic account decisions.',
    signature: 'Cheers,\nDallas Help Desk',
    kbContent: 'Part 1: Staff Help...',
  })
  assert.match(prompt, /DESK-SPECIFIC VOICE AND FACTS/)
  assert.match(prompt, /Never imply a third party owns/)
  assert.match(prompt, /Cheers,\nDallas Help Desk/)
  assert.match(prompt, /KNOWLEDGE BASE/)
  assert.match(prompt, /Part 1: Staff Help/)
})

test('buildUserMessage includes the subject and each message labeled by author', () => {
  const msg = buildUserMessage({
    subject: "Can't log in",
    messages: [
      { direction: 'inbound', body: 'My password reset link is broken.', authorLabel: 'the reporter' },
      { direction: 'outbound', body: 'Can you share the exact error?', authorLabel: 'Sam Torres' },
    ],
  })
  assert.match(msg, /Can't log in/)
  assert.match(msg, /\[the reporter\]\nMy password reset link is broken\./)
  assert.match(msg, /\[Sam Torres\]\nCan you share the exact error\?/)
})
