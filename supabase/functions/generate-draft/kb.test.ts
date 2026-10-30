// Run with: node --experimental-strip-types --test supabase/functions/generate-draft/
import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleKb } from './kb.ts'

test('assembleKb returns null when there is no knowledge base at all', () => {
  assert.equal(assembleKb({ own: null, sources: [] }), null)
  assert.equal(assembleKb({ own: '  ', sources: [{ deskName: 'Dallas', content: '' }] }), null)
})

test('assembleKb gives the own KB first, then each shared KB labeled with its desk, in the order given', () => {
  const kb = assembleKb({
    own: 'own text',
    sources: [{ deskName: 'Dallas', content: 'dallas text' }, { deskName: 'Global IT', content: 'git text' }],
  })!
  assert.match(kb, /^THIS DESK'S OWN KNOWLEDGE BASE/)
  assert.ok(kb.indexOf('own text') < kb.indexOf('dallas text'))
  assert.ok(kb.indexOf('dallas text') < kb.indexOf('git text'))
  assert.match(kb, /SHARED BY THE DALLAS DESK/)
  assert.match(kb, /SHARED BY THE GLOBAL IT DESK/)
})

test('assembleKb tells the model not to reveal [no-quote] sections and that the own KB wins', () => {
  const kb = assembleKb({ own: 'x', sources: [{ deskName: 'Dallas', content: 'y' }] })!
  assert.match(kb, /never quote, closely paraphrase or reveal/)
  assert.match(kb, /follow the earlier one/)
})

test('assembleKb works with only shared sources (a desk with an empty own KB)', () => {
  const kb = assembleKb({ own: null, sources: [{ deskName: 'Dallas', content: 'y' }] })!
  assert.doesNotMatch(kb, /THIS DESK'S OWN/)
  assert.match(kb, /y$/)
})
