// Run with: node --experimental-strip-types --test supabase/functions/generate-draft/
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, buildSystemBlocks, buildUserMessage, senderTrustNote, parsePromptCache } from './prompt.ts'

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

test('every prompt says to start with "Forgot password" and only escalate to identity checks if that failed', () => {
  const prompt = buildSystemPrompt({ toneNotes: null, signature: null, kbContent: null })
  assert.match(prompt, /Forgot password/)
  assert.match(prompt, /confirm it is really them/)
})

test('an external sender gets the strict note; a verified SIL sender gets none', () => {
  assert.match(buildSystemPrompt({ toneNotes: null, signature: null, kbContent: null, senderTrust: 'external' }), /outside SIL/)
  assert.match(buildSystemPrompt({ toneNotes: null, signature: null, kbContent: null, senderTrust: 'sil_unverified' }), /could not verify/)
  assert.doesNotMatch(buildSystemPrompt({ toneNotes: null, signature: null, kbContent: null, senderTrust: 'sil_verified' }), /SENDER:/)
  assert.doesNotMatch(buildSystemPrompt({ toneNotes: null, signature: null, kbContent: null }), /SENDER:/)
  assert.equal(senderTrustNote('sil_verified'), null)
})

const base = { toneNotes: 'Be brief.', signature: 'Cheers', kbContent: 'KB text' }

test('the cached block is identical whatever the sender, so one cache entry serves every ticket', () => {
  const verified = buildSystemBlocks({ ...base, senderTrust: 'sil_verified' })
  const external = buildSystemBlocks({ ...base, senderTrust: 'external' })
  const unverified = buildSystemBlocks({ ...base, senderTrust: 'sil_unverified' })
  assert.equal(verified.length, 1)
  assert.equal(external[0].text, verified[0].text)
  assert.equal(unverified[0].text, verified[0].text)
  assert.deepEqual(external[0].cache_control, { type: 'ephemeral' })
})

test('the per-ticket sender note is a separate block after the cached one and is never cached', () => {
  const blocks = buildSystemBlocks({ ...base, senderTrust: 'external' })
  assert.equal(blocks.length, 2)
  assert.match(blocks[1].text, /outside SIL/)
  assert.equal(blocks[1].cache_control, undefined)
  assert.doesNotMatch(blocks[0].text, /outside SIL|SENDER:/)
})

test('the cached block holds the rules, tone, sign-off and knowledge base', () => {
  const [stable] = buildSystemBlocks(base)
  for (const part of [/never use an em-dash/i, /Forgot password/, /Be brief\./, /Cheers/, /KB text/]) assert.match(stable.text, part)
})

test('cache lifetime: 5m by default, 1h on request, none when off', () => {
  assert.deepEqual(buildSystemBlocks(base)[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(buildSystemBlocks({ ...base, cache: '1h' })[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(buildSystemBlocks({ ...base, cache: 'off' })[0].cache_control, undefined)
})

test('parsePromptCache accepts off, 5m and 1h in any case and falls back to 5m', () => {
  assert.equal(parsePromptCache('OFF'), 'off')
  assert.equal(parsePromptCache(' 1H '), '1h')
  assert.equal(parsePromptCache('5m'), '5m')
  assert.equal(parsePromptCache(undefined), '5m')
  assert.equal(parsePromptCache('banana'), '5m')
})
